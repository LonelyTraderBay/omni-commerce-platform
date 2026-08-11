import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SOLD_ORDER_STATUSES } from '../../common/reporting/sold-order-statuses';
import { loadEnv } from '../../config/env';
import type { AttributionSummaryQuery } from './dto';

export const ATTRIBUTION_SUPABASE = Symbol('ATTRIBUTION_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from'>;

type SupabaseError = {
  code?: string;
  message?: string;
};

type OrderAttributionRow = {
  id: string;
  utm_source: string | null;
  total_vnd: string | number;
  created_at: string;
};

const ORDER_ATTRIBUTION_SELECT = 'id, utm_source, total_vnd, created_at';
/** Rows fetched per round-trip while walking the full date range. */
const ORDER_PAGE_SIZE = 1_000;
/** Runaway guard: 1M sold orders in one window means something is wrong upstream. */
const MAX_ORDER_PAGES = 1_000;

@Injectable()
export class AttributionService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(ATTRIBUTION_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async summary(orgId: string, query: AttributionSummaryQuery) {
    const rows = await this.loadOrders(orgId, query);
    const bySource = new Map<string, { count: number; revenue: bigint }>();
    let totalOrders = 0;
    let totalRevenue = 0n;

    for (const row of rows) {
      const key = sourceKey(row.utm_source);
      const bucket = bySource.get(key) ?? { count: 0, revenue: 0n };
      const revenue = toBigintVnd(row.total_vnd);

      bucket.count += 1;
      bucket.revenue += revenue;
      bySource.set(key, bucket);
      totalOrders += 1;
      totalRevenue += revenue;
    }

    return {
      totalOrders,
      totalRevenueVnd: totalRevenue.toString(),
      sources: [...bySource.entries()]
        .sort(([leftKey, left], [rightKey, right]) => {
          if (left.revenue === right.revenue) {
            return leftKey.localeCompare(rightKey);
          }
          return left.revenue > right.revenue ? -1 : 1;
        })
        .map(([key, bucket]) => ({
          utmSource: key === 'unknown' ? null : key,
          label: key === 'unknown' ? 'Không rõ nguồn' : key,
          orderCount: bucket.count,
          revenueVnd: bucket.revenue.toString(),
        })),
    };
  }

  /**
   * Loads the orders whose revenue this report is allowed to count.
   *
   * Two deliberate decisions live here, and they pull in opposite directions:
   *
   * 1. **Status: identical to P&L.** Only `SOLD_ORDER_STATUSES` counts. This
   *    filter used to be missing entirely, so `draft`, `cancelled` and
   *    `returned` orders contributed their full `total_vnd` to attribution
   *    revenue while `/pnl` reported zero for them — the two reports were
   *    guaranteed to disagree and no shop owner could reconcile them.
   *
   * 2. **Date basis: `created_at`, NOT `sold_at` — on purpose.** P&L buckets on
   *    the generated `orders.sold_at` (`coalesce(done_at, shipped_at,
   *    created_at)`) because it answers "when was this revenue recognized?".
   *    Attribution answers a different question: "which source produced this
   *    order?" — a click-date/cohort question. Ad spend is dated on the day the
   *    ads ran, so pairing it with orders *originated* that day is what makes
   *    ROAS meaningful; re-bucketing on `sold_at` would credit Monday's ad
   *    budget with an order that was clicked Monday and shipped Friday.
   *
   * The consequence, stated plainly so nobody "fixes" it later: `/attribution`
   * and `/pnl` now report the same revenue for the same *set* of orders, but
   * they still legitimately assign an order to different days when it is
   * created in one window and shipped in another. That divergence is by design;
   * the status divergence was the bug.
   */
  private async loadOrders(orgId: string, query: AttributionSummaryQuery) {
    const rows: OrderAttributionRow[] = [];

    for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
      let builder = this.supabase
        .from('orders')
        .select(ORDER_ATTRIBUTION_SELECT)
        .eq('org_id', orgId)
        .in('status', SOLD_ORDER_STATUSES);

      if (query.from) {
        builder = builder.gte('created_at', `${query.from}T00:00:00.000Z`);
      }
      if (query.to) {
        builder = builder.lte('created_at', `${query.to}T23:59:59.999Z`);
      }

      const offset = page * ORDER_PAGE_SIZE;
      const { data, error } = await builder
        .order('created_at', { ascending: true })
        .range(offset, offset + ORDER_PAGE_SIZE - 1);

      if (error) {
        throwAttributionError(error, 'Could not summarize attribution');
      }

      const batch = (data ?? []) as OrderAttributionRow[];
      rows.push(...batch);
      if (batch.length < ORDER_PAGE_SIZE) {
        return rows;
      }
    }

    throw new InternalServerErrorException({
      code: 'attribution_range_too_large',
      message:
        'Attribution range exceeded the maximum number of orders that can be summarized',
    });
  }
}

function sourceKey(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized || 'unknown';
}

function toBigintVnd(value: string | number) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throwAttributionError(
        {},
        'Order total must be a non-negative integer VND amount',
      );
    }
    return BigInt(value);
  }

  if (!/^\d+$/.test(value)) {
    throwAttributionError(
      {},
      'Order total must be a non-negative integer VND amount',
    );
  }
  return BigInt(value);
}

function throwAttributionError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: 'attribution_failed',
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
