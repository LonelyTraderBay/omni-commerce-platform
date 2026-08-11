import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  decryptToken,
  encryptToken,
} from '../../common/crypto/token-crypto';
import { loadEnv, type Env } from '../../config/env';
import { enqueueOutbox } from '../../jobs/outbox.publisher';
import { AuditService, type WriteAuditInput } from '../audit/audit.service';
import { CodService } from '../cod/cod.service';
import type {
  CreateShipmentBody,
  ShippingProviderBody,
  UpsertCarrierConnectionBody,
} from './dto';
import { GhnShippingProvider, type FetchLike } from './ghn-shipping.provider';
import { ManualShippingProvider } from './manual-shipping.provider';
import type {
  CreateShipmentResult,
  ShippingConnection,
  ShippingOrder,
  ShippingProvider,
  ShippingProviderCode,
} from './shipping-provider';

export const SHIPPING_SUPABASE = Symbol('SHIPPING_SUPABASE');
export const SHIPPING_ENV = Symbol('SHIPPING_ENV');
export const SHIPPING_FETCH = Symbol('SHIPPING_FETCH');

export type SupabaseLike = Pick<SupabaseClient, 'from' | 'rpc'>;
export type AuditWriter = {
  writeAudit(input: WriteAuditInput): Promise<unknown>;
};
export type ShippingEnv = Pick<
  Env,
  'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY' | 'TOKEN_ENCRYPTION_KEY'
>;

type JsonObject = Record<string, unknown>;

