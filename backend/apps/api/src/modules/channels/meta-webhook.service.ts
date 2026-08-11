import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { loadEnv, type Env } from "../../config/env";
import { verifyMetaSignature } from "../../integrations/meta/signature";
import { type JsonObject } from "../../jobs/outbox.publisher";

export const META_WEBHOOK_SUPABASE = Symbol("META_WEBHOOK_SUPABASE");
export const META_WEBHOOK_ENV = Symbol("META_WEBHOOK_ENV");

export type SupabaseLike = Pick<SupabaseClient, "from" | "rpc">;
export type MetaWebhookEnv = Pick<
  Env,
  | "META_APP_SECRET"
  | "META_VERIFY_TOKEN"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "SUPABASE_URL"
>;

type VerifySubscriptionInput = {
  challenge: string | undefined;
  mode: string | undefined;
  verifyToken: string | undefined;
};

type IngestInput = {
  payload: unknown;
  rawBody: Buffer;
  signatureHeader: string | undefined;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

type ChannelConnectionRow = {
  external_page_id: string;
  external_ig_id: string | null;
  org_id: string;
};

type RecordMetaWebhookRow = {
  receipt_inserted: boolean;
};

@Injectable()
export class MetaWebhookService {
  private readonly env: MetaWebhookEnv;
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(META_WEBHOOK_SUPABASE)
    supabase?: SupabaseLike,
    @Optional()
    @Inject(META_WEBHOOK_ENV)
    env?: MetaWebhookEnv,
  ) {
    this.env = env ?? loadEnv();
    this.supabase = supabase ?? createSupabaseServiceClient(this.env);
  }

  verifySubscription(input: VerifySubscriptionInput) {
    if (
      input.mode === "subscribe" &&
      input.verifyToken === this.env.META_VERIFY_TOKEN &&
      input.challenge !== undefined
    ) {
      return input.challenge;
    }

    throw new UnauthorizedException({
      code: "meta_verify_failed",
      message: "Meta webhook verify token is invalid",
    });
  }

  async ingest(input: IngestInput) {
    if (
      !verifyMetaSignature(
        input.rawBody,
        input.signatureHeader,
        this.env.META_APP_SECRET,
      )
    ) {
      throw new UnauthorizedException({
        code: "meta_signature_invalid",
        message: "Meta webhook signature is invalid",
      });
    }

    const payload = toJsonObject(input.payload);
    const entries = getEntries(payload);
    const routedEntries = entries.length > 0 ? entries : [undefined];
    const routeKind = getWebhookRouteKind(payload);
    const orgIdsByEntryId = await this.findOrgIdsByEntryId(
      routeKind,
      entries
        .map((entry) => toNonEmptyString(entry.id))
        .filter((id): id is string => id !== undefined),
    );

    for (const entry of routedEntries) {
      const scopedPayload = scopePayloadToEntry(payload, entry);
      const payloadHash =
        entry && entries.length > 1
          ? hashPayload(Buffer.from(JSON.stringify(scopedPayload), "utf8"))
          : hashPayload(input.rawBody);
      const pageId = entry ? toNonEmptyString(entry.id) : undefined;

      await this.recordReceiptAndMaybeOutbox({
        orgId: pageId ? (orgIdsByEntryId.get(pageId) ?? null) : null,
        payload: scopedPayload,
        payloadHash,
        receiptKey: entry
          ? getEntryReceiptKey(entry, payloadHash)
          : getReceiptKey(payload, payloadHash),
      });
    }

    return { ok: true };
  }

  private async findOrgIdsByEntryId(
    routeKind: "page" | "instagram",
    entryIds: string[],
  ) {
    if (entryIds.length === 0) {
      return new Map<string, string>();
    }

    if (routeKind === "page") {
      return this.findOrgIdsByChannelColumn({
        entryIds,
        provider: "meta_page",
        lookupColumn: "external_page_id",
      });
    }

    const orgIdsByEntryId = new Map<string, string>();
    for (const provider of ["meta_ig", "meta_page"] as const) {
      const rows = await this.selectChannelMappings({
        entryIds,
        provider,
        lookupColumn: "external_ig_id",
      });
      for (const row of rows) {
        const entryId = toNonEmptyString(row.external_ig_id);
        if (entryId) {
          setUniqueOrgId(orgIdsByEntryId, entryId, row.org_id);
        }
      }
    }

    return orgIdsByEntryId;
  }

  private async findOrgIdsByChannelColumn(input: {
    entryIds: string[];
    provider: "meta_page" | "meta_ig";
    lookupColumn: "external_page_id" | "external_ig_id";
  }) {
    const rows = await this.selectChannelMappings(input);
    const orgIdsByEntryId = new Map<string, string>();
    for (const row of rows) {
      const entryId = toNonEmptyString(row[input.lookupColumn]);
      if (entryId) {
        setUniqueOrgId(orgIdsByEntryId, entryId, row.org_id);
      }
    }

    return orgIdsByEntryId;
  }

  private async selectChannelMappings(input: {
    entryIds: string[];
    provider: "meta_page" | "meta_ig";
    lookupColumn: "external_page_id" | "external_ig_id";
  }) {
    const { data, error } = await this.supabase
      .from("channel_connections")
      .select("external_page_id, external_ig_id, org_id")
      .eq("provider", input.provider)
      .eq("status", "active")
      .in(input.lookupColumn, input.entryIds);

    if (error) {
      throwWebhookError(error, "Could not map Meta entry to organization");
    }

    return (data ?? []) as ChannelConnectionRow[];
  }

  private async recordReceiptAndMaybeOutbox(input: {
    orgId: string | null;
    payload: JsonObject;
    payloadHash: string;
    receiptKey: string;
  }) {
    const { data, error } = await this.supabase
      .rpc("record_meta_webhook_receipt_and_enqueue", {
        p_org_id: input.orgId,
        p_payload_hash: input.payloadHash,
        p_payload_json: input.payload,
        p_receipt_key: input.receiptKey,
      })
      .single();

    if (error) {
      throwWebhookError(error, "Could not record Meta webhook receipt");
    }

    return Boolean((data as RecordMetaWebhookRow | null)?.receipt_inserted);
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
    getFirstMessageMid(getEntries(payload)) ??
    `${getFirstEntryId(payload) ?? "unknown"}-${
      getFirstEntryTime(payload) ?? payloadHash
    }`
  );
}

