import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  SOLD_ORDER_STATUSES,
  type SoldOrderStatus,
} from '../../common/reporting/sold-order-statuses';
import { loadEnv } from '../../config/env';
import type { PnlDateRangeQuery } from './dto';

export const PNL_SUPABASE = Symbol('PNL_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from'>;

type OrderStatus = SoldOrderStatus;

type OrderItemRow = {
  sku_snapshot: string;
  qty: number;
  line_total_vnd: string | number;
  cogs_unit_vnd?: string | number | null;
};

type OrderRow = {
  id: string;
  status: OrderStatus;
  total_vnd: string | number;
  shipping_fee_vnd?: string | number | null;
  shipped_at: string | null;
  done_at: string | null;
  created_at: string;
  /** Generated column: coalesce(done_at, shipped_at, created_at). */
  sold_at?: string | null;
  items?: OrderItemRow[] | null;
};

type AdSpendRow = {
  date: string;
  amount_vnd: string | number;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

type GrossAggregate = {
  revenue: bigint;
  cogs: bigint;
  grossProfit: bigint;
  orderCount: number;
};

type MoneyAggregate = GrossAggregate & {
  shipping: bigint;
  adSpend: bigint;
};

type SkuAggregate = GrossAggregate & {
  sku: string;
  qty: number;
  orderIds: Set<string>;
};

const ORDER_WITH_ITEMS_SELECT =
  'id, status, total_vnd, shipping_fee_vnd, shipped_at, done_at, created_at, sold_at, items:order_items(sku_snapshot, qty, line_total_vnd, cogs_unit_vnd)';
const AD_SPEND_SELECT = 'date, amount_vnd';

/** Rows fetched per round-trip while walking the full date range. */
const ORDER_PAGE_SIZE = 1_000;
/** Runaway guard: 1M sold orders in one range means something is wrong upstream. */
const MAX_ORDER_PAGES = 1_000;

@Injectable()
export class PnlService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(PNL_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async getSummary(orgId: string, query: PnlDateRangeQuery) {
    const [orders, adSpendRows] = await Promise.all([
      this.loadSoldOrders(orgId, query),
      this.loadAdSpendRows(orgId, query),
    ]);
    const totals = emptyAggregate();
    const byDay = new Map<string, MoneyAggregate>();

    for (const order of orders) {
      const soldDate = soldAt(order);
      const day = soldDate.slice(0, 10);
      const dayAggregate = byDay.get(day) ?? emptyAggregate();
      const revenue = toBigintVnd(order.total_vnd);
      const cogs = orderCogs(order);
      const shipping = toBigintVnd(order.shipping_fee_vnd ?? '0');

      addOrder(totals, revenue, cogs, shipping);
      addOrder(dayAggregate, revenue, cogs, shipping);
      byDay.set(day, dayAggregate);
    }

    for (const row of adSpendRows) {
      const day = row.date;
      const dayAggregate = byDay.get(day) ?? emptyAggregate();
      const amount = toBigintVnd(row.amount_vnd);

      totals.adSpend += amount;
      dayAggregate.adSpend += amount;
      byDay.set(day, dayAggregate);
    }

    return {
      ...serializeAggregate(totals),
      days: [...byDay.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([day, aggregate]) => ({
          day,
          ...serializeAggregate(aggregate),
        })),
    };
  }

  async getBySku(orgId: string, query: PnlDateRangeQuery) {
    const orders = await this.loadSoldOrders(orgId, query);
    const bySku = new Map<string, SkuAggregate>();

    for (const order of orders) {
      for (const item of order.items ?? []) {
        const sku = item.sku_snapshot || '(no sku)';
        const aggregate = bySku.get(sku) ?? emptySkuAggregate(sku);
        const revenue = toBigintVnd(item.line_total_vnd);
        const cogs = itemCogs(item);

        aggregate.revenue += revenue;
        aggregate.cogs += cogs;
        aggregate.grossProfit += revenue - cogs;
        aggregate.qty += item.qty;
        aggregate.orderIds.add(order.id);
        aggregate.orderCount = aggregate.orderIds.size;
        bySku.set(sku, aggregate);
      }
    }

    return {
      items: [...bySku.values()]
        .sort((left, right) => left.sku.localeCompare(right.sku))
        .map((aggregate) => ({
          sku: aggregate.sku,
          qty: aggregate.qty,
          ...serializeGrossAggregate(aggregate),
        })),
    };
  }

  /**
   * Walks every sold order in the range.
   *
   * The date predicate is pushed into SQL against the generated `orders.sold_at`
   * column and the result set is paged, so a wide range returns *all* matching
   * orders instead of the newest 10k. Silently truncating a financial report is
   * worse than being slow.
   */
  private async loadSoldOrders(orgId: string, query: PnlDateRangeQuery) {
    const range = normalizeRangeIso(query);
    const orders: OrderRow[] = [];

    for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
      let builder = this.supabase
        .from('orders')
        .select(ORDER_WITH_ITEMS_SELECT)
        .eq('org_id', orgId)
        .in('status', SOLD_ORDER_STATUSES);

      if (range.from !== null) {
        builder = builder.gte('sold_at', range.from);
      }
      if (range.to !== null) {
        builder = builder.lte('sold_at', range.to);
      }

      const offset = page * ORDER_PAGE_SIZE;
      const { data, error } = await builder
        .order('sold_at', { ascending: true })
        .range(offset, offset + ORDER_PAGE_SIZE - 1);

      if (error) {
        throwPnlError(error, 'Could not load P&L orders');
      }

      const batch = (data ?? []) as unknown as OrderRow[];
      orders.push(...batch);
      if (batch.length < ORDER_PAGE_SIZE) {
        return orders;
      }
    }

    throw new InternalServerErrorException({
      code: 'pnl_range_too_large',
      message: 'P&L range exceeded the maximum number of orders that can be aggregated',
    });
  }

  private async loadAdSpendRows(orgId: string, query: PnlDateRangeQuery) {
    let builder = this.supabase
      .from('ad_spend')
      .select(AD_SPEND_SELECT)
      .eq('org_id', orgId)
      .order('date', { ascending: true })
      .limit(10_000);

    if (query.from) {
      builder = builder.gte('date', dateOnly(query.from, 'from'));
    }
    if (query.to) {
      builder = builder.lte('date', dateOnly(query.to, 'to'));
    }

    const { data, error } = await builder;
    if (error) {
      if (error.code === '42P01') {
        return [];
      }
      throwPnlError(error, 'Could not load P&L ad spend');
    }

    return (data ?? []) as AdSpendRow[];
  }
}

function emptyAggregate(): MoneyAggregate {
  return {
    revenue: 0n,
    cogs: 0n,
    grossProfit: 0n,
    shipping: 0n,
    adSpend: 0n,
    orderCount: 0,
  };
}

function emptySkuAggregate(sku: string): SkuAggregate {
  return {
    revenue: 0n,
    cogs: 0n,
    grossProfit: 0n,
    orderCount: 0,
    sku,
    qty: 0,
    orderIds: new Set<string>(),
  };
}

function addOrder(
  aggregate: MoneyAggregate,
  revenue: bigint,
  cogs: bigint,
  shipping: bigint,
) {
  aggregate.revenue += revenue;
  aggregate.cogs += cogs;
  aggregate.grossProfit += revenue - cogs;
  aggregate.shipping += shipping;
  aggregate.orderCount += 1;
}

function serializeAggregate(aggregate: MoneyAggregate) {
  return {
    revenueVnd: aggregate.revenue.toString(),
    cogsVnd: aggregate.cogs.toString(),
    grossProfitVnd: aggregate.grossProfit.toString(),
    shippingVnd: aggregate.shipping.toString(),
    adSpendVnd: aggregate.adSpend.toString(),
    // Spec: revenue − COGS − ship − ads. Shipping used to be omitted here, which
    // overstated profit by the full shipping spend and made this number disagree
    // with the accounting export (which does read `shipments.fee_vnd`).
    netProfitVnd: (
      aggregate.grossProfit -
      aggregate.shipping -
      aggregate.adSpend
    ).toString(),
    orderCount: aggregate.orderCount,
  };
}

function serializeGrossAggregate(aggregate: GrossAggregate) {
  return {
    revenueVnd: aggregate.revenue.toString(),
    cogsVnd: aggregate.cogs.toString(),
    grossProfitVnd: aggregate.grossProfit.toString(),
    orderCount: aggregate.orderCount,
  };
}

function soldAt(order: OrderRow) {
  // `sold_at` is the generated column the SQL filter uses; the coalesce chain is
  // kept as a fallback so aggregation stays correct against older rows/fixtures.
  return order.sold_at ?? order.done_at ?? order.shipped_at ?? order.created_at;
}

function orderCogs(order: OrderRow) {
  return (order.items ?? []).reduce((sum, item) => sum + itemCogs(item), 0n);
}

function itemCogs(item: OrderItemRow) {
  return toBigintVnd(item.cogs_unit_vnd ?? '0') * BigInt(item.qty);
}

/** Range bounds as ISO instants, ready to be sent to PostgREST as `sold_at` filters. */
function normalizeRangeIso(query: PnlDateRangeQuery) {
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

function dateOnly(value: string, bound: 'from' | 'to') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return new Date(dateBound(value, bound)).toISOString().slice(0, 10);
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

function throwPnlError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: 'pnl_failed',
    message: error.message ?? message,
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
