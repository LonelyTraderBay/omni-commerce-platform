import { describe, expect, it } from "vitest";

import { EntitlementsService, type SupabaseLike } from "./entitlements.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

function mockSupabase(input: { billingStatus: "active" | "past_due" }) {
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
                    max_pages: 2,
                    ai_monthly_token_limit: 2_000_000,
                    auto_confirm_allowed: true,
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

describe("EntitlementsService", () => {
  it("keeps catalog auto-confirm when billing is active", async () => {
    const service = new EntitlementsService(
      mockSupabase({ billingStatus: "active" }),
    );

    await expect(service.getEntitlements(ORG_ID)).resolves.toMatchObject({
      autoConfirmAllowed: true,
      autoConfirmBlockedReason: null,
    });
  });

  it("blocks auto-confirm when billing is past_due", async () => {
    const service = new EntitlementsService(
      mockSupabase({ billingStatus: "past_due" }),
    );

    await expect(service.getEntitlements(ORG_ID)).resolves.toMatchObject({
      autoConfirmAllowed: false,
      autoConfirmBlockedReason: "billing_past_due",
    });
  });
});
