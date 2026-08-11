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
  CreatePurchaseOrderBody,
  CreateSupplierBody,
  PurchaseOrderStatus,
  ReceivePurchaseOrderBody,
  UpdatePurchaseOrderStatusBody,
} from './dto';

export const SUPPLIER_PO_SUPABASE = Symbol('SUPPLIER_PO_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from' | 'rpc'>;

type SupplierRow = {
  id: string;
  org_id: string;
  name: string;
  tax_code: string | null;
  email: string | null;
  phone: string | null;
  address_text: string | null;
  created_at: string;
  updated_at: string;
};

type PurchaseOrderItemRow = {
  id: string;
  org_id: string;
  purchase_order_id: string;
  variant_id: string;
  qty: number;
  unit_cost_vnd: string | number;
  created_at: string;
};

type PurchaseOrderRow = {
  id: string;
  org_id: string;
  supplier_id: string;
  warehouse_id: string | null;
  status: PurchaseOrderStatus;
  note: string | null;
  ordered_at: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
  supplier?: SupplierRow | SupplierRow[] | null;
  suppliers?: SupplierRow | SupplierRow[] | null;
  items?: PurchaseOrderItemRow[] | null;
  purchase_order_items?: PurchaseOrderItemRow[] | null;
};

type SupabaseError = {
  code?: string;
  message?: string;
  hint?: string;
};

type ReceivePoPayload = {
  purchaseOrderId: string;
  warehouseId?: string;
  status: PurchaseOrderStatus;
  receivedAt: string | null;
  movements: Array<Record<string, unknown>>;
};

const SUPPLIER_SELECT =
  'id, org_id, name, tax_code, email, phone, address_text, created_at, updated_at';
const ITEM_SELECT =
  'id, org_id, purchase_order_id, variant_id, qty, unit_cost_vnd, created_at';
const PO_SELECT =
  'id, org_id, supplier_id, warehouse_id, status, note, ordered_at, received_at, created_at, updated_at';
const PO_WITH_ITEMS_SELECT = `${PO_SELECT}, supplier:suppliers(${SUPPLIER_SELECT}), items:purchase_order_items(${ITEM_SELECT})`;

@Injectable()
export class SupplierPoService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(SUPPLIER_PO_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async listSuppliers(orgId: string) {
    const { data, error } = await this.supabase
      .from('suppliers')
      .select(SUPPLIER_SELECT)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      throwSupplierPoError(error, 'Could not list suppliers');
    }

    return { suppliers: ((data ?? []) as SupplierRow[]).map(mapSupplier) };
  }

  async createSupplier(orgId: string, body: CreateSupplierBody) {
    const { data, error } = await this.supabase
      .from('suppliers')
      .insert({
        org_id: orgId,
        name: body.name,
        tax_code: body.taxCode ?? null,
        email: body.email ?? null,
        phone: body.phone ?? null,
        address_text: body.addressText ?? null,
      })
      .select(SUPPLIER_SELECT)
      .single();

    if (error) {
      throwSupplierPoError(error, 'Could not create supplier');
    }

    return { supplier: mapSupplier(data as SupplierRow) };
  }

  async listPurchaseOrders(orgId: string, status?: PurchaseOrderStatus) {
    let query = this.supabase
      .from('purchase_orders')
      .select(PO_WITH_ITEMS_SELECT)
      .eq('org_id', orgId);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      throwSupplierPoError(error, 'Could not list purchase orders');
    }

    return {
      purchaseOrders: ((data ?? []) as PurchaseOrderRow[]).map(
        mapPurchaseOrder,
      ),
    };
  }

  async createPurchaseOrder(orgId: string, body: CreatePurchaseOrderBody) {
    const now = new Date().toISOString();
    const { data: poRow, error: poError } = await this.supabase
      .from('purchase_orders')
      .insert({
        org_id: orgId,
        supplier_id: body.supplierId,
        warehouse_id: body.warehouseId ?? null,
        status: body.status,
        note: body.note ?? null,
        ordered_at: body.status === 'ordered' ? now : null,
      })
      .select(PO_SELECT)
      .single();

    if (poError) {
      throwSupplierPoError(poError, 'Could not create purchase order');
    }

    const purchaseOrderId = (poRow as PurchaseOrderRow).id;
    const { error: itemError } = await this.supabase
      .from('purchase_order_items')
      .insert(
        body.items.map((item) => ({
          org_id: orgId,
          purchase_order_id: purchaseOrderId,
          variant_id: item.variantId,
          qty: item.qty,
          unit_cost_vnd: item.unitCostVnd,
        })),
      );

    if (itemError) {
      await this.markPurchaseOrderCancelled(orgId, purchaseOrderId);
      throwSupplierPoError(itemError, 'Could not create purchase order items');
    }

    return this.getPurchaseOrder(orgId, purchaseOrderId);
  }

  async updatePurchaseOrderStatus(
    orgId: string,
    purchaseOrderId: string,
    body: UpdatePurchaseOrderStatusBody,
  ) {
    const current = await this.requirePurchaseOrder(orgId, purchaseOrderId);
    if (current.status === 'received') {
      throw new BadRequestException({
        code: 'purchase_order_received',
        message: 'Received purchase orders cannot change status',
      });
    }

    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('purchase_orders')
      .update({
        status: body.status,
        ordered_at:
          body.status === 'ordered' ? current.orderedAt ?? now : current.orderedAt,
        updated_at: now,
      })
      .eq('org_id', orgId)
      .eq('id', purchaseOrderId)
      .select(PO_WITH_ITEMS_SELECT)
      .single();

    if (error) {
      throwSupplierPoError(error, 'Could not update purchase order');
    }

    return { purchaseOrder: mapPurchaseOrder(data as PurchaseOrderRow) };
  }

  async receivePurchaseOrder(
    orgId: string,
    purchaseOrderId: string,
    body: ReceivePurchaseOrderBody,
    actorUserId?: string,
  ) {
    const { data, error } = await this.supabase.rpc('receive_po', {
      p_org_id: orgId,
      p_purchase_order_id: purchaseOrderId,
      p_warehouse_id: body.warehouseId,
      p_actor_user_id: actorUserId ?? null,
    });

    if (error) {
      throwSupplierPoError(error, 'Could not receive purchase order');
    }

    const refreshed = await this.getPurchaseOrder(orgId, purchaseOrderId);
    return {
      ...refreshed,
      receive: data as ReceivePoPayload,
    };
  }

  private async getPurchaseOrder(orgId: string, purchaseOrderId: string) {
    const { data, error } = await this.supabase
      .from('purchase_orders')
      .select(PO_WITH_ITEMS_SELECT)
      .eq('org_id', orgId)
      .eq('id', purchaseOrderId)
      .maybeSingle();

    if (error) {
      throwSupplierPoError(error, 'Could not read purchase order');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'purchase_order_not_found',
        message: 'Purchase order was not found',
      });
    }

    return { purchaseOrder: mapPurchaseOrder(data as PurchaseOrderRow) };
  }

  private async requirePurchaseOrder(orgId: string, purchaseOrderId: string) {
    return (await this.getPurchaseOrder(orgId, purchaseOrderId)).purchaseOrder;
  }

  private async markPurchaseOrderCancelled(
    orgId: string,
    purchaseOrderId: string,
  ) {
    await this.supabase
      .from('purchase_orders')
      .update({
        status: 'cancelled',
        note: 'Auto-cancelled after item insert failed',
        updated_at: new Date().toISOString(),
      })
      .eq('org_id', orgId)
      .eq('id', purchaseOrderId);
  }
}

