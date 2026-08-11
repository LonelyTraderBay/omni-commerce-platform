import { describe, expect, it, vi } from "vitest";

import { encryptToken } from "../../common/crypto/token-crypto";
import { signWebhookPayload } from "../../modules/public-api/public-api.service";
import {
  OrderWebhookDispatchService,
  type SupabaseLike,
} from "./order-webhook-dispatch";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ORDER_ID = "22222222-2222-2222-2222-222222222222";
const OUTBOX_EVENT_ID = "33333333-3333-3333-3333-333333333333";
const WEBHOOK_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_WEBHOOK_ID = "55555555-5555-5555-5555-555555555555";
const SECRET = "webhook-secret-value";
const ENCRYPTION_KEY = "x".repeat(32);
const NOW = new Date("2026-07-28T06:00:00.000Z");

type WebhookRow = {
  id: string;
  org_id: string;
  url: string;
  secret_enc: string;
  events: string[];
  enabled: boolean;
};

function webhookRow(overrides: Partial<WebhookRow> = {}): WebhookRow {
  return {
    id: WEBHOOK_ID,
    org_id: ORG_ID,
    url: "https://erp.example.test/webhooks/omni",
    secret_enc: encryptToken(SECRET, ENCRYPTION_KEY),
    events: ["order.shipped"],
    enabled: true,
    ...overrides,
  };
}

function mockSupabase(rows: WebhookRow[]) {
  const client = {
    from(table: string) {
      if (table !== "outbound_webhooks") {
        throw new Error(`unexpected table ${table}`);
      }

      const filters: Array<{ field: string; value: unknown }> = [];
      const query = {
        select() {
          return query;
        },
        eq(field: string, value: unknown) {
          filters.push({ field, value });
          return query;
        },
        contains(field: string, values: unknown[]) {
          const data = rows.filter((row) => {
            const record = row as unknown as Record<string, unknown>;
            const matchesEq = filters.every(
              ({ field: eqField, value }) => record[eqField] === value,
            );
            const rowValues = record[field] as unknown[];
            const matchesContains = values.every((value) =>
              rowValues.includes(value),
            );
            return matchesEq && matchesContains;
          });

          return Promise.resolve({ data, error: null });
        },
      };

      return query;
    },
  } as unknown as SupabaseLike;

  return client;
}

function createService(
  rows: WebhookRow[],
  overrides: { sender?: ReturnType<typeof vi.fn> } = {},
) {
  const sender =
    overrides.sender ?? vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const service = new OrderWebhookDispatchService({
    env: { TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY },
    now: () => NOW,
    sender,
    supabase: mockSupabase(rows),
  });

  return { service, sender };
}

function dispatchInput(overrides: Record<string, unknown> = {}) {
  return {
    event: "order.shipped",
    orderId: ORDER_ID,
    status: "shipped",
    orgId: ORG_ID,
    outboxEventId: OUTBOX_EVENT_ID,
    ...overrides,
  };
}

