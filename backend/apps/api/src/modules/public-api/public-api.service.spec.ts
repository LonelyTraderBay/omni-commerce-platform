import { describe, expect, it, vi } from 'vitest';

import {
  hashApiKey,
  PublicApiService,
  signWebhookPayload,
  type PublicApiEnv,
  type SupabaseLike,
} from './public-api.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_ID = '99999999-9999-9999-9999-999999999999';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const KEY_ID = '22222222-2222-2222-2222-222222222222';
const WEBHOOK_ID = '33333333-3333-3333-3333-333333333333';
const CREATED_AT = '2026-07-27T12:00:00.000Z';
const ENV: PublicApiEnv = {
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  SUPABASE_URL: 'https://supabase.example.test',
  TOKEN_ENCRYPTION_KEY: 'x'.repeat(32),
};

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

describe('PublicApiService', () => {
  it('creates hash-only API keys and authenticates returned omni_ token', async () => {
    const db = createClient();
    const service = createService(db.client);

    const result = await service.createKey({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { name: 'ERP read', scopes: ['orders.read'] },
    });

    expect(result.key).toMatch(/^omni_/);
    expect(result.apiKey).toMatchObject({
      orgId: ORG_ID,
      keyPrefix: result.key.slice(0, 13),
      scopes: ['orders.read'],
    });
    expect(db.tables.api_keys[0]).toMatchObject({
      key_hash: hashApiKey(result.key),
      key_prefix: result.key.slice(0, 13),
    });
    expect(db.tables.api_keys[0].key_hash).not.toContain(result.key);

    await expect(
      service.authenticateKey(result.key, 'orders.read'),
    ).resolves.toMatchObject({
      orgId: ORG_ID,
      scopes: ['orders.read'],
    });
  });

  it('rejects revoked keys and lists public orders within key org only', async () => {
    const key = 'omni_test_key_123456789';
    const db = createClient({
      api_keys: [
        apiKeyRow({ id: KEY_ID, key_hash: hashApiKey(key), revoked_at: null }),
      ],
      orders: [
        orderRow({ id: 'order-a', status: 'confirmed' }),
        orderRow({ id: 'order-b', status: 'draft' }),
        orderRow({ id: 'order-other', org_id: OTHER_ORG_ID, status: 'confirmed' }),
      ],
    });
    const service = createService(db.client);

    const auth = await service.authenticateKey(key, 'orders.read');
    await expect(
      service.listPublicOrders(auth.orgId, {
        status: 'confirmed',
        limit: 100,
      }),
    ).resolves.toEqual({
      orders: [
        expect.objectContaining({
          id: 'order-a',
          status: 'confirmed',
          totalVnd: '150000',
        }),
      ],
    });

    await service.revokeKey({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      keyId: KEY_ID,
    });
    await expect(service.authenticateKey(key, 'orders.read')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'invalid_public_api_key' }),
      status: 401,
    });
  });

  it('sends signed webhook test pings without exposing stored secret', async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const db = createClient();
    const service = createService(db.client, sender);

    const created = await service.createWebhook({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {
        url: 'https://erp.example.test/webhooks/omni',
        events: ['order.created', 'webhook.test'],
        secret: 'super-secret-webhook',
        enabled: true,
      },
    });

    expect(created.secret).toBe('super-secret-webhook');
    expect(db.tables.outbound_webhooks[0].secret_enc).not.toBe(
      'super-secret-webhook',
    );

    await expect(
      service.testWebhook({
        orgId: ORG_ID,
        actorUserId: USER_ID,
        webhookId: created.webhook.id,
      }),
    ).resolves.toMatchObject({
      delivered: true,
      status: 204,
      signatureHeader: expect.stringMatching(/^sha256=/),
    });

    const call = sender.mock.calls[0]?.[0];
    expect(call.url).toBe('https://erp.example.test/webhooks/omni');
    expect(call.headers['X-Omni-Event']).toBe('webhook.test');
    expect(call.headers['X-Omni-Signature']).toBe(
      signWebhookPayload(
        'super-secret-webhook',
        call.headers['X-Omni-Timestamp'],
        call.body,
      ),
    );
  });
});

function createService(client: SupabaseLike, sender = vi.fn()) {
  return new PublicApiService(client, { writeAudit: vi.fn() }, ENV, sender);
}

function createClient(seed: Partial<Tables> = {}) {
  const tables: Tables = {
    api_keys: [...(seed.api_keys ?? [])],
    orders: [...(seed.orders ?? [])],
    outbound_webhooks: [...(seed.outbound_webhooks ?? [])],
  };

  return {
    tables,
    client: {
      from(table: string) {
        if (!tables[table]) {
          tables[table] = [];
        }
        return new Query(tables, table);
      },
    } as unknown as SupabaseLike,
  };
}

function apiKeyRow(overrides: Row = {}) {
  return {
    id: `key-${Math.random()}`,
    org_id: ORG_ID,
    name: 'ERP key',
    key_prefix: 'omni_test_ke',
    key_hash: hashApiKey('omni_test_key_123456789'),
    scopes: ['orders.read'],
    revoked_at: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function orderRow(overrides: Row = {}) {
  return {
    id: `order-${Math.random()}`,
    org_id: ORG_ID,
    status: 'confirmed',
    payment_method: 'cod',
    customer_name: 'Nguyen Van A',
    phone_e164: '+84901234567',
    currency: 'VND',
    total_vnd: '150000',
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

class Query {
  private filters: Array<{ column: string; value: unknown }> = [];
  private insertValues: Row[] | null = null;
  private updateValues: Row | null = null;
  private limitCount: number | null = null;
  private maybeSingleRequested = false;
  private singleRequested = false;
  private orderBy: Array<{ column: string; ascending: boolean }> = [];

  constructor(
    private readonly tables: Tables,
    private readonly table: string,
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orderBy.push({ column, ascending: options.ascending ?? true });
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  insert(values: Row | Row[]) {
    this.insertValues = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values: Row) {
    this.updateValues = values;
    return this;
  }

  single() {
    this.singleRequested = true;
    return this;
  }

  maybeSingle() {
    this.maybeSingleRequested = true;
    return this;
  }

  then(resolve: (value: { data?: Row | Row[] | null; error: null }) => void) {
    const data = this.execute();
    if (this.singleRequested || this.maybeSingleRequested) {
      resolve({ data: data[0] ?? null, error: null });
      return;
    }
    resolve({ data, error: null });
  }

  private execute() {
    if (this.insertValues) {
      const inserted = this.insertValues.map((value) => ({
        id:
          this.table === 'outbound_webhooks'
            ? WEBHOOK_ID
            : `row-${this.tables[this.table].length + 1}`,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        ...value,
      }));
      this.tables[this.table].push(...inserted);
      return inserted;
    }

    const rows = this.applyFilters();
    if (this.updateValues) {
      for (const row of rows) {
        Object.assign(row, this.updateValues);
      }
      return rows;
    }

    return rows;
  }

  private applyFilters() {
    let rows = this.tables[this.table].filter((row) =>
      this.filters.every((filter) => row[filter.column] === filter.value),
    );

    for (const order of this.orderBy.slice().reverse()) {
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[order.column]).localeCompare(
          String(right[order.column]),
        );
        return order.ascending ? comparison : -comparison;
      });
    }

    if (this.limitCount !== null) {
      rows = rows.slice(0, this.limitCount);
    }
    return rows;
  }
}
