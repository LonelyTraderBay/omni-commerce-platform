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
import { AuditService, type WriteAuditInput } from '../audit/audit.service';
import type {
  ReconcileCodBatchBody,
  RecordCodCollectionBody,
} from './dto';

export const COD_SUPABASE = Symbol('COD_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from' | 'rpc'>;
export type AuditWriter = {
  writeAudit(input: WriteAuditInput): Promise<unknown>;
};

type PaymentMethod = 'cod' | 'bank_transfer' | 'other';
type OrderStatus = 'draft' | 'confirmed' | 'shipped' | 'done' | 'cancelled' | 'returned';
type CodExpectationStatus = 'open' | 'matched' | 'discrepancy' | 'written_off';
type CodDiscrepancyStatus = 'open' | 'resolved';
type CodCollectionSource = 'manual' | 'carrier_file' | 'carrier_api';

type OrderRow = {
  id: string;
  org_id: string;
  status: OrderStatus;
  payment_method: PaymentMethod;
  customer_name: string | null;
  phone_e164: string | null;
  total_vnd: string | number;
  shipped_at: string | null;
  created_at: string;
};

type OrderSnapshot = {
  id?: unknown;
  status?: unknown;
  paymentMethod?: unknown;
  totalVnd?: unknown;
};

type CodExpectationRow = {
  id: string;
  org_id: string;
  order_id: string;
  expected_vnd: string | number;
  status: CodExpectationStatus;
  created_at: string;
};

type CodCollectionRow = {
  id: string;
  org_id: string;
  order_id: string;
  amount_vnd: string | number;
  collected_at: string;
  source: CodCollectionSource;
  note: string | null;
  created_at: string;
};

type CodDiscrepancyRow = {
  id: string;
  org_id: string;
  order_id: string;
  expected_vnd: string | number;
  collected_vnd: string | number;
  delta_vnd: string | number;
  status: CodDiscrepancyStatus;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
};

type SupabaseError = {
  code?: string;
  message?: string;
  hint?: string;
};

/** One row out of `public.cod_report_summary`; money columns arrive as text. */
type CodReportSummaryRow = {
  open_count: number | string;
  discrepancy_count: number | string;
  expectation_count: number | string;
  expected_vnd: string;
  collected_vnd: string;
};

const EXPECTATION_SELECT =
  'id, org_id, order_id, expected_vnd, status, created_at';
const COLLECTION_SELECT =
  'id, org_id, order_id, amount_vnd, collected_at, source, note, created_at';
const DISCREPANCY_SELECT =
  'id, org_id, order_id, expected_vnd, collected_vnd, delta_vnd, status, note, created_at, resolved_at';
const ORDER_SELECT =
  'id, org_id, status, payment_method, customer_name, phone_e164, total_vnd, shipped_at, created_at';
/** Rows the report returns in its `expectations` / `discrepancies` lists. */
const REPORT_LIST_LIMIT = 100;
/**
 * Order ids `reconcileBatch` actually reconciles in one call when the caller
 * doesn't name them explicitly. `reconcileBatch` awaits `reconcileOrder` in a
 * plain sequential loop with no concurrency control (the abort-on-first-
 * rejection contract pinned in cod.service.spec.ts depends on that), so
 * reconciling an unbounded number of orders in one HTTP request risks a
 * request that runs for minutes and gets cut off by a gateway timeout
 * partway through. The batch stays capped at the size the endpoint already
 * accepted for an explicit `orderIds` list; what changed is that the caller
 * is now told exactly how many reconcilable orders are left instead of that
 * count being silently discarded.
 */
const RECONCILE_BATCH_LIMIT = 100;
/** Rows fetched per round-trip while paging every reconcilable order id. */
const RECONCILABLE_PAGE_SIZE = 1_000;
/** Runaway guard: paging past this many pages of reconcilable ids means something is wrong upstream. */
const RECONCILABLE_MAX_PAGES = 1_000;

@Injectable()
export class CodService {
  private readonly supabase: SupabaseLike;
  private readonly audit?: AuditWriter;

  constructor(
    @Optional()
    @Inject(COD_SUPABASE)
    supabase?: SupabaseLike,
    @Optional()
    @Inject(AuditService)
    audit?: AuditWriter,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
    this.audit = audit;
  }

  async ensureExpectationForOrder(input: {
    orgId: string;
    orderId: string;
    actorUserId?: string;
    order?: OrderSnapshot;
  }) {
    const order = await this.resolveOrderSnapshot(input);
    if (order.paymentMethod !== 'cod' || order.status !== 'shipped') {
      return null;
    }

    // Plan F 2C uses orders.total_vnd as the COD expected amount. Shipping fee
    // is tracked separately on shipments/orders and is not added here.
    const expectedVnd = toBigintVnd(order.totalVnd);
    const { data, error } = await this.supabase
      .from('cod_expectations')
      .upsert(
        {
          org_id: input.orgId,
          order_id: input.orderId,
          expected_vnd: expectedVnd.toString(),
        },
        { onConflict: 'org_id,order_id' },
      )
      .select(EXPECTATION_SELECT)
      .single();

    if (error) {
      throwCodError(error, 'Could not create COD expectation');
    }

    const expectation = mapExpectation(data as CodExpectationRow);
    await this.audit?.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: input.actorUserId ? 'user' : 'system',
      action: 'cod.expectation_upserted',
      entityType: 'order',
      entityId: input.orderId,
      meta: {
        expectedVnd: expectation.expectedVnd,
        source: 'orders.total_vnd',
      },
    });

    return { expectation };
  }

  async handleReturnedOrder(input: {
    orgId: string;
    orderId: string;
    actorUserId?: string;
    order?: OrderSnapshot;
    reason?: string | null;
  }) {
    const order = await this.resolveOrderSnapshot(input);
    if (order.paymentMethod !== 'cod' || order.status !== 'returned') {
      return null;
    }

    const expectation = await this.maybeExpectation(input.orgId, input.orderId);
    if (!expectation || expectation.status === 'matched') {
      return null;
    }

    if (expectation.status === 'open') {
      const updated = await this.updateExpectationStatus(
        input.orgId,
        input.orderId,
        'written_off',
      );
      await this.audit?.writeAudit({
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        actorType: input.actorUserId ? 'user' : 'system',
        action: 'cod.expectation_written_off',
        entityType: 'order',
        entityId: input.orderId,
        meta: {
          reason: normalizeNote(input.reason ?? undefined),
          source: 'order_returned',
        },
      });
      return { expectation: updated };
    }

    if (expectation.status === 'discrepancy') {
      await this.appendReturnDiscrepancyNote(
        input.orgId,
        input.orderId,
        returnDiscrepancyNote(input.reason ?? undefined),
      );
    }

    return { expectation: mapExpectation(expectation) };
  }

  async recordCollection(input: {
    orgId: string;
    actorUserId: string;
    body: RecordCodCollectionBody;
  }) {
    await this.requireExpectation(input.orgId, input.body.orderId);

    const amountVnd = toBigintVnd(input.body.amountVnd);
    const note = normalizeNote(input.body.note);
    const { data, error } = await this.supabase
      .from('cod_collections')
      .insert({
        org_id: input.orgId,
        order_id: input.body.orderId,
        amount_vnd: amountVnd.toString(),
        collected_at: input.body.collectedAt ?? new Date().toISOString(),
        source: input.body.source,
        note,
      })
      .select(COLLECTION_SELECT)
      .single();

    if (error) {
      throwCodError(error, 'Could not record COD collection');
    }

    const collection = mapCollection(data as CodCollectionRow);
    await this.audit?.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'cod.collection_recorded',
      entityType: 'order',
      entityId: input.body.orderId,
      meta: {
        amountVnd: collection.amountVnd,
        source: collection.source,
      },
    });

    return { collection };
  }

  async reconcileOrder(input: {
    orgId: string;
    actorUserId: string;
    orderId: string;
    note?: string;
  }) {
    const expectation = await this.requireExpectation(input.orgId, input.orderId);
    // A written-off expectation is a deliberate decision made when the order was
    // returned: nobody owes this money. Reconciling it would compute a negative
    // delta against zero collections, flip the row back to `discrepancy` and open
    // a fresh discrepancy for money that was never owed. Refuse before any write.
    if (expectation.status === 'written_off') {
      throw new BadRequestException({
        code: 'cod_expectation_written_off',
        message:
          'COD expectation was written off when the order was returned and cannot be reconciled',
      });
    }

    const expected = toBigintVnd(expectation.expected_vnd);
    const collected = await this.sumCollections(input.orgId, input.orderId);
    const delta = collected - expected;

    if (delta === 0n) {
      const updated = await this.updateExpectationStatus(
        input.orgId,
        input.orderId,
        'matched',
      );
      await this.resolveDiscrepancy(input.orgId, input.orderId);
      await this.writeReconcileAudit(input, expected, collected, delta, 'matched');
      return {
        expectation: mapExpectationForReconcile(updated, collected, delta),
        discrepancy: null,
        summary: mapReconcileSummary(expected, collected, delta),
      };
    }

    const updated = await this.updateExpectationStatus(
      input.orgId,
      input.orderId,
      'discrepancy',
    );
    const discrepancy = await this.upsertDiscrepancy({
      orgId: input.orgId,
      orderId: input.orderId,
      expected,
      collected,
      delta,
      note: normalizeNote(input.note),
    });
    await this.writeReconcileAudit(
      input,
      expected,
      collected,
      delta,
      'discrepancy',
    );

    return {
      expectation: mapExpectationForReconcile(updated, collected, delta),
      discrepancy,
      summary: mapReconcileSummary(expected, collected, delta),
    };
  }

  async reconcileBatch(input: {
    orgId: string;
    actorUserId: string;
    body: ReconcileCodBatchBody;
  }) {
    const explicitOrderIds = input.body.orderIds;
    const usingExplicitOrderIds = Boolean(
      explicitOrderIds && explicitOrderIds.length > 0,
    );

    // `remaining` only means something when we picked the ids ourselves: an
    // explicit `orderIds` list is a finite, caller-chosen set that either
    // finishes or aborts in this call, not a page of a larger pool.
    let orderIds: string[];
    let remaining = 0;

    if (usingExplicitOrderIds) {
      orderIds = explicitOrderIds as string[];
    } else {
      const reconcilable = await this.listReconcilableOrderIds(input.orgId);
      orderIds = reconcilable.slice(0, RECONCILE_BATCH_LIMIT);
      remaining = Math.max(reconcilable.length - orderIds.length, 0);
    }

    const results = [];

    for (const orderId of orderIds) {
      results.push(
        await this.reconcileOrder({
          orgId: input.orgId,
          actorUserId: input.actorUserId,
          orderId,
        }),
      );
    }

    return {
      reconciled: results.length,
      results,
      remaining,
      hasMore: remaining > 0,
    };
  }

  /**
   * COD reconciliation report: complete totals, one page of detail rows.
   *
   * The summary is aggregated in SQL over *every* open/discrepant expectation
   * (`public.cod_report_summary`). It used to be reduced over the same capped
   * 100-row page the `expectations` list is drawn from, and `discrepancyCount`
   * over the capped discrepancy page, so a shop with more than 100 open COD
   * expectations was shown understated totals with nothing marking them as
   * partial — the worst failure mode for a money screen.
   *
   * The detail lists stay capped: they back a UI table, and returning tens of
   * thousands of rows to render 100 helps nobody. What changed is that the caps
   * are now *declared* — `expectationsTruncated` / `discrepanciesTruncated` say
   * when a list is only a first page, while the totals above it stay whole.
   */
  async getReport(orgId: string) {
    const [summary, expectationRows, discrepancies] = await Promise.all([
      this.loadReportSummary(orgId),
      this.listReportExpectations(orgId),
      this.listOpenDiscrepancies(orgId),
    ]);

    const orderIds = expectationRows.map((row) => row.order_id);
    const [ordersById, collectedByOrderId] = await Promise.all([
      this.loadOrdersById(orgId, orderIds),
      this.loadCollectionTotals(orgId, orderIds),
    ]);

    return {
      summary: {
        openCount: summary.openCount,
        discrepancyCount: summary.discrepancyCount,
        expectedVnd: summary.expected.toString(),
        collectedVnd: summary.collected.toString(),
        deltaVnd: (summary.collected - summary.expected).toString(),
      },
      expectations: expectationRows.map((row) =>
        mapExpectationForReport(
          row,
          ordersById.get(row.order_id) ?? null,
          collectedByOrderId.get(row.order_id) ?? 0n,
        ),
      ),
      expectationsTruncated: summary.expectationCount > expectationRows.length,
      discrepancies: discrepancies.map(mapDiscrepancy),
      discrepanciesTruncated: summary.discrepancyCount > discrepancies.length,
    };
  }

  private async resolveOrderSnapshot(input: {
    orgId: string;
    orderId: string;
    order?: OrderSnapshot;
  }) {
    if (
      typeof input.order?.paymentMethod === 'string' &&
      typeof input.order?.status === 'string' &&
      (typeof input.order?.totalVnd === 'string' ||
        typeof input.order?.totalVnd === 'number')
    ) {
      return {
        paymentMethod: input.order.paymentMethod,
        status: input.order.status,
        totalVnd: input.order.totalVnd,
      };
    }

    const { data, error } = await this.supabase
      .from('orders')
      .select('id, org_id, status, payment_method, total_vnd')
      .eq('org_id', input.orgId)
      .eq('id', input.orderId)
      .maybeSingle();

    if (error) {
      throwCodError(error, 'Could not read order for COD expectation');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'order_not_found',
        message: 'Order was not found',
      });
    }

    const row = data as Pick<
      OrderRow,
      'status' | 'payment_method' | 'total_vnd'
    >;
    return {
      paymentMethod: row.payment_method,
      status: row.status,
      totalVnd: row.total_vnd,
    };
  }

  private async requireExpectation(orgId: string, orderId: string) {
    const data = await this.maybeExpectation(orgId, orderId);
    if (!data) {
      throw new NotFoundException({
        code: 'cod_expectation_not_found',
        message: 'COD expectation was not found for this order',
      });
    }

    return data;
  }

  private async maybeExpectation(orgId: string, orderId: string) {
    const { data, error } = await this.supabase
      .from('cod_expectations')
      .select(EXPECTATION_SELECT)
      .eq('org_id', orgId)
      .eq('order_id', orderId)
      .maybeSingle();

    if (error) {
      throwCodError(error, 'Could not read COD expectation');
    }

    return (data as CodExpectationRow | null) ?? null;
  }

  private async sumCollections(orgId: string, orderId: string) {
    const { data, error } = await this.supabase
      .from('cod_collections')
      .select('amount_vnd')
      .eq('org_id', orgId)
      .eq('order_id', orderId);

    if (error) {
      throwCodError(error, 'Could not read COD collections');
    }

    return ((data ?? []) as Array<{ amount_vnd: string | number }>).reduce(
      (sum, row) => sum + toBigintVnd(row.amount_vnd),
      0n,
    );
  }

  private async updateExpectationStatus(
    orgId: string,
    orderId: string,
    status: CodExpectationStatus,
  ) {
    const { data, error } = await this.supabase
      .from('cod_expectations')
      .update({ status })
      .eq('org_id', orgId)
      .eq('order_id', orderId)
      .select(EXPECTATION_SELECT)
      .single();

    if (error) {
      throwCodError(error, 'Could not update COD expectation');
    }

    return mapExpectation(data as CodExpectationRow);
  }

  private async resolveDiscrepancy(orgId: string, orderId: string) {
    const { error } = await this.supabase
      .from('cod_discrepancies')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
      })
      .eq('org_id', orgId)
      .eq('order_id', orderId)
      .eq('status', 'open');

    if (error) {
      throwCodError(error, 'Could not resolve COD discrepancy');
    }
  }

  private async appendReturnDiscrepancyNote(
    orgId: string,
    orderId: string,
    note: string,
  ) {
    const { data, error } = await this.supabase
      .from('cod_discrepancies')
      .select(DISCREPANCY_SELECT)
      .eq('org_id', orgId)
      .eq('order_id', orderId)
      .eq('status', 'open')
      .maybeSingle();

    if (error) {
      throwCodError(error, 'Could not read COD discrepancy');
    }
    if (!data) {
      return null;
    }

    const row = data as CodDiscrepancyRow;
    const existing = row.note ?? '';
    if (existing.includes(note)) {
      return mapDiscrepancy(row);
    }

    const { data: updated, error: updateError } = await this.supabase
      .from('cod_discrepancies')
      .update({
        note: [existing, note].filter(Boolean).join('\n'),
      })
      .eq('org_id', orgId)
      .eq('order_id', orderId)
      .eq('status', 'open')
      .select(DISCREPANCY_SELECT)
      .single();

    if (updateError) {
      throwCodError(updateError, 'Could not update COD discrepancy');
    }

    return mapDiscrepancy(updated as CodDiscrepancyRow);
  }

  private async upsertDiscrepancy(input: {
    orgId: string;
    orderId: string;
    expected: bigint;
    collected: bigint;
    delta: bigint;
    note: string | null;
  }) {
    const { data, error } = await this.supabase
      .from('cod_discrepancies')
      .upsert(
        {
          org_id: input.orgId,
          order_id: input.orderId,
          expected_vnd: input.expected.toString(),
          collected_vnd: input.collected.toString(),
          delta_vnd: input.delta.toString(),
          status: 'open',
          note: input.note,
          resolved_at: null,
        },
        { onConflict: 'org_id,order_id' },
      )
      .select(DISCREPANCY_SELECT)
      .single();

    if (error) {
      throwCodError(error, 'Could not upsert COD discrepancy');
    }

    return mapDiscrepancy(data as CodDiscrepancyRow);
  }

  /**
   * Every reconcilable (open/discrepancy) COD order id for the org, oldest
   * first. Paged with `.range()` the same way `AccountingService.loadPaged`
   * walks a full export range: push the filter into SQL and keep fetching
   * pages until a short page proves the table is exhausted.
   *
   * This used to be a single `.limit(100)` call, so `reconcileBatch`'s
   * "reconcile all open COD" action silently stopped at 100 orders with
   * nothing telling the caller more were left -- the write-path twin of the
   * bug `getReport`'s totals had. `reconcileBatch` still only *reconciles*
   * `RECONCILE_BATCH_LIMIT` ids from what this returns -- seeing the whole
   * reconcilable set doesn't mean the whole set gets written synchronously
   * in one request -- but it now uses the true length to report an exact
   * `remaining` count instead of guessing.
   */
  private async listReconcilableOrderIds(orgId: string) {
    const orderIds: string[] = [];

    for (let page = 0; page < RECONCILABLE_MAX_PAGES; page += 1) {
      const offset = page * RECONCILABLE_PAGE_SIZE;
      const { data, error } = await this.supabase
        .from('cod_expectations')
        .select('order_id')
        .eq('org_id', orgId)
        .in('status', ['open', 'discrepancy'])
        .order('created_at', { ascending: true })
        .range(offset, offset + RECONCILABLE_PAGE_SIZE - 1);

      if (error) {
        throwCodError(error, 'Could not list COD expectations');
      }

      const batch = (data ?? []) as Array<{ order_id: string }>;
      orderIds.push(...batch.map((row) => row.order_id));
      if (batch.length < RECONCILABLE_PAGE_SIZE) {
        return orderIds;
      }
    }

    throw new InternalServerErrorException({
      code: 'cod_reconcile_range_too_large',
      message: 'Too many reconcilable COD expectations to list in one request',
    });
  }

  private async loadOrdersById(orgId: string, orderIds: string[]) {
    const ordersById = new Map<string, ReturnType<typeof mapOrderSummary>>();
    if (orderIds.length === 0) {
      return ordersById;
    }

    const { data, error } = await this.supabase
      .from('orders')
      .select(ORDER_SELECT)
      .eq('org_id', orgId)
      .in('id', orderIds);

    if (error) {
      throwCodError(error, 'Could not load COD order summaries');
    }

    for (const row of (data ?? []) as OrderRow[]) {
      ordersById.set(row.id, mapOrderSummary(row));
    }
    return ordersById;
  }

  private async loadCollectionTotals(orgId: string, orderIds: string[]) {
    const totals = new Map<string, bigint>();
    if (orderIds.length === 0) {
      return totals;
    }

    const { data, error } = await this.supabase
      .from('cod_collections')
      .select('order_id, amount_vnd')
      .eq('org_id', orgId)
      .in('order_id', orderIds);

    if (error) {
      throwCodError(error, 'Could not load COD collection totals');
    }

    for (const row of (data ?? []) as Array<{
      order_id: string;
      amount_vnd: string | number;
    }>) {
      totals.set(
        row.order_id,
        (totals.get(row.order_id) ?? 0n) + toBigintVnd(row.amount_vnd),
      );
    }
    return totals;
  }

  /** Whole-org COD totals, aggregated in SQL so no row cap can understate them. */
  private async loadReportSummary(orgId: string) {
    const { data, error } = await this.supabase.rpc('cod_report_summary', {
      p_org_id: orgId,
    });

    if (error) {
      throwCodError(error, 'Could not load COD report summary');
    }

    // A `returns table (...)` function comes back as a one-element array.
    const row = (Array.isArray(data) ? data[0] : data) as
      | CodReportSummaryRow
      | null
      | undefined;

    return {
      openCount: toCount(row?.open_count ?? 0),
      discrepancyCount: toCount(row?.discrepancy_count ?? 0),
      expectationCount: toCount(row?.expectation_count ?? 0),
      expected: toBigintVnd(row?.expected_vnd ?? '0'),
      collected: toBigintVnd(row?.collected_vnd ?? '0'),
    };
  }

  private async listReportExpectations(orgId: string) {
    const { data, error } = await this.supabase
      .from('cod_expectations')
      .select(EXPECTATION_SELECT)
      .eq('org_id', orgId)
      .in('status', ['open', 'discrepancy'])
      .order('created_at', { ascending: false })
      .limit(REPORT_LIST_LIMIT);

    if (error) {
      throwCodError(error, 'Could not load COD expectations');
    }

    return (data ?? []) as CodExpectationRow[];
  }

  private async listOpenDiscrepancies(orgId: string) {
    const { data, error } = await this.supabase
      .from('cod_discrepancies')
      .select(DISCREPANCY_SELECT)
      .eq('org_id', orgId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(REPORT_LIST_LIMIT);

    if (error) {
      throwCodError(error, 'Could not list COD discrepancies');
    }

    return (data ?? []) as CodDiscrepancyRow[];
  }

  private async writeReconcileAudit(
    input: {
      orgId: string;
      actorUserId: string;
      orderId: string;
    },
    expected: bigint,
    collected: bigint,
    delta: bigint,
    result: 'matched' | 'discrepancy',
  ) {
    await this.audit?.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'cod.reconciled',
      entityType: 'order',
      entityId: input.orderId,
      meta: {
        expectedVnd: expected.toString(),
        collectedVnd: collected.toString(),
        deltaVnd: delta.toString(),
        result,
      },
    });
  }
}

