import { describe, expect, it, vi } from 'vitest';

import { CodService, type SupabaseLike } from './cod.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '22222222-2222-2222-2222-222222222222';
const ORDER_ID_2 = '44444444-4444-4444-4444-444444444444';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const CREATED_AT = '2026-07-27T11:00:00.000Z';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Mutation = { table: string; op: 'insert' | 'update' | 'upsert' };

function auditMock() {
  return {
    writeAudit: vi.fn(async () => ({})),
  };
}

function expectation(overrides: Row = {}) {
  return {
    id: 'exp-1',
    org_id: ORG_ID,
    order_id: ORDER_ID,
    expected_vnd: '150000',
    status: 'open',
    created_at: CREATED_AT,
    ...overrides,
  };
}

function collection(overrides: Row = {}) {
  return {
    id: 'col-1',
    org_id: ORG_ID,
    order_id: ORDER_ID,
    amount_vnd: '150000',
    collected_at: CREATED_AT,
    source: 'manual',
    note: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function createClient(seed: Partial<Tables> = {}) {
  const tables: Tables = {
    cod_expectations: [...(seed.cod_expectations ?? [])],
    cod_collections: [...(seed.cod_collections ?? [])],
    cod_discrepancies: [...(seed.cod_discrepancies ?? [])],
    orders: [...(seed.orders ?? [])],
  };
  // Every insert/update/upsert the service issues, so a test can assert that a
  // rejected call wrote nothing at all rather than only checking the end state.
  const mutations: Mutation[] = [];

  return {
    tables,
    mutations,
    client: {
      from(table: string) {
        if (!tables[table]) {
          tables[table] = [];
        }
        return new Query(tables, table, mutations);
      },
      rpc(fn: string, args: Record<string, unknown>) {
        if (fn !== 'cod_report_summary') {
          throw new Error(`Unexpected rpc call: ${fn}`);
        }
        return Promise.resolve({
          data: [codReportSummary(tables, args.p_org_id)],
          error: null,
        });
      },
    } as unknown as SupabaseLike,
  };
}

/**
 * In-memory twin of `public.cod_report_summary` (20260729030000). It aggregates
 * over the *whole* table on purpose: the point of the RPC is that the report's
 * totals no longer inherit the 100-row cap of the list beneath them. The SQL
 * itself is pinned separately in cod-report-summary.integration.spec.ts.
 */
function codReportSummary(tables: Tables, orgId: unknown) {
  const openOrDiscrepancy = tables.cod_expectations.filter(
    (row) =>
      row.org_id === orgId &&
      (row.status === 'open' || row.status === 'discrepancy'),
  );
  const orderIds = new Set(openOrDiscrepancy.map((row) => row.order_id));
  const sum = (rows: Row[], column: string) =>
    rows
      .reduce((total, row) => total + BigInt(String(row[column])), 0n)
      .toString();

  return {
    open_count: tables.cod_expectations.filter(
      (row) => row.org_id === orgId && row.status === 'open',
    ).length,
    discrepancy_count: tables.cod_discrepancies.filter(
      (row) => row.org_id === orgId && row.status === 'open',
    ).length,
    expectation_count: openOrDiscrepancy.length,
    expected_vnd: sum(openOrDiscrepancy, 'expected_vnd'),
    collected_vnd: sum(
      tables.cod_collections.filter(
        (row) => row.org_id === orgId && orderIds.has(row.order_id),
      ),
      'amount_vnd',
    ),
  };
}

describe('CodService', () => {
  it('upserts an expectation for shipped COD orders using total_vnd', async () => {
    const db = createClient();
    const audit = auditMock();
    const service = new CodService(db.client, audit);

    const result = await service.ensureExpectationForOrder({
      orgId: ORG_ID,
      orderId: ORDER_ID,
      actorUserId: USER_ID,
      order: {
        status: 'shipped',
        paymentMethod: 'cod',
        totalVnd: '150000',
      },
    });

    expect(result?.expectation).toMatchObject({
      orderId: ORDER_ID,
      expectedVnd: '150000',
      status: 'open',
    });
    expect(db.tables.cod_expectations[0]).toMatchObject({
      org_id: ORG_ID,
      order_id: ORDER_ID,
      expected_vnd: '150000',
    });
    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cod.expectation_upserted',
        meta: expect.objectContaining({ expectedVnd: '150000' }),
      }),
    );
  });

  it('records a collection and marks an order matched when sums equal expectation', async () => {
    const db = createClient({ cod_expectations: [expectation()] });
    const audit = auditMock();
    const service = new CodService(db.client, audit);

    const collection = await service.recordCollection({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {
        orderId: ORDER_ID,
        amountVnd: '150000',
        source: 'manual',
      },
    });
    const reconciled = await service.reconcileOrder({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      orderId: ORDER_ID,
    });

    expect(collection.collection).toMatchObject({
      orderId: ORDER_ID,
      amountVnd: '150000',
      source: 'manual',
    });
    expect(reconciled.expectation).toMatchObject({
      orderId: ORDER_ID,
      status: 'matched',
    });
    expect(reconciled.discrepancy).toBeNull();
    expect(reconciled.summary).toEqual({
      expectedVnd: '150000',
      collectedVnd: '150000',
      deltaVnd: '0',
    });
  });

  it('opens a discrepancy when collected COD does not match expected COD', async () => {
    const db = createClient({
      cod_expectations: [expectation()],
      cod_collections: [
        {
          id: 'col-1',
          org_id: ORG_ID,
          order_id: ORDER_ID,
          amount_vnd: '90000',
          collected_at: CREATED_AT,
          source: 'manual',
          note: null,
          created_at: CREATED_AT,
        },
      ],
    });
    const service = new CodService(db.client, auditMock());

    const result = await service.reconcileOrder({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      orderId: ORDER_ID,
    });

    expect(result.expectation).toMatchObject({
      orderId: ORDER_ID,
      status: 'discrepancy',
    });
    expect(result.discrepancy).toMatchObject({
      orderId: ORDER_ID,
      expectedVnd: '150000',
      collectedVnd: '90000',
      deltaVnd: '-60000',
      status: 'open',
    });
    expect(db.tables.cod_discrepancies).toHaveLength(1);
  });

  it('refuses to reconcile a written-off expectation and writes nothing', async () => {
    const db = createClient({
      cod_expectations: [expectation({ status: 'written_off' })],
    });
    const audit = auditMock();
    const service = new CodService(db.client, audit);

    await expect(
      service.reconcileOrder({
        orgId: ORG_ID,
        actorUserId: USER_ID,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({
      response: { code: 'cod_expectation_written_off' },
      status: 400,
    });

    // The write-off decision survives untouched: no status flip back to
    // `discrepancy`, no freshly opened discrepancy, no audit trail.
    expect(db.mutations).toEqual([]);
    expect(db.tables.cod_expectations[0]).toMatchObject({
      status: 'written_off',
    });
    expect(db.tables.cod_discrepancies).toHaveLength(0);
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('still marks an open expectation matched when the delta is zero', async () => {
    const db = createClient({
      cod_expectations: [expectation()],
      cod_collections: [collection()],
    });
    const audit = auditMock();
    const service = new CodService(db.client, audit);

    const result = await service.reconcileOrder({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      orderId: ORDER_ID,
    });

    expect(result.expectation).toMatchObject({ status: 'matched' });
    expect(result.discrepancy).toBeNull();
    expect(db.tables.cod_expectations[0]).toMatchObject({ status: 'matched' });
    expect(db.tables.cod_discrepancies).toHaveLength(0);
    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cod.reconciled',
        meta: expect.objectContaining({ result: 'matched', deltaVnd: '0' }),
      }),
    );
  });

  it('still opens a discrepancy for an open expectation with a non-zero delta', async () => {
    const db = createClient({
      cod_expectations: [expectation()],
      cod_collections: [collection({ amount_vnd: '90000' })],
    });
    const audit = auditMock();
    const service = new CodService(db.client, audit);

    const result = await service.reconcileOrder({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      orderId: ORDER_ID,
    });

    expect(result.expectation).toMatchObject({ status: 'discrepancy' });
    expect(result.discrepancy).toMatchObject({
      orderId: ORDER_ID,
      deltaVnd: '-60000',
      status: 'open',
    });
    expect(db.tables.cod_expectations[0]).toMatchObject({
      status: 'discrepancy',
    });
    expect(db.tables.cod_discrepancies).toHaveLength(1);
    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cod.reconciled',
        meta: expect.objectContaining({ result: 'discrepancy' }),
      }),
    );
  });

  it('leaves a matched expectation re-reconcilable (only written_off is blocked)', async () => {
    // A stray duplicate collection re-opens a matched expectation. That is
    // intentional: re-reconciling after a genuine correction has to stay
    // possible, so `matched` is deliberately not blocked the way
    // `written_off` is.
    const db = createClient({
      cod_expectations: [expectation({ status: 'matched' })],
      cod_collections: [
        collection(),
        collection({ id: 'col-2', amount_vnd: '150000' }),
      ],
    });
    const service = new CodService(db.client, auditMock());

    const result = await service.reconcileOrder({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      orderId: ORDER_ID,
    });

    expect(result.expectation).toMatchObject({ status: 'discrepancy' });
    expect(result.summary).toEqual({
      expectedVnd: '150000',
      collectedVnd: '300000',
      deltaVnd: '150000',
    });
  });

  it('aborts a batch that explicitly names a written-off order id', async () => {
    const db = createClient({
      cod_expectations: [
        expectation(),
        expectation({
          id: 'exp-2',
          order_id: ORDER_ID_2,
          status: 'written_off',
        }),
      ],
      cod_collections: [collection()],
    });
    const service = new CodService(db.client, auditMock());

    // reconcileBatch has no per-order error channel: it awaits reconcileOrder
    // in a plain loop, so the first rejection propagates and aborts the run.
    // Pinning that contract as-is; earlier orders in the batch stay reconciled
    // because the loop is not transactional.
    await expect(
      service.reconcileBatch({
        orgId: ORG_ID,
        actorUserId: USER_ID,
        body: { orderIds: [ORDER_ID, ORDER_ID_2] },
      }),
    ).rejects.toMatchObject({
      response: { code: 'cod_expectation_written_off' },
      status: 400,
    });

    expect(db.tables.cod_expectations[0]).toMatchObject({ status: 'matched' });
    expect(db.tables.cod_expectations[1]).toMatchObject({
      status: 'written_off',
    });
  });

  it('skips written-off expectations when reconcileBatch picks the order ids itself', async () => {
    const db = createClient({
      cod_expectations: [
        expectation(),
        expectation({
          id: 'exp-2',
          order_id: ORDER_ID_2,
          status: 'written_off',
        }),
      ],
      cod_collections: [collection()],
    });
    const service = new CodService(db.client, auditMock());

    const result = await service.reconcileBatch({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {},
    });

    expect(result.reconciled).toBe(1);
    expect(result.results[0]?.expectation).toMatchObject({
      orderId: ORDER_ID,
      status: 'matched',
    });
    expect(db.tables.cod_expectations[1]).toMatchObject({
      status: 'written_off',
    });
    // Only one reconcilable id existed and it was reconciled: nothing left.
    expect(result.remaining).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('reports no remaining work when the caller names orderIds explicitly', async () => {
    // The `remaining`/`hasMore` fields describe the auto-selected pool, not
    // the caller's own list: an explicit `orderIds` batch either finishes or
    // aborts in this call, so there is nothing left to report.
    const db = createClient({ cod_expectations: [expectation()] });
    const service = new CodService(db.client, auditMock());

    const result = await service.reconcileBatch({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderIds: [ORDER_ID] },
    });

    expect(result.reconciled).toBe(1);
    expect(result.remaining).toBe(0);
    expect(result.hasMore).toBe(false);
  });
});

