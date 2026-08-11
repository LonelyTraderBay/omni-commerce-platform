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
import { enqueueOutbox } from '../../jobs/outbox.publisher';
import { AuditService, type WriteAuditInput } from '../audit/audit.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { CodService } from '../cod/cod.service';
import type { CreateDraftOrderBody, OrderStatus, ReturnOrderBody } from './dto';
import {
  buildOrdersExport,
  type ExportFile,
  type ExportFormat,
  type ExportOrderRow,
} from './orders-export';

export const ORDERS_SUPABASE = Symbol('ORDERS_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from' | 'rpc'>;
export type AuditWriter = {
  writeAudit(input: WriteAuditInput): Promise<unknown>;
};
export type EntitlementsReader = Pick<EntitlementsService, 'getEntitlements'>;

type JsonObject = Record<string, unknown>;
type PaymentMethod = 'cod' | 'bank_transfer' | 'other';

type OrderRow = {
  id: string;
  org_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  status: OrderStatus;
  payment_method: PaymentMethod;
  customer_name: string | null;
  phone_e164: string | null;
  address_text: string | null;
  address_json: JsonObject;
  currency: 'VND';
  subtotal_vnd: number | string;
  shipping_fee_vnd: number | string;
  total_vnd: number | string;
  idempotency_key: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  click_id: string | null;
  confirmed_at: string | null;
  shipped_at: string | null;
  cancelled_at: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  items?: OrderItemRow[] | null;
};

type OrderItemRow = {
  id: string;
  product_id: string;
  variant_id: string;
  title_snapshot: string;
  sku_snapshot: string;
  qty: number;
  unit_price_vnd: number | string;
  line_total_vnd: number | string;
  cogs_unit_vnd: number | string;
};

type VariantRow = {
  id: string;
  org_id: string;
  product_id: string;
  sku: string;
  title: string;
  price_vnd: number | string;
  stock_qty: number;
  cogs_vnd?: number | string | null;
};

type OrganizationSettingsRow = {
  id: string;
  settings_json: JsonObject;
};

type VariantSnapshot = {
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  qty: number;
  unitPriceVnd: bigint;
  lineTotalVnd: bigint;
  cogsUnitVnd: bigint;
};

type SupabaseError = {
  code?: string;
  message?: string;
  hint?: string;
};

type IdempotencyRow = {
  key: string;
  method: string;
  path: string;
  status_code: number;
  response_json: JsonObject;
  expires_at: string | null;
};

type OrderPayload = {
  order: {
    id: string;
    status: OrderStatus;
    [key: string]: unknown;
  };
  items: unknown[];
};
type AutoConfirmOrderPayload = OrderPayload & {
  _idempotencyReplayed?: boolean;
};

type LifecycleRpcName =
  | 'confirm_order'
  | 'cancel_order'
  | 'ship_order'
  | 'return_order'
  | 'done_order';

const ORDER_SELECT =
  'id, org_id, conversation_id, contact_id, status, payment_method, customer_name, phone_e164, address_text, address_json, currency, subtotal_vnd, shipping_fee_vnd, total_vnd, idempotency_key, utm_source, utm_medium, utm_campaign, click_id, confirmed_at, shipped_at, cancelled_at, done_at, created_at, updated_at';
const ITEM_SELECT =
  'id, product_id, variant_id, title_snapshot, sku_snapshot, qty, unit_price_vnd, line_total_vnd, cogs_unit_vnd';
const ORDER_WITH_ITEMS_SELECT = `${ORDER_SELECT}, items:order_items(${ITEM_SELECT})`;
const VARIANT_SELECT =
  'id, org_id, product_id, sku, title, price_vnd, stock_qty, cogs_vnd';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_PENDING_STATUS = 102;

@Injectable()
export class OrdersService {
  private readonly supabase: SupabaseLike;
  private readonly audit: AuditWriter;
  private readonly entitlements?: EntitlementsReader;
  private readonly cod?: Pick<
    CodService,
    'ensureExpectationForOrder' | 'handleReturnedOrder'
  >;

  constructor(
    @Optional()
    @Inject(ORDERS_SUPABASE)
    supabase: SupabaseLike | undefined,
    @Inject(AuditService)
    audit: AuditWriter,
    @Optional()
    @Inject(EntitlementsService)
    entitlements?: EntitlementsReader,
    @Optional()
    @Inject(CodService)
    cod?: Pick<CodService, 'ensureExpectationForOrder' | 'handleReturnedOrder'>,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
    this.audit = audit;
    this.entitlements = entitlements;
    this.cod = cod;
  }

  async listOrders(input: { orgId: string; status?: OrderStatus }) {
    const rows = await this.fetchOrderRows({ ...input, limit: 100 });
    return { orders: rows.map((row) => mapOrder(row)) };
  }

  async exportOrders(input: {
    orgId: string;
    format: ExportFormat;
    status?: OrderStatus;
    createdFrom?: string;
    createdTo?: string;
  }): Promise<ExportFile> {
    const rows = await this.fetchOrderRows({
      ...input,
      limit: 5_000,
      includeItems: true,
    });
    const exportRows: ExportOrderRow[] = rows.flatMap((row) => {
      const base = {
        id: row.id,
        status: row.status,
        customerName: row.customer_name,
        phoneE164: row.phone_e164,
        addressText: row.address_text,
        paymentMethod: row.payment_method,
        totalVnd: row.total_vnd.toString(),
        createdAt: row.created_at,
        confirmedAt: row.confirmed_at,
        shippedAt: row.shipped_at,
      };
      const items = row.items ?? [];
      if (items.length === 0) {
        return [{ ...base, sku: '', qty: '', title: '' }];
      }
      return items.map((item) => ({
        ...base,
        sku: item.sku_snapshot,
        qty: String(item.qty),
        title: item.title_snapshot,
      }));
    });

    return buildOrdersExport(input.format, exportRows);
  }

  private async fetchOrderRows(input: {
    orgId: string;
    status?: OrderStatus;
    createdFrom?: string;
    createdTo?: string;
    limit: number;
    includeItems?: boolean;
  }) {
    let query = this.supabase
      .from('orders')
      .select(input.includeItems ? ORDER_WITH_ITEMS_SELECT : ORDER_SELECT)
      .eq('org_id', input.orgId);

    if (input.status) {
      query = query.eq('status', input.status);
    }
    if (input.createdFrom) {
      query = query.gte('created_at', input.createdFrom);
    }
    if (input.createdTo) {
      query = query.lte('created_at', input.createdTo);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(input.limit);

    if (error) {
      throwOrdersError(error, 'Could not list orders');
    }

    return (data ?? []) as unknown as OrderRow[];
  }

  async getOrder(input: { orgId: string; orderId: string }) {
    const order = await this.getOrderRow(input.orgId, input.orderId);
    return { order: mapOrder(order, { includeItems: true }) };
  }

  async createDraftOrder(input: {
    orgId: string;
    actorUserId: string;
    body: CreateDraftOrderBody;
    idempotencyKey?: string;
    path: string;
  }) {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const settings = await this.getOrgSettings(input.orgId);
    const items = await this.resolveOrderItems(input.orgId, input.body.items);

    await this.verifyOptionalOwner(
      'conversations',
      input.orgId,
      input.body.conversationId,
    );
    await this.verifyOptionalOwner(
      'contacts',
      input.orgId,
      input.body.contactId,
    );

    if (
      autoConfirmEnabled(settings.settings_json) &&
      (await this.autoConfirmAllowed(input.orgId))
    ) {
      const payload = await this.createAndConfirmOrderRpc(
        { ...input, idempotencyKey },
        items,
      );
      // No enqueue here. `order.created` and `order.confirmed` are written by
      // public.create_and_confirm_order itself, in the same transaction as the
      // order, its items, the stock decrement and the idempotency row
      // (20260729040000_create_and_confirm_order_transactional_outbox.sql).
      // Enqueuing them here as well would emit each event twice.
      //
      // The audit row stays out here: it is a separate concern, and writing it
      // is not what this fix was about. It is still guarded on `!replayed`, and
      // for the audit alone that guard now reads as "only the call that
      // actually created the order logs the confirmation" — a replay returns
      // the first call's response and must not append a second audit entry.
      // Unlike the events, a lost audit row is not silently unrecoverable: the
      // order itself records `confirmed_at`.
      if (!payload.replayed) {
        await this.writeOrderConfirmedAudit({
          orgId: input.orgId,
          orderId: payload.response.order.id,
          actorUserId: input.actorUserId,
          autoConfirm: true,
        });
      }
      return payload.response;
    }

    return this.withIdempotency(
      {
        orgId: input.orgId,
        key: idempotencyKey,
        method: 'POST',
        path: input.path,
        statusCode: 201,
      },
      async () => {
        const payload = await this.createDraftOrderRpc(
          { ...input, idempotencyKey },
          items,
        );
        await this.enqueueOrderEvent({
          orgId: input.orgId,
          orderId: payload.order.id,
          event: 'order.created',
          status: 'draft',
        });
        return payload;
      },
    );
  }

  async confirmOrder(input: {
    orgId: string;
    orderId: string;
    actorUserId: string;
    idempotencyKey?: string;
    path?: string;
    now?: Date;
    autoConfirm?: boolean;
  }) {
    return this.withIdempotency(
      {
        orgId: input.orgId,
        key: input.idempotencyKey,
        method: 'POST',
        path: input.path ?? `/v1/orders/${input.orderId}/confirm`,
        statusCode: 200,
      },
      async () => {
        const payload = await this.callLifecycleRpc('confirm_order', {
          p_org_id: input.orgId,
          p_order_id: input.orderId,
          p_confirmed_at: (input.now ?? new Date()).toISOString(),
        });

        await this.writeOrderConfirmedAudit({
          orgId: input.orgId,
          orderId: input.orderId,
          actorUserId: input.actorUserId,
          autoConfirm: input.autoConfirm === true,
        });
        await this.enqueueOrderEvent({
          orgId: input.orgId,
          orderId: input.orderId,
          event: 'order.confirmed',
          status: 'confirmed',
        });

        return payload;
      },
    );
  }

  async cancelOrder(input: {
    orgId: string;
    orderId: string;
    actorUserId: string;
    now?: Date;
  }) {
    const payload = await this.callLifecycleRpc('cancel_order', {
      p_org_id: input.orgId,
      p_order_id: input.orderId,
      p_cancelled_at: (input.now ?? new Date()).toISOString(),
    });

    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'order.cancelled',
      entityType: 'order',
      entityId: input.orderId,
      meta: {},
    });
    await this.enqueueOrderEvent({
      orgId: input.orgId,
      orderId: input.orderId,
      event: 'order.cancelled',
      status: 'cancelled',
    });

    return payload;
  }

  async shipOrder(input: {
    orgId: string;
    orderId: string;
    actorUserId: string;
    now?: Date;
  }) {
    const payload = await this.callLifecycleRpc('ship_order', {
      p_org_id: input.orgId,
      p_order_id: input.orderId,
      p_shipped_at: (input.now ?? new Date()).toISOString(),
    });

    await this.cod?.ensureExpectationForOrder({
      orgId: input.orgId,
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      order: payload.order,
    });

    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'order.shipped',
      entityType: 'order',
      entityId: input.orderId,
      meta: {},
    });
    await this.enqueueOrderEvent({
      orgId: input.orgId,
      orderId: input.orderId,
      event: 'order.shipped',
      status: 'shipped',
    });

    return payload;
  }

  async returnOrder(input: {
    orgId: string;
    orderId: string;
    actorUserId: string;
    body?: ReturnOrderBody;
    now?: Date;
  }) {
    const restock = input.body?.restock ?? true;
    const reason = input.body?.reason ?? null;
    const payload = await this.callLifecycleRpc('return_order', {
      p_org_id: input.orgId,
      p_order_id: input.orderId,
      p_reason: reason,
      p_restock: restock,
      p_at: (input.now ?? new Date()).toISOString(),
      p_actor_user_id: input.actorUserId,
    });

    await this.cod?.handleReturnedOrder({
      orgId: input.orgId,
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      order: payload.order,
      reason,
    });

    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'order.returned',
      entityType: 'order',
      entityId: input.orderId,
      meta: {
        restock,
        reason,
      },
    });
    await this.enqueueOrderEvent({
      orgId: input.orgId,
      orderId: input.orderId,
      event: 'order.returned',
      status: 'returned',
    });

    return payload;
  }

  async markOrderDone(input: {
    orgId: string;
    orderId: string;
    actorUserId: string;
    now?: Date;
  }) {
    const payload = await this.callLifecycleRpc('done_order', {
      p_org_id: input.orgId,
      p_order_id: input.orderId,
      p_done_at: (input.now ?? new Date()).toISOString(),
    });

    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'order.done',
      entityType: 'order',
      entityId: input.orderId,
      meta: {},
    });
    await this.enqueueOrderEvent({
      orgId: input.orgId,
      orderId: input.orderId,
      event: 'order.done',
      status: 'done',
    });

    return payload;
  }

  private async createDraftOrderRpc(
    input: {
      orgId: string;
      body: CreateDraftOrderBody;
      idempotencyKey?: string;
    },
    items: VariantSnapshot[],
  ) {
    const { data, error } = await this.supabase.rpc('create_draft_order', {
      p_org_id: input.orgId,
      p_conversation_id: input.body.conversationId ?? null,
      p_contact_id: input.body.contactId ?? null,
      p_payment_method: input.body.paymentMethod,
      p_customer_name: input.body.customerName ?? null,
      p_phone_e164: input.body.phoneE164 ?? null,
      p_address_text: input.body.addressText ?? null,
      p_address_json: input.body.addressJson,
      p_idempotency_key: input.idempotencyKey ?? null,
      p_utm_source: input.body.utmSource ?? null,
      p_utm_medium: input.body.utmMedium ?? null,
      p_utm_campaign: input.body.utmCampaign ?? null,
      p_click_id: input.body.clickId ?? null,
      p_items: items.map((item) => ({
        product_id: item.productId,
        variant_id: item.variantId,
        title_snapshot: item.title,
        sku_snapshot: item.sku,
        qty: item.qty,
        unit_price_vnd: item.unitPriceVnd.toString(),
        line_total_vnd: item.lineTotalVnd.toString(),
        cogs_unit_vnd: item.cogsUnitVnd.toString(),
      })),
    });

    if (error) {
      if (error.code === '23505' && input.idempotencyKey) {
        return this.getOrderByIdempotencyKey(input.orgId, input.idempotencyKey);
      }
      throwOrdersError(error, 'Could not create draft order');
    }

    return data as OrderPayload;
  }

  private async createAndConfirmOrderRpc(
    input: {
      orgId: string;
      body: CreateDraftOrderBody;
      idempotencyKey: string;
      path: string;
    },
    items: VariantSnapshot[],
  ) {
    const { data, error } = await this.supabase.rpc(
      'create_and_confirm_order',
      {
        p_org_id: input.orgId,
        p_conversation_id: input.body.conversationId ?? null,
        p_contact_id: input.body.contactId ?? null,
        p_payment_method: input.body.paymentMethod,
        p_customer_name: input.body.customerName ?? null,
        p_phone_e164: input.body.phoneE164 ?? null,
        p_address_text: input.body.addressText ?? null,
        p_address_json: input.body.addressJson,
        p_idempotency_key: input.idempotencyKey,
        p_utm_source: input.body.utmSource ?? null,
        p_utm_medium: input.body.utmMedium ?? null,
        p_utm_campaign: input.body.utmCampaign ?? null,
        p_click_id: input.body.clickId ?? null,
        p_items: items.map((item) => ({
          product_id: item.productId,
          variant_id: item.variantId,
          title_snapshot: item.title,
          sku_snapshot: item.sku,
          qty: item.qty,
          unit_price_vnd: item.unitPriceVnd.toString(),
          line_total_vnd: item.lineTotalVnd.toString(),
          cogs_unit_vnd: item.cogsUnitVnd.toString(),
        })),
        p_method: 'POST',
        p_path: input.path,
        p_status_code: 201,
        p_confirmed_at: new Date().toISOString(),
      },
    );

    if (error) {
      throwOrdersError(error, 'Could not create and confirm order');
    }

    const response = data as AutoConfirmOrderPayload;
    const replayed = response._idempotencyReplayed === true;
    delete response._idempotencyReplayed;

    return { response, replayed };
  }

  private async callLifecycleRpc(
    rpc: LifecycleRpcName,
    args: Record<string, unknown>,
  ) {
    const { data, error } = await this.supabase.rpc(rpc, args);

    if (error) {
      throwOrdersError(error, `Could not ${rpc.replace('_order', '')} order`);
    }
    if (!data) {
      throw new NotFoundException({
        code: 'order_not_found',
        message: 'Order was not found',
      });
    }

    return data as OrderPayload;
  }

  private async getOrderRow(orgId: string, orderId: string) {
    const { data, error } = await this.supabase
      .from('orders')
      .select(ORDER_WITH_ITEMS_SELECT)
      .eq('id', orderId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      throwOrdersError(error, 'Could not get order');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'order_not_found',
        message: 'Order was not found',
      });
    }

    return data as unknown as OrderRow;
  }

  private async getOrderByIdempotencyKey(orgId: string, key: string) {
    const { data, error } = await this.supabase
      .from('orders')
      .select(ORDER_WITH_ITEMS_SELECT)
      .eq('org_id', orgId)
      .eq('idempotency_key', key)
      .maybeSingle();

    if (error) {
      throwOrdersError(error, 'Could not load idempotent order');
    }
    if (!data) {
      throw new ConflictException({
        code: 'idempotency_conflict',
        message: 'Idempotent request is already in progress',
      });
    }

    return {
      order: mapOrder(data as unknown as OrderRow, { includeItems: true }),
      items: ((data as unknown as OrderRow).items ?? []).map(mapOrderItem),
    };
  }

  private async getOrgSettings(orgId: string) {
    const { data, error } = await this.supabase
      .from('organizations')
      .select('id, settings_json')
      .eq('id', orgId)
      .maybeSingle();

    if (error) {
      throwOrdersError(error, 'Could not read organization settings');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'organization_not_found',
        message: 'Organization was not found',
      });
    }

    return data as OrganizationSettingsRow;
  }

  private async autoConfirmAllowed(orgId: string) {
    if (!this.entitlements) {
      return false;
    }

    const entitlements = await this.entitlements.getEntitlements(orgId);
    return entitlements.autoConfirmAllowed === true;
  }

  private async resolveOrderItems(
    orgId: string,
    items: CreateDraftOrderBody['items'],
  ) {
    const snapshots: VariantSnapshot[] = [];
    const verifiedProducts = new Set<string>();

    for (const item of items) {
      const variant = await this.getVariant(orgId, item.variantId);

      if (!verifiedProducts.has(variant.product_id)) {
        await this.verifyActiveProduct(orgId, variant.product_id);
        verifiedProducts.add(variant.product_id);
      }

      const unitPriceVnd = toBigintVnd(variant.price_vnd);
      const cogsUnitVnd = toBigintVnd(variant.cogs_vnd ?? '0');
      snapshots.push({
        productId: variant.product_id,
        variantId: variant.id,
        sku: variant.sku,
        title: variant.title,
        qty: item.qty,
        unitPriceVnd,
        lineTotalVnd: unitPriceVnd * BigInt(item.qty),
        cogsUnitVnd,
      });
    }

    return snapshots;
  }

  private async getVariant(orgId: string, variantId: string) {
    const { data, error } = await this.supabase
      .from('product_variants')
      .select(VARIANT_SELECT)
      .eq('id', variantId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      throwOrdersError(error, 'Could not read product variant');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'product_variant_not_found',
        message: 'Product variant was not found',
      });
    }

    return data as VariantRow;
  }

  private async verifyActiveProduct(orgId: string, productId: string) {
    const { data, error } = await this.supabase
      .from('products')
      .select('id')
      .eq('id', productId)
      .eq('org_id', orgId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      throwOrdersError(error, 'Could not verify product');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'product_not_found',
        message: 'Product was not found',
      });
    }
  }

  private async verifyOptionalOwner(
    table: 'contacts' | 'conversations',
    orgId: string,
    id: string | null | undefined,
  ) {
    if (!id) {
      return;
    }

    const { data, error } = await this.supabase
      .from(table)
      .select('id')
      .eq('id', id)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      throwOrdersError(error, `Could not verify ${table} ownership`);
    }
    if (!data) {
      throw new NotFoundException({
        code: `${table.slice(0, -1)}_not_found`,
        message: `${table.slice(0, -1)} was not found`,
      });
    }
  }

  private async writeOrderConfirmedAudit(input: {
    orgId: string;
    orderId: string;
    actorUserId: string;
    autoConfirm: boolean;
  }) {
    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: input.autoConfirm ? 'system' : 'user',
      action: 'order.confirmed',
      entityType: 'order',
      entityId: input.orderId,
      meta: {
        autoConfirm: input.autoConfirm,
      },
    });
  }

  private async enqueueOrderEvent(input: {
    orgId: string;
    orderId: string;
    event:
      | 'order.created'
      | 'order.confirmed'
      | 'order.cancelled'
      | 'order.shipped'
      | 'order.returned'
      | 'order.done';
    status: OrderStatus;
  }) {
    await enqueueOutbox(this.supabase, {
      orgId: input.orgId,
      eventName: input.event,
      payload: {
        event: input.event,
        orderId: input.orderId,
        status: input.status,
      },
    });
  }

  private async withIdempotency<T extends JsonObject>(
    input: {
      orgId: string;
      key?: string;
      method: string;
      path: string;
      statusCode: number;
    },
    handler: () => Promise<T>,
  ) {
    const key = input.key?.trim();
    if (!key) {
      return handler();
    }
    if (key.length > 128) {
      throw new BadRequestException({
        code: 'invalid_idempotency_key',
        message: 'Idempotency-Key must be at most 128 characters',
      });
    }

    const claimed = await this.claimIdempotencyKey(input.orgId, key, input);
    if (!claimed) {
      const existing = await this.getIdempotencyRow(input.orgId, key);
      if (!existing) {
        throw new ConflictException({
          code: 'idempotency_conflict',
          message: 'Idempotent request is already in progress',
        });
      }
      return this.resolveIdempotencyReplay(existing, input);
    }

    try {
      const response = await handler();
      await this.completeIdempotencyKey(
        input.orgId,
        key,
        input.statusCode,
        response,
      );
      return response;
    } catch (error) {
      await this.releaseIdempotencyKey(input.orgId, key);
      throw error;
    }
  }

  private resolveIdempotencyReplay<T extends JsonObject>(
    row: IdempotencyRow,
    input: { method: string; path: string },
  ): T {
    if (this.isPendingIdempotency(row)) {
      throw new ConflictException({
        code: 'idempotency_conflict',
        message: 'Idempotent request is already in progress',
      });
    }
    if (row.method !== input.method || row.path !== input.path) {
      throw new ConflictException({
        code: 'idempotency_key_reused',
        message: 'Idempotency-Key was already used for another request',
      });
    }
    return row.response_json as T;
  }

  private isPendingIdempotency(row: IdempotencyRow) {
    return row.status_code === IDEMPOTENCY_PENDING_STATUS;
  }

  // `expires_at` is nullable: a row without an expiry never expires.
  private isExpiredIdempotency(row: IdempotencyRow, now = Date.now()) {
    if (!row.expires_at) {
      return false;
    }
    const expiresAt = Date.parse(row.expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= now;
  }

  private async claimIdempotencyKey(
    orgId: string,
    key: string,
    input: { method: string; path: string },
  ) {
    const { error } = await this.supabase.from('idempotency_keys').insert({
      org_id: orgId,
      key,
      ...this.buildIdempotencyClaim(input),
    });

    if (error?.code === '23505') {
      // A row already exists. It may be a leftover from a request that never
      // finished (process killed between the committed claim and
      // complete/release) or a completed row past its TTL — both are stale and
      // must be reclaimable, otherwise the key is wedged forever.
      return this.reclaimExpiredIdempotencyKey(orgId, key, input);
    }
    if (error) {
      throwOrdersError(error, 'Could not claim idempotency key');
    }
    return true;
  }

  private buildIdempotencyClaim(input: { method: string; path: string }) {
    return {
      method: input.method,
      path: input.path,
      status_code: IDEMPOTENCY_PENDING_STATUS,
      response_json: { _pending: true },
      expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
    };
  }

  /**
   * Take over an expired row as a fresh pending claim.
   *
   * The update is conditional on the row still being expired
   * (`expires_at < now`), so when two requests race to reclaim the same key
   * only one can match: Postgres re-evaluates the WHERE clause against the
   * winner's committed row version, which by then carries a future
   * `expires_at`. The loser matches zero rows and falls back to the normal
   * replay/conflict path. Rows with a NULL `expires_at` never match and keep
   * today's behaviour.
   */
  private async reclaimExpiredIdempotencyKey(
    orgId: string,
    key: string,
    input: { method: string; path: string },
  ) {
    const nowIso = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('idempotency_keys')
      .update(this.buildIdempotencyClaim(input))
      .eq('org_id', orgId)
      .eq('key', key)
      .lt('expires_at', nowIso)
      .select('key');

    if (error) {
      throwOrdersError(error, 'Could not claim idempotency key');
    }

    return Array.isArray(data) && data.length > 0;
  }

  private async completeIdempotencyKey(
    orgId: string,
    key: string,
    statusCode: number,
    response: JsonObject,
  ) {
    const { error } = await this.supabase
      .from('idempotency_keys')
      .update({
        status_code: statusCode,
        response_json: response,
      })
      .eq('org_id', orgId)
      .eq('key', key);

    if (error) {
      throwOrdersError(error, 'Could not persist idempotency key');
    }
  }

  private async releaseIdempotencyKey(orgId: string, key: string) {
    await this.supabase
      .from('idempotency_keys')
      .delete()
      .eq('org_id', orgId)
      .eq('key', key);
  }

  private async getIdempotencyRow(orgId: string, key: string) {
    const { data, error } = await this.supabase
      .from('idempotency_keys')
      .select('key, method, path, status_code, response_json, expires_at')
      .eq('org_id', orgId)
      .eq('key', key)
      .maybeSingle();

    if (error) {
      throwOrdersError(error, 'Could not read idempotency key');
    }

    const row = data as IdempotencyRow | null;
    // An expired row carries no idempotency guarantee any more: report it as
    // absent so it is never replayed and never reported as "in progress".
    if (!row || this.isExpiredIdempotency(row)) {
      return null;
    }
    return row;
  }
}