describe("OrderWebhookDispatchService", () => {
  it("does nothing and makes no HTTP call when no webhook matches the event", async () => {
    const { service, sender } = createService([
      webhookRow({ events: ["order.cancelled"] }),
    ]);

    await expect(service.dispatch(dispatchInput())).resolves.toEqual({
      ok: true,
      dispatched: 0,
    });
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends one correctly signed payload to a matching enabled webhook", async () => {
    const { service, sender } = createService([webhookRow()]);

    await expect(service.dispatch(dispatchInput())).resolves.toEqual({
      ok: true,
      dispatched: 1,
    });

    expect(sender).toHaveBeenCalledTimes(1);
    const call = sender.mock.calls[0]?.[0];
    expect(call.url).toBe("https://erp.example.test/webhooks/omni");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.headers["X-Omni-Event"]).toBe("order.shipped");
    expect(call.headers["X-Omni-Timestamp"]).toBe(
      Math.floor(NOW.getTime() / 1000).toString(),
    );
    expect(call.headers["X-Omni-Signature"]).toBe(
      signWebhookPayload(SECRET, call.headers["X-Omni-Timestamp"], call.body),
    );
    expect(JSON.parse(call.body)).toEqual({
      id: OUTBOX_EVENT_ID,
      event: "order.shipped",
      sentAt: NOW.toISOString(),
      data: {
        orderId: ORDER_ID,
        status: "shipped",
      },
    });
  });

  it("does not call a webhook that is not subscribed to this event", async () => {
    const notSubscribed = webhookRow({
      id: OTHER_WEBHOOK_ID,
      events: ["order.confirmed", "order.cancelled"],
    });
    const { service, sender } = createService([notSubscribed]);

    await expect(service.dispatch(dispatchInput())).resolves.toEqual({
      ok: true,
      dispatched: 0,
    });
    expect(sender).not.toHaveBeenCalled();
  });

  it("excludes disabled webhooks even when the events array matches", async () => {
    const disabled = webhookRow({ enabled: false });
    const { service, sender } = createService([disabled]);

    await expect(service.dispatch(dispatchInput())).resolves.toEqual({
      ok: true,
      dispatched: 0,
    });
    expect(sender).not.toHaveBeenCalled();
  });

  it("rejects so the outbox layer retries when the endpoint responds non-2xx", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { service } = createService([webhookRow()], { sender });

    await expect(service.dispatch(dispatchInput())).rejects.toThrow(/500/);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("sends to every enabled webhook subscribed to the event", async () => {
    const first = webhookRow();
    const second = webhookRow({
      id: OTHER_WEBHOOK_ID,
      url: "https://erp2.example.test/webhooks/omni",
    });
    const { service, sender } = createService([first, second]);

    await expect(service.dispatch(dispatchInput())).resolves.toEqual({
      ok: true,
      dispatched: 2,
    });
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("still delivers to a healthy webhook when an earlier one responds non-2xx", async () => {
    const dead = webhookRow({ url: "https://dead.example.test/webhooks/omni" });
    const healthy = webhookRow({
      id: OTHER_WEBHOOK_ID,
      url: "https://healthy.example.test/webhooks/omni",
    });
    const sender = vi.fn().mockImplementation(async (input: { url: string }) => {
      if (input.url === "https://dead.example.test/webhooks/omni") {
        return { ok: false, status: 500 };
      }
      return { ok: true, status: 200 };
    });
    const { service } = createService([dead, healthy], { sender });

    await expect(service.dispatch(dispatchInput())).rejects.toThrow(
      /1 of 2 webhook/,
    );

    // The healthy endpoint is not starved by the dead one.
    expect(sender).toHaveBeenCalledTimes(2);
    const targetedUrls = sender.mock.calls.map((call) => call[0].url);
    expect(targetedUrls).toContain("https://healthy.example.test/webhooks/omni");
  });

  it("reports every failing webhook id and status in the thrown error", async () => {
    const deadA = webhookRow({ url: "https://a.example.test/hook" });
    const deadB = webhookRow({
      id: OTHER_WEBHOOK_ID,
      url: "https://b.example.test/hook",
    });
    const sender = vi.fn().mockImplementation(async (input: { url: string }) => {
      return input.url === "https://a.example.test/hook"
        ? { ok: false, status: 500 }
        : { ok: false, status: 404 };
    });
    const { service } = createService([deadA, deadB], { sender });

    const error = await service
      .dispatch(dispatchInput())
      .then(() => null)
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(WEBHOOK_ID);
    expect(message).toContain(OTHER_WEBHOOK_ID);
    expect(message).toContain("500");
    expect(message).toContain("404");
    expect(message).toContain(OUTBOX_EVENT_ID);
  });

  it("treats an undecryptable secret as that webhook's failure, not an org-wide blackout", async () => {
    // Simulates a TOKEN_ENCRYPTION_KEY rotation that left one row behind.
    const rotated = webhookRow({
      secret_enc: encryptToken(SECRET, "y".repeat(32)),
      url: "https://rotated.example.test/hook",
    });
    const healthy = webhookRow({
      id: OTHER_WEBHOOK_ID,
      url: "https://healthy.example.test/hook",
    });
    const { service, sender } = createService([rotated, healthy]);

    await expect(service.dispatch(dispatchInput())).rejects.toThrow(
      /1 of 2 webhook/,
    );

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]?.[0].url).toBe(
      "https://healthy.example.test/hook",
    );
  });
});
