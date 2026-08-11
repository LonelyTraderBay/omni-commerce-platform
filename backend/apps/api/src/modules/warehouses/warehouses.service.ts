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
import type { CreateWarehouseBody, TransferStockBody } from './dto';

export const WAREHOUSES_SUPABASE = Symbol('WAREHOUSES_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from' | 'rpc'>;

type SupabaseError = {
  code?: string;
  message?: string;
  hint?: string;
};

type WarehouseRow = {
  id: string;
  org_id: string;
  name: string;
  code: string;
  is_default: boolean;
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

type VariantStockRow = {
  org_id: string;
  warehouse_id: string;
  variant_id: string;
  qty: number;
  variant?: VariantRow | VariantRow[] | null;
  product_variants?: VariantRow | VariantRow[] | null;
};

type MovementPayload = {
  id: string;
  orgId: string;
  warehouseId: string | null;
  variantId: string;
  movementType: string;
  qtyDelta: number;
  stockAfter: number;
  orderId: string | null;
  reason: string | null;
  actorUserId: string | null;
  createdAt: string;
};

const WAREHOUSE_SELECT = 'id, org_id, name, code, is_default, created_at';
const VARIANT_SELECT =
  'id, org_id, product_id, sku, title, price_vnd, stock_qty, cogs_vnd, attrs_json, created_at, updated_at';
const STOCK_SELECT = `org_id, warehouse_id, variant_id, qty, product_variants(${VARIANT_SELECT})`;

@Injectable()
export class WarehousesService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(WAREHOUSES_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async listWarehouses(orgId: string) {
    const { data, error } = await this.supabase
      .from('warehouses')
      .select(WAREHOUSE_SELECT)
      .eq('org_id', orgId)
      .order('is_default', { ascending: false })
      .order('name', { ascending: true });

    if (error) {
      throwWarehouseError(error, 'Could not list warehouses');
    }

    return {
      warehouses: ((data ?? []) as WarehouseRow[]).map(mapWarehouse),
    };
  }

  async createWarehouse(orgId: string, body: CreateWarehouseBody) {
    const { data, error } = await this.supabase
      .from('warehouses')
      .insert({
        org_id: orgId,
        name: body.name,
        code: body.code,
        is_default: body.isDefault,
      })
      .select(WAREHOUSE_SELECT)
      .single();

    if (error) {
      throwWarehouseError(error, 'Could not create warehouse');
    }

    return { warehouse: mapWarehouse(data as WarehouseRow) };
  }

  async getWarehouseStock(orgId: string, warehouseId: string) {
    const warehouse = await this.requireWarehouse(orgId, warehouseId);
    const { data, error } = await this.supabase
      .from('variant_stocks')
      .select(STOCK_SELECT)
      .eq('org_id', orgId)
      .eq('warehouse_id', warehouseId)
      .order('qty', { ascending: true })
      .limit(500);

    if (error) {
      throwWarehouseError(error, 'Could not list warehouse stock');
    }

    return {
      warehouse: mapWarehouse(warehouse),
      stock: ((data ?? []) as VariantStockRow[]).map(mapVariantStock),
    };
  }

  async transferStock(
    orgId: string,
    body: TransferStockBody,
    actorUserId?: string,
  ) {
    const { data, error } = await this.supabase.rpc('transfer_stock', {
      p_org_id: orgId,
      p_from_warehouse_id: body.fromWarehouseId,
      p_to_warehouse_id: body.toWarehouseId,
      p_variant_id: body.variantId,
      p_qty: body.qty,
      p_actor_user_id: actorUserId ?? null,
      p_reason: body.reason ?? null,
    });

    if (error) {
      throwWarehouseError(error, 'Could not transfer stock');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'transfer_not_found',
        message: 'Transfer target was not found',
      });
    }

    return data as {
      variant: ReturnType<typeof mapVariant>;
      fromStock: { warehouseId: string; variantId: string; qty: number };
      toStock: { warehouseId: string; variantId: string; qty: number };
      movements: MovementPayload[];
    };
  }

  private async requireWarehouse(orgId: string, warehouseId: string) {
    const { data, error } = await this.supabase
      .from('warehouses')
      .select(WAREHOUSE_SELECT)
      .eq('org_id', orgId)
      .eq('id', warehouseId)
      .maybeSingle();

    if (error) {
      throwWarehouseError(error, 'Could not read warehouse');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'warehouse_not_found',
        message: 'Warehouse was not found',
      });
    }

    return data as WarehouseRow;
  }
}

function mapWarehouse(row: WarehouseRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    code: row.code,
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

function mapVariantStock(row: VariantStockRow) {
  const variant = unwrapVariant(row.product_variants ?? row.variant);
  return {
    orgId: row.org_id,
    warehouseId: row.warehouse_id,
    variantId: row.variant_id,
    qty: row.qty,
    variant: variant ? mapVariant(variant) : null,
  };
}

function unwrapVariant(
  value: VariantRow | VariantRow[] | null | undefined,
): VariantRow | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
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

function throwWarehouseError(error: SupabaseError, message: string): never {
  if (
    error.hint === 'invalid_qty' ||
    error.hint === 'invalid_warehouse' ||
    error.hint === 'insufficient_stock'
  ) {
    throw new BadRequestException({
      code: error.hint,
      message: error.message ?? message,
    });
  }

  if (
    error.hint === 'warehouse_not_found' ||
    error.hint === 'variant_not_found'
  ) {
    throw new NotFoundException({
      code: error.hint,
      message: error.message ?? message,
    });
  }

  if (error.code === '23505') {
    throw new BadRequestException({
      code: 'warehouse_code_exists',
      message: error.message ?? 'Warehouse code already exists',
    });
  }

  throw new InternalServerErrorException({
    code: 'warehouse_failed',
    message: error.message ?? message,
  });
}

function createSupabaseServiceClient(): SupabaseLike {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
