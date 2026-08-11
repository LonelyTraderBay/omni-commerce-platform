import {
  BadGatewayException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadEnv, type Env } from '../../config/env';
import { AiRunsService } from '../audit/ai-runs.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { AdvisorAiResponseSchema, type AdvisorSuggestBody } from './dto';

export const ADVISOR_FETCH = Symbol('ADVISOR_FETCH');
export const ADVISOR_ENV = Symbol('ADVISOR_ENV');
export const ADVISOR_SUPABASE = Symbol('ADVISOR_SUPABASE');

type AdvisorEnv = Pick<Env, 'AI_BASE_URL' | 'SERVICE_M2M_KEY'>;
export type SupabaseLike = Pick<SupabaseClient, 'from'>;
type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'text'>>;

type ProductRow = {
  id: string;
  status: 'active' | 'archived';
  deleted_at: string | null;
};

type VariantRow = {
  id: string;
  sku: string;
  title: string;
  price_vnd: string | number;
  stock_qty: number;
  cogs_vnd: string | number;
};

type OrderItemRow = {
  sku_snapshot: string;
  qty: number;
  line_total_vnd: string | number;
  cogs_unit_vnd?: string | number | null;
};

type OrderRow = {
  id: string;
  status: string;
  total_vnd: string | number;
  created_at: string;
  shipped_at: string | null;
  done_at: string | null;
  items?: OrderItemRow[] | null;
};

type CatalogAggregates = {
  note: string;
  empty: boolean;
  productCount: number;
  activeProductCount: number;
  variantCount: number;
  totalStockQty: number;
  lowStockCount: number;
  sampleLowStock: Array<{
    sku: string;
    title: string;
    stockQty: number;
    priceVnd: string;
  }>;
};

type SalesAggregates = {
  note: string;
  empty: boolean;
  windowDays: number;
  orderCount: number;
  soldOrderCount: number;
  revenueVnd: string;
  cogsVnd: string;
  grossProfitVnd: string;
  byStatus: Record<string, number>;
  topSkus: Array<{
    sku: string;
    qty: number;
    revenueVnd: string;
  }>;
};

const ADVISOR_DISCLAIMER =
  'Advisor chỉ tư vấn; người bán duyệt trước khi đăng, gửi Meta hoặc mua ads.';
const SALES_WINDOW_DAYS = 7;
const LOW_STOCK_THRESHOLD = 5;
const SAMPLE_LOW_STOCK_LIMIT = 5;
const TOP_SKU_LIMIT = 5;
const SOLD_STATUSES = new Set(['shipped', 'done']);
const PRODUCT_SELECT = 'id, status, deleted_at';
const VARIANT_SELECT = 'id, sku, title, price_vnd, stock_qty, cogs_vnd';
const ORDER_WITH_ITEMS_SELECT =
  'id, status, total_vnd, created_at, shipped_at, done_at, items:order_items(sku_snapshot, qty, line_total_vnd, cogs_unit_vnd)';

@Injectable()
export class AdvisorService {
  private readonly fetchFn: FetchLike;
  private readonly env: AdvisorEnv;
  private readonly supabase: SupabaseLike;

