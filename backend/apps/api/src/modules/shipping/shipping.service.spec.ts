import { describe, expect, it, vi } from 'vitest';

import { decryptToken, encryptToken } from '../../common/crypto/token-crypto';
import { GhnShippingProvider } from './ghn-shipping.provider';
import { ManualShippingProvider } from './manual-shipping.provider';
import {
  ShippingService,
  type ShippingEnv,
  type SupabaseLike,
} from './shipping.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-4444-444444444444';
const SHIPMENT_ID = '55555555-5555-5555-5555-555555555555';
const TOKEN_KEY = 'shipping-token-encryption-key-32chars';
const CREATED_AT = '2026-07-27T10:00:00.000Z';

/** shipments_one_live_claim_per_order_idx's TTL for a `pending` claim, mirrored
 * from CLAIM_TTL_MS in shipping.service.ts (kept in sync manually since the
 * constant is not exported — these tests assert on its externally observable
 * behaviour, not the literal value). */
const CLAIM_TTL_MS = 2 * 60 * 1000;

const env = {
  SUPABASE_URL: 'https://supabase.example.com',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
} satisfies ShippingEnv;

function shippingOrder() {
  return {
    id: ORDER_ID,
    customerName: 'Nguyen Van A',
    phoneE164: '+84901234567',
    addressText: '1 Nguyen Hue, Q1',
    addressJson: {},
    items: [
      {
        id: '66666666-6666-6666-6666-666666666666',
        productId: '77777777-7777-7777-7777-777777777777',
        variantId: '88888888-8888-8888-8888-888888888888',
        titleSnapshot: 'Ao thun',
        skuSnapshot: 'AT-1',
        qty: 1,
        unitPriceVnd: '100000',
        lineTotalVnd: '100000',
      },
    ],
  };
}

function orderRow(status = 'confirmed') {
  return {
    id: ORDER_ID,
    org_id: ORG_ID,
    status,
    payment_method: 'cod',
    customer_name: 'Nguyen Van A',
    phone_e164: '+84901234567',
    address_text: '1 Nguyen Hue, Q1',
    address_json: {},
    total_vnd: '100000',
    items: [
      {
        id: '66666666-6666-6666-6666-666666666666',
        product_id: '77777777-7777-7777-7777-777777777777',
        variant_id: '88888888-8888-8888-8888-888888888888',
        title_snapshot: 'Ao thun',
        sku_snapshot: 'AT-1',
        qty: 1,
        unit_price_vnd: '100000',
        line_total_vnd: '100000',
      },
    ],
  };
}

function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIPMENT_ID,
    org_id: ORG_ID,
    order_id: ORDER_ID,
    carrier_connection_id: null,
    provider: 'manual',
    external_shipment_id: 'MANUAL-22222222',
    tracking_code: 'MANUAL-22222222',
    status: 'created',
    fee_vnd: '0',
    label_url: null,
    raw_json: {},
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

// createShipment now enqueues an `order.shipped` outbox event through
// `this.supabase.from('outbox_events')` when it ships a confirmed order (the
// same event OrdersService.shipOrder emits). This returns the insert handler
// that table expects and records each inserted row into `sink`.
function outboxInsertHandler(sink: Array<Record<string, unknown>>) {
  return {
    insert(values: Record<string, unknown>) {
      sink.push(values);
      return {
        select() {
          return {
            single: async () => ({
              data: {
                id: `outbox-${sink.length}`,
                created_at: CREATED_AT,
                published_at: null,
                attempts: 0,
                ...values,
              },
              error: null,
            }),
          };
        },
      };
    },
  };
}

/**
 * createShipment now reserves the order with a `pending` claim row BEFORE it
 * calls the carrier (see claimShipment/finalizeShipmentClaim in
 * shipping.service.ts), so the shipments stub has to answer an
 * insert().select().single() (the claim) followed by an
 * update().eq().eq()[.select().single()] (the finalize) — plus the
 * select().eq().eq().in().order() chain the soft pre-check
 * (findLiveShipment) already used. `existing` is what that pre-check finds;
 * every claim insert is recorded into `sink`; every update (finalize or
 * mark-failed) is recorded into the returned `updates` array.
 *
 * This fake does NOT enforce the partial-unique-index invariant — every claim
 * insert unconditionally succeeds — because these tests exercise the
 * single-request happy/mock/not-confirmed paths, not the race itself. The
 * race is proven separately by `stubShipmentsTable` below, which does enforce
 * it.
 */