type CarrierConnectionRow = {
  id: string;
  org_id: string;
  provider: ShippingProviderCode;
  display_name: string;
  credentials_enc: string | null;
  config_json: JsonObject;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type OrderStatus = 'draft' | 'confirmed' | 'shipped' | 'done' | 'cancelled' | 'returned';
type PaymentMethod = 'cod' | 'bank_transfer' | 'other';

type OrderRow = {
  id: string;
  org_id: string;
  status: OrderStatus;
  payment_method: PaymentMethod;
  customer_name: string | null;
  phone_e164: string | null;
  address_text: string | null;
  address_json: JsonObject;
  total_vnd: string | number;
  items?: OrderItemRow[] | null;
};

type OrderItemRow = {
  id: string;
  product_id: string;
  variant_id: string;
  title_snapshot: string;
  sku_snapshot: string;
  qty: number;
  unit_price_vnd: string | number;
  line_total_vnd: string | number;
};

type ShipmentRow = {
  id: string;
  org_id: string;
  order_id: string;
  carrier_connection_id: string | null;
  provider: ShippingProviderCode;
  external_shipment_id: string | null;
  tracking_code: string | null;
  status: string;
  fee_vnd: string | number;
  label_url: string | null;
  raw_json: JsonObject;
  created_at: string;
  updated_at: string;
};

type SupabaseError = {
  code?: string;
  message?: string;
  hint?: string;
};

type OrderPayload = {
  order: Record<string, unknown>;
  items: unknown[];
};

const CONNECTION_SELECT =
  'id, org_id, provider, display_name, credentials_enc, config_json, enabled, created_at, updated_at';
const ORDER_ITEM_SELECT =
  'id, product_id, variant_id, title_snapshot, sku_snapshot, qty, unit_price_vnd, line_total_vnd';
const ORDER_WITH_ITEMS_SELECT =
  `id, org_id, status, payment_method, customer_name, phone_e164, address_text, address_json, total_vnd, items:order_items(${ORDER_ITEM_SELECT})`;
const SHIPMENT_SELECT =
  'id, org_id, order_id, carrier_connection_id, provider, external_shipment_id, tracking_code, status, fee_vnd, label_url, raw_json, created_at, updated_at';

/**
 * Shipment statuses that mean "a parcel for this order is live at the carrier".
 * Full vocabulary (shipments_status_check): `created | picking | delivering |
 * delivered | cancelled | failed`. `cancelled` and `failed` are excluded so a
 * cancelled or failed booking can be re-attempted; everything else blocks a
 * second booking, because that would mint a second real waybill and a second
 * carrier fee.
 */
const LIVE_SHIPMENT_STATUSES = [
  'created',
  'picking',
  'delivering',
  'delivered',
];

/**
 * `LIVE_SHIPMENT_STATUSES` plus `pending`: every status that means "this
 * order already has a claim or a booking; a new request must not step on
 * it". `pending` is the state a request occupies for the single round-trip to
 * the carrier (see `claimShipment`). Mirrors the predicate of
 * `shipments_one_live_claim_per_order_idx`
 * (20260729050000_shipments_claim_then_call.sql).
 */
const CLAIM_BLOCKING_STATUSES = ['pending', ...LIVE_SHIPMENT_STATUSES];

/**
 * How long a `pending` claim may sit unfinished before a new request is
 * allowed to take it over (see `reclaimStaleShipmentClaim`).
 *
 * `createShipment`'s provider call is a single HTTP round-trip to GHN (or the
 * manual provider, which never leaves the process) -- not a background job --
 * so a healthy request resolves the claim (finalized or failed) in low
 * single-digit seconds. Two minutes gives generous headroom for a slow
 * network or a briefly overloaded event loop while still letting an order
 * recover quickly from a genuinely crashed process (killed between the claim
 * insert and the provider responding). It is deliberately far shorter than
 * `IDEMPOTENCY_TTL_MS` (24h) in orders.service.ts, which guards full HTTP
 * replay semantics for an arbitrary handler, not a single bounded outbound
 * call.
 */
const CLAIM_TTL_MS = 2 * 60 * 1000;

@Injectable()
export class ShippingService {
  private readonly supabase: SupabaseLike;
  private readonly env: ShippingEnv;
  private readonly audit?: AuditWriter;

  constructor(
    @Optional()
    @Inject(SHIPPING_SUPABASE)
    supabase?: SupabaseLike,
    @Optional()
    @Inject(SHIPPING_ENV)
    env?: ShippingEnv,
    @Optional()
    @Inject(AuditService)
    audit?: AuditWriter,
    @Optional()
    @Inject(SHIPPING_FETCH)
    private readonly fetchImpl?: FetchLike,
    @Optional()
    @Inject(CodService)
    private readonly cod?: Pick<CodService, 'ensureExpectationForOrder'>,
  ) {
    this.env = env ?? loadEnv();
    this.supabase = supabase ?? createSupabaseServiceClient(this.env);
    this.audit = audit;
  }

  async listConnections(orgId: string) {
    const { data, error } = await this.supabase
      .from('carrier_connections')
      .select(CONNECTION_SELECT)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });

    if (error) {
      throwShippingError(error, 'Could not list carrier connections');
    }

    return {
      connections: ((data ?? []) as CarrierConnectionRow[]).map(mapConnection),
    };
  }

  async upsertConnection(input: {
    orgId: string;
    actorUserId: string;
    body: UpsertCarrierConnectionBody;
  }) {
    const now = new Date().toISOString();
    const existing = await this.findConnectionByProvider(
      input.orgId,
      input.body.provider,
    );
    const credentialsEnc =
      input.body.credentials === undefined
        ? undefined
        : encryptToken(
            JSON.stringify(input.body.credentials),
            this.env.TOKEN_ENCRYPTION_KEY,
          );

    const displayName =
      input.body.displayName ?? defaultDisplayName(input.body.provider);
    const values = {
      display_name: displayName,
      config_json: input.body.config,
      enabled: input.body.enabled,
      updated_at: now,
      ...(credentialsEnc === undefined
        ? {}
        : { credentials_enc: credentialsEnc }),
    };

    const { data, error } = existing
      ? await this.supabase
          .from('carrier_connections')
          .update(values)
          .eq('id', existing.id)
          .eq('org_id', input.orgId)
          .select(CONNECTION_SELECT)
          .single()
      : await this.supabase
          .from('carrier_connections')
          .insert({
            org_id: input.orgId,
            provider: input.body.provider,
            ...values,
          })
          .select(CONNECTION_SELECT)
          .single();

    if (error) {
      throwShippingError(error, 'Could not save carrier connection');
    }

    const connection = mapConnection(data as CarrierConnectionRow);
    await this.audit?.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'carrier_connection.upserted',
      entityType: 'carrier_connection',
      entityId: connection.id,
      meta: {
        provider: connection.provider,
        enabled: connection.enabled,
      },
    });

    return { connection };
  }

  async createShipment(input: {
    orgId: string;
    actorUserId: string;
    body: CreateShipmentBody;
  }) {
    const order = await this.getShipmentOrder(input.orgId, input.body.orderId);
    if (order.status !== 'confirmed' && order.status !== 'shipped') {
      throw new BadRequestException({
        code: 'invalid_order_status',
        message: 'Order must be confirmed or already shipped before shipment creation',
      });
    }

    // `provider.createShipment(...)` books a REAL waybill and incurs a REAL
    // carrier fee. It used to run first, with the local shipment row, the fee
    // update and the ship transition happening only afterwards — so if any of
    // those threw, or the request timed out, the client retried and the carrier
    // was called a second time: two live waybills, two fees charged, and
    // `orders.shipping_fee_vnd` reflecting only the last one. This soft
    // pre-check refuses the obvious second booking before the provider is ever
    // reached — but it is only a fast path (a SELECT, not a lock): two
    // requests that both reach it before either has written a row would both
    // pass. The actual safety mechanism is `claimShipment` below, backed by
    // `shipments_one_live_claim_per_order_idx`.
    const live = await this.findLiveShipment(input.orgId, order.id);
    if (live) {
      throw shipmentConflict(live);
    }

    const connection = await this.resolveConnection(
      input.orgId,
      input.body.provider,
      input.body.carrierConnectionId,
    );
    const provider = this.providerFor(connection.provider);

    // Reserve the order BEFORE the provider is ever called. A losing
    // concurrent request fails right here — at the INSERT, or the conditional
    // reclaim UPDATE — and never reaches `provider.createShipment`. Unlike the
    // soft pre-check above, this is race-proof: it is arbitrated by
    // `shipments_one_live_claim_per_order_idx` at the database level, not by
    // a SELECT in application code.
    const claim = await this.claimShipment(input.orgId, order.id, connection);

    let providerResult: CreateShipmentResult;
    try {
      providerResult = await provider.createShipment({
        orgId: input.orgId,
        order: mapShippingOrder(order),
        connection,
      });
    } catch (error) {
      // Compensate: free the claim so the order is not stranded, but never
      // swallow or wrap the original error — a `BadRequestException` like
      // `carrier_not_configured` or `carrier_request_failed` must reach the
      // caller exactly as it does today.
      await this.markShipmentClaimFailed(input.orgId, claim.id, error);
      throw error;
    }

    const isMock = providerResult.isMock === true;

    const shipment = await this.finalizeShipmentClaim(input.orgId, claim.id, {
      externalShipmentId: providerResult.externalShipmentId,
      trackingCode: providerResult.trackingCode,
      status: providerResult.status,
      feeVnd: providerResult.feeVnd,
      labelUrl: providerResult.labelUrl,
      raw: providerResult.raw,
    });

    // A mock shipment is a traceability record only. Its fee is unknown (not
    // zero) and no parcel exists, so it must not overwrite the order's shipping
    // fee, must not advance the order to `shipped`, and must not create a COD
    // expectation the shop would later try to reconcile against a real carrier.
    if (isMock) {
      await this.audit?.writeAudit({
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: 'shipment.created_mock',
        entityType: 'shipment',
        entityId: shipment.id,
        meta: {
          orderId: order.id,
          provider: shipment.provider,
          trackingCode: shipment.trackingCode,
          note: 'No carrier contacted; order status, shipping fee and COD were left untouched.',
        },
      });

      return { shipment, mock: true as const };
    }

    await this.updateOrderShippingFee(
      input.orgId,
      order.id,
      providerResult.feeVnd,
    );

    let orderPayload: OrderPayload | null = null;
    if (order.status === 'confirmed') {
      orderPayload = await this.shipConfirmedOrder(input.orgId, order.id);
      await this.audit?.writeAudit({
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: 'order.shipped',
        entityType: 'order',
        entityId: order.id,
        meta: {
          via: 'shipping.createShipment',
          shipmentId: shipment.id,
        },
      });
      // Fire the same `order.shipped` outbound event the orders ship path emits
      // (OrdersService.shipOrder), so subscribers get identical outbox rows no
      // matter which fulfilment path transitioned the order to `shipped`.
      await enqueueOutbox(this.supabase, {
        orgId: input.orgId,
        eventName: 'order.shipped',
        payload: {
          event: 'order.shipped',
          orderId: order.id,
          status: 'shipped',
        },
      });
    }

    await this.cod?.ensureExpectationForOrder({
      orgId: input.orgId,
      orderId: order.id,
      actorUserId: input.actorUserId,
      order: {
        status: orderPayload?.order.status ?? order.status,
        paymentMethod: orderPayload?.order.paymentMethod ?? order.payment_method,
        totalVnd: orderPayload?.order.totalVnd ?? order.total_vnd,
      },
    });

    await this.audit?.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: 'shipment.created',
      entityType: 'shipment',
      entityId: shipment.id,
      meta: {
        orderId: order.id,
        provider: shipment.provider,
        trackingCode: shipment.trackingCode,
        feeVnd: shipment.feeVnd,
      },
    });

    return {
      shipment,
      ...(orderPayload
        ? { order: orderPayload.order, items: orderPayload.items }
        : {}),
    };
  }

  async listShipments(orgId: string, orderId: string) {
    const { data, error } = await this.supabase
      .from('shipments')
      .select(SHIPMENT_SELECT)
      .eq('org_id', orgId)
      .eq('order_id', orderId)
      .order('created_at', { ascending: false });

    if (error) {
      throwShippingError(error, 'Could not list shipments');
    }

    return {
      shipments: ((data ?? []) as ShipmentRow[]).map(mapShipment),
    };
  }

  private async findConnectionByProvider(
    orgId: string,
    provider: ShippingProviderBody,
  ) {
    const { data, error } = await this.supabase
      .from('carrier_connections')
      .select(CONNECTION_SELECT)
      .eq('org_id', orgId)
      .eq('provider', provider)
      .maybeSingle();

    if (error) {
      throwShippingError(error, 'Could not read carrier connection');
    }

    return data as CarrierConnectionRow | null;
  }

  private async getConnectionById(orgId: string, connectionId: string) {
    const { data, error } = await this.supabase
      .from('carrier_connections')
      .select(CONNECTION_SELECT)
      .eq('org_id', orgId)
      .eq('id', connectionId)
      .maybeSingle();

    if (error) {
      throwShippingError(error, 'Could not read carrier connection');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'carrier_connection_not_found',
        message: 'Carrier connection was not found',
      });
    }

    return data as CarrierConnectionRow;
  }

  private async resolveConnection(
    orgId: string,
    provider: ShippingProviderBody,
    connectionId?: string,
  ): Promise<ShippingConnection> {
    const row = connectionId
      ? await this.getConnectionById(orgId, connectionId)
      : await this.findConnectionByProvider(orgId, provider);

    if (!row) {
      if (provider === 'manual') {
        return {
          id: null,
          provider: 'manual',
          displayName: defaultDisplayName('manual'),
          config: {},
          credentials: {},
        };
      }
      throw new BadRequestException({
        code: 'carrier_not_configured',
        message: 'Carrier connection is not configured',
      });
    }
    if (!row.enabled) {
      throw new BadRequestException({
        code: 'carrier_disabled',
        message: 'Carrier connection is disabled',
      });
    }

    return {
      id: row.id,
      provider: row.provider,
      displayName: row.display_name,
      config: row.config_json ?? {},
      credentials: decryptCredentials(row.credentials_enc, this.env),
    };
  }

  private async getShipmentOrder(orgId: string, orderId: string) {
    const { data, error } = await this.supabase
      .from('orders')
      .select(ORDER_WITH_ITEMS_SELECT)
      .eq('org_id', orgId)
      .eq('id', orderId)
      .maybeSingle();

    if (error) {
      throwShippingError(error, 'Could not read order');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'order_not_found',
        message: 'Order was not found',
      });
    }

    return data as unknown as OrderRow;
  }

  /**
   * The newest shipment for an order that represents a real parcel at a
   * carrier, or null when a new booking is legitimate.
   *
   * Mock rows are skipped on purpose: they are traceability records where no
   * carrier was contacted (see `GhnShippingProvider`, `raw_json.mode = 'mock'`),
   * so they cost nothing and must never block a genuine booking. Blocking on
   * them would change mock semantics, which stay untouched.
   */
  private findLiveShipment(orgId: string, orderId: string) {
    return this.findShipmentByStatuses(orgId, orderId, LIVE_SHIPMENT_STATUSES);
  }

  /**
   * The row currently holding `shipments_one_live_claim_per_order_idx`'s slot
   * for an order — a `pending` claim or a booked (non-mock) shipment. The
   * index guarantees at most one such row can exist per order, so this is
   * exactly what a losing `claimShipment` insert collided with.
   */
  private findClaimBlocker(orgId: string, orderId: string) {
    return this.findShipmentByStatuses(
      orgId,
      orderId,
      CLAIM_BLOCKING_STATUSES,
    );
  }

  private async findShipmentByStatuses(
    orgId: string,
    orderId: string,
    statuses: string[],
  ) {
    const { data, error } = await this.supabase
      .from('shipments')
      .select(SHIPMENT_SELECT)
      .eq('org_id', orgId)
      .eq('order_id', orderId)
      .in('status', statuses)
      .order('created_at', { ascending: false });

    if (error) {
      throwShippingError(error, 'Could not read existing shipments');
    }

    return (
      ((data ?? []) as ShipmentRow[]).find((row) => !isMockShipmentRow(row)) ??
      null
    );
  }

  /**
   * Reserve the order for a booking attempt BEFORE the carrier is ever
   * called. Returns the claim row (status `pending`) whose `id` the caller
   * must finalize (on success) or mark failed (on throw).
   *
   * Losing the insert here means `shipments_one_live_claim_per_order_idx` was
   * violated (23505). That is not automatically a hard failure: the blocker
   * may be a `pending` claim abandoned by a process that died between its
   * insert and the provider responding, in which case it is reclaimed
   * instead (see `reclaimStaleShipmentClaim`). Only when the blocker is
   * genuinely live, or a `pending` claim still within its TTL, is this a real
   * conflict.
   */
  private async claimShipment(
    orgId: string,
    orderId: string,
    connection: ShippingConnection,
  ): Promise<ShipmentRow> {
    const { data, error } = await this.supabase
      .from('shipments')
      .insert({
        org_id: orgId,
        order_id: orderId,
        carrier_connection_id: connection.id,
        provider: connection.provider,
        external_shipment_id: null,
        tracking_code: null,
        status: 'pending',
        fee_vnd: '0',
        label_url: null,
        raw_json: {},
      })
      .select(SHIPMENT_SELECT)
      .single();

    if (!error) {
      return data as ShipmentRow;
    }
    if (error.code !== '23505') {
      throwShippingError(error, 'Could not claim shipment');
    }

    const blocker = await this.findClaimBlocker(orgId, orderId);
    if (blocker?.status === 'pending' && isStaleClaim(blocker)) {
      const reclaimed = await this.reclaimStaleShipmentClaim(
        orgId,
        blocker.id,
        connection,
      );
      if (reclaimed) {
        return reclaimed;
      }
    }

    throw shipmentConflict(blocker);
  }

  /**
   * Take over an abandoned `pending` claim as a fresh claim for THIS request.
   *
   * The UPDATE is conditional on the row still being `pending` AND its
   * `updated_at` still predating the TTL cutoff computed by this call. Two
   * concurrent reclaimers racing the identical conditional UPDATE can't both
   * win: Postgres blocks the second on the first's row lock, then
   * re-evaluates the WHERE clause against the first's newly committed row
   * once it commits (the same mechanism `reclaimExpiredIdempotencyKey` in
   * orders.service.ts relies on, read for the exact precedent). Critically,
   * `updated_at` is both the column compared in the WHERE clause AND the
   * column the winner's SET clause refreshes to "now" — so the instant the
   * winner commits, its row no longer satisfies `updated_at < cutoff`, and
   * the second UPDATE matches zero rows instead of also succeeding.
   * (Comparing on `created_at` instead would NOT have this property:
   * `created_at` never changes across a reclaim, so a second concurrent
   * reclaimer would still match after the first committed, and both would
   * believe they won — silently reopening the exact double-booking race this
   * whole migration exists to close. `updated_at` is what makes the
   * guarantee real; see the integration spec's "two concurrent reclaims"
   * case, which fails without this.)
   */
  private async reclaimStaleShipmentClaim(
    orgId: string,
    claimId: string,
    connection: ShippingConnection,
  ): Promise<ShipmentRow | null> {
    const cutoffIso = new Date(Date.now() - CLAIM_TTL_MS).toISOString();

    const { data, error } = await this.supabase
      .from('shipments')
      .update({
        status: 'pending',
        carrier_connection_id: connection.id,
        provider: connection.provider,
        external_shipment_id: null,
        tracking_code: null,
        fee_vnd: '0',
        label_url: null,
        raw_json: {},
        updated_at: new Date().toISOString(),
      })
      .eq('id', claimId)
      .eq('org_id', orgId)
      .eq('status', 'pending')
      .lt('updated_at', cutoffIso)
      .select(SHIPMENT_SELECT);

    if (error) {
      throwShippingError(error, 'Could not reclaim stale shipment claim');
    }

    const rows = (data ?? []) as ShipmentRow[];
    return rows[0] ?? null;
  }

  private async finalizeShipmentClaim(
    orgId: string,
    claimId: string,
    input: {
      externalShipmentId: string | null;
      trackingCode: string | null;
      status: string;
      feeVnd: bigint;
      labelUrl: string | null;
      raw: JsonObject;
    },
  ) {
    const { data, error } = await this.supabase
      .from('shipments')
      .update({
        external_shipment_id: input.externalShipmentId,
        tracking_code: input.trackingCode,
        status: input.status,
        fee_vnd: input.feeVnd.toString(),
        label_url: input.labelUrl,
        raw_json: input.raw,
        updated_at: new Date().toISOString(),
      })
      .eq('id', claimId)
      .eq('org_id', orgId)
      .select(SHIPMENT_SELECT)
      .single();

    if (error) {
      throwShippingError(error, 'Could not finalize shipment');
    }

    return mapShipment(data as ShipmentRow);
  }

  /**
   * Compensate a claim whose provider call threw: mark it `failed` (which
   * `shipments_one_live_claim_per_order_idx` excludes, so the order stays
   * bookable on retry) and stash the error for debugging. Best-effort — if
   * this UPDATE itself fails, the claim row is simply left as-is (it will
   * still expire out of `pending` via the TTL/reclaim path); either way the
   * caller re-throws the original provider error regardless of what happens
   * here.
   */
  private async markShipmentClaimFailed(
    orgId: string,
    claimId: string,
    error: unknown,
  ): Promise<void> {
    await this.supabase
      .from('shipments')
      .update({
        status: 'failed',
        raw_json: serializeClaimError(error),
        updated_at: new Date().toISOString(),
      })
      .eq('id', claimId)
      .eq('org_id', orgId);
  }

  private async updateOrderShippingFee(
    orgId: string,
    orderId: string,
    feeVnd: bigint,
  ) {
    const { error } = await this.supabase
      .from('orders')
      .update({
        shipping_fee_vnd: feeVnd.toString(),
        updated_at: new Date().toISOString(),
      })
      .eq('org_id', orgId)
      .eq('id', orderId);

    if (error) {
      throwShippingError(error, 'Could not update order shipping fee');
    }
  }

  private async shipConfirmedOrder(orgId: string, orderId: string) {
    const { data, error } = await this.supabase.rpc('ship_order', {
      p_org_id: orgId,
      p_order_id: orderId,
      p_shipped_at: new Date().toISOString(),
    });

    if (error) {
      throwShippingError(error, 'Could not ship order');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'order_not_found',
        message: 'Order was not found',
      });
    }

    return data as OrderPayload;
  }

  private providerFor(provider: ShippingProviderCode): ShippingProvider {
    if (provider === 'manual') {
      return new ManualShippingProvider();
    }
    return new GhnShippingProvider(this.fetchImpl);
  }
}