describe('CodService.reconcileBatch auto-selected paging', () => {
  /**
   * `count` open expectations, each paired with a collection that exactly
   * matches its expected amount so reconciling flips it to `matched` and
   * removes it from the reconcilable pool -- otherwise a zero-collection
   * order would flip to `discrepancy`, which is still reconcilable, and a
   * second `reconcileBatch` call would not cleanly pick up "the rest."
   */
  function reconcilableExpectations(count: number) {
    return {
      cod_expectations: Array.from({ length: count }, (_, index) =>
        expectation({
          id: `exp-auto-${index}`,
          order_id: `order-auto-${index}`,
          expected_vnd: '1000',
          created_at: `2026-01-${String(1 + Math.floor(index / 24)).padStart(
            2,
            '0',
          )}T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
        }),
      ),
      cod_collections: Array.from({ length: count }, (_, index) =>
        collection({
          id: `col-auto-${index}`,
          order_id: `order-auto-${index}`,
          amount_vnd: '1000',
        }),
      ),
    };
  }

  it('bounds the auto-selected batch at 100 and reports the remainder explicitly', async () => {
    // 150 reconcilable expectations against the 100-per-call reconcile cap.
    // `reconcileBatch` used to hand back `{ reconciled: 100, results: [...] }`
    // with nothing distinguishing that from "all done" -- a shop with more
    // than 100 open COD expectations had to guess it needed to press the
    // button again, and had no idea how many more presses it would take.
    const db = createClient(reconcilableExpectations(150));
    const service = new CodService(db.client, auditMock());

    const first = await service.reconcileBatch({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {},
    });

    expect(first.reconciled).toBe(100);
    expect(first.results).toHaveLength(100);
    expect(first.remaining).toBe(50);
    expect(first.hasMore).toBe(true);
    expect(
      db.tables.cod_expectations.filter((row) => row.status === 'matched'),
    ).toHaveLength(100);
  });

  it('finishes the pool on a second call once the first batch is done', async () => {
    // Proves the "call again" contract end-to-end: after the remainder from
    // the first call is itself reconciled, nothing is left.
    const db = createClient(reconcilableExpectations(150));
    const service = new CodService(db.client, auditMock());

    await service.reconcileBatch({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {},
    });
    const second = await service.reconcileBatch({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {},
    });

    expect(second.reconciled).toBe(50);
    expect(second.remaining).toBe(0);
    expect(second.hasMore).toBe(false);
    expect(
      db.tables.cod_expectations.every((row) => row.status === 'matched'),
    ).toBe(true);
  });

  it('does not report a remainder when the whole pool fits in one batch', async () => {
    const db = createClient(reconcilableExpectations(3));
    const service = new CodService(db.client, auditMock());

    const result = await service.reconcileBatch({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {},
    });

    expect(result.reconciled).toBe(3);
    expect(result.remaining).toBe(0);
    expect(result.hasMore).toBe(false);
  });
});

describe('CodService.getReport totals', () => {
  /** One `open` expectation per order, each with a matching part-collection. */
  function manyExpectations(count: number) {
    return {
      cod_expectations: Array.from({ length: count }, (_, index) =>
        expectation({
          id: `exp-${index}`,
          order_id: `order-${index}`,
          expected_vnd: '1000',
          created_at: `2026-07-27T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
        }),
      ),
      cod_collections: Array.from({ length: count }, (_, index) =>
        collection({
          id: `col-${index}`,
          order_id: `order-${index}`,
          amount_vnd: '400',
        }),
      ),
    };
  }

  it('computes totals over ALL expectations, not just the first page', async () => {
    // 250 open expectations against a 100-row list cap. The summary used to be
    // reduced over the same 100 rows the list is drawn from, so a shop with
    // more than 100 open COD expectations was shown 100/100000/40000 — numbers
    // that are wrong by 60% and presented as complete.
    const db = createClient(manyExpectations(250));
    const service = new CodService(db.client, auditMock());

    const report = await service.getReport(ORG_ID);

    expect(report.summary).toEqual({
      openCount: 250,
      discrepancyCount: 0,
      expectedVnd: '250000',
      collectedVnd: '100000',
      deltaVnd: '-150000',
    });
  });

  it('flags the expectation list as truncated while keeping the totals whole', async () => {
    const db = createClient(manyExpectations(250));
    const service = new CodService(db.client, auditMock());

    const report = await service.getReport(ORG_ID);

    expect(report.expectations).toHaveLength(100);
    expect(report.expectationsTruncated).toBe(true);
    expect(report.summary.openCount).toBe(250);
  });

  it('does not flag truncation when everything fits in one page', async () => {
    const db = createClient(manyExpectations(3));
    const service = new CodService(db.client, auditMock());

    const report = await service.getReport(ORG_ID);

    expect(report.expectations).toHaveLength(3);
    expect(report.expectationsTruncated).toBe(false);
    expect(report.discrepanciesTruncated).toBe(false);
    expect(report.summary).toEqual({
      openCount: 3,
      discrepancyCount: 0,
      expectedVnd: '3000',
      collectedVnd: '1200',
      deltaVnd: '-1800',
    });
  });

  it('counts every open discrepancy, even past the discrepancy list cap', async () => {
    const db = createClient({
      ...manyExpectations(5),
      cod_discrepancies: Array.from({ length: 120 }, (_, index) => ({
        id: `disc-${index}`,
        org_id: ORG_ID,
        order_id: `order-${index}`,
        expected_vnd: '1000',
        collected_vnd: '400',
        delta_vnd: '-600',
        status: 'open',
        note: null,
        created_at: CREATED_AT,
        resolved_at: null,
      })),
    });
    const service = new CodService(db.client, auditMock());

    const report = await service.getReport(ORG_ID);

    // `discrepancyCount` used to be `discrepancies.length`, i.e. the capped page.
    expect(report.discrepancies).toHaveLength(100);
    expect(report.summary.discrepancyCount).toBe(120);
    expect(report.discrepanciesTruncated).toBe(true);
  });
});

