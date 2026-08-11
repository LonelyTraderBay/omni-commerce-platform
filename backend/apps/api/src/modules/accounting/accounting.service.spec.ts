import { describe, expect, it } from 'vitest';

import { neutralizeSpreadsheetFormula } from '../../common/csv/csv-formula-guard';
import { AccountingService, type SupabaseLike } from './accounting.service';
import type { AccountingExportQuery } from './dto';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const QUERY = { format: 'csv' } as AccountingExportQuery;

/**
 * PostgREST caps every response at `db-max-rows` (1000 by default) no matter
 * what the client asks for. Modelling that here is the whole point: a fake that
 * happily returns 10,000 rows cannot see the bug where a `.limit(10_000)` was
 * never actually the binding constraint.
 */
const DB_MAX_ROWS = 1_000;

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

class Query {
  private eqFilters: Array<{ column: string; value: unknown }> = [];
  private inFilters: Array<{ column: string; values: readonly unknown[] }> = [];
  private rangeFilters: Array<{
    column: string;
    value: unknown;
    op: 'gte' | 'lte';
  }> = [];
  private limitCount: number | null = null;
  private sort: { column: string; ascending: boolean } | null = null;
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

  in(column: string, values: readonly unknown[]) {
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

  order(column: string, options: { ascending?: boolean } = {}) {
    this.sort = { column, ascending: options.ascending ?? true };
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
    let rows = (this.tables[this.table] ?? []).filter(
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

    if (this.sort) {
      const { column, ascending } = this.sort;
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[column]).localeCompare(
          String(right[column]),
        );
        return ascending ? comparison : -comparison;
      });
    }
    if (this.limitCount !== null) {
      rows = rows.slice(0, this.limitCount);
    }
    if (this.offsets) {
      rows = rows.slice(this.offsets.from, this.offsets.to + 1);
    }

    resolve({ data: rows.slice(0, DB_MAX_ROWS), error: null });
  }
}

function createClient(seed: Partial<Tables>): SupabaseLike {
  const tables: Tables = {
    orders: [...(seed.orders ?? [])],
    shipments: [...(seed.shipments ?? [])],
    cod_collections: [...(seed.cod_collections ?? [])],
    ad_spend: [...(seed.ad_spend ?? [])],
  };

  return {
    from(table: string) {
      return new Query(tables, table);
    },
  } as unknown as SupabaseLike;
}

async function exportCsv(seed: Partial<Tables>) {
  const service = new AccountingService(createClient(seed));
  const file = await service.export(ORG_ID, QUERY);
  return file.buffer.toString('utf8');
}

function adSpend(overrides: Row = {}): Row {
  return {
    id: 'ad-1',
    org_id: ORG_ID,
    date: '2026-07-01',
    campaign_name: 'Tết Sale',
    amount_vnd: '500000',
    ...overrides,
  };
}

function codCollection(overrides: Row = {}): Row {
  return {
    id: 'cod-1',
    org_id: ORG_ID,
    order_id: 'order-1',
    amount_vnd: '250000',
    collected_at: '2026-07-02T08:00:00.000Z',
    ...overrides,
  };
}

/** `2020-01-01` plus `days`, as a date-only string. */
function dayString(days: number) {
  return new Date(Date.UTC(2020, 0, 1 + days)).toISOString().slice(0, 10);
}

function countLines(csv: string, accountHint: string) {
  return csv
    .split('\n')
    .filter((line) => line.includes(`,"${accountHint}",`)).length;
}

