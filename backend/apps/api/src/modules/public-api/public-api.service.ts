import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, createHmac, randomBytes } from 'node:crypto';

import { decryptToken, encryptToken } from '../../common/crypto/token-crypto';
import { loadEnv, type Env } from '../../config/env';
import { AuditService, type WriteAuditInput } from '../audit/audit.service';
import type {
  ApiKeyScope,
  CreateApiKeyBody,
  CreateOutboundWebhookBody,
  ListPublicOrdersQuery,
  UpdateOutboundWebhookBody,
} from './dto';

export const PUBLIC_API_SUPABASE = Symbol('PUBLIC_API_SUPABASE');
export const PUBLIC_API_ENV = Symbol('PUBLIC_API_ENV');
export const PUBLIC_API_WEBHOOK_SENDER = Symbol('PUBLIC_API_WEBHOOK_SENDER');

export type SupabaseLike = Pick<SupabaseClient, 'from'>;
export type PublicApiEnv = Pick<
  Env,
  'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY' | 'TOKEN_ENCRYPTION_KEY'
>;
export type AuditWriter = {
  writeAudit(input: WriteAuditInput): Promise<unknown>;
};
export type WebhookSender = (input: {
  body: string;
  headers: Record<string, string>;
  url: string;
}) => Promise<{ ok: boolean; status: number }>;

export type PublicApiAuthContext = {
  apiKeyId: string;
  orgId: string;
  scopes: ApiKeyScope[];
};

type ApiKeyRow = {
  id: string;
  org_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: ApiKeyScope[];
  revoked_at: string | null;
  created_at: string;
};

type OrderRow = {
  id: string;
  status: string;
  payment_method: string;
  customer_name: string | null;
  phone_e164: string | null;
  currency: string;
  total_vnd: number | string;
  created_at: string;
  updated_at: string;
};