class Query {
  private filters: Array<{ column: string; value: unknown; values?: unknown[] }> = [];
  private limitCount: number | null = null;
  private sort: { column: string; ascending: boolean } | null = null;
  private offsets: { from: number; to: number } | null = null;
  private insertValues: Row | null = null;
  private updateValues: Row | null = null;
  private upsertValues: Row | null = null;

  constructor(
    private readonly tables: Tables,
    private readonly table: string,
    private readonly mutations: Mutation[] = [],
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ column, value: undefined, values });
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

  insert(values: Row) {
    this.insertValues = values;
    this.mutations.push({ table: this.table, op: 'insert' });
    return this;
  }

  update(values: Row) {
    this.updateValues = values;
    this.mutations.push({ table: this.table, op: 'update' });
    return this;
  }

  upsert(values: Row) {
    this.upsertValues = values;
    this.mutations.push({ table: this.table, op: 'upsert' });
    return this;
  }

  async maybeSingle() {
    const rows = this.applyFilters();
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    if (this.insertValues) {
      const row = this.withDefaults(this.insertValues);
      this.tables[this.table].push(row);
      return { data: row, error: null };
    }

    if (this.upsertValues) {
      const existing = this.tables[this.table].find(
        (row) =>
          row.org_id === this.upsertValues?.org_id &&
          row.order_id === this.upsertValues?.order_id,
      );
      if (existing) {
        Object.assign(existing, this.upsertValues);
        return { data: existing, error: null };
      }
      const row = this.withDefaults(this.upsertValues);
      this.tables[this.table].push(row);
      return { data: row, error: null };
    }

    if (this.updateValues) {
      const row = this.applyFilters()[0];
      if (row) {
        Object.assign(row, this.updateValues);
      }
      return { data: row ?? null, error: null };
    }

    const rows = this.applyFilters();
    return { data: rows[0] ?? null, error: null };
  }

  then(resolve: (value: { data?: Row[]; error: null }) => void) {
    if (this.updateValues) {
      for (const row of this.applyFilters()) {
        Object.assign(row, this.updateValues);
      }
      resolve({ error: null });
      return;
    }
    resolve({ data: this.applyFilters(), error: null });
  }

  private applyFilters() {
    let rows = this.tables[this.table].filter((row) =>
      this.filters.every((filter) =>
        filter.values
          ? filter.values.includes(row[filter.column])
          : row[filter.column] === filter.value,
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
    return rows;
  }

  private withDefaults(values: Row) {
    return {
      id: `${this.table}-${this.tables[this.table].length + 1}`,
      created_at: CREATED_AT,
      ...(this.table === 'cod_expectations' ? { status: 'open' } : {}),
      ...(this.table === 'cod_discrepancies' ? { status: 'open' } : {}),
      ...values,
    };
  }
}
