import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { decryptToken } from "../../common/crypto/token-crypto";
import { loadEnv, type Env } from "../../config/env";
import { signWebhookPayload } from "../../modules/public-api/public-api.service";
import { inngest } from "../inngest.client";

export type SupabaseLike = Pick<SupabaseClient, "from">;
export type JsonObject = Record<string, unknown>;

type OrderWebhookDispatchInput = JsonObject & {
  event?: unknown;
  orderId?: unknown;
  status?: unknown;
  orgId?: unknown;
  outboxEventId?: unknown;
};

type OrderWebhookDispatchEnv = Pick<Env, "TOKEN_ENCRYPTION_KEY">;

type WebhookSender = (input: {
  body: string;
  headers: Record<string, string>;
  url: string;
}) => Promise<{ ok: boolean; status: number }>;

type OrderWebhookDispatchOptions = {
  env?: OrderWebhookDispatchEnv;
  now?: () => Date;
  sender?: WebhookSender;
  supabase?: SupabaseLike;
};

type OutboundWebhookRow = {
  id: string;
  org_id: string;
  url: string;
  secret_enc: string;
  events: string[];
  enabled: boolean;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

const OUTBOUND_WEBHOOK_SELECT = "id, org_id, url, secret_enc, events, enabled";

export class OrderWebhookDispatchService {
  private readonly env: OrderWebhookDispatchEnv;
  private readonly now: () => Date;
  private readonly sender: WebhookSender;
  private readonly supabase: SupabaseLike;

  constructor(options: OrderWebhookDispatchOptions = {}) {
    this.env = options.env ?? loadEnv();
    this.now = options.now ?? (() => new Date());
    this.sender = options.sender ?? defaultWebhookSender;
    this.supabase = options.supabase ?? createSupabaseServiceClient();
  }

  async dispatch(input: OrderWebhookDispatchInput) {
    const event = parseOrderWebhookDispatchEvent(input);
    const webhooks = await this.loadMatchingWebhooks(
      event.orgId,
      event.event,
    );

    if (webhooks.length === 0) {
      return { ok: true, dispatched: 0 };
    }

    // Every webhook is attempted, always. A dead endpoint (or one webhook with
    // an undecryptable `secret_enc` after a TOKEN_ENCRYPTION_KEY rotation) must
    // not blackout the org's other endpoints. Redelivery on the Inngest retry
    // is safe for the ones that already succeeded because the payload carries a
    // stable `id` (the outbox event id) for receiver-side dedup.
    const failures: string[] = [];

    for (const webhook of webhooks) {
      try {
        await this.sendToWebhook(webhook, event);
      } catch (error) {
        failures.push(`${webhook.id}: ${errorToText(error)}`);
      }
    }

    if (failures.length > 0) {
      // Throw so Inngest retries, but only after every endpoint had its turn.
      throw new Error(
        `Order webhook dispatch failed for ${failures.length} of ${webhooks.length} webhook(s) ` +
          `(event ${event.event}, outbox event ${event.outboxEventId}): ${failures.join("; ")}`,
      );
    }

    return { ok: true, dispatched: webhooks.length };
  }

  private async loadMatchingWebhooks(orgId: string, eventName: string) {
    const { data, error } = await this.supabase
      .from("outbound_webhooks")
      .select(OUTBOUND_WEBHOOK_SELECT)
      .eq("org_id", orgId)
      .eq("enabled", true)
      .contains("events", [eventName]);

    if (error) {
      throwDispatchError(error, "Could not read outbound webhooks");
    }

    return (data ?? []) as OutboundWebhookRow[];
  }

  private async sendToWebhook(
    webhook: OutboundWebhookRow,
    event: {
      event: string;
      orderId: string;
      status: string;
      outboxEventId: string;
    },
  ) {
    const now = this.now();
    const body = JSON.stringify({
      id: event.outboxEventId,
      event: event.event,
      sentAt: now.toISOString(),
      data: {
        orderId: event.orderId,
        status: event.status,
      },
    });
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const secret = decryptToken(
      webhook.secret_enc,
      this.env.TOKEN_ENCRYPTION_KEY,
    );
    const signature = signWebhookPayload(secret, timestamp, body);

    const response = await this.sender({
      url: webhook.url,
      body,
      headers: {
        "Content-Type": "application/json",
        "X-Omni-Event": event.event,
        "X-Omni-Timestamp": timestamp,
        "X-Omni-Signature": signature,
      },
    });

    if (!response.ok) {
      // The caller prefixes the webhook id and aggregates across endpoints.
      throw new Error(`responded HTTP ${response.status}`);
    }
  }
}

function errorToText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const orderWebhookDispatch = inngest.createFunction(
  { id: "order-webhook-dispatch", triggers: { event: "order/webhook_dispatch" } },
  async ({ event }) => {
    const service = new OrderWebhookDispatchService();
    return service.dispatch((event.data ?? {}) as OrderWebhookDispatchInput);
  },
);

function parseOrderWebhookDispatchEvent(input: OrderWebhookDispatchInput) {
  return {
    orgId: toUuid(input.orgId, "orgId"),
    outboxEventId: toUuid(input.outboxEventId, "outboxEventId"),
    orderId: toUuid(input.orderId, "orderId"),
    event: toNonEmptyString(input.event, "event"),
    status: toNonEmptyString(input.status, "status"),
  };
}

function toUuid(value: unknown, fieldName: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`order/webhook_dispatch requires UUID ${fieldName}`);
  }

  return value;
}

function toNonEmptyString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`order/webhook_dispatch requires ${fieldName}`);
  }

  return value.trim();
}

function throwDispatchError(error: SupabaseError, message: string): never {
  throw new Error(`${message}: ${error.message ?? error.code ?? "unknown"}`);
}

function createSupabaseServiceClient() {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

async function defaultWebhookSender(input: {
  body: string;
  headers: Record<string, string>;
  url: string;
}) {
  const response = await fetch(input.url, {
    body: input.body,
    headers: input.headers,
    method: "POST",
  });
  return { ok: response.ok, status: response.status };
}