function mapOrder(row: OrderRow, options: { includeItems?: boolean } = {}) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    status: row.status,
    paymentMethod: row.payment_method,
    customerName: row.customer_name,
    phoneE164: row.phone_e164,
    addressText: row.address_text,
    addressJson: row.address_json,
    currency: row.currency,
    subtotalVnd: row.subtotal_vnd.toString(),
    shippingFeeVnd: row.shipping_fee_vnd?.toString() ?? '0',
    totalVnd: row.total_vnd.toString(),
    idempotencyKey: row.idempotency_key,
    utmSource: row.utm_source ?? null,
    utmMedium: row.utm_medium ?? null,
    utmCampaign: row.utm_campaign ?? null,
    clickId: row.click_id ?? null,
    confirmedAt: row.confirmed_at,
    shippedAt: row.shipped_at,
    cancelledAt: row.cancelled_at,
    doneAt: row.done_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(options.includeItems
      ? { items: (row.items ?? []).map(mapOrderItem) }
      : {}),
  };
}

function mapOrderItem(row: OrderItemRow) {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id,
    titleSnapshot: row.title_snapshot,
    skuSnapshot: row.sku_snapshot,
    qty: row.qty,
    unitPriceVnd: row.unit_price_vnd.toString(),
    lineTotalVnd: row.line_total_vnd.toString(),
    cogsUnitVnd: row.cogs_unit_vnd?.toString() ?? '0',
  };
}

