import { describe, expect, it, vi } from "vitest";

import {
  IdentityService,
  type AuditWriter,
  type SupabaseLike,
} from "./identity.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const ORDER_ID = "33333333-3333-3333-3333-333333333333";

type InsertCall = {
  table: string;
  values: unknown;
};

type RpcCall = {
  fn: string;
  args: unknown;
};

type QueryResult = {
  data: unknown;
  error: null;
};

type QueryCall = {
  table: string;
  select: string;
  filters: Array<{ column: string; value: string }>;
  orderBy?: { column: string; options: unknown };
  limit?: number;
  maybeSingle?: boolean;
};

function mockSupabase(results: QueryResult[]) {
  const insertCalls: InsertCall[] = [];
  const rpcCalls: RpcCall[] = [];

  const client = {
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return {
        single: async () => {
          const result = results.shift();
          if (!result) {
            throw new Error("Unexpected Supabase rpc");
          }
          return result;
        },
      };
    },
    from(table: string) {
      return {
        insert(values: unknown) {
          insertCalls.push({ table, values });
          return {
            select: () => ({
              single: async () => {
                const result = results.shift();
                if (!result) {
                  throw new Error("Unexpected Supabase insert");
                }
                return result;
              },
            }),
          };
        },
      };
    },
  } as unknown as SupabaseLike;

  return { client, insertCalls, rpcCalls };
}

type OrgUpdateCall = {
  values: unknown;
  filters: Array<{ column: string; value: unknown }>;
};

/**
 * Mocks the two-call sequence updateOrgSettings() makes against the
 * `organizations` table: a plain select-by-id (fetchOrganization, reused
 * as-is) followed by an update-and-return-the-new-row.
 */
