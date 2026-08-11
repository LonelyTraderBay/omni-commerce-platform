import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MetaWebhookService,
  type MetaWebhookEnv,
  type SupabaseLike,
} from "./meta-webhook.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ORG_2_ID = "11111111-1111-1111-1111-111111111112";
const OUTBOX_ID = "22222222-2222-2222-2222-222222222222";
const RECEIPT_ID = "33333333-3333-3333-3333-333333333333";

const env = {
  META_APP_SECRET: "meta-app-secret",
  META_VERIFY_TOKEN: "verify-token",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_URL: "https://supabase.example.com",
} satisfies MetaWebhookEnv;

type SupabaseCall = {
  args?: unknown;
  columns?: string;
  field?: string;
  functionName?: string;
  op: string;
  options?: unknown;
  table?: string;
  value?: unknown;
  values?: unknown;
};

type ChannelMapping = {
  external_ig_id?: string | null;
  external_page_id?: string;
  org_id: string;
  provider?: "meta_page" | "meta_ig";
  status?: "active" | "needs_reauth" | "revoked";
};

type RpcResult = {
  outbox_event_id: string | null;
  receipt_id: string | null;
  receipt_inserted: boolean;
};

function signedPayload(payload: Record<string, unknown>) {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    payload,
    rawBody,
    signatureHeader:
      "sha256=" +
      createHmac("sha256", env.META_APP_SECRET).update(rawBody).digest("hex"),
  };
}