function mapSupplier(row: SupplierRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    taxCode: row.tax_code,
    email: row.email,
    phone: row.phone,
    addressText: row.address_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPurchaseOrder(row: PurchaseOrderRow) {
  const items = row.items ?? row.purchase_order_items ?? [];
  return {
    id: row.id,
    orgId: row.org_id,
    supplierId: row.supplier_id,
    warehouseId: row.warehouse_id,
    status: row.status,
    note: row.note,
    orderedAt: row.ordered_at,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    supplier: mapMaybeSupplier(row.supplier ?? row.suppliers),
    items: items.map(mapPurchaseOrderItem),
  };
}

function mapPurchaseOrderItem(row: PurchaseOrderItemRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    purchaseOrderId: row.purchase_order_id,
    variantId: row.variant_id,
    qty: row.qty,
    unitCostVnd: String(row.unit_cost_vnd),
    createdAt: row.created_at,
  };
}

function mapMaybeSupplier(
  value: SupplierRow | SupplierRow[] | null | undefined,
) {
  if (!value) {
    return null;
  }
  const row = Array.isArray(value) ? value[0] : value;
  return row ? mapSupplier(row) : null;
}

function throwSupplierPoError(error: SupabaseError, message: string): never {
  if (
    error.hint === 'invalid_purchase_order_status' ||
    error.hint === 'invalid_purchase_order_items' ||
    error.hint === 'purchase_order_receive_mismatch'
  ) {
    throw new BadRequestException({
      code: error.hint,
      message: error.message ?? message,
    });
  }

  if (
    error.hint === 'purchase_order_not_found' ||
    error.hint === 'warehouse_not_found'
  ) {
    throw new NotFoundException({
      code: error.hint,
      message: error.message ?? message,
    });
  }

  if (error.code === '23505') {
    throw new BadRequestException({
      code: 'supplier_or_purchase_order_conflict',
      message: error.message ?? 'Supplier or purchase order already exists',
    });
  }

  if (error.code === '23503') {
    throw new BadRequestException({
      code: 'invalid_purchase_order_reference',
      message: error.message ?? 'Supplier, warehouse, or variant was not found',
    });
  }

  throw new InternalServerErrorException({
    code: 'supplier_po_failed',
    message: error.message ?? message,
  });
}

function createSupabaseServiceClient(): SupabaseLike {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
