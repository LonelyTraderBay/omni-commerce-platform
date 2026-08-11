import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadEnv } from '../../config/env';
import type {
  EinvoiceJobStatus,
  EinvoiceProviderCode,
  IssueEinvoiceBody,
} from './dto';
import {
  HttpSandboxEinvoiceProvider,
  resolveDefaultEinvoiceProvider,
} from './http-sandbox-einvoice.provider';
import {
  StubEinvoiceProvider,
  type EinvoiceProvider,
  type EinvoiceIssueResult,
} from './stub-einvoice.provider';

export const EINVOICE_SUPABASE = Symbol('EINVOICE_SUPABASE');
export const EINVOICE_PROVIDER = Symbol('EINVOICE_PROVIDER');
export const EINVOICE_PROVIDERS = Symbol('EINVOICE_PROVIDERS');

export type SupabaseLike = Pick<SupabaseClient, 'from'>;
export type EinvoiceProviderMap = Partial<
  Record<EinvoiceProviderCode, EinvoiceProvider>
>;

type JsonObject = Record<string, unknown>;

type OrderRow = {
  id: string;
  org_id: string;
  status: string;
  payment_method: string;
  customer_name: string | null;
  phone_e164: string | null;
  total_vnd: string | number;
  done_at: string | null;
  created_at: string;
};

