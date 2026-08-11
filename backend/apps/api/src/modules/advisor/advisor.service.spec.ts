import { describe, expect, it, vi } from 'vitest';

import { AdvisorService, type SupabaseLike } from './advisor.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function createSupabase(seed: Partial<Tables> = {}) {
  const tables: Tables = {
    products: [...(seed.products ?? [])],
    product_variants: [...(seed.product_variants ?? [])],
    orders: [...(seed.orders ?? [])],
  };

  return {
    from(table: string) {
      if (!tables[table]) {
        tables[table] = [];
      }
      return new Query(tables, table);
    },
  } as unknown as SupabaseLike;
}

function createService(
  input: {
    killAiAll?: boolean;
    aiStatus?: number;
    aiBody?: Record<string, unknown>;
    supabase?: SupabaseLike;
  } = {},
) {
  const featureFlags = {
    isEnabled: vi.fn(
      async (key: string) => key === 'kill_ai_all' && input.killAiAll,
    ),
  };
  const aiRuns = {
    writeRun: vi.fn(async (run: Record<string, unknown>) => ({
      aiRun: {
        id: 'run-1',
        ...run,
        createdAt: '2026-07-27T12:00:00.000Z',
      },
    })),
  };
  const fetchFn = vi.fn(async () => ({
    ok: (input.aiStatus ?? 200) >= 200 && (input.aiStatus ?? 200) < 300,
    status: input.aiStatus ?? 200,
    json: async () =>
      input.aiBody ?? {
        suggestionsText: 'Gợi ý bán hàng stub',
        disclaimer: 'Advisor chỉ tư vấn; không auto-post.',
        promptVersion: 'advisor.v1',
        model: 'advisor-stub',
        tokens: { input: 0, output: 0, total: 0 },
        toolsUsed: [{ kind: 'advisor', mode: 'stub' }],
        citations: [{ source: 'sales_aggregates' }],
      },
    text: async () => 'AI failed',
  }));

  return {
    service: new AdvisorService(
      featureFlags as never,
      aiRuns as never,
      fetchFn as never,
      {
        AI_BASE_URL: 'http://ai.local',
        SERVICE_M2M_KEY: 'service-key',
      },
      input.supabase ?? createSupabase(),
    ),
    featureFlags,
    aiRuns,
    fetchFn,
  };
}