describe('AccountingService CSV export', () => {
  it('leaves the header row untouched', async () => {
    const csv = await exportCsv({ ad_spend: [adSpend()] });

    expect(csv.split('\n')[0]).toBe('"date","account_hint","amount_vnd","ref"');
  });

  it('neutralizes a formula-leading cell with an apostrophe inside the quotes', async () => {
    // A hostile value reaching a leading cell position is neutralized even
    // though quoting alone would not stop a spreadsheet from evaluating it.
    const csv = await exportCsv({ ad_spend: [adSpend({ date: '=1+1' })] });

    expect(csv.split('\n')[1]).toContain(`"'=1+1"`);
  });

  it('leaves a positive amount and ordinary text alone', async () => {
    const csv = await exportCsv({ cod_collections: [codCollection()] });

    expect(csv.split('\n')[1]).toBe(
      '"2026-07-02","cod_cash","250000","cod:cod-1:order:order-1"',
    );
  });

  it('still doubles an embedded quote', async () => {
    const csv = await exportCsv({
      cod_collections: [codCollection({ order_id: 'a"b' })],
    });

    expect(csv.split('\n')[1]).toContain('"cod:cod-1:order:a""b"');
  });

  it('does not prefix a campaign name embedded mid-cell', async () => {
    // `ref` always starts with an `ad_spend:` literal, so a hostile campaign
    // name never occupies the leading position a spreadsheet parses as a formula.
    const csv = await exportCsv({
      ad_spend: [adSpend({ campaign_name: "=cmd|'/c calc'!A0" })],
    });

    expect(csv.split('\n')[1]).toContain(`"ad_spend:ad-1:=cmd|'/c calc'!A0"`);
  });

  it('leaves legitimately negative amounts as numbers, so SUM() still works', async () => {
    // cogs, shipping fees and ad spend are legitimately negative VND. A pure
    // integer literal cannot be a formula (a formula needs an operator, function
    // or cell reference), so the guard exempts `^-?\d+$` — the cell stays a
    // number and the shop owner's SUM() over the ledger keeps working.
    const csv = await exportCsv({ ad_spend: [adSpend()] });

    expect(csv.split('\n')[1]).toBe(
      `"2026-07-01","ad_spend","-500000","ad_spend:ad-1:Tết Sale"`,
    );
  });

  it('still neutralizes a formula that merely starts with a minus sign', async () => {
    // The numeric carve-out must not become an injection hole: `-1+1` is a real
    // formula (Excel evaluates it to 0) and does not match `^-?\d+$`.
    expect(neutralizeSpreadsheetFormula('-1+1')).toBe("'-1+1");
    expect(neutralizeSpreadsheetFormula('-500000')).toBe('-500000');
  });
});

describe('AccountingService range completeness', () => {
  const ROW_COUNT = 1_500; // > DB_MAX_ROWS, so a single unpaged fetch cannot see it all

  function wideRangeSeed(): Partial<Tables> {
    return {
      shipments: Array.from({ length: ROW_COUNT }, (_, index) => ({
        id: `ship-${String(index).padStart(4, '0')}`,
        org_id: ORG_ID,
        order_id: `order-${index}`,
        fee_vnd: '1000',
        created_at: `${dayString(index)}T08:00:00.000Z`,
      })),
      cod_collections: Array.from({ length: ROW_COUNT }, (_, index) => ({
        id: `cod-${String(index).padStart(4, '0')}`,
        org_id: ORG_ID,
        order_id: `order-${index}`,
        amount_vnd: '2000',
        collected_at: `${dayString(index)}T09:00:00.000Z`,
      })),
      ad_spend: Array.from({ length: ROW_COUNT }, (_, index) => ({
        id: `ad-${String(index).padStart(4, '0')}`,
        org_id: ORG_ID,
        date: dayString(index),
        campaign_name: 'Chiến dịch',
        amount_vnd: '3000',
      })),
    };
  }

  it('keeps the OLDEST row in a range that exceeds one page, for every ledger leg', async () => {
    // The shipments / COD / ad-spend loaders used to order DESCENDING under a
    // cap, so the rows that vanished when a range overflowed were the oldest
    // ones in the window — and nothing in the export said so. This asserts the
    // direction bug specifically: it is the *first* row of each range, not the
    // last, that used to disappear.
    const csv = await exportCsv(wideRangeSeed());

    expect(csv).toContain('"shipment:ship-0000:order:order-0"');
    expect(csv).toContain('"cod:cod-0000:order:order-0"');
    expect(csv).toContain('"ad_spend:ad-0000:Chiến dịch"');
  });

  it('exports every row of every leg, not just the newest page', async () => {
    const csv = await exportCsv(wideRangeSeed());

    expect(countLines(csv, 'shipping_fee')).toBe(ROW_COUNT);
    expect(countLines(csv, 'cod_cash')).toBe(ROW_COUNT);
    expect(countLines(csv, 'ad_spend')).toBe(ROW_COUNT);
    // Newest rows were never the ones at risk, but they must survive the switch
    // to ascending paging too.
    expect(csv).toContain(`"shipment:ship-1499:order:order-1499"`);
    expect(csv).toContain(`"cod:cod-1499:order:order-1499"`);
  });
});