function mapConnection(row: CarrierConnectionRow) {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    config: row.config_json ?? {},
    enabled: row.enabled,
    hasCredentials: Boolean(row.credentials_enc),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapShipment(row: ShipmentRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    orderId: row.order_id,
    carrierConnectionId: row.carrier_connection_id,
    provider: row.provider,
    externalShipmentId: row.external_shipment_id,
    trackingCode: row.tracking_code,
    status: row.status,
    feeVnd: row.fee_vnd.toString(),
    labelUrl: row.label_url,
    raw: row.raw_json ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isMockShipmentRow(row: ShipmentRow) {
  return (row.raw_json ?? {}).mode === 'mock';
}

/**
 * A `pending` claim older than `CLAIM_TTL_MS` is presumed abandoned — the
 * process that owned it died somewhere between the claim insert and the
 * provider responding — and becomes eligible for reclaim by a new request.
 */
function isStaleClaim(row: ShipmentRow, now = Date.now()) {
  const updatedAt = Date.parse(row.updated_at);
  return Number.isFinite(updatedAt) && updatedAt < now - CLAIM_TTL_MS;
}

/**
 * The `shipment_already_exists` conflict both the soft pre-check
 * (`findLiveShipment`) and the claim path (`claimShipment`) throw when an
 * order already has a live shipment or claim. `row` is null only in the
 * defensive case where the unique index rejected an insert but the follow-up
 * read could not find the row that blocked it — should not happen in
 * practice; the message still makes sense without the detail fields.
 */
function shipmentConflict(row: ShipmentRow | null) {
  return new ConflictException({
    code: 'shipment_already_exists',
    message:
      'Order already has an active shipment. Cancel it before booking another.',
    ...(row
      ? {
          shipmentId: row.id,
          trackingCode: row.tracking_code,
          status: row.status,
        }
      : {}),
  });
}

/**
 * Stash enough of a failed claim's error to be useful for debugging without
 * ever losing the claim row silently. Deliberately never produces
 * `raw_json.mode === 'mock'`, so a failed claim can never be mistaken for a
 * mock result by `isMockShipmentRow` (moot for indexing purposes since
 * `failed` already sits outside `shipments_one_live_claim_per_order_idx`, but
 * kept distinct for anyone reading the row later).
 */
function serializeClaimError(error: unknown): JsonObject {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    return {
      stage: 'provider_call_failed',
      status: error.getStatus(),
      response:
        response && typeof response === 'object'
          ? (response as JsonObject)
          : { message: response },
    };
  }
  if (error instanceof Error) {
    return {
      stage: 'provider_call_failed',
      name: error.name,
      message: error.message,
    };
  }
  return { stage: 'provider_call_failed', error: String(error) };
}

function mapShippingOrder(row: OrderRow): ShippingOrder {
  return {
    id: row.id,
    customerName: row.customer_name,
    phoneE164: row.phone_e164,
    addressText: row.address_text,
    addressJson: row.address_json ?? {},
    items: (row.items ?? []).map((item) => ({
      id: item.id,
      productId: item.product_id,
      variantId: item.variant_id,
      titleSnapshot: item.title_snapshot,
      skuSnapshot: item.sku_snapshot,
      qty: item.qty,
      unitPriceVnd: item.unit_price_vnd.toString(),
      lineTotalVnd: item.line_total_vnd.toString(),
    })),
  };
}

function decryptCredentials(
  encrypted: string | null,
  env: ShippingEnv,
): JsonObject {
  if (!encrypted) {
    return {};
  }

  try {
    const parsed = JSON.parse(
      decryptToken(encrypted, env.TOKEN_ENCRYPTION_KEY),
    ) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    throw new BadRequestException({
      code: 'carrier_not_configured',
      message: 'Carrier credentials could not be read',
    });
  }
}

function defaultDisplayName(provider: ShippingProviderBody) {
  return provider === 'manual' ? 'Thủ công' : 'GHN';
}

function throwShippingError(error: SupabaseError, message: string): never {
  if (error.code === '23505') {
    throw new ConflictException({
      code: 'shipping_conflict',
      message: error.message ?? message,
    });
  }
  if (error.hint === 'invalid_order_status') {
    throw new BadRequestException({
      code: 'invalid_order_status',
      message: error.message ?? message,
    });
  }

  throw new InternalServerErrorException({
    code: 'shipping_failed',
    message,
  });
}

function createSupabaseServiceClient(env: ShippingEnv): SupabaseLike {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