describe('AdvisorService', () => {
  it('calls AI advisor with real local catalog/sales aggregates and writes ai_runs', async () => {
    const now = Date.now();
    const { service, fetchFn, aiRuns } = createService({
      supabase: createSupabase({
        products: [
          {
            id: 'p1',
            org_id: ORG_ID,
            status: 'active',
            deleted_at: null,
          },
          {
            id: 'p2',
            org_id: ORG_ID,
            status: 'archived',
            deleted_at: null,
          },
        ],
        product_variants: [
          {
            id: 'v1',
            org_id: ORG_ID,
            sku: 'SKU-LOW',
            title: 'Low stock',
            price_vnd: '100000',
            stock_qty: 2,
            cogs_vnd: '40000',
          },
          {
            id: 'v2',
            org_id: ORG_ID,
            sku: 'SKU-OK',
            title: 'In stock',
            price_vnd: '200000',
            stock_qty: 20,
            cogs_vnd: '80000',
          },
        ],
        orders: [
          {
            id: 'o1',
            org_id: ORG_ID,
            status: 'shipped',
            total_vnd: '150000',
            created_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
            shipped_at: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
            done_at: null,
            items: [
              {
                sku_snapshot: 'SKU-LOW',
                qty: 1,
                line_total_vnd: '100000',
                cogs_unit_vnd: '40000',
              },
              {
                sku_snapshot: 'SKU-OK',
                qty: 1,
                line_total_vnd: '50000',
                cogs_unit_vnd: '20000',
              },
            ],
          },
          {
            id: 'o2',
            org_id: ORG_ID,
            status: 'draft',
            total_vnd: '999999',
            created_at: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
            shipped_at: null,
            done_at: null,
            items: [],
          },
        ],
      }),
    });

    const result = await service.suggest({
      orgId: ORG_ID,
      body: { goal: 'Tăng doanh thu cuối tuần' },
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'http://ai.local/internal/v1/ai/advise',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-service-key': 'service-key',
        }),
      }),
    );

    const requestBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      orgId: ORG_ID,
      goal: 'Tăng doanh thu cuối tuần',
      catalogAggregates: {
        empty: false,
        productCount: 2,
        activeProductCount: 1,
        variantCount: 2,
        totalStockQty: 22,
        lowStockCount: 1,
      },
      salesAggregates: {
        empty: false,
        windowDays: 7,
        orderCount: 2,
        soldOrderCount: 1,
        revenueVnd: '150000',
        cogsVnd: '60000',
        grossProfitVnd: '90000',
        byStatus: { shipped: 1, draft: 1 },
      },
    });
    expect(requestBody.catalogAggregates.note).not.toMatch(/stub/i);
    expect(requestBody.salesAggregates.note).not.toMatch(/stub/i);
    expect(requestBody.salesAggregates.note).toMatch(/không gồm Meta ads/i);
    expect(requestBody.salesAggregates).not.toHaveProperty('adSpendVnd');
    expect(requestBody.catalogAggregates.sampleLowStock).toEqual([
      {
        sku: 'SKU-LOW',
        title: 'Low stock',
        stockQty: 2,
        priceVnd: '100000',
      },
    ]);
    expect(requestBody.salesAggregates.topSkus).toEqual([
      { sku: 'SKU-LOW', qty: 1, revenueVnd: '100000' },
      { sku: 'SKU-OK', qty: 1, revenueVnd: '50000' },
    ]);

    expect(aiRuns.writeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        promptVersion: 'advisor.v1',
        model: 'advisor-stub',
        status: 'succeeded',
        tools: expect.arrayContaining([
          expect.objectContaining({ kind: 'advisor', adviseOnly: true }),
        ]),
      }),
    );
    expect(result).toMatchObject({
      suggestionsText: 'Gợi ý bán hàng stub',
      disclaimer: expect.stringContaining('không auto-post'),
      entitlement: { allowed: true },
    });
  });

  it('sends graceful empty-state aggregates when catalog and orders are empty', async () => {
    const { service, fetchFn } = createService({
      supabase: createSupabase(),
    });

    await service.suggest({ orgId: ORG_ID, body: {} });

    const requestBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(requestBody.catalogAggregates).toMatchObject({
      empty: true,
      productCount: 0,
      variantCount: 0,
      note: expect.stringMatching(/Chưa có sản phẩm/i),
    });
    expect(requestBody.salesAggregates).toMatchObject({
      empty: true,
      orderCount: 0,
      revenueVnd: '0',
      note: expect.stringMatching(/Chưa có đơn hàng/i),
    });
  });

  it('does not call AI when kill_ai_all is enabled', async () => {
    const { service, fetchFn, aiRuns } = createService({ killAiAll: true });

    await expect(
      service.suggest({ orgId: ORG_ID, body: {} }),
    ).rejects.toMatchObject({
      response: { code: 'advisor_disabled' },
      status: 503,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(aiRuns.writeRun).not.toHaveBeenCalled();
  });
});

class Query {
  private eqFilters: Array<{ column: string; value: unknown }> = [];
  private isFilters: Array<{ column: string; value: unknown }> = [];
  private rangeFilters: Array<{
    column: string;
    value: unknown;
    op: 'gte' | 'lte';
  }> = [];
  private limitCount: number | null = null;

  constructor(
    private readonly tables: Tables,
    private readonly table: string,
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.eqFilters.push({ column, value });
    return this;
  }

  is(column: string, value: unknown) {
    this.isFilters.push({ column, value });
    return this;
  }

  gte(column: string, value: unknown) {
    this.rangeFilters.push({ column, value, op: 'gte' });
    return this;
  }

  lte(column: string, value: unknown) {
    this.rangeFilters.push({ column, value, op: 'lte' });
    return this;
  }

  order() {
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  then(
    resolve: (value: {
      data: Row[] | null;
      error: { code?: string; message?: string } | null;
    }) => void,
  ) {
    let rows = this.tables[this.table].filter(
      (row) =>
        this.eqFilters.every((filter) => row[filter.column] === filter.value) &&
        this.isFilters.every((filter) => row[filter.column] === filter.value) &&
        this.rangeFilters.every((filter) =>
          filter.op === 'gte'
            ? String(row[filter.column]) >= String(filter.value)
            : String(row[filter.column]) <= String(filter.value),
        ),
    );
    if (this.limitCount !== null) {
      rows = rows.slice(0, this.limitCount);
    }
    resolve({ data: rows, error: null });
  }
}
