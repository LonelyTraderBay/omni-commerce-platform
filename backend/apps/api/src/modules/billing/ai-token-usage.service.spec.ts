import { describe, expect, it } from "vitest";

import {
  AI_TOKEN_USAGE_KIND,
  AiTokenUsageService,
  type SupabaseLike,
} from "./ai-token-usage.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

type SupabaseCall = {
  op: string;
  table?: string;
  field?: string;
  value?: unknown;
  values?: unknown;
};

function mockSupabase(input: {
  limit: number | string;
  /** Whole-month total the SQL aggregate reports, as PostgREST `text`. */
  usageSum?: number | string;
}) {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(values: string) {
          calls.push({ op: "select", table, values });
          const query = {
            eq(field: string, value: unknown) {
              calls.push({ op: "eq", table, field, value });
              return query;
            },
            gte(field: string, value: unknown) {
              calls.push({ op: "gte", table, field, value });
              return query;
            },
            maybeSingle: async () => {
              if (table === "entitlements") {
                return {
                  data: {
                    org_id: ORG_ID,
                    ai_monthly_token_limit: input.limit,
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          };

          return query;
        },
        insert(values: unknown) {
          calls.push({ op: "insert", table, values });
          return Promise.resolve({ error: null });
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ op: "rpc", table: fn, values: args });
      if (fn !== "sum_usage_event_quantity") {
        throw new Error(`Unexpected rpc call: ${fn}`);
      }
      return Promise.resolve({ data: String(input.usageSum ?? 0), error: null });
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

describe("AiTokenUsageService", () => {
  it("reports quota exceeded when monthly usage meets the entitlement limit", async () => {
    const { client } = mockSupabase({ limit: 100, usageSum: 100 });
    const service = new AiTokenUsageService(client);

    await expect(service.getQuotaStatus(ORG_ID)).resolves.toMatchObject({
      allowed: false,
      exceeded: true,
      used: 100,
      limit: 100,
    });
  });

  it("allows usage below the monthly entitlement limit", async () => {
    const { client } = mockSupabase({ limit: 1_000, usageSum: 250 });
    const service = new AiTokenUsageService(client);

    await expect(service.getQuotaStatus(ORG_ID)).resolves.toMatchObject({
      allowed: true,
      exceeded: false,
      used: 250,
      limit: 1_000,
    });
  });

  it("reads usage as a SQL aggregate, so the quota gate cannot be under-counted", async () => {
    // The gate used to sum `usage_events` rows client-side with no `.limit()`.
    // PostgREST caps that at `db-max-rows` (1000 by default), so the busiest
    // orgs — the only ones that can actually blow a token limit — were exactly
    // the ones whose usage was truncated and whose limit never engaged.
    const { client, calls } = mockSupabase({
      limit: 2_000_000,
      usageSum: "2500000",
    });
    const service = new AiTokenUsageService(client);

    await expect(service.getQuotaStatus(ORG_ID)).resolves.toMatchObject({
      allowed: false,
      exceeded: true,
      used: 2_500_000,
    });
    expect(
      calls.some(
        (call) =>
          call.op === "rpc" && call.table === "sum_usage_event_quantity",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.op === "select" && call.table === "usage_events",
      ),
    ).toBe(false);
  });

  it("records ai token usage events", async () => {
    const { client, calls } = mockSupabase({ limit: 1_000 });
    const service = new AiTokenUsageService(client);

    await service.recordUsage({
      orgId: ORG_ID,
      quantity: 17,
      refType: "message",
      refId: "33333333-3333-3333-3333-333333333333",
    });

    expect(calls).toContainEqual({
      op: "insert",
      table: "usage_events",
      values: {
        org_id: ORG_ID,
        kind: AI_TOKEN_USAGE_KIND,
        quantity: 17,
        ref_type: "message",
        ref_id: "33333333-3333-3333-3333-333333333333",
      },
    });
  });
});