type OutboundWebhookRow = {
  id: string;
  org_id: string;
  url: string;
  secret_enc: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

const API_KEY_SELECT =
  'id, org_id, name, key_prefix, key_hash, scopes, revoked_at, created_at';
const PUBLIC_ORDER_SELECT =
  'id, status, payment_method, customer_name, phone_e164, currency, total_vnd, created_at, updated_at';
const OUTBOUND_WEBHOOK_SELECT =
  'id, org_id, url, secret_enc, events, enabled, created_at, updated_at';

@Injectable()
export class PublicApiService {
  private readonly supabase: SupabaseLike;
  private readonly env: PublicApiEnv;
  private readonly sender: WebhookSender;

  constructor(
    @Optional()
    @Inject(PUBLIC_API_SUPABASE)
    supabase: SupabaseLike | undefined,
    @Inject(AuditService)
    private readonly audit: AuditWriter,
    @Optional()
    @Inject(PUBLIC_API_ENV)
    env?: PublicApiEnv,
    @Optional()
    @Inject(PUBLIC_API_WEBHOOK_SENDER)
    sender?: WebhookSender,
  ) {
    this.env = env ?? loadEnv();
    this.supabase = supabase ?? createSupabaseServiceClient(this.env);
    this.sender = sender ?? defaultWebhookSender;
  }

  async createKey(input: {
    orgId: string;
    actorUserId: string;
    body: CreateApiKeyBody;
  }) {
    const key = `omni_${randomBytes(24).toString('base64url')}`;
    const keyPrefix = key.slice(0, 13);
    const { data, error } = await this.supabase
      .from('api_keys')
      .insert({
        org_id: input.orgId,
        name: input.body.name,
        key_prefix: keyPrefix,
        key_hash: hashApiKey(key),
        scopes: uniqueScopes(input.body.scopes),
      })
      .select(API_KEY_SELECT)
      .single();

    if (error) {
      throwPublicApiError(error, 'Could not create API key');
    }

    const apiKey = mapApiKey(data as ApiKeyRow);
    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'public_api.key_created',
      entityType: 'api_key',
      entityId: apiKey.id,
      meta: { keyPrefix: apiKey.keyPrefix, scopes: apiKey.scopes },
    });

    return { apiKey, key };
  }

  async listKeys(orgId: string) {
    const { data, error } = await this.supabase
      .from('api_keys')
      .select(API_KEY_SELECT)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });

    if (error) {
      throwPublicApiError(error, 'Could not list API keys');
    }

    return { apiKeys: ((data ?? []) as ApiKeyRow[]).map(mapApiKey) };
  }

  async revokeKey(input: {
    orgId: string;
    actorUserId: string;
    keyId: string;
  }) {
    const { data, error } = await this.supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', input.keyId)
      .eq('org_id', input.orgId)
      .select(API_KEY_SELECT)
      .maybeSingle();

    if (error) {
      throwPublicApiError(error, 'Could not revoke API key');
    }
    if (!data) {
      throwApiKeyNotFound();
    }

    const apiKey = mapApiKey(data as ApiKeyRow);
    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'public_api.key_revoked',
      entityType: 'api_key',
      entityId: apiKey.id,
      meta: { keyPrefix: apiKey.keyPrefix },
    });

    return { apiKey };
  }

  async authenticateKey(
    token: string | undefined,
    requiredScope: ApiKeyScope,
  ): Promise<PublicApiAuthContext> {
    if (!token?.startsWith('omni_')) {
      throw new UnauthorizedException({
        code: 'public_api_key_required',
        message: 'A valid omni_ API key is required',
      });
    }

    const { data, error } = await this.supabase
      .from('api_keys')
      .select(API_KEY_SELECT)
      .eq('key_hash', hashApiKey(token))
      .maybeSingle();

    if (error) {
      throwPublicApiError(error, 'Could not authenticate API key');
    }
    if (!data) {
      throwInvalidApiKey();
    }

    const row = data as ApiKeyRow;
    if (row.revoked_at) {
      throwInvalidApiKey();
    }
    if (!row.scopes.includes(requiredScope)) {
      throw new ForbiddenException({
        code: 'public_api_scope_denied',
        message: `Missing API key scope: ${requiredScope}`,
      });
    }

    return {
      apiKeyId: row.id,
      orgId: row.org_id,
      scopes: row.scopes,
    };
  }

  async listPublicOrders(orgId: string, query: ListPublicOrdersQuery) {
    let builder = this.supabase
      .from('orders')
      .select(PUBLIC_ORDER_SELECT)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(query.limit);

    if (query.status) {
      builder = builder.eq('status', query.status);
    }

    const { data, error } = await builder;
    if (error) {
      throwPublicApiError(error, 'Could not list public orders');
    }

    return { orders: ((data ?? []) as OrderRow[]).map(mapPublicOrder) };
  }

  async createWebhook(input: {
    orgId: string;
    actorUserId: string;
    body: CreateOutboundWebhookBody;
  }) {
    const secret = input.body.secret ?? randomBytes(32).toString('base64url');
    const { data, error } = await this.supabase
      .from('outbound_webhooks')
      .insert({
        org_id: input.orgId,
        url: input.body.url,
        secret_enc: encryptToken(secret, this.env.TOKEN_ENCRYPTION_KEY),
        events: uniqueStrings(input.body.events),
        enabled: input.body.enabled,
      })
      .select(OUTBOUND_WEBHOOK_SELECT)
      .single();

    if (error) {
      throwPublicApiError(error, 'Could not create outbound webhook');
    }

    const webhook = mapWebhook(data as OutboundWebhookRow);
    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'public_api.webhook_created',
      entityType: 'outbound_webhook',
      entityId: webhook.id,
      meta: { url: webhook.url, events: webhook.events },
    });

    return { webhook, secret };
  }

  async listWebhooks(orgId: string) {
    const { data, error } = await this.supabase
      .from('outbound_webhooks')
      .select(OUTBOUND_WEBHOOK_SELECT)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });

    if (error) {
      throwPublicApiError(error, 'Could not list outbound webhooks');
    }

    return { webhooks: ((data ?? []) as OutboundWebhookRow[]).map(mapWebhook) };
  }

  async updateWebhook(input: {
    orgId: string;
    actorUserId: string;
    webhookId: string;
    body: UpdateOutboundWebhookBody;
  }) {
    const { data, error } = await this.supabase
      .from('outbound_webhooks')
      .update({
        ...(input.body.enabled !== undefined
          ? { enabled: input.body.enabled }
          : {}),
        ...(input.body.events !== undefined
          ? { events: uniqueStrings(input.body.events) }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.webhookId)
      .eq('org_id', input.orgId)
      .select(OUTBOUND_WEBHOOK_SELECT)
      .maybeSingle();

    if (error) {
      throwPublicApiError(error, 'Could not update outbound webhook');
    }
    if (!data) {
      throwWebhookNotFound();
    }

    const webhook = mapWebhook(data as OutboundWebhookRow);
    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'public_api.webhook_updated',
      entityType: 'outbound_webhook',
      entityId: webhook.id,
      meta: { enabled: webhook.enabled, events: webhook.events },
    });

    return { webhook };
  }

  async testWebhook(input: {
    orgId: string;
    actorUserId: string;
    webhookId: string;
  }) {
    const row = await this.getWebhook(input.orgId, input.webhookId);
    if (!row.enabled) {
      throw new BadRequestException({
        code: 'webhook_disabled',
        message: 'Webhook is disabled',
      });
    }

    const payload = {
      event: 'webhook.test',
      sentAt: new Date().toISOString(),
      data: {
        webhookId: row.id,
      },
    };
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = decryptToken(row.secret_enc, this.env.TOKEN_ENCRYPTION_KEY);
    const signature = signWebhookPayload(secret, timestamp, body);
    const response = await this.sender({
      url: row.url,
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Omni-Event': 'webhook.test',
        'X-Omni-Timestamp': timestamp,
        'X-Omni-Signature': signature,
      },
    });

    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'public_api.webhook_test_ping',
      entityType: 'outbound_webhook',
      entityId: row.id,
      meta: {
        status: response.status,
        ok: response.ok,
      },
    });

    return {
      delivered: response.ok,
      status: response.status,
      signatureHeader: signature,
    };
  }

  private async getWebhook(orgId: string, webhookId: string) {
    const { data, error } = await this.supabase
      .from('outbound_webhooks')
      .select(OUTBOUND_WEBHOOK_SELECT)
      .eq('id', webhookId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      throwPublicApiError(error, 'Could not read outbound webhook');
    }
    if (!data) {
      throwWebhookNotFound();
    }

    return data as OutboundWebhookRow;
  }
}