  constructor(
    @Inject(FeatureFlagsService)
    private readonly featureFlags: FeatureFlagsService,
    @Inject(AiRunsService)
    private readonly aiRuns: AiRunsService,
    @Optional()
    @Inject(ADVISOR_FETCH)
    fetchFn?: FetchLike,
    @Optional()
    @Inject(ADVISOR_ENV)
    env?: AdvisorEnv,
    @Optional()
    @Inject(ADVISOR_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.fetchFn = fetchFn ?? fetch;
    this.env = env ?? loadEnv();
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async suggest(input: { orgId: string; body: AdvisorSuggestBody }) {
    if (await this.featureFlags.isEnabled('kill_ai_all', input.orgId)) {
      throw new ServiceUnavailableException({
        code: 'advisor_disabled',
        message: 'AI advisor is disabled by kill_ai_all',
      });
    }

    const aiResponse = await this.callAiAdvisor(input.orgId, input.body);
    const aiRun = await this.aiRuns.writeRun({
      orgId: input.orgId,
      promptVersion: aiResponse.promptVersion,
      model: aiResponse.model,
      tokens: aiResponse.tokens,
      tools: [
        {
          kind: 'advisor',
          adviseOnly: true,
        },
        ...aiResponse.toolsUsed,
      ],
      citations: aiResponse.citations,
      status: 'succeeded',
    });

    return {
      suggestionsText: aiResponse.suggestionsText,
      disclaimer: aiResponse.disclaimer || ADVISOR_DISCLAIMER,
      promptVersion: aiResponse.promptVersion,
      model: aiResponse.model,
      citations: aiResponse.citations,
      aiRun: aiRun.aiRun,
      entitlement: {
        allowed: true,
        note: 'Plan G MVP allows all orgs; add plan flag before GA.',
      },
    };
  }

  private async callAiAdvisor(orgId: string, body: AdvisorSuggestBody) {
    const [catalogAggregates, salesAggregates] = await Promise.all([
      this.buildCatalogAggregates(orgId),
      this.buildSalesAggregates(orgId),
    ]);

    const url = new URL('/internal/v1/ai/advise', this.env.AI_BASE_URL);
    const response = await this.fetchFn(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-key': this.env.SERVICE_M2M_KEY,
      },
      body: JSON.stringify({
        orgId,
        goal: body.goal ?? null,
        catalogAggregates,
        salesAggregates,
      }),
    });

    if (!response.ok) {
      throw new BadGatewayException({
        code: 'advisor_ai_failed',
        message: `AI advisor failed with status ${response.status}`,
        detail: await response.text().catch(() => undefined),
      });
    }

    const parsed = AdvisorAiResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new BadGatewayException({
        code: 'advisor_ai_invalid_response',
        message: 'AI advisor response is invalid',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return parsed.data;
  }

  private async buildCatalogAggregates(orgId: string): Promise<CatalogAggregates> {
    const [productsResult, variantsResult] = await Promise.all([
      this.loadProducts(orgId),
      this.loadVariants(orgId),
    ]);

    if (productsResult.error || variantsResult.error) {
      return emptyCatalogAggregates(
        'Không đọc được catalog từ DB local (products/variants).',
      );
    }

    const products = productsResult.rows;
    const variants = variantsResult.rows;

    if (products.length === 0 && variants.length === 0) {
      return emptyCatalogAggregates('Chưa có sản phẩm/biến thể trong catalog.');
    }

    const activeProductCount = products.filter(
      (product) => product.status === 'active' && product.deleted_at == null,
    ).length;
    const totalStockQty = variants.reduce(
      (sum, variant) => sum + (variant.stock_qty ?? 0),
      0,
    );
    const lowStock = variants
      .filter((variant) => (variant.stock_qty ?? 0) <= LOW_STOCK_THRESHOLD)
      .sort((left, right) => left.stock_qty - right.stock_qty);
    const sampleLowStock = lowStock.slice(0, SAMPLE_LOW_STOCK_LIMIT).map((variant) => ({
      sku: variant.sku,
      title: variant.title,
      stockQty: variant.stock_qty,
      priceVnd: toVndString(variant.price_vnd),
    }));

    const note = [
      `${products.length} sản phẩm (${activeProductCount} đang bán), ${variants.length} biến thể`,
      `tồn ${totalStockQty}`,
      lowStock.length > 0
        ? `${lowStock.length} SKU tồn ≤ ${LOW_STOCK_THRESHOLD}`
        : 'không có SKU tồn thấp',
    ].join('; ');

    return {
      note,
      empty: false,
      productCount: products.length,
      activeProductCount,
      variantCount: variants.length,
      totalStockQty,
      lowStockCount: lowStock.length,
      sampleLowStock,
    };
  }

  private async buildSalesAggregates(orgId: string): Promise<SalesAggregates> {
    const since = new Date(
      Date.now() - SALES_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const ordersResult = await this.loadRecentOrders(orgId, since);

    if (ordersResult.error) {
      return emptySalesAggregates('Không đọc được đơn hàng từ DB local.');
    }

    const orders = ordersResult.rows;

    if (orders.length === 0) {
      return emptySalesAggregates(
        `Chưa có đơn hàng trong ${SALES_WINDOW_DAYS} ngày gần đây.`,
      );
    }

    const byStatus: Record<string, number> = {};
    let soldOrderCount = 0;
    let revenue = 0n;
    let cogs = 0n;
    const skuMap = new Map<string, { qty: number; revenue: bigint }>();

    for (const order of orders) {
      byStatus[order.status] = (byStatus[order.status] ?? 0) + 1;
      if (!SOLD_STATUSES.has(order.status)) {
        continue;
      }

      soldOrderCount += 1;
      revenue += toBigintVnd(order.total_vnd);
      for (const item of order.items ?? []) {
        const lineRevenue = toBigintVnd(item.line_total_vnd);
        const lineCogs =
          toBigintVnd(item.cogs_unit_vnd ?? '0') * BigInt(item.qty);
        cogs += lineCogs;
        const sku = item.sku_snapshot || '(no sku)';
        const current = skuMap.get(sku) ?? { qty: 0, revenue: 0n };
        current.qty += item.qty;
        current.revenue += lineRevenue;
        skuMap.set(sku, current);
      }
    }

    const topSkus = [...skuMap.entries()]
      .sort((left, right) => {
        if (right[1].revenue === left[1].revenue) {
          return right[1].qty - left[1].qty;
        }
        return right[1].revenue > left[1].revenue ? 1 : -1;
      })
      .slice(0, TOP_SKU_LIMIT)
      .map(([sku, aggregate]) => ({
        sku,
        qty: aggregate.qty,
        revenueVnd: aggregate.revenue.toString(),
      }));

    const note = [
      `${orders.length} đơn / ${SALES_WINDOW_DAYS} ngày`,
      `${soldOrderCount} đã giao/hoàn tất`,
      `doanh thu ${revenue.toString()} VND`,
      `lợi nhuận gộp ${(revenue - cogs).toString()} VND`,
      '(không gồm Meta ads — chưa có nguồn ads thật)',
    ].join('; ');

    return {
      note,
      empty: false,
      windowDays: SALES_WINDOW_DAYS,
      orderCount: orders.length,
      soldOrderCount,
      revenueVnd: revenue.toString(),
      cogsVnd: cogs.toString(),
      grossProfitVnd: (revenue - cogs).toString(),
      byStatus,
      topSkus,
    };
  }

  private async loadProducts(orgId: string) {
    const { data, error } = await this.supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .limit(5_000);

    if (error) {
      return { rows: [] as ProductRow[], error: true };
    }

    return { rows: (data ?? []) as ProductRow[], error: false };
  }

  private async loadVariants(orgId: string) {
    const { data, error } = await this.supabase
      .from('product_variants')
      .select(VARIANT_SELECT)
      .eq('org_id', orgId)
      .limit(10_000);

    if (error) {
      return { rows: [] as VariantRow[], error: true };
    }

    return { rows: (data ?? []) as VariantRow[], error: false };
  }

  private async loadRecentOrders(orgId: string, sinceIso: string) {
    const { data, error } = await this.supabase
      .from('orders')
      .select(ORDER_WITH_ITEMS_SELECT)
      .eq('org_id', orgId)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(2_000);

    if (error) {
      return { rows: [] as OrderRow[], error: true };
    }

    return { rows: (data ?? []) as unknown as OrderRow[], error: false };
  }
}

function emptyCatalogAggregates(note: string): CatalogAggregates {
  return {
    note,
    empty: true,
    productCount: 0,
    activeProductCount: 0,
    variantCount: 0,
    totalStockQty: 0,
    lowStockCount: 0,
    sampleLowStock: [],
  };
}

function emptySalesAggregates(note: string): SalesAggregates {
  return {
    note,
    empty: true,
    windowDays: SALES_WINDOW_DAYS,
    orderCount: 0,
    soldOrderCount: 0,
    revenueVnd: '0',
    cogsVnd: '0',
    grossProfitVnd: '0',
    byStatus: {},
    topSkus: [],
  };
}

function toVndString(value: string | number) {
  return toBigintVnd(value).toString();
}

function toBigintVnd(value: string | number | null | undefined) {
  if (value == null) {
    return 0n;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return 0n;
    }
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return 0n;
}

function createSupabaseServiceClient(): SupabaseLike {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
