import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, timingSafeEqual } from "node:crypto";

import { loadEnv, type Env } from "../../config/env";
import { type JsonObject } from "../../jobs/outbox.publisher";

export const ZALO_WEBHOOK_SUPABASE = Symbol("ZALO_WEBHOOK_SUPABASE");
export const ZALO_WEBHOOK_ENV = Symbol("ZALO_WEBHOOK_ENV");

export type SupabaseLike = Pick<SupabaseClient, "from" | "rpc">;
export type ZaloWebhookEnv = Pick<
  Env,
  "SUPABASE_SERVICE_ROLE_KEY" | "SUPABASE_URL" | "ZALO_WEBHOOK_SECRET"
>;

type IngestInput = {
  payload: unknown;
  rawBody: Buffer;
  secretHeader: string | undefined;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

type ChannelConnectionRow = {
  org_id: string;
};

@Injectable()
export class ZaloWebhookService {
  private readonly env: ZaloWebhookEnv;
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(ZALO_WEBHOOK_SUPABASE)
    supabase?: SupabaseLike,
    @Optional()
    @Inject(ZALO_WEBHOOK_ENV)
    env?: ZaloWebhookEnv,
  ) {
    this.env = env ?? loadEnv();
    this.supabase = supabase ?? createSupabaseServiceClient(this.env);
  }

  async ingest(input: IngestInput) {
    this.verifySecret(input.secretHeader);

    const payload = toJsonObject(input.payload);
    const payloadHash = hashPayload(input.rawBody);
    const oaId = getOaId(payload);
    const orgId = oaId ? await this.findOrgIdByOaId(oaId) : null;

    await this.recordReceiptAndMaybeOutbox({
      orgId,
      payload,
      payloadHash,
      receiptKey: getReceiptKey(payload, payloadHash),
    });

    return { ok: true };
  }

  private verifySecret(secretHeader: string | undefined) {
    // TODO(security): This authenticates the caller with a static shared-secret
    // header (x-zalo-webhook-secret). If/when Zalo OA documents a body-bound
    // HMAC signing scheme, upgrade this to verify a signature over rawBody like
    // the Meta webhook does, so requests can't be replayed.
    const expected = this.env.ZALO_WEBHOOK_SECRET?.trim();
    if (!expected) {
      // Fail closed: without a configured secret we cannot authenticate the
      // caller, so we must not process (and pay for) attacker-controllable work.
      throw new UnauthorizedException({
        code: "zalo_webhook_not_configured",
        message:
          "Zalo webhook secret is not configured — the webhook endpoint is disabled until ZALO_WEBHOOK_SECRET is set.",
      });
    }

    if (!secretHeader || !safeEqual(secretHeader.trim(), expected)) {
      throw new UnauthorizedException({
        code: "zalo_webhook_secret_invalid",
        message: "Zalo webhook secret is invalid",
      });
    }
  }

  private async findOrgIdByOaId(oaId: string) {
    const { data, error } = await this.supabase
      .from("channel_connections")
      .select("org_id")
      .eq("provider", "zalo_oa")
      .eq("status", "active")
      .eq("external_page_id", oaId)
      .maybeSingle();

    if (error) {
      throwWebhookError(error, "Could not map Zalo OA to organization");
    }

    return ((data as ChannelConnectionRow | null) ?? null)?.org_id ?? null;
  }

  private async recordReceiptAndMaybeOutbox(input: {
    orgId: string | null;
    payload: JsonObject;
    payloadHash: string;
    receiptKey: string;
  }) {
    const { error } = await this.supabase
      .rpc("record_zalo_webhook_receipt_and_enqueue", {
        p_org_id: input.orgId,
        p_payload_hash: input.payloadHash,
        p_payload_json: input.payload,
        p_receipt_key: input.receiptKey,
      })
      .single();

    if (error) {
      throwWebhookError(error, "Could not record Zalo webhook receipt");
    }
  }
}

function toJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function hashPayload(rawBody: Buffer) {
  return createHash("sha256").update(rawBody).digest("hex");
}

function getReceiptKey(payload: JsonObject, payloadHash: string) {
  return (
    readString(payload, ["message", "msg_id"]) ??
    readString(payload, ["message", "mid"]) ??
    readString(payload, ["msg_id"]) ??
    readString(payload, ["message_id"]) ??
    readString(payload, ["event_id"]) ??
    `${getOaId(payload) ?? "unknown"}-${readString(payload, ["timestamp"]) ?? payloadHash}`
  );
}

function getOaId(payload: JsonObject) {
  return (
    readString(payload, ["oaId"]) ??
    readString(payload, ["oa_id"]) ??
    readString(payload, ["oa", "id"]) ??
    readString(payload, ["recipient", "id"])
  );
}

function readString(value: unknown, path: string[]) {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }

  return toNonEmptyString(cursor);
}

function toNonEmptyString(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function safeEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function throwWebhookError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: "zalo_webhook_failed",
    message,
  });
}

function createSupabaseServiceClient(env: ZaloWebhookEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
