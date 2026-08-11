import { describe, expect, it } from "vitest";

import {
  type SupabaseLike,
  ZaloWebhookService,
  type ZaloWebhookEnv,
} from "./zalo-webhook.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

const env = {
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_URL: "https://supabase.example.com",
  ZALO_WEBHOOK_SECRET: "zalo-secret",
} satisfies ZaloWebhookEnv;

// Deployments where Zalo is not configured: the secret is either absent from
// the env or present but empty. Both must fail closed (see verifySecret).
const envWithoutSecret = {
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_URL: "https://supabase.example.com",
} satisfies ZaloWebhookEnv;

const envWithEmptySecret = {
  ...envWithoutSecret,
  ZALO_WEBHOOK_SECRET: "",
} satisfies ZaloWebhookEnv;

type SupabaseCall = {
  args?: unknown;
  columns?: string;
  field?: string;
  functionName?: string;
  op: string;
  table?: string;
  value?: unknown;
};

function zaloPayload(overrides: Record<string, unknown> = {}) {
  return {
    oa_id: "oa-1",
    event_name: "user_send_text",
    timestamp: 1_721_824_400_000,
    message: {
      msg_id: "zalo-message-1",
      text: "xin chao",
    },
    sender: {
      id: "zalo-user-1",
    },
    ...overrides,
  };
}

function request(payload: Record<string, unknown>) {
  return {
    payload,
    rawBody: Buffer.from(JSON.stringify(payload), "utf8"),
    secretHeader: env.ZALO_WEBHOOK_SECRET,
  };
}

function mockSupabase(input: {
  orgId?: string | null;
  rpcError?: { code?: string; message?: string };
}) {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      if (table !== "channel_connections") {
        throw new Error(`Unexpected table ${table}`);
      }

      const filters: Array<{ field: string; value: unknown }> = [];
      const query = {
        select(columns: string) {
          calls.push({ columns, op: "select", table });
          return query;
        },
        eq(field: string, value: unknown) {
          calls.push({ field, op: "eq", table, value });
          filters.push({ field, value });
          return query;
        },
        maybeSingle: async () => {
          const matchesZalo = filters.every((filter) => {
            const expected: Record<string, unknown> = {
              external_page_id: "oa-1",
              provider: "zalo_oa",
              status: "active",
            };
            return expected[filter.field] === filter.value;
          });

          return {
            data:
              matchesZalo && input.orgId !== null
                ? { org_id: input.orgId ?? ORG_ID }
                : null,
            error: null,
          };
        },
      };

      return query;
    },
    rpc(functionName: string, args: unknown) {
      calls.push({ args, functionName, op: "rpc" });
      return {
        single: async () =>
          input.rpcError
            ? { data: null, error: input.rpcError }
            : {
                data: {
                  outbox_event_id: "22222222-2222-2222-2222-222222222222",
                  receipt_id: "33333333-3333-3333-3333-333333333333",
                  receipt_inserted: true,
                },
                error: null,
              },
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

describe("ZaloWebhookService", () => {
  it("verifies secret, maps OA ID, and records receipt/outbox atomically", async () => {
    const { calls, client } = mockSupabase({});
    const service = new ZaloWebhookService(client, env);
    const payload = zaloPayload();

    await expect(service.ingest(request(payload))).resolves.toEqual({ ok: true });
    expect(calls).toContainEqual({
      columns: "org_id",
      op: "select",
      table: "channel_connections",
    });
    expect(calls).toContainEqual({
      field: "provider",
      op: "eq",
      table: "channel_connections",
      value: "zalo_oa",
    });
    expect(calls).toContainEqual({
      field: "external_page_id",
      op: "eq",
      table: "channel_connections",
      value: "oa-1",
    });
    expect(calls).toContainEqual({
      args: expect.objectContaining({
        p_org_id: ORG_ID,
        p_payload_json: payload,
        p_receipt_key: "zalo-message-1",
      }),
      functionName: "record_zalo_webhook_receipt_and_enqueue",
      op: "rpc",
    });
    expect(calls).not.toContainEqual(
      expect.objectContaining({ op: "insert", table: "webhook_receipts" }),
    );
    expect(calls).not.toContainEqual(
      expect.objectContaining({ op: "insert", table: "outbox_events" }),
    );
  });

  it("rejects a bad configured webhook secret before database writes", async () => {
    const { calls, client } = mockSupabase({});
    const service = new ZaloWebhookService(client, env);

    await expect(
      service.ingest({
        ...request(zaloPayload()),
        secretHeader: "bad-secret",
      }),
    ).rejects.toMatchObject({
      response: { code: "zalo_webhook_secret_invalid" },
      status: 401,
    });
    expect(calls).toEqual([]);
  });

  it("rejects a missing header when a secret is configured, before database writes", async () => {
    const { calls, client } = mockSupabase({});
    const service = new ZaloWebhookService(client, env);

    await expect(
      service.ingest({
        ...request(zaloPayload()),
        secretHeader: undefined,
      }),
    ).rejects.toMatchObject({
      response: { code: "zalo_webhook_secret_invalid" },
      status: 401,
    });
    expect(calls).toEqual([]);
  });

  it("fails closed when the secret is configured as an empty string, never touching Supabase", async () => {
    const { calls, client } = mockSupabase({});
    const service = new ZaloWebhookService(client, envWithEmptySecret);

    await expect(
      service.ingest({
        ...request(zaloPayload()),
        secretHeader: undefined,
      }),
    ).rejects.toMatchObject({
      response: { code: "zalo_webhook_not_configured" },
      status: 401,
    });
    expect(calls).toEqual([]);
  });

  it("fails closed when ZALO_WEBHOOK_SECRET is absent from the env, even if a header is supplied", async () => {
    const { calls, client } = mockSupabase({});
    const service = new ZaloWebhookService(client, envWithoutSecret);

    await expect(
      service.ingest({
        ...request(zaloPayload()),
        secretHeader: "attacker-supplied-anything",
      }),
    ).rejects.toMatchObject({
      response: { code: "zalo_webhook_not_configured" },
      status: 401,
    });
    expect(calls).toEqual([]);
  });
});