export function hashApiKey(key: string) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function signWebhookPayload(
  secret: string,
  timestamp: string,
  body: string,
) {
  return `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex')}`;
}

function uniqueScopes(scopes: ApiKeyScope[]) {
  return [...new Set(scopes)];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function mapApiKey(row: ApiKeyRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function mapPublicOrder(row: OrderRow) {
  return {
    id: row.id,
    status: row.status,
    paymentMethod: row.payment_method,
    customerName: row.customer_name,
    phoneE164: row.phone_e164,
    currency: row.currency,
    totalVnd: row.total_vnd.toString(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWebhook(row: OutboundWebhookRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function throwInvalidApiKey(): never {
  throw new UnauthorizedException({
    code: 'invalid_public_api_key',
    message: 'Public API key is invalid or revoked',
  });
}

function throwApiKeyNotFound(): never {
  throw new NotFoundException({
    code: 'api_key_not_found',
    message: 'API key was not found',
  });
}

function throwWebhookNotFound(): never {
  throw new NotFoundException({
    code: 'outbound_webhook_not_found',
    message: 'Outbound webhook was not found',
  });
}

function throwPublicApiError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: 'public_api_failed',
    message: error.message ?? message,
  });
}

function createSupabaseServiceClient(env: PublicApiEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

async function defaultWebhookSender(input: {
  body: string;
  headers: Record<string, string>;
  url: string;
}) {
  const response = await fetch(input.url, {
    body: input.body,
    headers: input.headers,
    method: 'POST',
  });
  return { ok: response.ok, status: response.status };
}