function mockOrganizationSupabase(fixture: {
  initial: unknown;
  updated: unknown;
}) {
  const updateCalls: OrgUpdateCall[] = [];

  const client = {
    rpc() {
      throw new Error("rpc() should not be called");
    },
    from(table: string) {
      if (table !== "organizations") {
        throw new Error(`Unexpected table ${table}`);
      }
      return {
        select() {
          const chain = {
            eq() {
              return chain;
            },
            maybeSingle: () =>
              Promise.resolve({ data: fixture.initial, error: null }),
          };
          return chain;
        },
        update(values: unknown) {
          const call: OrgUpdateCall = { values, filters: [] };
          updateCalls.push(call);
          const chain = {
            eq(column: string, value: unknown) {
              call.filters.push({ column, value });
              return chain;
            },
            select: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: fixture.updated, error: null }),
            }),
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseLike;

  return { client, updateCalls };
}

function auditMock() {
  return {
    writeAudit: vi.fn(async () => ({ audit: { id: "audit-id" } })),
  } satisfies AuditWriter;
}

function mockExportSupabase(tables: Record<string, unknown[]>) {
  const queryCalls: QueryCall[] = [];

  const client = {
    rpc() {
      throw new Error("rpc() should not be called");
    },
    from(table: string) {
      return {
        select(select: string) {
          const call: QueryCall = { table, select, filters: [] };
          queryCalls.push(call);
          const chain = {
            eq(column: string, value: string) {
              call.filters.push({ column, value });
              return chain;
            },
            order(column: string, options: unknown) {
              call.orderBy = { column, options };
              return chain;
            },
            limit(limit: number) {
              call.limit = limit;
              return Promise.resolve({
                data: tables[table] ?? [],
                error: null,
              });
            },
            maybeSingle() {
              call.maybeSingle = true;
              return Promise.resolve({
                data: tables[table]?.[0] ?? null,
                error: null,
              });
            },
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseLike;

  return { client, queryCalls };
}

describe("IdentityService", () => {
  it("creates org owner membership and syncs entitlements from the plan catalog", async () => {
    const { client, insertCalls, rpcCalls } = mockSupabase([
      {
        data: {
          organization: {
            id: ORG_ID,
            name: "Shop A",
            slug: "shop-a",
            plan: "free",
            settings_json: {},
            timezone: "Asia/Ho_Chi_Minh",
            locale: "vi",
            suspended_at: null,
            created_at: "2026-07-24T10:00:00.000Z",
            updated_at: "2026-07-24T10:00:00.000Z",
          },
          membership: {
            id: "33333333-3333-3333-3333-333333333333",
            org_id: ORG_ID,
            user_id: USER_ID,
            role: "owner",
          },
          // create_organization_with_owner() inserts the entitlements row
          // scoped only by org_id, so the RPC itself always returns the
          // `entitlements` table's raw zeroed column defaults here — it is
          // IdentityService's job to sync real plan limits afterward.
          entitlements: {
            org_id: ORG_ID,
            max_pages: 0,
            ai_monthly_token_limit: 0,
            auto_confirm_allowed: false,
            updated_at: "2026-07-24T10:00:00.000Z",
          },
        },
        error: null,
      },
    ]);
    const syncPlanEntitlements = vi.fn(async () => ({
      orgId: ORG_ID,
      maxPages: 1,
      aiMonthlyTokenLimit: 100_000,
      autoConfirmAllowed: false,
      autoConfirmBlockedReason: null,
      updatedAt: "2026-07-24T10:00:00.000Z",
    }));
    const service = new IdentityService(client, undefined, undefined, {
      syncPlanEntitlements,
    });

    const result = await service.createOrganization(
      { id: USER_ID, email: "owner@example.com" },
      { name: "Shop A", slug: "shop-a" },
    );

    expect(rpcCalls).toEqual([
      {
        fn: "create_organization_with_owner",
        args: {
          p_name: "Shop A",
          p_owner_user_id: USER_ID,
          p_slug: "shop-a",
        },
      },
    ]);
    expect(insertCalls).toEqual([]);
    // Regression: a brand-new "free"-plan org must be provisioned with the
    // free plan's real entitlements (PLAN_CATALOG.free: 1 page, 100k AI
    // tokens/month), not the entitlements table's raw zeroed column defaults
    // that create_organization_with_owner() alone leaves in place — that bug
    // meant every new signup was unable to connect any channel or use AI at
    // all until a platform admin manually ran the admin-ops plan sync.
    expect(syncPlanEntitlements).toHaveBeenCalledWith(ORG_ID, "free");
    expect(result.entitlements).toMatchObject({
      orgId: ORG_ID,
      maxPages: 1,
      aiMonthlyTokenLimit: 100_000,
      autoConfirmAllowed: false,
    });
  });

  it("exports a practical org-scoped PDPA bundle and audits the export", async () => {
    const { client, queryCalls } = mockExportSupabase({
      organizations: [
        {
          id: ORG_ID,
          name: "Shop A",
          slug: "shop-a",
          plan: "free",
          settings_json: { locale: "vi" },
          timezone: "Asia/Ho_Chi_Minh",
          locale: "vi",
          suspended_at: null,
          created_at: "2026-07-24T10:00:00.000Z",
          updated_at: "2026-07-24T10:00:00.000Z",
        },
      ],
      memberships: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          org_id: ORG_ID,
          user_id: USER_ID,
          role: "owner",
          created_at: "2026-07-24T10:00:00.000Z",
          updated_at: "2026-07-24T10:00:00.000Z",
        },
      ],
      contacts: [
        {
          id: "55555555-5555-5555-5555-555555555555",
          org_id: ORG_ID,
          display_name: "Khach A",
          phone_e164: "+84900000000",
          page_scoped_id: "psid-1",
          ig_scoped_id: null,
          tags_json: ["vip"],
          created_at: "2026-07-24T10:01:00.000Z",
          updated_at: "2026-07-24T10:01:00.000Z",
        },
      ],
      conversations: [
        {
          id: "66666666-6666-6666-6666-666666666666",
          org_id: ORG_ID,
          channel: "messenger",
          channel_connection_id: "77777777-7777-7777-7777-777777777777",
          contact_id: "55555555-5555-5555-5555-555555555555",
          status: "open",
          bot_paused: false,
          bot_epoch: 1,
          assignee_user_id: null,
          last_message_at: "2026-07-24T10:02:00.000Z",
          created_at: "2026-07-24T10:01:00.000Z",
          updated_at: "2026-07-24T10:02:00.000Z",
        },
      ],
      orders: [
        {
          id: ORDER_ID,
          org_id: ORG_ID,
          conversation_id: "66666666-6666-6666-6666-666666666666",
          contact_id: "55555555-5555-5555-5555-555555555555",
          status: "confirmed",
          payment_method: "cod",
          customer_name: "Khach A",
          phone_e164: "+84900000000",
          address_text: "Quan 1",
          address_json: {},
          currency: "VND",
          subtotal_vnd: 2500,
          total_vnd: "2500",
          idempotency_key: null,
          confirmed_at: "2026-07-24T10:03:00.000Z",
          shipped_at: null,
          cancelled_at: null,
          done_at: null,
          created_at: "2026-07-24T10:03:00.000Z",
          updated_at: "2026-07-24T10:03:00.000Z",
          items: [
            {
              id: "88888888-8888-8888-8888-888888888888",
              product_id: "99999999-9999-9999-9999-999999999999",
              variant_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              title_snapshot: "Ao thun den",
              sku_snapshot: "AT-DEN",
              qty: 1,
              unit_price_vnd: 2500,
              line_total_vnd: "2500",
            },
          ],
        },
      ],
    });
    const audit = auditMock();
    const service = new IdentityService(client, undefined, audit);

    const bundle = await service.exportOrganizationData({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      now: new Date("2026-07-25T00:00:00.000Z"),
    });

    expect(bundle).toMatchObject({
      exportedAt: "2026-07-25T00:00:00.000Z",
      orgId: ORG_ID,
      generatedByUserId: USER_ID,
      organization: { id: ORG_ID, name: "Shop A" },
      memberships: [{ userId: USER_ID, role: "owner" }],
      contacts: [{ displayName: "Khach A", phoneE164: "+84900000000" }],
      conversations: [
        {
          id: "66666666-6666-6666-6666-666666666666",
          channel: "messenger",
        },
      ],
      orders: [
        {
          id: ORDER_ID,
          totalVnd: "2500",
          items: [{ skuSnapshot: "AT-DEN", lineTotalVnd: "2500" }],
        },
      ],
    });
    expect(queryCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "organizations",
          filters: [{ column: "id", value: ORG_ID }],
        }),
        expect.objectContaining({
          table: "contacts",
          filters: [{ column: "org_id", value: ORG_ID }],
        }),
        expect.objectContaining({
          table: "orders",
          filters: [{ column: "org_id", value: ORG_ID }],
        }),
      ]),
    );
    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        actorUserId: USER_ID,
        actorType: "user",
        action: "organization.pdpa_exported",
        entityType: "organization",
        entityId: ORG_ID,
        meta: {
          exportedAt: "2026-07-25T00:00:00.000Z",
          counts: {
            memberships: 1,
            contacts: 1,
            conversations: 1,
            orders: 1,
          },
        },
      }),
    );
  });

  it("records a pending organization delete request in audit logs", async () => {
    const { client } = mockExportSupabase({});
    const audit = auditMock();
    const service = new IdentityService(client, undefined, audit);

    const result = await service.requestOrganizationDelete({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      now: new Date("2026-07-25T01:00:00.000Z"),
    });

    expect(result).toEqual({
      deleteRequest: {
        orgId: ORG_ID,
        status: "pending",
        requestedByUserId: USER_ID,
        requestedAt: "2026-07-25T01:00:00.000Z",
      },
    });
    expect(audit.writeAudit).toHaveBeenCalledWith({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      actorType: "user",
      action: "organization.delete_requested",
      entityType: "organization",
      entityId: ORG_ID,
      meta: result.deleteRequest,
    });
  });

  it("merges a partial settings update onto existing settings_json using snake_case keys", async () => {
    const initialRow = {
      id: ORG_ID,
      name: "Shop A",
      slug: "shop-a",
      plan: "free",
      // aiDraftMaxAmountVnd / allowCskhApprove are the example keys called
      // out in the settings_json column comment (supabase/migrations/
      // 20260724120000_init_platform.sql) — this update must not know about
      // them, but must not erase them either.
      settings_json: { aiDraftMaxAmountVnd: 5_000_000, allowCskhApprove: false },
      timezone: "Asia/Ho_Chi_Minh",
      locale: "vi",
      suspended_at: null,
      created_at: "2026-07-24T10:00:00.000Z",
      updated_at: "2026-07-24T10:00:00.000Z",
    };
    const updatedRow = {
      ...initialRow,
      settings_json: {
        aiDraftMaxAmountVnd: 5_000_000,
        allowCskhApprove: false,
        auto_confirm: true,
      },
      updated_at: "2026-07-28T00:00:00.000Z",
    };
    const { client, updateCalls } = mockOrganizationSupabase({
      initial: initialRow,
      updated: updatedRow,
    });
    const service = new IdentityService(client);

    const result = await service.updateOrgSettings(ORG_ID, {
      autoConfirm: true,
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].values).toMatchObject({
      settings_json: {
        aiDraftMaxAmountVnd: 5_000_000,
        allowCskhApprove: false,
        auto_confirm: true,
      },
    });
    // Only the provided field is written — no ai_replies/ai_draft_orders/
    // ai_product_suggestions keys should appear from an undefined input.
    expect(
      Object.keys(
        (updateCalls[0].values as { settings_json: Record<string, unknown> })
          .settings_json,
      ),
    ).toEqual(['aiDraftMaxAmountVnd', 'allowCskhApprove', 'auto_confirm']);
    expect(updateCalls[0].filters).toEqual([{ column: "id", value: ORG_ID }]);
    // Response shape matches what listOrganizations/createOrganization already
    // return for `organization` (same mapOrganization() mapping).
    expect(result).toEqual({
      organization: {
        id: ORG_ID,
        name: "Shop A",
        slug: "shop-a",
        plan: "free",
        settingsJson: {
          aiDraftMaxAmountVnd: 5_000_000,
          allowCskhApprove: false,
          auto_confirm: true,
        },
        timezone: "Asia/Ho_Chi_Minh",
        locale: "vi",
        suspendedAt: null,
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    });
  });

  it("writes snake_case keys for every settings field when all four are provided", async () => {
    const initialRow = {
      id: ORG_ID,
      name: "Shop A",
      slug: "shop-a",
      plan: "free",
      settings_json: { locale: "vi" },
      timezone: "Asia/Ho_Chi_Minh",
      locale: "vi",
      suspended_at: null,
      created_at: "2026-07-24T10:00:00.000Z",
      updated_at: "2026-07-24T10:00:00.000Z",
    };
    const updatedRow = {
      ...initialRow,
      settings_json: {
        locale: "vi",
        auto_confirm: true,
        ai_replies: false,
        ai_draft_orders: false,
        ai_product_suggestions: true,
      },
      updated_at: "2026-07-28T01:00:00.000Z",
    };
    const { client, updateCalls } = mockOrganizationSupabase({
      initial: initialRow,
      updated: updatedRow,
    });
    const service = new IdentityService(client);

    await service.updateOrgSettings(ORG_ID, {
      autoConfirm: true,
      aiReplies: false,
      aiDraftOrders: false,
      aiProductSuggestions: true,
    });

    expect(updateCalls[0].values).toMatchObject({
      settings_json: {
        locale: "vi",
        auto_confirm: true,
        ai_replies: false,
        ai_draft_orders: false,
        ai_product_suggestions: true,
      },
    });
  });

  it("creates an invite and returns the raw token once", async () => {
    const { client, insertCalls } = mockSupabase([
      {
        data: {
          id: "44444444-4444-4444-4444-444444444444",
          org_id: ORG_ID,
          email: "cskh@example.com",
          role: "cskh",
          expires_at: "2026-08-01T00:00:00.000Z",
          created_at: "2026-07-25T00:00:00.000Z",
          accepted_at: null,
        },
        error: null,
      },
    ]);
    const service = new IdentityService(client);

    const result = await service.createInvite(ORG_ID, {
      email: "cskh@example.com",
      role: "cskh",
    });

    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(result.invite).toMatchObject({
      id: "44444444-4444-4444-4444-444444444444",
      orgId: ORG_ID,
      email: "cskh@example.com",
      role: "cskh",
      acceptedAt: null,
    });
    expect(insertCalls[0]).toMatchObject({
      table: "membership_invites",
      values: expect.objectContaining({
        org_id: ORG_ID,
        email: "cskh@example.com",
        role: "cskh",
        token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(
      (insertCalls[0].values as { token_hash: string }).token_hash,
    ).not.toEqual(result.token);
  });

  it("lists pending non-expired invites for an org", async () => {
    const { client, queryCalls } = mockInviteSupabase({
      list: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          org_id: ORG_ID,
          email: "cskh@example.com",
          role: "cskh",
          expires_at: "2026-08-01T00:00:00.000Z",
          created_at: "2026-07-25T00:00:00.000Z",
          accepted_at: null,
        },
      ],
    });
    const service = new IdentityService(client);

    const result = await service.listInvites(
      ORG_ID,
      new Date("2026-07-26T00:00:00.000Z"),
    );

    expect(result.invites).toEqual([
      {
        id: "44444444-4444-4444-4444-444444444444",
        orgId: ORG_ID,
        email: "cskh@example.com",
        role: "cskh",
        expiresAt: "2026-08-01T00:00:00.000Z",
        createdAt: "2026-07-25T00:00:00.000Z",
        acceptedAt: null,
      },
    ]);
    expect(queryCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "membership_invites",
          filters: expect.arrayContaining([
            { column: "org_id", value: ORG_ID },
            { column: "accepted_at", value: null, op: "is" },
          ]),
        }),
      ]),
    );
  });

  it("accepts a valid invite token and invalidates it", async () => {
    const { createHash } = await import("node:crypto");
    const rawToken = "a".repeat(64);
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const inviteeId = "55555555-5555-5555-5555-555555555555";
    const { client, insertCalls, updateCalls } = mockInviteSupabase({
      acceptLookup: {
        id: "44444444-4444-4444-4444-444444444444",
        org_id: ORG_ID,
        email: "cskh@example.com",
        role: "cskh",
        token_hash: tokenHash,
        expires_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-07-25T00:00:00.000Z",
        accepted_at: null,
      },
      membershipInsert: {
        id: "66666666-6666-6666-6666-666666666666",
        org_id: ORG_ID,
        user_id: inviteeId,
        role: "cskh",
      },
    });
    const service = new IdentityService(client);

    const result = await service.acceptInvite(
      { id: inviteeId, email: "cskh@example.com" },
      { token: rawToken },
    );

    expect(result.membership).toEqual({
      id: "66666666-6666-6666-6666-666666666666",
      orgId: ORG_ID,
      userId: inviteeId,
      role: "cskh",
    });
    expect(result.invite.acceptedAt).toBeTruthy();
    expect(insertCalls).toEqual([
      expect.objectContaining({
        table: "memberships",
        values: {
          org_id: ORG_ID,
          user_id: inviteeId,
          role: "cskh",
        },
      }),
    ]);
    expect(updateCalls).toEqual([
      expect.objectContaining({
        table: "membership_invites",
        values: { accepted_at: expect.any(String) },
        filters: expect.arrayContaining([
          { column: "id", value: "44444444-4444-4444-4444-444444444444" },
          { column: "accepted_at", value: null, op: "is" },
        ]),
      }),
    ]);
  });

  it("rejects accept when signed-in email does not match invite", async () => {
    const { createHash } = await import("node:crypto");
    const rawToken = "b".repeat(64);
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const { client } = mockInviteSupabase({
      acceptLookup: {
        id: "44444444-4444-4444-4444-444444444444",
        org_id: ORG_ID,
        email: "cskh@example.com",
        role: "cskh",
        token_hash: tokenHash,
        expires_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-07-25T00:00:00.000Z",
        accepted_at: null,
      },
    });
    const service = new IdentityService(client);

    await expect(
      service.acceptInvite(
        { id: "55555555-5555-5555-5555-555555555555", email: "other@example.com" },
        { token: rawToken },
      ),
    ).rejects.toMatchObject({
      response: { code: "invite_email_mismatch" },
    });
  });
});