function shipmentsTableHandler(
  sink: Array<Record<string, unknown>>,
  options: {
    existing?: Array<Record<string, unknown>>;
  } = {},
) {
  const liveStatusFilters: unknown[][] = [];
  const updates: Array<Record<string, unknown>> = [];
  let claimRow: Record<string, unknown> = shipmentRow();

  return {
    liveStatusFilters,
    updates,
    select() {
      return {
        eq() {
          return {
            eq() {
              return {
                in(_column: string, values: unknown[]) {
                  liveStatusFilters.push(values);
                  return {
                    order: async () => ({
                      data: options.existing ?? [],
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
    insert(values: Record<string, unknown>) {
      sink.push(values);
      claimRow = {
        ...shipmentRow(),
        status: 'pending',
        external_shipment_id: null,
        tracking_code: null,
        fee_vnd: '0',
        label_url: null,
        raw_json: {},
        ...values,
      };
      const row = claimRow;
      return {
        select() {
          return {
            single: async () => ({ data: row, error: null }),
          };
        },
      };
    },
    update(values: Record<string, unknown>) {
      updates.push(values);
      claimRow = { ...claimRow, ...values };
      const row = claimRow;
      const terminal = {
        select() {
          return { single: async () => ({ data: row, error: null }) };
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(resolve),
      };
      return {
        eq() {
          return { eq: () => terminal };
        },
      };
    },
  };
}

const STUB_CLAIM_BLOCKING_STATUSES = [
  'pending',
  'created',
  'picking',
  'delivering',
  'delivered',
];

function isClaimBlockingStubRow(row: Record<string, unknown>) {
  const status = row.status as string;
  const raw = (row.raw_json as Record<string, unknown> | undefined) ?? {};
  return STUB_CLAIM_BLOCKING_STATUSES.includes(status) && raw.mode !== 'mock';
}

/**
 * A minimal, synchronous, stateful stand-in for the `shipments` table that
 * enforces the SAME invariant as `shipments_one_live_claim_per_order_idx`
 * (supabase/migrations/20260729050000_shipments_claim_then_call.sql): at most
 * one non-mock row per (org_id, order_id) with status in
 * ('pending','created','picking','delivering','delivered'). Every resolver
 * below runs to completion synchronously (no `await` inside any of them), so
 * two "concurrent" calls into this fake can never both observe the table
 * before either one's write has landed — exactly how a real unique index
 * arbitrates two concurrent Postgres inserts. This is what lets a unit test
 * PROVE the claim-then-call race is closed, rather than merely asserting
 * against a pre-scripted response the way `shipmentsTableHandler` does.
 *
 * Supports exactly the shapes ShippingService issues against `shipments`:
 *   select(...).eq().eq().in().order()
 *   insert(...).select().single()
 *   update(...).eq().eq()[.eq().lt()][.select()[.single()]]
 */
function stubShipmentsTable(seed: Array<Record<string, unknown>> = []) {
  const rows: Array<Record<string, unknown>> = [...seed];
  let autoId = 0;

  function select(_cols?: string) {
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      in(col: string, vals: unknown[]) {
        return {
          order: async (_col2: string, opts?: { ascending?: boolean }) => {
            const matched = rows.filter(
              (r) =>
                filters.every(([c, v]) => r[c] === v) &&
                vals.includes(r[col]),
            );
            matched.sort((a, b) => {
              const cmp = String(a.created_at).localeCompare(
                String(b.created_at),
              );
              return opts?.ascending === false ? -cmp : cmp;
            });
            return { data: matched, error: null };
          },
        };
      },
    };
    return api;
  }

  function insert(values: Record<string, unknown>) {
    return {
      select(_cols?: string) {
        return {
          single: async () => {
            autoId += 1;
            const now = new Date().toISOString();
            const candidate: Record<string, unknown> = {
              id: `stub-claim-${autoId}`,
              created_at: now,
              updated_at: now,
              ...values,
            };
            const conflict = rows.some(
              (r) =>
                r.org_id === candidate.org_id &&
                r.order_id === candidate.order_id &&
                isClaimBlockingStubRow(r) &&
                isClaimBlockingStubRow(candidate),
            );
            if (conflict) {
              return {
                data: null,
                error: {
                  code: '23505',
                  message:
                    'duplicate key value violates unique constraint "shipments_one_live_claim_per_order_idx"',
                },
              };
            }
            rows.push(candidate);
            return { data: candidate, error: null };
          },
        };
      },
    };
  }

  function update(values: Record<string, unknown>) {
    const filters: Array<[string, unknown]> = [];
    let ltFilter: [string, unknown] | null = null;
    const matchRows = () => {
      const lt = ltFilter;
      return rows.filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          (!lt || String(r[lt[0]]) < String(lt[1])),
      );
    };
    const applyAndReturn = () => {
      const matched = matchRows();
      for (const row of matched) {
        Object.assign(row, values);
      }
      return matched;
    };
    const api = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      lt(col: string, val: unknown) {
        ltFilter = [col, val];
        return api;
      },
      select(_cols?: string) {
        return {
          single: async () => {
            const matched = applyAndReturn();
            if (matched.length === 0) {
              return {
                data: null,
                error: { code: 'PGRST116', message: 'no rows returned' },
              };
            }
            return { data: matched[0], error: null };
          },
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: applyAndReturn(), error: null }).then(
              resolve,
            ),
        };
      },
      then(resolve: (value: unknown) => unknown) {
        applyAndReturn();
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return api;
  }

  return { rows, select, insert, update };
}

function ghnConnectionRow(config: Record<string, unknown>) {
  return {
    id: CONNECTION_ID,
    org_id: ORG_ID,
    provider: 'ghn',
    display_name: 'GHN',
    credentials_enc: encryptToken(
      JSON.stringify({ token: 'GHN_TOKEN' }),
      TOKEN_KEY,
    ),
    config_json: config,
    enabled: true,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function createShipmentClient(options: {
  shipments:
    | ReturnType<typeof shipmentsTableHandler>
    | ReturnType<typeof stubShipmentsTable>;
  updates: unknown[];
  outboxInserts: Array<Record<string, unknown>>;
  rpc: () => Promise<unknown>;
  connection?: Record<string, unknown> | null;
  orderStatus?: string;
}) {
  return {
    rpc: options.rpc,
    from(table: string) {
      if (table === 'outbox_events') {
        return outboxInsertHandler(options.outboxInserts);
      }

      if (table === 'shipments') {
        return options.shipments;
      }

      if (table === 'orders') {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({
                        data: orderRow(options.orderStatus ?? 'confirmed'),
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
          update(values: unknown) {
            options.updates.push(values);
            return {
              eq() {
                return { eq: async () => ({ error: null }) };
              },
            };
          },
        };
      }

      if (table === 'carrier_connections') {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({
                        data: options.connection ?? null,
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseLike;
}

describe('shipping providers', () => {
  it('manual provider creates a deterministic tracking code with configured fee', async () => {
    const provider = new ManualShippingProvider();

    const result = await provider.createShipment({
      orgId: ORG_ID,
      order: shippingOrder(),
      connection: {
        id: null,
        provider: 'manual',
        displayName: 'Thu cong',
        config: { feeVnd: '25000' },
        credentials: {},
      },
    });

    expect(result.trackingCode).toBe('MANUAL-22222222');
    expect(result.feeVnd).toBe(25000n);
  });

  it('GHN provider returns a clear configuration error without a token', async () => {
    const provider = new GhnShippingProvider();

    await expect(
      provider.createShipment({
        orgId: ORG_ID,
        order: shippingOrder(),
        connection: {
          id: CONNECTION_ID,
          provider: 'ghn',
          displayName: 'GHN',
          config: {},
          credentials: {},
        },
      }),
    ).rejects.toMatchObject({
      response: { code: 'carrier_not_configured' },
      status: 400,
    });
  });

  it('GHN provider fails closed when no sandbox URL is configured', async () => {
    // Regression: this branch used to fabricate `GHN-MOCK-*` with feeVnd 0n,
    // which then flowed into orders.shipping_fee_vnd and ship_order.
    const provider = new GhnShippingProvider();

    await expect(
      provider.createShipment({
        orgId: ORG_ID,
        order: shippingOrder(),
        connection: {
          id: CONNECTION_ID,
          provider: 'ghn',
          displayName: 'GHN',
          config: {},
          credentials: { token: 'GHN_TOKEN' },
        },
      }),
    ).rejects.toMatchObject({
      response: { code: 'carrier_not_configured' },
      status: 400,
    });
  });

  it('GHN provider only mocks when the org explicitly opts in, and flags the result', async () => {
    const provider = new GhnShippingProvider();

    const result = await provider.createShipment({
      orgId: ORG_ID,
      order: shippingOrder(),
      connection: {
        id: CONNECTION_ID,
        provider: 'ghn',
        displayName: 'GHN',
        config: { allowMock: true },
        credentials: { token: 'GHN_TOKEN' },
      },
    });

    expect(result.isMock).toBe(true);
    expect(result.externalShipmentId).toBe('GHN-MOCK-22222222');
    // The tracking code must also be recognisably fake, never a plausible one.
    expect(result.trackingCode).toBe('GHN-MOCK-22222222');
  });
});

describe('ShippingService', () => {
  it('creates a manual shipment, stores fee on the order, and ships confirmed order', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({
      data: {
        order: {
          id: ORDER_ID,
          status: 'shipped',
          shippingFeeVnd: '0',
        },
        items: [],
      },
      error: null,
    }));
    const shipments = shipmentsTableHandler(inserts);
    const client = {
      rpc,
      from(table: string) {
        if (table === 'outbox_events') {
          return outboxInsertHandler(outboxInserts);
        }

        if (table === 'orders') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: async () => ({
                          data: orderRow(),
                          error: null,
                        }),
                      };
                    },
                  };
                },
              };
            },
            update(values: unknown) {
              updates.push(values);
              return {
                eq() {
                  return {
                    eq: async () => ({ error: null }),
                  };
                },
              };
            },
          };
        }

        if (table === 'carrier_connections') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: async () => ({ data: null, error: null }),
                      };
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'shipments') {
          return shipments;
        }

        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseLike;
    const cod = {
      ensureExpectationForOrder: vi.fn(async () => null),
    };
    const service = new ShippingService(
      client,
      env,
      undefined,
      undefined,
      cod,
    );

    const result = await service.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'manual' },
    });

    // The claim is inserted BEFORE the provider is ever called: `pending`,
    // no tracking code yet.
    expect(inserts[0]).toMatchObject({
      org_id: ORG_ID,
      order_id: ORDER_ID,
      provider: 'manual',
      status: 'pending',
      tracking_code: null,
      fee_vnd: '0',
    });
    // The finalize step (after the provider responds) writes the real result
    // onto that same claim row.
    expect(shipments.updates[0]).toMatchObject({
      tracking_code: 'MANUAL-22222222',
      status: 'created',
      fee_vnd: '0',
    });
    expect(updates[0]).toMatchObject({ shipping_fee_vnd: '0' });
    expect(rpc).toHaveBeenCalledWith('ship_order', {
      p_org_id: ORG_ID,
      p_order_id: ORDER_ID,
      p_shipped_at: expect.any(String),
    });
    expect(cod.ensureExpectationForOrder).toHaveBeenCalledWith({
      orgId: ORG_ID,
      orderId: ORDER_ID,
      actorUserId: USER_ID,
      order: {
        status: 'shipped',
        paymentMethod: 'cod',
        totalVnd: '100000',
      },
    });
    expect(result.shipment.trackingCode).toBe('MANUAL-22222222');
    expect(result.order).toMatchObject({ status: 'shipped' });
    // The carrier/shipment fulfilment path must emit the same `order.shipped`
    // outbound event OrdersService.shipOrder does, so webhook subscribers get
    // it regardless of which path transitioned the order to `shipped`.
    expect(outboxInserts).toEqual([
      expect.objectContaining({
        org_id: ORG_ID,
        event_name: 'order.shipped',
        payload_json: expect.objectContaining({
          event: 'order.shipped',
          orderId: ORDER_ID,
          status: 'shipped',
        }),
      }),
    ]);
  });

  it('never lets a mock shipment touch the order fee, status, or COD', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const shipments = shipmentsTableHandler(inserts);
    const client = {
      rpc,
      from(table: string) {
        if (table === 'outbox_events') {
          return outboxInsertHandler(outboxInserts);
        }

        if (table === 'orders') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: async () => ({
                          data: orderRow('confirmed'),
                          error: null,
                        }),
                      };
                    },
                  };
                },
              };
            },
            update(values: unknown) {
              updates.push(values);
              return {
                eq() {
                  return { eq: async () => ({ error: null }) };
                },
              };
            },
          };
        }

        if (table === 'carrier_connections') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: async () => ({
                          data: {
                            id: CONNECTION_ID,
                            org_id: ORG_ID,
                            provider: 'ghn',
                            display_name: 'GHN',
                            credentials_enc: encryptToken(
                              JSON.stringify({ token: 'GHN_TOKEN' }),
                              TOKEN_KEY,
                            ),
                            config_json: { allowMock: true },
                            enabled: true,
                            created_at: CREATED_AT,
                            updated_at: CREATED_AT,
                          },
                          error: null,
                        }),
                      };
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'shipments') {
          return shipments;
        }

        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseLike;
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, undefined, cod);

    const result = await service.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'ghn' },
    });

    // The claim row is still written so the attempt is traceable...
    expect(inserts).toHaveLength(1);
    expect(result.shipment.trackingCode).toBe('GHN-MOCK-22222222');
    // ...but nothing downstream may treat it as a real parcel.
    expect(updates).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(cod.ensureExpectationForOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mock: true });
    expect(result).not.toHaveProperty('order');
    // The order never transitioned to `shipped`, so no `order.shipped` event
    // may be emitted — the mock is a traceability record only.
    expect(outboxInserts).toEqual([]);
  });

  it('does not emit order.shipped when the order is not confirmed', async () => {
    // An already-`shipped` order may still receive further shipment records, but
    // `shipConfirmedOrder` is not called and no status transition happens — so
    // it must NOT re-emit `order.shipped`.
    const inserts: Array<Record<string, unknown>> = [];
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const shipments = shipmentsTableHandler(inserts);
    const client = {
      rpc,
      from(table: string) {
        if (table === 'outbox_events') {
          return outboxInsertHandler(outboxInserts);
        }

        if (table === 'orders') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: async () => ({
                          data: orderRow('shipped'),
                          error: null,
                        }),
                      };
                    },
                  };
                },
              };
            },
            update(values: unknown) {
              updates.push(values);
              return {
                eq() {
                  return { eq: async () => ({ error: null }) };
                },
              };
            },
          };
        }

        if (table === 'carrier_connections') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: async () => ({ data: null, error: null }),
                      };
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'shipments') {
          return shipments;
        }

        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseLike;
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, undefined, cod);

    const result = await service.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'manual' },
    });

    // The claim row is still written and the fee recorded...
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    // ...but ship_order never runs and no `order.shipped` event is emitted.
    expect(rpc).not.toHaveBeenCalled();
    expect(outboxInserts).toEqual([]);
    expect(result).not.toHaveProperty('order');
  });

  it('refuses a second booking for an order that already has a live shipment', async () => {
    // The defect: the carrier was called FIRST and the local row/fee/ship
    // transition written afterwards. When any of those threw (or the request
    // timed out) the client retried, the carrier was called again, and the shop
    // ended up with two live waybills and two carrier fees for one order.
    const fetchImpl = vi.fn(async () => {
      throw new Error('the carrier must not be contacted');
    });
    const inserts: Array<Record<string, unknown>> = [];
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const shipments = shipmentsTableHandler(inserts, {
      existing: [
        shipmentRow({
          provider: 'ghn',
          status: 'delivering',
          tracking_code: 'GHN-REAL-0001',
          raw_json: { mode: 'sandbox' },
        }),
      ],
    });
    const client = createShipmentClient({
      shipments,
      updates,
      outboxInserts,
      rpc,
      connection: ghnConnectionRow({
        sandboxUrl: 'https://sandbox.example.com/ghn',
      }),
    });
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, fetchImpl, cod);

    await expect(
      service.createShipment({
        orgId: ORG_ID,
        actorUserId: USER_ID,
        body: { orderId: ORDER_ID, provider: 'ghn' },
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'shipment_already_exists',
        shipmentId: SHIPMENT_ID,
        trackingCode: 'GHN-REAL-0001',
      },
      status: 409,
    });

    // The whole point of the guard: no second waybill, no second carrier fee.
    expect(fetchImpl).not.toHaveBeenCalled();
    // ...and nothing downstream moved either.
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(outboxInserts).toEqual([]);
    expect(cod.ensureExpectationForOrder).not.toHaveBeenCalled();
    // Only live parcels block. `cancelled` and `failed` bookings stay
    // re-bookable, otherwise a cancelled waybill would strand the order.
    expect(shipments.liveStatusFilters).toEqual([
      ['created', 'picking', 'delivering', 'delivered'],
    ]);
  });

  it('lets a real booking through when the only prior shipment was a mock', async () => {
    // Mock rows are traceability records where no carrier was contacted, so
    // they cost nothing and must never block a genuine booking. Mock semantics
    // stay exactly as they were. (This is the SOFT pre-check's version of the
    // guarantee; the claim-index's own version of it is proven directly,
    // against real uniqueness enforcement, in the "claim-then-call
    // concurrency" describe block below.)
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { order_code: 'GHN-SANDBOX-1', total_fee: 30000 },
      }),
    }));
    const inserts: Array<Record<string, unknown>> = [];
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({
      data: { order: { id: ORDER_ID, status: 'shipped' }, items: [] },
      error: null,
    }));
    const shipments = shipmentsTableHandler(inserts, {
      existing: [
        shipmentRow({
          provider: 'ghn',
          status: 'created',
          tracking_code: 'GHN-MOCK-22222222',
          raw_json: { mode: 'mock' },
        }),
      ],
    });
    const client = createShipmentClient({
      shipments,
      updates,
      outboxInserts,
      rpc,
      connection: ghnConnectionRow({
        sandboxUrl: 'https://sandbox.example.com/ghn',
      }),
    });
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, fetchImpl, cod);

    const result = await service.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'ghn' },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    expect(result.shipment.trackingCode).toBe('GHN-SANDBOX-1');
  });

  it('encrypts carrier credentials and omits them from the returned DTO', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const client = {
      rpc() {
        throw new Error('rpc should not be called');
      },
      from(table: string) {
        if (table !== 'carrier_connections') {
          throw new Error(`unexpected table ${table}`);
        }

        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({ data: null, error: null }),
                    };
                  },
                };
              },
            };
          },
          insert(values: Record<string, unknown>) {
            inserts.push(values);
            return {
              select() {
                return {
                  single: async () => ({
                    data: {
                      id: CONNECTION_ID,
                      org_id: ORG_ID,
                      provider: 'ghn',
                      display_name: 'GHN',
                      credentials_enc: values.credentials_enc,
                      config_json: values.config_json,
                      enabled: true,
                      created_at: CREATED_AT,
                      updated_at: CREATED_AT,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseLike;
    const service = new ShippingService(client, env);

    const result = await service.upsertConnection({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {
        provider: 'ghn',
        credentials: { token: 'GHN_TOKEN', shopId: 123 },
        config: { sandboxUrl: 'https://sandbox.example.com/ghn' },
        enabled: true,
      },
    });

    expect(JSON.stringify(result)).not.toContain('GHN_TOKEN');
    expect(result.connection).toMatchObject({
      id: CONNECTION_ID,
      provider: 'ghn',
      hasCredentials: true,
    });
    expect(
      decryptToken(String(inserts[0].credentials_enc), TOKEN_KEY),
    ).toBe(JSON.stringify({ token: 'GHN_TOKEN', shopId: 123 }));
  });
});

describe('ShippingService claim-then-call concurrency (shipments_one_live_claim_per_order_idx)', () => {
  it('calls the carrier exactly once when two requests race for the same order', async () => {
    // Models two truly simultaneous HTTP requests: both calls are started
    // (via Promise.allSettled's argument list) before either is awaited, so
    // both requests' order lookup / soft pre-check / connection resolution
    // run before either has written a claim row — exactly the case
    // findLiveShipment's SELECT-then-call guard cannot arbitrate, and exactly
    // the case shipments_one_live_claim_per_order_idx exists to close.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { order_code: 'GHN-RACE-1', total_fee: 15000 },
      }),
    }));
    const shipments = stubShipmentsTable();
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({
      data: { order: { id: ORDER_ID, status: 'shipped' }, items: [] },
      error: null,
    }));
    const client = createShipmentClient({
      shipments,
      updates,
      outboxInserts,
      rpc,
      connection: ghnConnectionRow({
        sandboxUrl: 'https://sandbox.example.com/ghn',
      }),
    });
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, fetchImpl, cod);

    const request = () =>
      service.createShipment({
        orgId: ORG_ID,
        actorUserId: USER_ID,
        body: { orderId: ORDER_ID, provider: 'ghn' },
      });

    const outcomes = await Promise.allSettled([request(), request()]);

    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
    const rejected = outcomes.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      response: { code: 'shipment_already_exists' },
      status: 409,
    });

    // The assertion that actually distinguishes claim-then-call from the old
    // SELECT-then-call guard: the carrier is contacted exactly once, no
    // matter how the two requests interleaved.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(shipments.rows).toHaveLength(1);
    expect(shipments.rows[0]).toMatchObject({ status: 'created' });
  });

  it('reclaims a pending claim abandoned past its TTL and calls the carrier using the reclaimed row', async () => {
    const staleUpdatedAt = new Date(
      Date.now() - CLAIM_TTL_MS - 60 * 1000,
    ).toISOString();
    const shipments = stubShipmentsTable([
      {
        id: 'abandoned-claim-1',
        org_id: ORG_ID,
        order_id: ORDER_ID,
        carrier_connection_id: null,
        provider: 'manual',
        external_shipment_id: null,
        tracking_code: null,
        status: 'pending',
        fee_vnd: '0',
        label_url: null,
        raw_json: {},
        created_at: staleUpdatedAt,
        updated_at: staleUpdatedAt,
      },
    ]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { order_code: 'GHN-RECLAIM-1', total_fee: 12000 },
      }),
    }));
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({
      data: { order: { id: ORDER_ID, status: 'shipped' }, items: [] },
      error: null,
    }));
    const client = createShipmentClient({
      shipments,
      updates,
      outboxInserts,
      rpc,
      connection: ghnConnectionRow({
        sandboxUrl: 'https://sandbox.example.com/ghn',
      }),
    });
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, fetchImpl, cod);

    const result = await service.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'ghn' },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.shipment.trackingCode).toBe('GHN-RECLAIM-1');
    // The reclaim reused the abandoned row rather than creating a second one.
    expect(shipments.rows).toHaveLength(1);
    expect(shipments.rows[0].id).toBe('abandoned-claim-1');
    expect(shipments.rows[0].status).toBe('created');
  });

  it('treats a not-yet-expired pending claim as a live conflict and never calls the carrier', async () => {
    // Regression against over-eager reclaim: a claim that is merely IN
    // FLIGHT (well within its TTL) must block a concurrent request exactly
    // as hard as a booked shipment does.
    const freshUpdatedAt = new Date(Date.now() - 1000).toISOString();
    const shipments = stubShipmentsTable([
      {
        id: 'inflight-claim-1',
        org_id: ORG_ID,
        order_id: ORDER_ID,
        carrier_connection_id: null,
        provider: 'manual',
        external_shipment_id: null,
        tracking_code: null,
        status: 'pending',
        fee_vnd: '0',
        label_url: null,
        raw_json: {},
        created_at: freshUpdatedAt,
        updated_at: freshUpdatedAt,
      },
    ]);
    const fetchImpl = vi.fn(async () => {
      throw new Error('the carrier must not be contacted');
    });
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = createShipmentClient({
      shipments,
      updates,
      outboxInserts,
      rpc,
      connection: ghnConnectionRow({
        sandboxUrl: 'https://sandbox.example.com/ghn',
      }),
    });
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, fetchImpl, cod);

    await expect(
      service.createShipment({
        orgId: ORG_ID,
        actorUserId: USER_ID,
        body: { orderId: ORDER_ID, provider: 'ghn' },
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'shipment_already_exists',
        shipmentId: 'inflight-claim-1',
        status: 'pending',
      },
      status: 409,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    // Still exactly the one in-flight claim: nothing new was inserted, and it
    // was never reclaimed.
    expect(shipments.rows).toHaveLength(1);
    expect(shipments.rows[0].status).toBe('pending');
  });

  it('marks a claim failed and propagates the original error when the provider throws, and allows a retry', async () => {
    const shipments = stubShipmentsTable();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    // The first (failing) attempt never reaches `ship_order`, but the retry
    // below succeeds and does — so this must return a real payload, not
    // `{data: null}` (which `shipConfirmedOrder` treats as "order not found").
    const rpc = vi.fn(async () => ({
      data: { order: { id: ORDER_ID, status: 'shipped' }, items: [] },
      error: null,
    }));
    const client = createShipmentClient({
      shipments,
      updates,
      outboxInserts,
      rpc,
      connection: ghnConnectionRow({
        sandboxUrl: 'https://sandbox.example.com/ghn',
      }),
    });
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, fetchImpl, cod);

    await expect(
      service.createShipment({
        orgId: ORG_ID,
        actorUserId: USER_ID,
        body: { orderId: ORDER_ID, provider: 'ghn' },
      }),
    ).rejects.toMatchObject({
      response: { code: 'carrier_request_failed' },
      status: 400,
    });

    // No side effects from a failed booking attempt.
    expect(updates).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(outboxInserts).toEqual([]);
    expect(cod.ensureExpectationForOrder).not.toHaveBeenCalled();

    // The claim row is left behind, marked failed, with the error preserved
    // for debugging — and `failed` sits outside the claim index, so the
    // order is not stranded.
    expect(shipments.rows).toHaveLength(1);
    expect(shipments.rows[0]).toMatchObject({ status: 'failed' });
    expect(shipments.rows[0].raw_json).toMatchObject({
      stage: 'provider_call_failed',
    });

    // Retry: a fresh request for the same order is NOT blocked by the failed
    // row (mirrors the mock-exclusion logic, but for `failed`).
    const fetchImpl2 = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { order_code: 'GHN-RETRY-1', total_fee: 9000 },
      }),
    }));
    const service2 = new ShippingService(client, env, undefined, fetchImpl2, cod);
    const retryResult = await service2.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'ghn' },
    });

    expect(fetchImpl2).toHaveBeenCalledTimes(1);
    expect(retryResult.shipment.trackingCode).toBe('GHN-RETRY-1');
    expect(shipments.rows).toHaveLength(2);
  });

  it('lets a second mock booking for the same order succeed because mock rows are excluded from the claim index', async () => {
    const shipments = stubShipmentsTable();
    const fetchImpl = vi.fn(async () => {
      throw new Error('mock bookings must never contact the carrier');
    });
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = createShipmentClient({
      shipments,
      updates,
      outboxInserts,
      rpc,
      connection: ghnConnectionRow({ allowMock: true }),
    });
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, fetchImpl, cod);

    const first = await service.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'ghn' },
    });
    const second = await service.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'ghn' },
    });

    expect(first).toMatchObject({ mock: true });
    expect(second).toMatchObject({ mock: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(shipments.rows).toHaveLength(2);
    expect(
      shipments.rows.every(
        (row) => (row.raw_json as Record<string, unknown>).mode === 'mock',
      ),
    ).toBe(true);
  });

  it('does not let a prior mock booking block a real booking for the same order', async () => {
    const shipments = stubShipmentsTable();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { order_code: 'GHN-AFTER-MOCK-1', total_fee: 18000 },
      }),
    }));
    const updates: unknown[] = [];
    const outboxInserts: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async () => ({
      data: { order: { id: ORDER_ID, status: 'shipped' }, items: [] },
      error: null,
    }));
    const clientOptions = {
      shipments,
      updates,
      outboxInserts,
      rpc,
      connection: ghnConnectionRow({ allowMock: true }) as Record<
        string,
        unknown
      > | null,
    };
    const client = createShipmentClient(clientOptions);
    const cod = { ensureExpectationForOrder: vi.fn(async () => null) };
    const service = new ShippingService(client, env, undefined, fetchImpl, cod);

    const mockResult = await service.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'ghn' },
    });
    expect(mockResult).toMatchObject({ mock: true });

    // Switch the org's connection to a real (sandbox) carrier before the
    // second request — `createShipmentClient` re-reads `options.connection`
    // on every lookup, so this takes effect immediately.
    clientOptions.connection = ghnConnectionRow({
      sandboxUrl: 'https://sandbox.example.com/ghn',
    });

    const realResult = await service.createShipment({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: { orderId: ORDER_ID, provider: 'ghn' },
    });

    expect(realResult).not.toHaveProperty('mock');
    expect(realResult.shipment.trackingCode).toBe('GHN-AFTER-MOCK-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(shipments.rows).toHaveLength(2);
  });
});
