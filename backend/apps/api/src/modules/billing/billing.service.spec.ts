import { describe, expect, it } from "vitest";

import { BillingService, type SupabaseLike } from "./billing.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

type SupabaseCall = {
  op: string;
  table?: string;
  field?: string;
  value?: unknown;
  values?: unknown;
  options?: unknown;
};

type MockInput = {
  billingStatus?: string;
  /** Exact counts the database reports; deliberately not row arrays. */
  activePageCount?: number;
  ordersCount?: number;
  aiTokenSum?: number | string;
  invoices?: unknown[];
};

function mockSupabase(input: MockInput) {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(
          values: string,
          options?: { count?: string; head?: boolean },
        ) {
          calls.push({ op: "select", table, values, options });
          const query = {
            eq(field: string, value: unknown) {
              calls.push({ op: "eq", table, field, value });
              return query;
            },
            gte(field: string, value: unknown) {
              calls.push({ op: "gte", table, field, value });
              return query;
            },
            order(field: string, value: unknown) {
              calls.push({ op: "order", table, field, value });
              return query;
            },
            maybeSingle: async () => {
              if (table === "organizations") {
                return {
                  data: {
                    id: ORG_ID,
                    plan: "pilot",
                    billing_customer_email: "billing@example.com",
                    billing_status: input.billingStatus ?? "active",
                    plan_renews_at: "2026-08-01T00:00:00.000Z",
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
            then(resolve: (value: unknown) => unknown) {
              return Promise.resolve(resultFor(table, input, options)).then(
                resolve,
              );
            },
          };
          return query;
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ op: "rpc", table: fn, values: args });
      if (fn !== "sum_usage_event_quantity") {
        throw new Error(`Unexpected rpc call: ${fn}`);
      }
      // The SQL function returns `text` so a bigint sum survives JSON intact.
      return Promise.resolve({
        data: String(input.aiTokenSum ?? 0),
        error: null,
      });
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

function resultFor(
  table: string,
  input: MockInput,
  options?: { count?: string; head?: boolean },
) {
  // A `head: true` count request returns no rows at all — only the count. A
  // mock that returned rows here would let a client-side `.length` keep passing.
  if (options?.head) {
    if (table === "channel_connections") {
      return { data: null, count: input.activePageCount ?? 0, error: null };
    }
    if (table === "orders") {
      return { data: null, count: input.ordersCount ?? 0, error: null };
    }
    return { data: null, count: 0, error: null };
  }
  if (table === "billing_invoices") {
    return { data: input.invoices ?? [], error: null };
  }
  return { data: [], error: null };
}

function entitlementsMock(input: { autoConfirmAllowed: boolean }) {
  return {
    getEntitlements: async (orgId: string) => ({
      orgId,
      maxPages: 2,
      aiMonthlyTokenLimit: 2_000_000,
      autoConfirmAllowed: input.autoConfirmAllowed,
      autoConfirmBlockedReason: input.autoConfirmAllowed
        ? null
        : "billing_past_due",
      updatedAt: "2026-07-25T00:00:00.000Z",
    }),
  };
}

describe("BillingService", () => {
  it("returns current plan and entitlements for the organization", async () => {
    const { client } = mockSupabase({ billingStatus: "active" });
    const service = new BillingService(
      client,
      entitlementsMock({ autoConfirmAllowed: true }) as never,
    );

    await expect(service.getPlan(ORG_ID)).resolves.toMatchObject({
      plan: "pilot",
      billingStatus: "active",
      billingCustomerEmail: "billing@example.com",
      entitlements: {
        maxPages: 2,
        autoConfirmAllowed: true,
      },
      dunning: {
        autoConfirmBlocked: false,
        reason: null,
      },
    });
  });

  it("exposes past_due as an auto-confirm soft gate", async () => {
    const { client } = mockSupabase({ billingStatus: "past_due" });
    const service = new BillingService(
      client,
      entitlementsMock({ autoConfirmAllowed: false }) as never,
    );

    await expect(service.getPlan(ORG_ID)).resolves.toMatchObject({
      billingStatus: "past_due",
      entitlements: {
        autoConfirmAllowed: false,
        autoConfirmBlockedReason: "billing_past_due",
      },
      dunning: {
        autoConfirmBlocked: true,
        reason: "billing_past_due",
      },
    });
  });

  it("returns simple usage meters for the current month", async () => {
    const { client } = mockSupabase({
      activePageCount: 2,
      aiTokenSum: 125,
      ordersCount: 1,
    });
    const service = new BillingService(
      client,
      entitlementsMock({ autoConfirmAllowed: true }) as never,
    );

    await expect(
      service.getUsage(ORG_ID, new Date("2026-07-25T01:00:00.000Z")),
    ).resolves.toMatchObject({
      periodStart: "2026-07-01T00:00:00.000Z",
      pagesConnectedCount: 2,
      aiTokensMonth: 125,
      ordersCountMonth: 1,
    });
  });

  it("reports exact counts past PostgREST's default max-rows cap", async () => {
    // These meters used to fetch rows and count them with `.length`. PostgREST
    // caps a response at `db-max-rows` (1000 by default), so an org with 5,000
    // orders in the month was shown `ordersCountMonth: 1000` — and the AI token
    // total that quota enforcement reads was under-summed the same way.
    const { client, calls } = mockSupabase({
      activePageCount: 1_200,
      ordersCount: 5_000,
      aiTokenSum: "4200000",
    });
    const service = new BillingService(
      client,
      entitlementsMock({ autoConfirmAllowed: true }) as never,
    );

    await expect(
      service.getUsage(ORG_ID, new Date("2026-07-25T01:00:00.000Z")),
    ).resolves.toMatchObject({
      pagesConnectedCount: 1_200,
      ordersCountMonth: 5_000,
      aiTokensMonth: 4_200_000,
    });

    // Counting has to happen in Postgres: `head: true` means no rows are
    // transferred at all, so there is nothing left for a cap to truncate.
    expect(calls).toContainEqual({
      op: "select",
      table: "orders",
      values: "id",
      options: { count: "exact", head: true },
    });
    expect(calls).toContainEqual({
      op: "select",
      table: "channel_connections",
      values: "id",
      options: { count: "exact", head: true },
    });
    // ...and summing has to happen in Postgres too.
    expect(calls).toContainEqual({
      op: "rpc",
      table: "sum_usage_event_quantity",
      values: {
        p_org_id: ORG_ID,
        p_kind: "ai_tokens",
        p_since: "2026-07-01T00:00:00.000Z",
      },
    });
  });
});