type EinvoiceJobRow = {
  id: string;
  org_id: string;
  order_id: string;
  provider: EinvoiceProviderCode;
  status: EinvoiceJobStatus;
  attempts: number;
  last_error: string | null;
  payload_json: JsonObject;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

const ORDER_SELECT =
  'id, org_id, status, payment_method, customer_name, phone_e164, total_vnd, done_at, created_at';
const JOB_SELECT =
  'id, org_id, order_id, provider, status, attempts, last_error, payload_json, created_at, updated_at, sent_at';

/**
 * Statuses that mean "an invoice for this order is already claimed or issued".
 * The full vocabulary is `pending | sent | failed | dead`
 * (einvoice_jobs_status_check). `failed` and `dead` are deliberately excluded:
 * a failed attempt must stay retryable, otherwise a provider outage would
 * permanently lock an order out of ever being invoiced. Mirrors the predicate
 * of `einvoice_jobs_one_active_per_order_idx`.
 */
const ACTIVE_JOB_STATUSES: EinvoiceJobStatus[] = ['pending', 'sent'];

@Injectable()
export class EinvoiceService {
  private readonly supabase: SupabaseLike;
  private readonly providers: Record<EinvoiceProviderCode, EinvoiceProvider>;
  /** Test override: force a single provider for all codes. */
  private readonly providerOverride: EinvoiceProvider | undefined;

  constructor(
    @Optional()
    @Inject(EINVOICE_SUPABASE)
    supabase?: SupabaseLike,
    @Optional()
    @Inject(EINVOICE_PROVIDER)
    providerOverride?: EinvoiceProvider,
    @Optional()
    @Inject(EINVOICE_PROVIDERS)
    providers?: EinvoiceProviderMap,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
    this.providerOverride = providerOverride;
    this.providers = {
      stub: providers?.stub ?? new StubEinvoiceProvider(),
      http_sandbox:
        providers?.http_sandbox ?? new HttpSandboxEinvoiceProvider(),
    };
  }

  async listJobs(orgId: string, status?: EinvoiceJobStatus) {
    let query = this.supabase
      .from('einvoice_jobs')
      .select(JOB_SELECT)
      .eq('org_id', orgId);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      throwEinvoiceError(error, 'Could not list e-invoice jobs');
    }

    return { jobs: ((data ?? []) as EinvoiceJobRow[]).map(mapJob) };
  }

  async issue(orgId: string, body: IssueEinvoiceBody) {
    const order = await this.requireOrder(orgId, body.orderId);
    if (order.status !== 'done') {
      throw new BadRequestException({
        code: 'order_not_done',
        message: 'E-invoice can only be issued for done orders',
      });
    }

    // Issuing is a real, externally visible tax event: `runJob` calls
    // `provider.issue(...)`, which mints a legal invoice. This used to insert a
    // job and call the provider unconditionally, so a double-click, a client
    // retry after a timeout, or two operators acting at once produced two legal
    // invoices for one sale. Check for an already-active job BEFORE touching the
    // provider, and report that job instead of issuing again.
    const active = await this.findActiveJob(orgId, body.orderId);
    if (active) {
      return { job: mapJob(active), alreadyIssued: true as const };
    }

    const providerCode = body.provider ?? resolveDefaultEinvoiceProvider();
    const payload = buildPayload(order);
    const { data, error } = await this.supabase
      .from('einvoice_jobs')
      .insert({
        org_id: orgId,
        order_id: body.orderId,
        provider: providerCode,
        status: 'pending',
        attempts: 0,
        payload_json: payload,
      })
      .select(JOB_SELECT)
      .single();

    if (error) {
      // Two requests raced past the lookup above; the partial unique index
      // `einvoice_jobs_one_active_per_order_idx` let exactly one insert through.
      // The loser reports the winner's job rather than a raw 500 — no provider
      // call happens on this path, which is the whole point of the index.
      if (error.code === '23505') {
        const winner = await this.findActiveJob(orgId, body.orderId);
        if (winner) {
          return { job: mapJob(winner), alreadyIssued: true as const };
        }
        throw new ConflictException({
          code: 'einvoice_already_active',
          message: 'An e-invoice job for this order is already being issued',
        });
      }
      throwEinvoiceError(error, 'Could not create e-invoice job');
    }

    const job = data as EinvoiceJobRow;
    return { job: mapJob(await this.runJob(job, payload)) };
  }

  /**
   * The single `pending`/`sent` job for an order, if any. At most one can exist
   * (`einvoice_jobs_one_active_per_order_idx`); ordering keeps the result
   * deterministic for rows predating that index.
   */
  private async findActiveJob(
    orgId: string,
    orderId: string,
  ): Promise<EinvoiceJobRow | null> {
    const { data, error } = await this.supabase
      .from('einvoice_jobs')
      .select(JOB_SELECT)
      .eq('org_id', orgId)
      .eq('order_id', orderId)
      .in('status', ACTIVE_JOB_STATUSES)
      .order('created_at', { ascending: true });

    if (error) {
      throwEinvoiceError(error, 'Could not read existing e-invoice jobs');
    }

    return ((data ?? []) as EinvoiceJobRow[])[0] ?? null;
  }

  private async requireOrder(orgId: string, orderId: string) {
    const { data, error } = await this.supabase
      .from('orders')
      .select(ORDER_SELECT)
      .eq('org_id', orgId)
      .eq('id', orderId)
      .maybeSingle();

    if (error) {
      throwEinvoiceError(error, 'Could not read order for e-invoice');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'order_not_found',
        message: 'Order was not found',
      });
    }

    return data as OrderRow;
  }

  private resolveProvider(code: EinvoiceProviderCode): EinvoiceProvider {
    if (this.providerOverride) {
      return this.providerOverride;
    }
    return this.providers[code] ?? this.providers.stub;
  }

  private async runJob(job: EinvoiceJobRow, payload: JsonObject) {
    const attempts = job.attempts + 1;
    try {
      const result = await this.resolveProvider(job.provider).issue({
        orgId: job.org_id,
        orderId: job.order_id,
        payload,
      });
      return await this.updateJob(job, {
        status: 'sent',
        attempts,
        last_error: null,
        sent_at: result.sentAt,
        payload_json: {
          ...payload,
          result: serializeProviderResult(result),
        },
      });
    } catch (err) {
      const lastError =
        err instanceof Error ? err.message : 'E-invoice provider failed';
      return await this.updateJob(job, {
        status: attempts >= 3 ? 'dead' : 'failed',
        attempts,
        last_error: lastError,
      });
    }
  }

  private async updateJob(
    job: EinvoiceJobRow,
    values: Partial<{
      status: EinvoiceJobStatus;
      attempts: number;
      last_error: string | null;
      sent_at: string | null;
      payload_json: JsonObject;
    }>,
  ) {
    const { data, error } = await this.supabase
      .from('einvoice_jobs')
      .update({
        ...values,
        updated_at: new Date().toISOString(),
      })
      .eq('org_id', job.org_id)
      .eq('id', job.id)
      .select(JOB_SELECT)
      .single();

    if (error) {
      throwEinvoiceError(error, 'Could not update e-invoice job');
    }

    return data as EinvoiceJobRow;
  }
}

function buildPayload(order: OrderRow): JsonObject {
  return {
    orderId: order.id,
    status: order.status,
    paymentMethod: order.payment_method,
    customerName: order.customer_name,
    phoneE164: order.phone_e164,
    totalVnd: String(order.total_vnd),
    doneAt: order.done_at,
    createdAt: order.created_at,
  };
}

function serializeProviderResult(result: EinvoiceIssueResult): JsonObject {
  return {
    provider: result.provider,
    externalId: result.externalId,
    sentAt: result.sentAt,
    ...(result.note ? { note: result.note } : {}),
  };
}

function mapJob(row: EinvoiceJobRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    orderId: row.order_id,
    provider: row.provider,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    payload: row.payload_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

function throwEinvoiceError(error: SupabaseError, message: string): never {
  if (error.code === '23503') {
    throw new BadRequestException({
      code: 'invalid_einvoice_reference',
      message: error.message ?? 'Order was not found',
    });
  }

  throw new InternalServerErrorException({
    code: 'einvoice_failed',
    message: error.message ?? message,
  });
}

function createSupabaseServiceClient(): SupabaseLike {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
