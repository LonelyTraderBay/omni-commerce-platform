import { describe, expect, it } from 'vitest';

import { AdSpendService, type SupabaseLike } from './ad-spend.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_ID = '99999999-9999-9999-9999-999999999999';
const CREATED_AT = '2026-07-27T12:00:00.000Z';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function createClient(seed: Partial<Tables> = {}) {
  const tables: Tables = {
    ad_spend: [...(seed.ad_spend ?? [])],
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

describe('AdSpendService', () => {
  it('imports pasted CSV rows with date,campaign,amount_vnd headers', async () => {
    const db = createClient();
    const service = new AdSpendService(db.client);

    const result = await service.importRows(ORG_ID, {
      source: 'csv',
      csv: 'date,campaign,amount_vnd\n2026-07-27,"Meta, prospecting",150000',
    });

    expect(result.importedCount).toBe(1);
    expect(result.adSpend[0]).toMatchObject({
      orgId: ORG_ID,
      source: 'csv',
      date: '2026-07-27',
      campaignName: 'Meta, prospecting',
      amountVnd: '150000',
    });
    expect(db.tables.ad_spend[0]).toMatchObject({
      org_id: ORG_ID,
      amount_vnd: '150000',
    });
  });

  it('imports JSON rows and lists only current-org rows in range', async () => {
    const db = createClient({
      ad_spend: [
        row({ org_id: OTHER_ORG_ID, campaign_name: 'Other org' }),
        row({ date: '2026-07-20', campaign_name: 'Outside range' }),
      ],
    });
    const service = new AdSpendService(db.client);

    await service.importRows(ORG_ID, {
      source: 'csv',
      rows: [
        {
          source: 'meta_ads',
          date: '2026-07-27',
          campaignName: 'Meta retargeting',
          amountVnd: '90000',
          externalId: 'meta-1',
        },
      ],
    });

    const result = await service.list(ORG_ID, {
      from: '2026-07-27',
      to: '2026-07-27',
      limit: 50,
    });

    expect(result.adSpend).toEqual([
      expect.objectContaining({
        source: 'meta_ads',
        campaignName: 'Meta retargeting',
        amountVnd: '90000',
        externalId: 'meta-1',
      }),
    ]);
  });

  it('summarizes ad spend by day using bigint strings', async () => {
    const db = createClient({
      ad_spend: [
        row({ date: '2026-07-27', amount_vnd: '100000' }),
        row({ date: '2026-07-27', amount_vnd: '50000' }),
        row({ date: '2026-07-28', amount_vnd: '25000' }),
      ],
    });
    const service = new AdSpendService(db.client);

    await expect(
      service.summary(ORG_ID, { from: '2026-07-27', to: '2026-07-28' }),
    ).resolves.toEqual({
      totalVnd: '175000',
      days: [
        { day: '2026-07-27', amountVnd: '150000' },
        { day: '2026-07-28', amountVnd: '25000' },
      ],
    });
  });
});

function row(overrides: Row = {}) {
  return {
    id: `ad-${Math.random()}`,
    org_id: ORG_ID,
    source: 'csv',
    date: '2026-07-27',
    campaign_name: 'Meta campaign',
    amount_vnd: '100000',
    external_id: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

class Query {
  private filters: Array<{
    column: string;
    value: unknown;
    op: 'eq' | 'gte' | 'lte';
  }> = [];
  private insertValues: Row[] | null = null;
  private limitCount: number | null = null;
  private orderBy: Array<{ column: string; ascending: boolean }> = [];

  constructor(
    private readonly tables: Tables,
    private readonly table: string,
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value, op: 'eq' });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ column, value, op: 'gte' });
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push({ column, value, op: 'lte' });
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

  then(resolve: (value: { data?: Row[]; error: null }) => void) {
    if (this.insertValues) {
      const inserted = this.insertValues.map((value) => ({
        id: `ad-${this.tables[this.table].length + 1}`,
        created_at: CREATED_AT,
        ...value,
      }));
      this.tables[this.table].push(...inserted);
      resolve({ data: inserted, error: null });
      return;
    }

    resolve({ data: this.applyFilters(), error: null });
  }

  private applyFilters() {
    let rows = this.tables[this.table].filter((row) =>
      this.filters.every((filter) => {
        const value = row[filter.column];
        if (filter.op === 'gte') {
          return String(value) >= String(filter.value);
        }
        if (filter.op === 'lte') {
          return String(value) <= String(filter.value);
        }
        return value === filter.value;
      }),
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
