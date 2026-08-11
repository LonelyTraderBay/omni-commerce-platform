import { describe, expect, it } from 'vitest';

import { PnlService, type SupabaseLike } from './pnl.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function order(overrides: Row = {}) {
  const row = {
    id: 'order-1',
    org_id: ORG_ID,
    status: 'shipped',
    total_vnd: '150000',
    shipping_fee_vnd: '0',
    shipped_at: '2026-07-27T10:00:00.000Z',
    done_at: null,
    created_at: '2026-07-26T10:00:00.000Z',
    items: [
      {
        sku_snapshot: 'SKU-A',
        qty: 2,
        line_total_vnd: '100000',
        cogs_unit_vnd: '30000',
      },
      {
        sku_snapshot: 'SKU-B',
        qty: 1,
        line_total_vnd: '50000',
        cogs_unit_vnd: '20000',
      },
    ],
    ...overrides,
  };

  // Mirrors the `orders.sold_at` generated column so the fake honours the same
  // SQL predicate the service now pushes down.
  return {
    ...row,
    sold_at: row.done_at ?? row.shipped_at ?? row.created_at,
  };
}

function createClient(seed: Row[] | Partial<Tables>) {
  const tables: Tables = Array.isArray(seed)
    ? { orders: seed, ad_spend: [] }
    : {
        orders: [...(seed.orders ?? [])],
        ad_spend: [...(seed.ad_spend ?? [])],
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

describe('PnlService', () => {
  it('aggregates sold order revenue, COGS, and gross profit by day', async () => {
    const service = new PnlService(
      createClient({
        orders: [
          order({ shipping_fee_vnd: '25000' }),
          order({
            id: 'order-2',
            status: 'done',
            total_vnd: '120000',
            shipping_fee_vnd: '15000',
            shipped_at: '2026-07-27T12:00:00.000Z',
            done_at: '2026-07-28T09:00:00.000Z',
            items: [
              {
                sku_snapshot: 'SKU-A',
                qty: 1,
                line_total_vnd: '120000',
                cogs_unit_vnd: '40000',
              },
            ],
          }),
          order({
            id: 'returned-order',
            status: 'returned',
            total_vnd: '999999',
          }),
          order({
            id: 'outside-range',
            total_vnd: '999999',
            shipped_at: '2026-07-20T10:00:00.000Z',
          }),
        ],
        ad_spend: [
          {
            org_id: ORG_ID,
            date: '2026-07-27',
            amount_vnd: '20000',
          },
          {
            org_id: ORG_ID,
            date: '2026-07-28',
            amount_vnd: '10000',
          },
        ],
      }),
    );

    const result = await service.getSummary(ORG_ID, {
      from: '2026-07-27',
      to: '2026-07-28',
    });

    // net = gross − shipping − ads, per design spec §2E.
    expect(result).toEqual({
      revenueVnd: '270000',
      cogsVnd: '120000',
      grossProfitVnd: '150000',
      shippingVnd: '40000',
      adSpendVnd: '30000',
      netProfitVnd: '80000',
      orderCount: 2,
      days: [
        {
          day: '2026-07-27',
          revenueVnd: '150000',
          cogsVnd: '80000',
          grossProfitVnd: '70000',
          shippingVnd: '25000',
          adSpendVnd: '20000',
          netProfitVnd: '25000',
          orderCount: 1,
        },
        {
          day: '2026-07-28',
          revenueVnd: '120000',
          cogsVnd: '40000',
          grossProfitVnd: '80000',
          shippingVnd: '15000',
          adSpendVnd: '10000',
          netProfitVnd: '55000',
          orderCount: 1,
        },
      ],
    });
  });

  it('aggregates P&L by SKU using line revenue and item COGS snapshots', async () => {
    const service = new PnlService(
      createClient([
        order(),
        order({
          id: 'order-2',
          status: 'done',
          total_vnd: '120000',
          done_at: '2026-07-28T09:00:00.000Z',
          items: [
            {
              sku_snapshot: 'SKU-A',
              qty: 1,
              line_total_vnd: '120000',
              cogs_unit_vnd: '40000',
            },
          ],
        }),
      ]),
    );

    const result = await service.getBySku(ORG_ID, {
      from: '2026-07-27',
      to: '2026-07-28',
    });

    expect(result).toEqual({
      items: [
        {
          sku: 'SKU-A',
          qty: 3,
          revenueVnd: '220000',
          cogsVnd: '100000',
          grossProfitVnd: '120000',
          orderCount: 2,
        },
        {
          sku: 'SKU-B',
          qty: 1,
          revenueVnd: '50000',
          cogsVnd: '20000',
          grossProfitVnd: '30000',
          orderCount: 1,
        },
      ],
    });
  });

  it('includes ad-only days in summary as expense lines', async () => {
    const service = new PnlService(
      createClient({
        orders: [],
        ad_spend: [
          {
            org_id: ORG_ID,
            date: '2026-07-27',
            amount_vnd: '50000',
          },
        ],
      }),
    );

    await expect(
      service.getSummary(ORG_ID, { from: '2026-07-27', to: '2026-07-27' }),
    ).resolves.toEqual({
      revenueVnd: '0',
      cogsVnd: '0',
      grossProfitVnd: '0',
      shippingVnd: '0',
      adSpendVnd: '50000',
      netProfitVnd: '-50000',
      orderCount: 0,
      days: [
        {
          day: '2026-07-27',
          revenueVnd: '0',
          cogsVnd: '0',
          grossProfitVnd: '0',
          shippingVnd: '0',
          adSpendVnd: '50000',
          netProfitVnd: '-50000',
          orderCount: 0,
        },
      ],
    });
  });

  it('subtracts shipping cost from net profit', async () => {
    const service = new PnlService(
      createClient([order({ total_vnd: '150000', shipping_fee_vnd: '30000' })]),
    );

    const result = await service.getSummary(ORG_ID, {
      from: '2026-07-27',
      to: '2026-07-27',
    });

    // revenue 150000 − COGS 80000 = gross 70000; minus 30000 shipping = 40000.
    // Before this fix netProfitVnd reported 70000 and silently overstated profit.
    expect(result.grossProfitVnd).toBe('70000');
    expect(result.shippingVnd).toBe('30000');
    expect(result.netProfitVnd).toBe('40000');
  });

  it('pages through every sold order in range instead of truncating at one batch', async () => {
    // 2500 orders => 3 pages of 1000. The previous implementation issued a single
    // unfiltered `.limit(10_000)` and filtered in Node, so any org past the cap
    // silently received a partial — not empty — financial report.
    const orders = Array.from({ length: 2_500 }, (_, index) =>
      order({
        id: `order-${index}`,
        total_vnd: '1000',
        shipping_fee_vnd: '0',
        items: [
          {
            sku_snapshot: 'SKU-A',
            qty: 1,
            line_total_vnd: '1000',
            cogs_unit_vnd: '400',
          },
        ],
      }),
    );

    const service = new PnlService(createClient(orders));
    const result = await service.getSummary(ORG_ID, {
      from: '2026-07-27',
      to: '2026-07-27',
    });

    expect(result.orderCount).toBe(2_500);
    expect(result.revenueVnd).toBe('2500000');
    expect(result.grossProfitVnd).toBe('1500000');
  });

  it('excludes orders whose sold_at falls outside the requested range', async () => {
    const service = new PnlService(
      createClient([
        order({ id: 'in-range', total_vnd: '100000' }),
        order({
          id: 'too-old',
          total_vnd: '999999',
          shipped_at: '2026-07-01T10:00:00.000Z',
          created_at: '2026-07-01T09:00:00.000Z',
        }),
      ]),
    );

    const result = await service.getSummary(ORG_ID, {
      from: '2026-07-27',
      to: '2026-07-27',
    });

    expect(result.orderCount).toBe(1);
    expect(result.revenueVnd).toBe('100000');
  });
});

class Query {
  private eqFilters: Array<{ column: string; value: unknown }> = [];
  private inFilters: Array<{ column: string; values: unknown[] }> = [];
  private rangeFilters: Array<{ column: string; value: unknown; op: 'gte' | 'lte' }> =
    [];
  private limitCount: number | null = null;
  private sortColumn: string | null = null;
  private offsets: { from: number; to: number } | null = null;

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

  in(column: string, values: unknown[]) {
    this.inFilters.push({ column, values });
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

  order(column?: string) {
    this.sortColumn = column ?? null;
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  /** PostgREST `.range()` is inclusive on both bounds. */
  range(from: number, to: number) {
    this.offsets = { from, to };
    return this;
  }

  then(resolve: (value: { data: Row[]; error: null }) => void) {
    let rows = this.tables[this.table].filter(
      (row) =>
        this.eqFilters.every((filter) => row[filter.column] === filter.value) &&
        this.inFilters.every((filter) =>
          filter.values.includes(row[filter.column]),
        ) &&
        this.rangeFilters.every((filter) =>
          filter.op === 'gte'
            ? String(row[filter.column]) >= String(filter.value)
            : String(row[filter.column]) <= String(filter.value),
        ),
    );
    if (this.sortColumn) {
      const column = this.sortColumn;
      rows = [...rows].sort((left, right) =>
        String(left[column]).localeCompare(String(right[column])),
      );
    }
    if (this.limitCount !== null) {
      rows = rows.slice(0, this.limitCount);
    }
    if (this.offsets) {
      rows = rows.slice(this.offsets.from, this.offsets.to + 1);
    }
    resolve({ data: rows, error: null });
  }
}