function metaPayload(overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    entry: [
      {
        id: "page-1",
        time: 1_721_824_400,
        messaging: [
          {
            sender: { id: "customer-1" },
            recipient: { id: "page-1" },
            timestamp: 1_721_824_400_000,
            message: {
              mid: "m_page_1",
              text: "hello",
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function instagramPayload(overrides: Record<string, unknown> = {}) {
  return metaPayload({
    object: "instagram",
    entry: [
      {
        id: "ig-1",
        time: 1_721_824_400,
        messaging: [
          {
            sender: { id: "ig-customer-1" },
            recipient: { id: "ig-1" },
            timestamp: 1_721_824_400_000,
            message: {
              mid: "m_ig_1",
              text: "hello from ig",
            },
          },
        ],
      },
    ],
    ...overrides,
  });
}

function mockSupabase(input: {
  mappings?: ChannelMapping[];
  rpcError?: { code?: string; message?: string };
  rpcResults?: RpcResult[];
}) {
  const calls: SupabaseCall[] = [];
  let rpcIndex = 0;

  const client = {
    from(table: string) {
      if (table === "channel_connections") {
        const filters: Array<{ field: string; value: unknown }> = [];
        const query = {
          select(columns: string) {
            calls.push({ op: "select", table, columns });
            return query;
          },
          eq(field: string, value: unknown) {
            calls.push({ op: "eq", field, value });
            filters.push({ field, value });
            return query;
          },
          in(field: string, value: unknown) {
            calls.push({ op: "in", field, value });
            const lookupIds = new Set(value as string[]);
            return {
              data: (input.mappings ?? []).filter((row) => {
                const normalized = normalizeMapping(row);
                return (
                  filters.every(
                    (filter) =>
                      normalized[filter.field as keyof typeof normalized] ===
                      filter.value,
                  ) &&
                  lookupIds.has(
                    normalized[field as keyof typeof normalized] as string,
                  )
                );
              }),
              error: null,
            };
          },
        };
        return query;
      }

      throw new Error(`Unexpected table ${table}`);
    },
    rpc(functionName: string, args: unknown) {
      calls.push({ args, functionName, op: "rpc" });
      return {
        single: async () => {
          if (input.rpcError) {
            return { data: null, error: input.rpcError };
          }

          const data = input.rpcResults?.[rpcIndex++] ?? {
            outbox_event_id: OUTBOX_ID,
            receipt_id: RECEIPT_ID,
            receipt_inserted: true,
          };

          return { data, error: null };
        },
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

function normalizeMapping(row: ChannelMapping) {
  return {
    external_ig_id: row.external_ig_id ?? null,
    external_page_id: row.external_page_id ?? "",
    org_id: row.org_id,
    provider: row.provider ?? "meta_page",
    status: row.status ?? "active",
  };
}

describe("MetaWebhookService", () => {
  it("returns challenge when verify token matches", () => {
    const service = new MetaWebhookService({} as SupabaseLike, env);

    expect(
      service.verifySubscription({
        challenge: "challenge-123",
        mode: "subscribe",
        verifyToken: env.META_VERIFY_TOKEN,
      }),
    ).toBe("challenge-123");
  });

  it("rejects bad signature", async () => {
    const { calls, client } = mockSupabase({
      mappings: [{ external_page_id: "page-1", org_id: ORG_ID }],
    });
    const service = new MetaWebhookService(client, env);
    const request = signedPayload(metaPayload());

    await expect(
      service.ingest({
        ...request,
        signatureHeader: "sha256=bad",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toEqual([]);
  });

  it("records receipt and outbox atomically for a new receipt", async () => {
    const { calls, client } = mockSupabase({
      mappings: [{ external_page_id: "page-1", org_id: ORG_ID }],
    });
    const service = new MetaWebhookService(client, env);
    const request = signedPayload(metaPayload());

    await expect(service.ingest(request)).resolves.toEqual({ ok: true });
    expect(calls).toContainEqual({
      columns: "external_page_id, external_ig_id, org_id",
      op: "select",
      table: "channel_connections",
    });
    expect(calls).toContainEqual({
      args: expect.objectContaining({
        p_org_id: ORG_ID,
        p_payload_json: request.payload,
        p_receipt_key: "m_page_1",
      }),
      functionName: "record_meta_webhook_receipt_and_enqueue",
      op: "rpc",
    });
    expect(calls).not.toContainEqual(expect.objectContaining({ op: "limit" }));
    expect(calls).not.toContainEqual(
      expect.objectContaining({ op: "insert", table: "outbox_events" }),
    );
  });

  it("uses entry id and time when message mid is absent", async () => {
    const { calls, client } = mockSupabase({
      mappings: [{ external_page_id: "page-1", org_id: ORG_ID }],
    });
    const service = new MetaWebhookService(client, env);
    const request = signedPayload(
      metaPayload({
        entry: [
          {
            id: "page-1",
            time: 1_721_824_400,
            messaging: [{ message: { text: "hello" } }],
          },
        ],
      }),
    );

    await expect(service.ingest(request)).resolves.toEqual({ ok: true });
    expect(calls).toContainEqual({
      args: expect.objectContaining({
        p_receipt_key: "page-1-1721824400",
      }),
      functionName: "record_meta_webhook_receipt_and_enqueue",
      op: "rpc",
    });
  });

  it("skips outbox on duplicate receipt_key", async () => {
    const { calls, client } = mockSupabase({
      mappings: [{ external_page_id: "page-1", org_id: ORG_ID }],
      rpcResults: [
        {
          outbox_event_id: null,
          receipt_id: null,
          receipt_inserted: false,
        },
      ],
    });
    const service = new MetaWebhookService(client, env);

    await expect(service.ingest(signedPayload(metaPayload()))).resolves.toEqual({
      ok: true,
    });
    expect(calls).toContainEqual(
      expect.objectContaining({
        functionName: "record_meta_webhook_receipt_and_enqueue",
        op: "rpc",
      }),
    );
    expect(calls).not.toContainEqual(
      expect.objectContaining({
        op: "insert",
        table: "outbox_events",
      }),
    );
  });

  it("does not leave a separate receipt insert path when outbox enqueue fails", async () => {
    const { calls, client } = mockSupabase({
      mappings: [{ external_page_id: "page-1", org_id: ORG_ID }],
      rpcError: { message: "outbox insert failed" },
    });
    const service = new MetaWebhookService(client, env);

    await expect(
      service.ingest(signedPayload(metaPayload())),
    ).rejects.toMatchObject({ status: 500 });
    expect(calls).toContainEqual(
      expect.objectContaining({
        functionName: "record_meta_webhook_receipt_and_enqueue",
        op: "rpc",
      }),
    );
    expect(calls).not.toContainEqual(
      expect.objectContaining({
        op: "upsert",
        table: "webhook_receipts",
      }),
    );
    expect(calls).not.toContainEqual(
      expect.objectContaining({
        op: "insert",
        table: "outbox_events",
      }),
    );
  });

  it("routes multi-page payload entries to their own organizations", async () => {
    const { calls, client } = mockSupabase({
      mappings: [
        { external_page_id: "page-1", org_id: ORG_ID },
        { external_page_id: "page-2", org_id: ORG_2_ID },
      ],
      rpcResults: [
        {
          outbox_event_id: OUTBOX_ID,
          receipt_id: RECEIPT_ID,
          receipt_inserted: true,
        },
        {
          outbox_event_id: "22222222-2222-2222-2222-222222222223",
          receipt_id: "33333333-3333-3333-3333-333333333334",
          receipt_inserted: true,
        },
      ],
    });
    const service = new MetaWebhookService(client, env);
    const request = signedPayload(
      metaPayload({
        entry: [
          {
            id: "page-1",
            time: 1_721_824_400,
            messaging: [{ message: { mid: "m_page_1" } }],
          },
          {
            id: "page-2",
            time: 1_721_824_401,
            messaging: [{ message: { mid: "m_page_2" } }],
          },
        ],
      }),
    );

    await expect(service.ingest(request)).resolves.toEqual({ ok: true });

    const rpcCalls = calls.filter((call) => call.op === "rpc");
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0]).toEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          p_org_id: ORG_ID,
          p_payload_json: expect.objectContaining({
            entry: [expect.objectContaining({ id: "page-1" })],
          }),
          p_receipt_key: "m_page_1",
        }),
      }),
    );
    expect(rpcCalls[1]).toEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          p_org_id: ORG_2_ID,
          p_payload_json: expect.objectContaining({
            entry: [expect.objectContaining({ id: "page-2" })],
          }),
          p_receipt_key: "m_page_2",
        }),
      }),
    );
    expect(calls).not.toContainEqual(expect.objectContaining({ op: "limit" }));
  });

  it("routes instagram entries by external_ig_id to their organization", async () => {
    const { calls, client } = mockSupabase({
      mappings: [
        {
          external_ig_id: "ig-1",
          external_page_id: "page-1",
          org_id: ORG_ID,
          provider: "meta_ig",
        },
      ],
    });
    const service = new MetaWebhookService(client, env);
    const request = signedPayload(instagramPayload());

    await expect(service.ingest(request)).resolves.toEqual({ ok: true });

    expect(calls).toContainEqual({
      field: "provider",
      op: "eq",
      value: "meta_ig",
    });
    expect(calls).toContainEqual({
      field: "external_ig_id",
      op: "in",
      value: ["ig-1"],
    });
    expect(calls).toContainEqual({
      args: expect.objectContaining({
        p_org_id: ORG_ID,
        p_payload_json: request.payload,
        p_receipt_key: "m_ig_1",
      }),
      functionName: "record_meta_webhook_receipt_and_enqueue",
      op: "rpc",
    });
  });

  it("routes instagram entries through page linkage when no meta_ig row exists", async () => {
    const { calls, client } = mockSupabase({
      mappings: [
        {
          external_ig_id: "ig-1",
          external_page_id: "page-1",
          org_id: ORG_ID,
          provider: "meta_page",
        },
      ],
    });
    const service = new MetaWebhookService(client, env);

    await expect(
      service.ingest(signedPayload(instagramPayload())),
    ).resolves.toEqual({ ok: true });
    expect(calls).toContainEqual({
      args: expect.objectContaining({
        p_org_id: ORG_ID,
        p_receipt_key: "m_ig_1",
      }),
      functionName: "record_meta_webhook_receipt_and_enqueue",
      op: "rpc",
    });
  });

  it("records unmapped entries without an outbox destination", async () => {
    const { calls, client } = mockSupabase({ mappings: [] });
    const service = new MetaWebhookService(client, env);

    await expect(service.ingest(signedPayload(metaPayload()))).resolves.toEqual({
      ok: true,
    });
    expect(calls).toContainEqual({
      args: expect.objectContaining({
        p_org_id: null,
        p_receipt_key: "m_page_1",
      }),
      functionName: "record_meta_webhook_receipt_and_enqueue",
      op: "rpc",
    });
  });

  it("records unmapped instagram entries without an outbox destination", async () => {
    const { calls, client } = mockSupabase({ mappings: [] });
    const service = new MetaWebhookService(client, env);

    await expect(
      service.ingest(signedPayload(instagramPayload())),
    ).resolves.toEqual({ ok: true });
    expect(calls).toContainEqual({
      args: expect.objectContaining({
        p_org_id: null,
        p_receipt_key: "m_ig_1",
      }),
      functionName: "record_meta_webhook_receipt_and_enqueue",
      op: "rpc",
    });
  });
});
