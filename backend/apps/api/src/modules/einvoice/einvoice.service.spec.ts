import { describe, expect, it, vi } from 'vitest';

import {
  EinvoiceService,
  type SupabaseLike,
} from './einvoice.service';
import type { EinvoiceProvider } from './stub-einvoice.provider';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '22222222-2222-2222-2222-222222222222';
const JOB_ID = '33333333-3333-3333-3333-333333333333';
const CREATED_AT = '2026-07-27T21:00:00.000Z';

describe('EinvoiceService', () => {
  it('creates a pending job and marks stub issue as sent', async () => {
    const issue = vi.fn(async () => ({
      provider: 'stub' as const,
      externalId: 'stub-order',
      sentAt: CREATED_AT,
    }));
    const updates: unknown[] = [];
    const jobs = einvoiceJobsHandler({
      updates,
      inserted: jobRow({ status: 'pending', attempts: 0 }),
      updated: jobRow({ status: 'sent', attempts: 1, sent_at: CREATED_AT }),
    });
    const client = supabaseStub(jobs);
    const provider = { issue } satisfies EinvoiceProvider;

    const service = new EinvoiceService(client, provider);
    const result = await service.issue(ORG_ID, {
      orderId: ORDER_ID,
      provider: 'stub',
    });

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, orderId: ORDER_ID }),
    );
    expect(updates[0]).toMatchObject({ status: 'sent', attempts: 1 });
    expect(result.job).toMatchObject({
      orderId: ORDER_ID,
      provider: 'stub',
      status: 'sent',
      attempts: 1,
    });
  });

  it('maps http_sandbox provider failure into failed job status', async () => {
    const updates: unknown[] = [];
    const inserts: unknown[] = [];
    const jobs = einvoiceJobsHandler({
      inserts,
      updates,
      inserted: jobRow({
        provider: 'http_sandbox',
        status: 'pending',
        attempts: 0,
      }),
      updated: jobRow({
        provider: 'http_sandbox',
        status: 'failed',
        attempts: 1,
        last_error: 'http_sandbox provider failed with HTTP 500',
      }),
    });
    const client = supabaseStub(jobs);

    const failingProvider: EinvoiceProvider = {
      issue: async () => {
        throw new Error('http_sandbox provider failed with HTTP 500');
      },
    };

    const service = new EinvoiceService(client, undefined, {
      http_sandbox: failingProvider,
    });
    const result = await service.issue(ORG_ID, {
      orderId: ORDER_ID,
      provider: 'http_sandbox',
    });

    expect(inserts[0]).toMatchObject({ provider: 'http_sandbox' });
    expect(updates[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'http_sandbox provider failed with HTTP 500',
    });
    expect(result.job).toMatchObject({
      provider: 'http_sandbox',
      status: 'failed',
      attempts: 1,
    });
  });

  it('never issues twice for an order that already has an active job', async () => {
    // The defect: `issue()` inserted a job and called the provider
    // unconditionally, so a double-click or a client retry minted a SECOND
    // legal tax invoice for one sale.
    const issue = vi.fn(async () => ({
      provider: 'stub' as const,
      externalId: 'stub-order',
      sentAt: CREATED_AT,
    }));
    const inserts: unknown[] = [];
    const existing = jobRow({ status: 'sent', attempts: 1, sent_at: CREATED_AT });
    const jobs = einvoiceJobsHandler({ inserts, activeLookups: [[existing]] });
    const client = supabaseStub(jobs);

    const service = new EinvoiceService(client, { issue });
    const result = await service.issue(ORG_ID, { orderId: ORDER_ID });

    // The provider is never contacted, and no second job row is written.
    expect(issue).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    // The caller gets the invoice that actually exists, flagged as a repeat.
    expect(result).toMatchObject({
      alreadyIssued: true,
      job: { id: JOB_ID, status: 'sent' },
    });
  });

  it('only treats pending and sent as active, so a failed job can be retried', async () => {
    // A provider outage must never lock an order out of ever being invoiced:
    // `failed` and `dead` are excluded from the active set (and from the
    // partial unique index predicate) precisely so a retry can proceed.
    const issue = vi.fn(async () => ({
      provider: 'stub' as const,
      externalId: 'stub-order',
      sentAt: CREATED_AT,
    }));
    const inserts: unknown[] = [];
    const jobs = einvoiceJobsHandler({
      inserts,
      // A prior `failed` job is simply not returned by the active lookup.
      activeLookups: [[]],
      inserted: jobRow({ status: 'pending', attempts: 1 }),
      updated: jobRow({ status: 'sent', attempts: 2, sent_at: CREATED_AT }),
    });
    const client = supabaseStub(jobs);

    const service = new EinvoiceService(client, { issue });
    const result = await service.issue(ORG_ID, { orderId: ORDER_ID });

    expect(jobs.activeStatusFilters).toEqual([['pending', 'sent']]);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    expect(result.job).toMatchObject({ status: 'sent' });
    expect(result).not.toHaveProperty('alreadyIssued');
  });

  it('handles the concurrent-insert unique violation without a raw 500', async () => {
    // Two requests race past the lookup; the partial unique index
    // `einvoice_jobs_one_active_per_order_idx` lets exactly one insert through.
    const issue = vi.fn(async () => ({
      provider: 'stub' as const,
      externalId: 'stub-order',
      sentAt: CREATED_AT,
    }));
    const winner = jobRow({ status: 'pending', attempts: 0 });
    const jobs = einvoiceJobsHandler({
      // First lookup finds nothing (the winner has not committed yet), the
      // insert then collides, and the retry lookup finds the winner.
      activeLookups: [[], [winner]],
      insertError: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "einvoice_jobs_one_active_per_order_idx"',
      },
    });
    const client = supabaseStub(jobs);

    const service = new EinvoiceService(client, { issue });
    const result = await service.issue(ORG_ID, { orderId: ORDER_ID });

    expect(issue).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      alreadyIssued: true,
      job: { id: JOB_ID, status: 'pending' },
    });
  });

  it('reports a conflict, not a 500, when the racing job cannot be read back', async () => {
    const issue = vi.fn(async () => ({
      provider: 'stub' as const,
      externalId: 'stub-order',
      sentAt: CREATED_AT,
    }));
    const jobs = einvoiceJobsHandler({
      activeLookups: [[], []],
      insertError: { code: '23505', message: 'duplicate key value' },
    });
    const client = supabaseStub(jobs);

    const service = new EinvoiceService(client, { issue });

    await expect(
      service.issue(ORG_ID, { orderId: ORDER_ID }),
    ).rejects.toMatchObject({
      response: { code: 'einvoice_already_active' },
      status: 409,
    });
    expect(issue).not.toHaveBeenCalled();
  });
});