function autoConfirmEnabled(settings: JsonObject) {
  return settings.auto_confirm === true || settings.autoConfirm === true;
}

function requireIdempotencyKey(idempotencyKey: string | undefined) {
  const key = idempotencyKey?.trim();
  if (!key) {
    throw new BadRequestException({
      code: 'missing_idempotency_key',
      message: 'Idempotency-Key header is required',
    });
  }
  if (key.length > 128) {
    throw new BadRequestException({
      code: 'invalid_idempotency_key',
      message: 'Idempotency-Key must be at most 128 characters',
    });
  }

  return key;
}

function toBigintVnd(value: string | number) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InternalServerErrorException({
        code: 'invalid_catalog_price',
        message: 'Catalog price must be a non-negative integer VND amount',
      });
    }
    return BigInt(value);
  }

  if (!/^\d+$/.test(value)) {
    throw new InternalServerErrorException({
      code: 'invalid_catalog_price',
      message: 'Catalog price must be a non-negative integer VND amount',
    });
  }
  return BigInt(value);
}

function throwOrdersError(error: SupabaseError, message: string): never {
  if (error.code === '23505') {
    throw new ConflictException({
      code: 'orders_conflict',
      message: error.message ?? message,
    });
  }
  if (error.code === '22023' || error.hint === 'invalid_order_items') {
    throw new BadRequestException({
      code: 'invalid_order',
      message: error.message ?? message,
    });
  }
  if (error.hint === 'insufficient_stock') {
    throw new BadRequestException({
      code: 'insufficient_stock',
      message: 'Insufficient stock to confirm order',
    });
  }
  if (error.hint === 'warehouse_not_found') {
    throw new BadRequestException({
      code: 'warehouse_not_found',
      message: 'Default warehouse is missing for this organization',
    });
  }
  if (error.hint === 'invalid_order_status') {
    throw new BadRequestException({
      code: 'invalid_order_status',
      message: error.message ?? message,
    });
  }
  if (error.hint === 'invalid_idempotency_key') {
    throw new BadRequestException({
      code: 'invalid_idempotency_key',
      message: error.message ?? 'Idempotency-Key is invalid',
    });
  }
  if (error.hint === 'idempotency_conflict') {
    throw new ConflictException({
      code: 'idempotency_conflict',
      message: 'Idempotent request is already in progress',
    });
  }
  if (error.hint === 'idempotency_key_reused') {
    throw new ConflictException({
      code: 'idempotency_key_reused',
      message: 'Idempotency-Key was already used for another request',
    });
  }

  throw new InternalServerErrorException({
    code: 'orders_failed',
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
