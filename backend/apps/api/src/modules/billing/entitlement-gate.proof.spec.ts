/**
 * R1 eng prep — entitlement gate proof harness.
 *
 * Proves invoice+plan-flags gates fire without paid billing / Supabase Pro.
 * Owner-paid R1 (Pro/PITR/always-on/live LLM) remains out of scope here.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ChannelsService,
  type ChannelsEnv,
  type GraphLike,
  type SupabaseLike as ChannelsSupabaseLike,
} from "../channels/channels.service";
import {
  OrdersService,
  type AuditWriter,
  type SupabaseLike as OrdersSupabaseLike,
} from "../orders/orders.service";
import { EntitlementsService, type SupabaseLike } from "./entitlements.service";
import { PLAN_CATALOG } from "./plan-catalog";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const CONNECTION_ID = "33333333-3333-3333-3333-333333333333";
const ORDER_ID = "44444444-4444-4444-4444-444444444444";
const PRODUCT_ID = "55555555-5555-5555-5555-555555555555";
const VARIANT_ID = "66666666-6666-6666-6666-666666666666";
const TOKEN_KEY = "dev-token-encryption-key-32chars!!";

const channelsEnv = {
  META_APP_ID: "meta-app-id",
  META_APP_SECRET: "meta-secret",
  META_REDIRECT_URI: "https://app.example.com/meta/callback",
  META_GRAPH_VERSION: "v21.0",
  SUPABASE_URL: "https://supabase.example.com",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
} satisfies ChannelsEnv;

function entitlementsSupabase(input: {
  maxPages: number;
  autoConfirmAllowed: boolean;
  billingStatus: "active" | "past_due" | "suspended";
}) {
  return {
    from(table: string) {
      return {
        select() {
          const query = {
            eq() {
              return query;
            },
            maybeSingle: async () => {
              if (table === "entitlements") {
                return {
                  data: {
                    org_id: ORG_ID,
                    max_pages: input.maxPages,
                    ai_monthly_token_limit: 100_000,
                    auto_confirm_allowed: input.autoConfirmAllowed,
                    updated_at: "2026-07-25T00:00:00.000Z",
                  },
                  error: null,
                };
              }
              if (table === "organizations") {
                return {
                  data: {
                    id: ORG_ID,
                    billing_status: input.billingStatus,
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseLike;
}

describe("R1 eng prep — entitlement gate proof", () => {
  it("free catalog hard-limits max_pages and disallows auto_confirm", () => {
    expect(PLAN_CATALOG.free).toMatchObject({
      maxPages: 1,
      autoConfirmAllowed: false,
    });
  });

  it("blocks auto_confirm when entitlement flag is false (active billing)", async () => {
    const service = new EntitlementsService(
      entitlementsSupabase({
        maxPages: 1,
        autoConfirmAllowed: false,
        billingStatus: "active",
      }),
    );

    await expect(service.getEntitlements(ORG_ID)).resolves.toMatchObject({
      maxPages: 1,
      autoConfirmAllowed: false,
      autoConfirmBlockedReason: null,
    });
  });

  it("blocks auto_confirm when billing is past_due even if catalog allows", async () => {
    const service = new EntitlementsService(
      entitlementsSupabase({
        maxPages: 2,
        autoConfirmAllowed: true,
        billingStatus: "past_due",
      }),
    );

    await expect(service.getEntitlements(ORG_ID)).resolves.toMatchObject({
      autoConfirmAllowed: false,
      autoConfirmBlockedReason: "billing_past_due",
    });
  });

  it("returns 403 max_pages_exceeded when connecting beyond plan max_pages", async () => {
    const oauthStates = [
      {
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        org_id: ORG_ID,
        state: "oauth-state-1",
        user_id: USER_ID,
      },
    ];
    const upserts: unknown[] = [];
    const client = {
      from(table: string) {
        if (table === "oauth_states") {
          return {
            delete() {
              const filters: Array<{ field: string; value: string }> = [];
              let expiresAfter = "";
              const query = {
                eq(field: string, value: string) {
                  filters.push({ field, value });
                  return query;
                },
                gt(field: string, value: string) {
                  expect(field).toBe("expires_at");
                  expiresAfter = value;
                  return query;
                },
                select() {
                  return {
                    maybeSingle: async () => {
                      const index = oauthStates.findIndex(
                        (row) =>
                          filters.every(
                            (filter) =>
                              row[filter.field as keyof typeof row] ===
                              filter.value,
                          ) && row.expires_at > expiresAfter,
                      );
                      if (index === -1) {
                        return { data: null, error: null };
                      }
                      const [row] = oauthStates.splice(index, 1);
                      return { data: { state: row.state }, error: null };
                    },
                  };
                },
              };
              return query;
            },
          };
        }
        if (table === "channel_connections") {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq: async () => ({
                      data: [
                        {
                          id: CONNECTION_ID,
                          org_id: ORG_ID,
                          provider: "meta_page",
                          external_page_id: "page-existing",
                          external_ig_id: null,
                          status: "active",
                          created_at: "2026-07-24T10:00:00.000Z",
                        },
                      ],
                      error: null,
                    }),
                  };
                },
              };
            },
            upsert(values: unknown) {
              upserts.push(values);
              return {
                select: async () => ({ data: [], error: null }),
              };
            },
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as unknown as ChannelsSupabaseLike;

    const graph = {
      exchangeCodeForToken: async () => ({
        access_token: "USER_TOKEN",
        expires_in: 3600,
      }),
      debugToken: async () => ({
        data: {
          app_id: channelsEnv.META_APP_ID,
          is_valid: true,
          scopes: ["pages_show_list"],
          user_id: "meta-user-1",
        },
      }),
      getManagedPages: async () => ({
        data: [
          {
            id: "page-new",
            name: "New Shop Page",
            access_token: "EAAB_PLAIN",
          },
        ],
      }),
      getPageAccessToken: async () => ({
        id: "page-new",
        access_token: "EAAB_PLAIN",
      }),
    } satisfies GraphLike;

    const service = new ChannelsService(client, graph, undefined, channelsEnv, {
      getEntitlements: async () => ({
        orgId: ORG_ID,
        maxPages: PLAN_CATALOG.free.maxPages,
        aiMonthlyTokenLimit: PLAN_CATALOG.free.aiMonthlyTokenLimit,
        autoConfirmAllowed: PLAN_CATALOG.free.autoConfirmAllowed,
        updatedAt: "2026-07-25T00:00:00.000Z",
      }),
    });

    await expect(
      service.completeOAuth({
        orgId: ORG_ID,
        userId: USER_ID,
        code: "x",
        state: "oauth-state-1",
      }),
    ).rejects.toMatchObject({
      response: { code: "max_pages_exceeded" },
      status: 403,
    });
    expect(upserts).toEqual([]);
  });

  it("keeps draft (auto_confirm blocked) when org wants auto_confirm but plan disallows", async () => {
    const outboxInserts: Record<string, unknown>[] = [];
    const client = {
      rpc: vi.fn(async (fn: string) => {
        expect(fn).toBe("create_draft_order");
        return {
          data: {
            order: {
              id: ORDER_ID,
              status: "draft",
              paymentMethod: "cod",
              currency: "VND",
              subtotalVnd: "1000",
              totalVnd: "1000",
              createdAt: "2026-07-25T00:00:00.000Z",
              updatedAt: "2026-07-25T00:00:00.000Z",
            },
            items: [],
          },
          error: null,
        };
      }),
      from(table: string) {
        if (table === "outbox_events") {
          return {
            insert(values: Record<string, unknown>) {
              outboxInserts.push(values);
              return {
                select() {
                  return {
                    single: async () => ({
                      data: {
                        id: "outbox-1",
                        created_at: "2026-07-25T00:00:00.000Z",
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

        const chain = {
          select() {
            return chain;
          },
          eq() {
            return chain;
          },
          is() {
            return chain;
          },
          maybeSingle: async () => {
            if (table === "organizations") {
              return {
                data: { id: ORG_ID, settings_json: { auto_confirm: true } },
                error: null,
              };
            }
            if (table === "product_variants") {
              return {
                data: {
                  id: VARIANT_ID,
                  org_id: ORG_ID,
                  product_id: PRODUCT_ID,
                  sku: "AT-DEN-L",
                  title: "Black / L",
                  price_vnd: "1000",
                  stock_qty: 1,
                },
                error: null,
              };
            }
            if (table === "products") {
              return { data: { id: PRODUCT_ID }, error: null };
            }
            throw new Error(`unexpected maybeSingle table ${table}`);
          },
          insert() {
            expect(table).toBe("idempotency_keys");
            return Promise.resolve({ error: null });
          },
          update() {
            expect(table).toBe("idempotency_keys");
            return chain;
          },
        };
        return chain;
      },
    } as unknown as OrdersSupabaseLike;

    const audit = {
      writeAudit: vi.fn(async () => ({ audit: { id: "audit-id" } })),
    } satisfies AuditWriter;

    const service = new OrdersService(client, audit, {
      getEntitlements: async () => ({
        orgId: ORG_ID,
        maxPages: PLAN_CATALOG.free.maxPages,
        aiMonthlyTokenLimit: PLAN_CATALOG.free.aiMonthlyTokenLimit,
        autoConfirmAllowed: false,
        updatedAt: "2026-07-25T00:00:00.000Z",
      }),
    });

    const result = await service.createDraftOrder({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {
        paymentMethod: "cod",
        addressJson: {},
        items: [{ variantId: VARIANT_ID, qty: 1 }],
      },
      idempotencyKey: "r1-auto-confirm-blocked",
      path: "/v1/orders",
    });

    expect(result.order.status).toBe("draft");
    expect(client.rpc).toHaveBeenCalledWith(
      "create_draft_order",
      expect.anything(),
    );
    expect(audit.writeAudit).not.toHaveBeenCalled();
    expect(outboxInserts).toEqual([
      expect.objectContaining({
        org_id: ORG_ID,
        event_name: "order.created",
        payload_json: expect.objectContaining({
          event: "order.created",
          orderId: ORDER_ID,
          status: "draft",
        }),
      }),
    ]);
  });
});
