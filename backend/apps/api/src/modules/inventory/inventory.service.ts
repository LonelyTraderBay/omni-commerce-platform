import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadEnv } from '../../config/env';
import type {
  AdjustStockBody,
  ListMovementsQuery,
  LowStockQuery,
} from './dto';

export const INVENTORY_SUPABASE = Symbol('INVENTORY_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from' | 'rpc'>;

type SupabaseError = {
  code?: string;
  message?: string;
  hint?: string;
};

type MovementRow = {
  id: string;
  org_id: string;
  warehouse_id: string | null;
  variant_id: string;
  movement_type: string;
  qty_delta: number;
  stock_after: number;
  order_id: string | null;
  reason: string | null;
  actor_user_id: string | null;
  created_at: string;
};

type VariantRow = {
  id: string;
  org_id: string;
  product_id: string;
  sku: string;
  title: string;
  price_vnd: number | string;
  stock_qty: number;
  cogs_vnd: number | string;
  attrs_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type OrgRow = {
  low_stock_threshold: number;
};

const MOVEMENT_SELECT =
  'id, org_id, warehouse_id, variant_id, movement_type, qty_delta, stock_after, order_id, reason, actor_user_id, created_at';
const VARIANT_SELECT =
  'id, org_id, product_id, sku, title, price_vnd, stock_qty, cogs_vnd, attrs_json, created_at, updated_at';

@Injectable()
export class InventoryService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(INVENTORY_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async listMovements(orgId: string, query: ListMovementsQuery) {
    let builder = this.supabase
      .from('stock_movements')
      .select(MOVEMENT_SELECT)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(query.limit);

    if (query.variantId) {
      builder = builder.eq('variant_id', query.variantId);
    }

    const { data, error } = await builder;
    if (error) {
      throwInventoryError(error, 'Could not list stock movements');
    }

    return {
      movements: ((data ?? []) as MovementRow[]).map(mapMovement),
    };
  }

  async listLowStock(orgId: string, query: LowStockQuery) {
    const threshold =
      query.threshold ?? (await this.readOrgThreshold(orgId));

    const { data, error } = await this.supabase
      .from('product_variants')
      .select(VARIANT_SELECT)
      .eq('org_id', orgId)
      .lte('stock_qty', threshold)
      .order('stock_qty', { ascending: true })
      .limit(200);

    if (error) {
      throwInventoryError(error, 'Could not list low-stock variants');
    }

    return {
      threshold,
      variants: ((data ?? []) as VariantRow[]).map(mapVariant),
    };
  }

  async adjust(
    orgId: string,
    body: AdjustStockBody,
    actorUserId?: string,
  ) {
    const { data, error } = await this.supabase.rpc('adjust_variant_stock', {
      p_org_id: orgId,
      p_variant_id: body.variantId,
      p_qty_delta: body.qtyDelta,
      p_reason: body.reason ?? null,
      p_actor_user_id: actorUserId ?? null,
      p_movement_type: body.movementType,
    });

    if (error) {
      throwInventoryError(error, 'Could not adjust stock');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'product_variant_not_found',
        message: 'Product variant was not found',
      });
    }

    return data as {
      variant: ReturnType<typeof mapVariant>;
      movement: ReturnType<typeof mapMovement>;
    };
  }

  async setStockQty(input: {
    orgId: string;
    variantId: string;
    targetQty: number;
    reason?: string;
    actorUserId?: string;
  }) {
    const { data, error } = await this.supabase
      .from('product_variants')
      .select('stock_qty')
      .eq('org_id', input.orgId)
      .eq('id', input.variantId)
      .maybeSingle();

    if (error) {
      throwInventoryError(error, 'Could not read product variant stock');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'product_variant_not_found',
        message: 'Product variant was not found',
      });
    }

    const current = (data as { stock_qty: number }).stock_qty;
    const qtyDelta = input.targetQty - current;
    if (qtyDelta === 0) {
      const { data: variant, error: variantError } = await this.supabase
        .from('product_variants')
        .select(VARIANT_SELECT)
        .eq('org_id', input.orgId)
        .eq('id', input.variantId)
        .maybeSingle();

      if (variantError) {
        throwInventoryError(variantError, 'Could not read product variant');
      }
      if (!variant) {
        throw new NotFoundException({
          code: 'product_variant_not_found',
          message: 'Product variant was not found',
        });
      }

      return {
        variant: mapVariant(variant as VariantRow),
        movement: null,
      };
    }

    return this.adjust(
      input.orgId,
      {
        variantId: input.variantId,
        qtyDelta,
        reason: input.reason ?? 'catalog stockQty update',
        movementType: 'adjust',
      },
      input.actorUserId,
    );
  }

  private async readOrgThreshold(orgId: string) {
    const { data, error } = await this.supabase
      .from('organizations')
      .select('low_stock_threshold')
      .eq('id', orgId)
      .maybeSingle();

    if (error) {
      throwInventoryError(error, 'Could not read organization threshold');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'organization_not_found',
        message: 'Organization was not found',
      });
    }

    return (data as OrgRow).low_stock_threshold ?? 5;
  }
}

function mapMovement(row: MovementRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    warehouseId: row.warehouse_id,
    variantId: row.variant_id,
    movementType: row.movement_type,
    qtyDelta: row.qty_delta,
    stockAfter: row.stock_after,
    orderId: row.order_id,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  };
}

function mapVariant(row: VariantRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    productId: row.product_id,
    sku: row.sku,
    title: row.title,
    priceVnd: String(row.price_vnd),
    stockQty: row.stock_qty,
    cogsVnd: row.cogs_vnd?.toString() ?? '0',
    attrs: row.attrs_json ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function throwInventoryError(error: SupabaseError, message: string): never {
  if (
    error.hint === 'insufficient_stock' ||
    error.hint === 'invalid_qty_delta' ||
    error.hint === 'invalid_movement_type'
  ) {
    throw new BadRequestException({
      code: error.hint,
      message: error.message ?? message,
    });
  }

  throw new InternalServerErrorException({
    code: 'inventory_failed',
    message: error.message ?? message,
  });
}

function createSupabaseServiceClient(): SupabaseLike {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