function mapExpectation(row: CodExpectationRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    orderId: row.order_id,
    expectedVnd: row.expected_vnd.toString(),
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapCollection(row: CodCollectionRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    orderId: row.order_id,
    amountVnd: row.amount_vnd.toString(),
    collectedAt: row.collected_at,
    source: row.source,
    note: row.note,
    createdAt: row.created_at,
  };
}

function mapDiscrepancy(row: CodDiscrepancyRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    orderId: row.order_id,
    expectedVnd: row.expected_vnd.toString(),
    collectedVnd: row.collected_vnd.toString(),
    deltaVnd: row.delta_vnd.toString(),
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapOrderSummary(row: OrderRow) {
  return {
    id: row.id,
    status: row.status,
    paymentMethod: row.payment_method,
    customerName: row.customer_name,
    phoneE164: row.phone_e164,
    totalVnd: row.total_vnd.toString(),
    shippedAt: row.shipped_at,
    createdAt: row.created_at,
  };
}

function mapExpectationForReport(
  row: CodExpectationRow,
  order: ReturnType<typeof mapOrderSummary> | null,
  collected: bigint,
) {
  const expected = toBigintVnd(row.expected_vnd);
  return {
    ...mapExpectation(row),
    collectedVnd: collected.toString(),
    deltaVnd: (collected - expected).toString(),
    order,
  };
}

function mapReconcileSummary(expected: bigint, collected: bigint, delta: bigint) {
  return {
    expectedVnd: expected.toString(),
    collectedVnd: collected.toString(),
    deltaVnd: delta.toString(),
  };
}

function mapExpectationForReconcile(
  expectation: ReturnType<typeof mapExpectation>,
  collected: bigint,
  delta: bigint,
) {
  return {
    ...expectation,
    collectedVnd: collected.toString(),
    deltaVnd: delta.toString(),
    order: null,
  };
}

function normalizeNote(note: string | undefined) {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
}

function returnDiscrepancyNote(reason: string | undefined) {
  const normalized = normalizeNote(reason);
  return normalized
    ? `Order returned; COD discrepancy left open: ${normalized}`
    : 'Order returned; COD discrepancy left open';
}

/** `count(*)` arrives as a JSON number, but PostgREST may hand back bigint text. */
function toCount(value: number | string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InternalServerErrorException({
      code: 'cod_failed',
      message: 'COD report summary returned an invalid row count',
    });
  }
  return parsed;
}

function toBigintVnd(value: string | number | unknown) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestException({
        code: 'invalid_money_amount',
        message: 'Money amount must be a non-negative integer VND value',
      });
    }
    return BigInt(value);
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException({
      code: 'invalid_money_amount',
      message: 'Money amount must be a non-negative integer VND value',
    });
  }
  return BigInt(value);
}

function throwCodError(error: SupabaseError, message: string): never {
  if (error.code === '23505') {
    throw new ConflictException({
      code: 'cod_conflict',
      message: error.message ?? message,
    });
  }

  throw new InternalServerErrorException({
    code: 'cod_failed',
    message,
  });
}

function createSupabaseServiceClient() {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
