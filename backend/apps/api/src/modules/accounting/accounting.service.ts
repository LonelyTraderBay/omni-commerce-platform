import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { neutralizeSpreadsheetFormula } from '../../common/csv/csv-formula-guard';
import { SOLD_ORDER_STATUSES } from '../../common/reporting/sold-order-statuses';
import { loadEnv } from '../../config/env';
import type { AccountingExportQuery } from './dto';

export const ACCOUNTING_SUPABASE = Symbol('ACCOUNTING_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from'>;

export type AccountingExportFile = {
  buffer: Buffer;
  contentType: string;
  filename: string;
};

type OrderItemRow = {
  cogs_unit_vnd?: string | number | null;
  qty: number;
};

type OrderRow = {
  id: string;
  status: 'shipped' | 'done' | string;
  total_vnd: string | number;
  shipped_at: string | null;
  done_at: string | null;
  created_at: string;
  /** Generated column: coalesce(done_at, shipped_at, created_at). */
  sold_at?: string | null;
  items?: OrderItemRow[] | null;
};

type ShipmentRow = {
  id: string;
  order_id: string;
  fee_vnd: string | number;
  created_at: string;
};

type CodCollectionRow = {
  id: string;
  order_id: string;
  amount_vnd: string | number;
  collected_at: string;
};

type AdSpendRow = {
  id: string;
  date: string;
  campaign_name: string;
  amount_vnd: string | number;
};

type JournalLine = {
  date: string;
  accountHint: string;
  amountVnd: string;
  ref: string;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

const ORDER_SELECT =
  'id, status, total_vnd, shipped_at, done_at, created_at, sold_at, items:order_items(cogs_unit_vnd, qty)';
/** Rows fetched per round-trip while walking the full date range. */
const PAGE_SIZE = 1_000;
/** Runaway guard: 1M rows of one kind in one export means something is wrong upstream. */
const MAX_PAGES = 1_000;
const SHIPMENT_SELECT = 'id, order_id, fee_vnd, created_at';
const COD_SELECT = 'id, order_id, amount_vnd, collected_at';
const AD_SPEND_SELECT = 'id, date, campaign_name, amount_vnd';

type PagedLoad = {
  table: string;
  select: string;
  /** Column the range predicate and the page ordering both use. */
  dateColumn: string;
  /** Lower/upper bounds already normalized for `dateColumn`, or null for unbounded. */
  from: string | null;
  to: string | null;
  statuses?: readonly string[];
  errorMessage: string;
  tooLargeMessage: string;
  /**
   * Tables that a given deployment may not have provisioned yet. A missing
   * relation yields an empty section instead of failing the whole export.
   */
  optionalTable?: boolean;
};

@Injectable()
export class AccountingService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(ACCOUNTING_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async export(orgId: string, query: AccountingExportQuery) {
    const [orders, shipments, codCollections, adSpend] = await Promise.all([
      this.loadOrders(orgId, query),
      this.loadShipments(orgId, query),
      this.loadCodCollections(orgId, query),
      this.loadAdSpend(orgId, query),
    ]);

    const lines: JournalLine[] = [];
    for (const order of orders) {
      const date = soldAt(order).slice(0, 10);
      lines.push({
        date,
        accountHint: 'sales_revenue',
        amountVnd: toBigintVnd(order.total_vnd).toString(),
        ref: `order:${order.id}`,
      });

      const cogs = orderCogs(order);
      if (cogs > 0n) {
        lines.push({
          date,
          accountHint: 'cogs',
          amountVnd: (-cogs).toString(),
          ref: `order:${order.id}`,
        });
      }
    }

    for (const shipment of shipments) {
      const fee = toBigintVnd(shipment.fee_vnd);
      if (fee > 0n) {
        lines.push({
          date: shipment.created_at.slice(0, 10),
          accountHint: 'shipping_fee',
          amountVnd: (-fee).toString(),
          ref: `shipment:${shipment.id}:order:${shipment.order_id}`,
        });
      }
    }

    for (const collection of codCollections) {
      lines.push({
        date: collection.collected_at.slice(0, 10),
        accountHint: 'cod_cash',
        amountVnd: toBigintVnd(collection.amount_vnd).toString(),
        ref: `cod:${collection.id}:order:${collection.order_id}`,
      });
    }

    for (const spend of adSpend) {
      const amount = toBigintVnd(spend.amount_vnd);
      if (amount > 0n) {
        lines.push({
          date: spend.date,
          accountHint: 'ad_spend',
          amountVnd: (-amount).toString(),
          ref: `ad_spend:${spend.id}:${spend.campaign_name}`,
        });
      }
    }

    lines.sort((left, right) =>
      `${left.date}:${left.accountHint}:${left.ref}`.localeCompare(
        `${right.date}:${right.accountHint}:${right.ref}`,
      ),
    );

    return buildCsvExport(query, lines);
  }

  /**
   * Walks every row of one kind in the range, oldest first.
   *
   * This is the pattern `loadOrders` established when the orders leg of this
   * export was fixed, generalized so the other three legs stop reintroducing
   * the same bug: the date predicate is pushed into SQL and the result set is
   * paged with `.range()` until a short page proves the range is exhausted.
   *
   * The shape being replaced was `.order(dateColumn, { ascending: false })`
   * plus `.limit(10_000)`. Note *which* rows that dropped: descending order
   * means the cap keeps the newest rows and discards the **oldest ones in the
   * requested window**, with nothing in the response saying so. A shop owner
   * exporting a wide range got a ledger that looked complete and balanced but
   * was silently missing its earliest entries.
   */
  private async loadPaged<Row>(orgId: string, options: PagedLoad) {
    const rows: Row[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      let builder = this.supabase
        .from(options.table)
        .select(options.select)
        .eq('org_id', orgId);

      if (options.statuses) {
        builder = builder.in('status', options.statuses);
      }
      if (options.from !== null) {
        builder = builder.gte(options.dateColumn, options.from);
      }
      if (options.to !== null) {
        builder = builder.lte(options.dateColumn, options.to);
      }

      const offset = page * PAGE_SIZE;
      const { data, error } = await builder
        .order(options.dateColumn, { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        if (options.optionalTable && error.code === '42P01') {
          return [];
        }
        throwAccountingError(error, options.errorMessage);
      }

      const batch = (data ?? []) as unknown as Row[];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) {
        return rows;
      }
    }

    throw new InternalServerErrorException({
      code: 'accounting_range_too_large',
      message: options.tooLargeMessage,
    });
  }

  /** Sold orders in the range, bucketed on the generated `orders.sold_at` column. */
  private async loadOrders(orgId: string, query: AccountingExportQuery) {
    const range = normalizeRangeIso(query);
    return this.loadPaged<OrderRow>(orgId, {
      table: 'orders',
      select: ORDER_SELECT,
      dateColumn: 'sold_at',
      from: range.from,
      to: range.to,
      statuses: SOLD_ORDER_STATUSES,
      errorMessage: 'Could not load accounting orders',
      tooLargeMessage:
        'Accounting range exceeded the maximum number of orders that can be exported',
    });
  }

  private async loadShipments(orgId: string, query: AccountingExportQuery) {
    const range = normalizeRangeIso(query);
    return this.loadPaged<ShipmentRow>(orgId, {
      table: 'shipments',
      select: SHIPMENT_SELECT,
      dateColumn: 'created_at',
      from: range.from,
      to: range.to,
      errorMessage: 'Could not load accounting shipments',
      tooLargeMessage:
        'Accounting range exceeded the maximum number of shipments that can be exported',
      optionalTable: true,
    });
  }

  private async loadCodCollections(orgId: string, query: AccountingExportQuery) {
    const range = normalizeRangeIso(query);
    return this.loadPaged<CodCollectionRow>(orgId, {
      table: 'cod_collections',
      select: COD_SELECT,
      dateColumn: 'collected_at',
      from: range.from,
      to: range.to,
      errorMessage: 'Could not load accounting COD collections',
      tooLargeMessage:
        'Accounting range exceeded the maximum number of COD collections that can be exported',
      optionalTable: true,
    });
  }

  private async loadAdSpend(orgId: string, query: AccountingExportQuery) {
    // `ad_spend.date` is a plain `date`, not a timestamptz, so it takes the
    // date-only bounds rather than the ISO instants the other legs use.
    return this.loadPaged<AdSpendRow>(orgId, {
      table: 'ad_spend',
      select: AD_SPEND_SELECT,
      dateColumn: 'date',
      from: query.from ? dateOnly(query.from, 'from') : null,
      to: query.to ? dateOnly(query.to, 'to') : null,
      errorMessage: 'Could not load accounting ad spend',
      tooLargeMessage:
        'Accounting range exceeded the maximum number of ad spend rows that can be exported',
      optionalTable: true,
    });
  }
}

function buildCsvExport(
  query: AccountingExportQuery,
  lines: JournalLine[],
): AccountingExportFile {
  const rows = [
    ['date', 'account_hint', 'amount_vnd', 'ref'],
    ...lines.map((line) => [
      line.date,
      line.accountHint,
      line.amountVnd,
      line.ref,
    ]),
  ];
  // Wrapping a cell in quotes is *not* an injection defence -- Excel evaluates
  // `"=1+1"` just the same -- so every cell goes through the formula guard. `ref`
  // carries a customer-controlled `campaign_name`, which is the live vector.
  //
  // Trade-off: `amount_vnd` is legitimately negative for cogs/shipping/ad spend,
  // so those cells come out as `'-1500` and land in the sheet as text rather than
  // numbers. Values here are always server-generated `BigInt.toString()`, so a
  // `/^-?\d+$/` carve-out would be safe if numeric typing matters more.
  const csv = rows
    .map((row) =>
      row
        .map(
          (cell) =>
            `"${neutralizeSpreadsheetFormula(cell).replace(/"/g, '""')}"`,
        )
        .join(','),
    )
    .join('\n');
  const from = query.from ? dateOnly(query.from, 'from') : 'all';
  const to = query.to ? dateOnly(query.to, 'to') : 'all';
  return {
    buffer: Buffer.from(csv, 'utf8'),
    contentType: 'text/csv; charset=utf-8',
    filename: `accounting-${from}-${to}.csv`,
  };
}

function soldAt(order: OrderRow) {
  // `sold_at` is the generated column the SQL filter uses; the coalesce chain is
  // kept as a fallback so grouping stays correct against older rows/fixtures.
  return order.sold_at ?? order.done_at ?? order.shipped_at ?? order.created_at;
}

function orderCogs(order: OrderRow) {
  return (order.items ?? []).reduce((sum, item) => {
    return sum + toBigintVnd(item.cogs_unit_vnd ?? '0') * BigInt(item.qty);
  }, 0n);
}

/** Range bounds as ISO instants, ready to be sent to PostgREST as `sold_at` filters. */
function normalizeRangeIso(query: AccountingExportQuery) {
  return {
    from: query.from ? new Date(dateBound(query.from, 'from')).toISOString() : null,
    to: query.to ? new Date(dateBound(query.to, 'to')).toISOString() : null,
  };
}

function dateBound(value: string, bound: 'from' | 'to') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return bound === 'from'
      ? new Date(`${value}T00:00:00.000Z`).getTime()
      : new Date(`${value}T23:59:59.999Z`).getTime();
  }
  return new Date(value).getTime();
}

function dateIso(value: string, bound: 'from' | 'to') {
  return new Date(dateBound(value, bound)).toISOString();
}

function dateOnly(value: string, bound: 'from' | 'to') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return dateIso(value, bound).slice(0, 10);
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

function throwAccountingError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: 'accounting_failed',
    message: error.message ?? message,
  });
}

function createSupabaseServiceClient(): SupabaseLike {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