function getFirstEntryId(payload: JsonObject) {
  return toNonEmptyString(getEntries(payload)[0]?.id);
}

function getFirstEntryTime(payload: JsonObject) {
  return toNonEmptyString(getEntries(payload)[0]?.time);
}

function getEntryReceiptKey(entry: Record<string, unknown>, payloadHash: string) {
  return (
    getFirstMessageMid([entry]) ??
    `${toNonEmptyString(entry.id) ?? "unknown"}-${
      toNonEmptyString(entry.time) ?? payloadHash
    }`
  );
}

function getFirstMessageMid(entries: Record<string, unknown>[]) {
  for (const entry of entries) {
    for (const event of getMessagingEvents(entry)) {
      const mid = toNonEmptyString(asRecord(event.message)?.mid);
      if (mid) {
        return mid;
      }
    }
  }

  return undefined;
}

function getEntries(payload: JsonObject) {
  return toRecordArray(payload.entry);
}

function getWebhookRouteKind(payload: JsonObject): "page" | "instagram" {
  return payload.object === "instagram" ? "instagram" : "page";
}

function getMessagingEvents(entry: Record<string, unknown>) {
  return toRecordArray(entry.messaging);
}

function scopePayloadToEntry(
  payload: JsonObject,
  entry: Record<string, unknown> | undefined,
) {
  if (!entry) {
    return payload;
  }

  return {
    ...payload,
    entry: [entry],
  };
}

function toRecordArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function asRecord(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function setUniqueOrgId(
  orgIdsByEntryId: Map<string, string>,
  entryId: string,
  orgId: string,
) {
  const existingOrgId = orgIdsByEntryId.get(entryId);
  if (existingOrgId && existingOrgId !== orgId) {
    throwWebhookError(
      { message: "Meta entry maps to multiple organizations" },
      "Could not map Meta entry to organization",
    );
  }
  orgIdsByEntryId.set(entryId, orgId);
}

function throwWebhookError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: "meta_webhook_failed",
    message,
  });
}

function createSupabaseServiceClient(env: MetaWebhookEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