function ordersHandler() {
  return {
    select() {
      return {
        eq() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: orderRow(), error: null }),
              };
            },
          };
        },
      };
    },
  };
}

// `issue()` now looks up an already-active (`pending`/`sent`) job for the order
// before it calls the provider, so the einvoice_jobs stub has to answer a
// `select().eq().eq().in().order()` chain as well as insert/update.
// `activeLookups` is consumed one entry per lookup (the last entry repeats).
function einvoiceJobsHandler(options: {
  activeLookups?: Array<Array<Record<string, unknown>>>;
  insertError?: { code: string; message: string };
  inserted?: Record<string, unknown>;
  updated?: Record<string, unknown>;
  inserts?: unknown[];
  updates?: unknown[];
}) {
  const lookups = [...(options.activeLookups ?? [[]])];
  const activeStatusFilters: unknown[][] = [];

  return {
    activeStatusFilters,
    select() {
      return {
        eq() {
          return {
            eq() {
              return {
                in(_column: string, values: unknown[]) {
                  activeStatusFilters.push(values);
                  return {
                    order: async () => ({
                      data: lookups.length > 1 ? lookups.shift() : lookups[0],
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
    insert(values: unknown) {
      options.inserts?.push(values);
      return {
        select() {
          return {
            single: async () =>
              options.insertError
                ? { data: null, error: options.insertError }
                : { data: options.inserted ?? jobRow({}), error: null },
          };
        },
      };
    },
    update(values: unknown) {
      options.updates?.push(values);
      return {
        eq() {
          return {
            eq() {
              return {
                select() {
                  return {
                    single: async () => ({
                      data: options.updated ?? jobRow({}),
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function supabaseStub(jobs: ReturnType<typeof einvoiceJobsHandler>) {
  return {
    from(table: string) {
      if (table === 'orders') {
        return ordersHandler();
      }

      expect(table).toBe('einvoice_jobs');
      return jobs;
    },
  } as unknown as SupabaseLike;
}

function orderRow() {
  return {
    id: ORDER_ID,
    org_id: ORG_ID,
    status: 'done',
    payment_method: 'cod',
    customer_name: 'Nguyen Van A',
    phone_e164: '+84901234567',
    total_vnd: '120000',
    done_at: CREATED_AT,
    created_at: CREATED_AT,
  };
}

function jobRow(overrides: Record<string, unknown>) {
  return {
    id: JOB_ID,
    org_id: ORG_ID,
    order_id: ORDER_ID,
    provider: 'stub',
    status: 'pending',
    attempts: 0,
    last_error: null,
    payload_json: {},
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    sent_at: null,
    ...overrides,
  };
}
