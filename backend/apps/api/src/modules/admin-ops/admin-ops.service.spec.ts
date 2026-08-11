import { describe, expect, it } from "vitest";

import { AdminOpsService, type SupabaseLike } from "./admin-ops.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

type QueryResult = {
  data: unknown;
  error: null;
};

type SupabaseCall = {
  op: string;
  table?: string;
  values?: unknown;
  field?: string;
  value?: unknown;
};

function mockSupabase(input: {
  listResult?: QueryResult;
  updateResults?: QueryResult[];
  insertResults?: QueryResult[];
}) {
  const calls: SupabaseCall[] = [];
  const updateResults = [...(input.updateResults ?? [])];
  const insertResults = [...(input.insertResults ?? [])];

  const client = {
    from(table: string) {
      return {
        select() {
          calls.push({ op: "select", table });
          return {
            order: async (field: string, value: unknown) => {
              calls.push({ op: "order", field, value });
              return input.listResult ?? { data: [], error: null };
            },
          };
        },
        update(values: unknown) {
          calls.push({ op: "update", table, values });
          const query = {
            eq(field: string, value: unknown) {
              calls.push({ op: "eq", field, value });
              return query;
            },
            is(field: string, value: unknown) {
              calls.push({ op: "is", field, value });
              return query;
            },
            select() {
              calls.push({ op: "select", table });
              return {
                maybeSingle: async () =>
                  updateResults.shift() ?? { data: null, error: null },
              };
            },
          };
          return query;
        },
        insert(values: unknown) {
          calls.push({ op: "insert", table, values });
          return {
            select() {
              calls.push({ op: "select", table });
              return {
                single: async () => {
                  const result = insertResults.shift();
                  if (!result) {
                    throw new Error("Unexpected Supabase insert");
                  }
                  return result;
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

function orgRow(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function flagRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    key: "kill_ai_all",
    org_id: null,
    enabled: true,
    payload_json: {},
    ...overrides,
  };
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    org_id: ORG_ID,
    period_start: "2026-07-01T00:00:00.000Z",
    period_end: "2026-08-01T00:00:00.000Z",
    amount_vnd: "1500000",
    status: "issued",
    issued_at: "2026-07-25T00:00:00.000Z",
    note: "Pilot thang 7",
    created_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("AdminOpsService", () => {
  it("lists organizations for platform admin ops", async () => {
    const { client } = mockSupabase({
      listResult: { data: [orgRow()], error: null },
    });
    const service = new AdminOpsService(client);

    const result = await service.listOrganizations();

    expect(result.organizations).toEqual([
      expect.objectContaining({ id: ORG_ID, slug: "shop-a" }),
    ]);
  });

  it("sets suspended_at on an organization", async () => {
    const suspendedAt = new Date("2026-07-24T11:00:00.000Z");
    const auditCalls: unknown[] = [];
    const { calls, client } = mockSupabase({
      updateResults: [
        {
          data: orgRow({ suspended_at: suspendedAt.toISOString() }),
          error: null,
        },
      ],
    });
    const service = new AdminOpsService(client, {
      writeAudit: async (input) => {
        auditCalls.push(input);
        return { audit: { id: "audit-1" } };
      },
    });

    const result = await service.suspendOrganization(ORG_ID, suspendedAt);

    expect(calls).toContainEqual({
      op: "update",
      table: "organizations",
      values: {
        suspended_at: suspendedAt.toISOString(),
        updated_at: suspendedAt.toISOString(),
      },
    });
    expect(auditCalls).toEqual([
      {
        orgId: ORG_ID,
        action: "organization.suspended",
        entityType: "organization",
        entityId: ORG_ID,
        meta: { suspendedAt: suspendedAt.toISOString() },
      },
    ]);
    expect(result.organization.suspendedAt).toBe(suspendedAt.toISOString());
  });

  it("updates organization plan and syncs catalog entitlements", async () => {
    const updatedAt = new Date("2026-07-24T12:00:00.000Z");
    const auditCalls: unknown[] = [];
    const entitlementCalls: unknown[] = [];
    const { calls, client } = mockSupabase({
      updateResults: [
        {
          data: orgRow({ plan: "starter", updated_at: updatedAt.toISOString() }),
          error: null,
        },
      ],
    });
    const service = new AdminOpsService(
      client,
      {
        writeAudit: async (input) => {
          auditCalls.push(input);
          return { audit: { id: "audit-1" } };
        },
      },
      {
        syncPlanEntitlements: async (orgId, plan, at) => {
          entitlementCalls.push({ orgId, plan, at });
          return {
            orgId,
            maxPages: 5,
            aiMonthlyTokenLimit: 10_000_000,
            autoConfirmAllowed: true,
            updatedAt: at.toISOString(),
          };
        },
      },
    );

    const result = await service.updateOrganizationPlan(
      ORG_ID,
      { plan: "starter" },
      updatedAt,
    );

    expect(calls).toContainEqual({
      op: "update",
      table: "organizations",
      values: { plan: "starter", updated_at: updatedAt.toISOString() },
    });
    expect(entitlementCalls).toEqual([
      { orgId: ORG_ID, plan: "starter", at: updatedAt },
    ]);
    expect(auditCalls).toEqual([
      {
        orgId: ORG_ID,
        action: "organization.plan_updated",
        entityType: "organization",
        entityId: ORG_ID,
        meta: { plan: "starter" },
      },
    ]);
    expect(result.organization.plan).toBe("starter");
    expect(result.entitlements).toMatchObject({
      maxPages: 5,
      aiMonthlyTokenLimit: 10_000_000,
      autoConfirmAllowed: true,
    });
  });

  it("updates a global kill switch flag", async () => {
    const { calls, client } = mockSupabase({
      updateResults: [
        {
          data: flagRow({ enabled: false }),
          error: null,
        },
      ],
    });
    const service = new AdminOpsService(client);

    const result = await service.setGlobalFlag("kill_ai_all", {
      enabled: false,
      payloadJson: {},
    });

    expect(calls).toContainEqual({ op: "is", field: "org_id", value: null });
    expect(result.flag).toMatchObject({
      key: "kill_ai_all",
      orgId: null,
      enabled: false,
    });
  });

  it("issues a manual billing invoice", async () => {
    const issuedAt = new Date("2026-07-25T00:00:00.000Z");
    const auditCalls: unknown[] = [];
    const { calls, client } = mockSupabase({
      insertResults: [{ data: invoiceRow(), error: null }],
    });
    const service = new AdminOpsService(client, {
      writeAudit: async (input) => {
        auditCalls.push(input);
        return { audit: { id: "audit-1" } };
      },
    });

    const result = await service.issueInvoice(
      ORG_ID,
      {
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-08-01T00:00:00.000Z",
        amountVnd: "1500000",
        note: "Pilot thang 7",
      },
      issuedAt,
    );

    expect(calls).toContainEqual({
      op: "insert",
      table: "billing_invoices",
      values: {
        org_id: ORG_ID,
        period_start: "2026-07-01T00:00:00.000Z",
        period_end: "2026-08-01T00:00:00.000Z",
        amount_vnd: "1500000",
        status: "issued",
        issued_at: issuedAt.toISOString(),
        note: "Pilot thang 7",
      },
    });
    expect(auditCalls).toEqual([
      {
        orgId: ORG_ID,
        actorType: "platform",
        action: "billing.invoice_issued",
        entityType: "billing_invoice",
        entityId: "33333333-3333-3333-3333-333333333333",
        meta: {
          periodStart: "2026-07-01T00:00:00.000Z",
          periodEnd: "2026-08-01T00:00:00.000Z",
          amountVnd: "1500000",
        },
      },
    ]);
    expect(result.invoice).toMatchObject({
      orgId: ORG_ID,
      amountVnd: "1500000",
      status: "issued",
    });
  });

  it("rejects unsupported global flags", async () => {
    const { client } = mockSupabase({});
    const service = new AdminOpsService(client);

    await expect(
      service.setGlobalFlag("random_flag", {
        enabled: true,
        payloadJson: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
