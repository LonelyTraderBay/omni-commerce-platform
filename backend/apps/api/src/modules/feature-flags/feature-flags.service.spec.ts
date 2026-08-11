import { describe, expect, it } from "vitest";

import { FeatureFlagsService, type SupabaseLike } from "./feature-flags.service";

type QueryResult = {
  data: unknown;
  error: null;
};

type SupabaseCall = {
  op: string;
  table?: string;
  columns?: string;
  field?: string;
  value?: unknown;
};

function mockSupabase(results: QueryResult[]) {
  const calls: SupabaseCall[] = [];
  const queuedResults = [...results];

  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          calls.push({ op: "select", table, columns });
          const query = {
            eq(field: string, value: unknown) {
              calls.push({ op: "eq", field, value });
              return query;
            },
            is(field: string, value: unknown) {
              calls.push({ op: "is", field, value });
              return query;
            },
            maybeSingle: async () =>
              queuedResults.shift() ?? { data: null, error: null },
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

describe("FeatureFlagsService", () => {
  it("defaults global kill_ai_outbound to disabled when no row exists", async () => {
    const { calls, client } = mockSupabase([{ data: null, error: null }]);
    const service = new FeatureFlagsService(client);

    await expect(service.isEnabled("kill_ai_outbound", null)).resolves.toBe(
      false,
    );
    expect(calls).toContainEqual({ op: "is", field: "org_id", value: null });
  });

  it("enables global kill_ai_outbound when the flag row is enabled", async () => {
    const { client } = mockSupabase([
      {
        data: { key: "kill_ai_outbound", org_id: null, enabled: true },
        error: null,
      },
    ]);
    const service = new FeatureFlagsService(client);

    await expect(service.isEnabled("kill_ai_outbound", null)).resolves.toBe(
      true,
    );
  });
});