type InviteQueryCall = {
  table: string;
  select?: string;
  filters: Array<{ column: string; value: unknown; op?: string }>;
  orderBy?: { column: string; options: unknown };
};

type InviteUpdateCall = {
  table: string;
  values: unknown;
  filters: Array<{ column: string; value: unknown; op?: string }>;
};

function mockInviteSupabase(fixture: {
  list?: unknown[];
  acceptLookup?: unknown | null;
  membershipInsert?: unknown;
}) {
  const insertCalls: InsertCall[] = [];
  const updateCalls: InviteUpdateCall[] = [];
  const queryCalls: InviteQueryCall[] = [];

  const client = {
    rpc() {
      throw new Error("rpc() should not be called");
    },
    from(table: string) {
      return {
        insert(values: unknown) {
          insertCalls.push({ table, values });
          return {
            select: () => ({
              single: async () => ({
                data: fixture.membershipInsert ?? null,
                error: null,
              }),
            }),
          };
        },
        update(values: unknown) {
          const call: InviteUpdateCall = { table, values, filters: [] };
          updateCalls.push(call);
          const chain = {
            eq(column: string, value: unknown) {
              call.filters.push({ column, value });
              return chain;
            },
            is(column: string, value: unknown) {
              call.filters.push({ column, value, op: "is" });
              return Promise.resolve({ data: null, error: null });
            },
          };
          return chain;
        },
        select(select: string) {
          const call: InviteQueryCall = { table, select, filters: [] };
          queryCalls.push(call);
          const chain = {
            eq(column: string, value: unknown) {
              call.filters.push({ column, value });
              return chain;
            },
            is(column: string, value: unknown) {
              call.filters.push({ column, value, op: "is" });
              return chain;
            },
            gt(column: string, value: unknown) {
              call.filters.push({ column, value, op: "gt" });
              return chain;
            },
            order(column: string, orderOptions: unknown) {
              call.orderBy = { column, options: orderOptions };
              return Promise.resolve({
                data: fixture.list ?? [],
                error: null,
              });
            },
            maybeSingle() {
              return Promise.resolve({
                data: fixture.acceptLookup ?? null,
                error: null,
              });
            },
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseLike;

  return { client, insertCalls, updateCalls, queryCalls };
}
