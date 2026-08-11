import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { decryptToken } from "../../common/crypto/token-crypto";
import { loadEnv, type Env } from "../../config/env";
import {
  createGraphClientFromEnv,
  type GraphClient,
} from "../../integrations/meta/graph.client";
import { FeatureFlagsService } from "../../modules/feature-flags/feature-flags.service";
import { inngest } from "../inngest.client";

export type SupabaseLike = Pick<SupabaseClient, "from">;
export type JsonObject = Record<string, unknown>;

type MetaSendInput = JsonObject & {
  botEpoch?: unknown;
  conversationId?: unknown;
  inboundMessageId?: unknown;
  orgId?: unknown;
  replyText?: unknown;
};

type MetaSendEnv = Pick<
  Env,
  "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY" | "TOKEN_ENCRYPTION_KEY"
>;

type GraphMessenger = Pick<GraphClient, "sendMessage">;

type MetaSendJobOptions = {
  env?: Pick<Env, "TOKEN_ENCRYPTION_KEY">;
  featureFlags?: FeatureFlagReader;
  graph?: GraphMessenger;
  now?: () => Date;
  supabase?: SupabaseLike;
};

type ConversationRow = {
  id: string;
  org_id: string;
  channel: "messenger" | "instagram";
  channel_connection_id: string;
  contact_id: string;
  bot_paused: boolean;
  bot_epoch: number;
  last_message_at: string | null;
};

type ChannelConnectionRow = {
  id: string;
  org_id: string;
  provider: "meta_page" | "meta_ig";
  external_page_id: string;
  external_ig_id: string | null;
  access_token_enc: string;
  status: "active" | "needs_reauth" | "revoked";
};

type ContactRow = {
  id: string;
  org_id: string;
  page_scoped_id: string | null;
  ig_scoped_id: string | null;
};

type MessageRow = {
  id: string;
  org_id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  sender_type: "customer" | "ai" | "staff" | "system";
  created_at: string;
};

type MetaOutboundSendRow = {
  id: string;
  org_id: string;
  inbound_message_id: string;
  conversation_id: string;
  status: "sending" | "sent" | "failed";
  provider_message_id: string | null;
  error_text: string | null;
};

type FeatureFlagReader = {
  isEnabled(key: string, orgId: string | null): Promise<boolean>;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

const CONVERSATION_SELECT =
  "id, org_id, channel, channel_connection_id, contact_id, bot_paused, bot_epoch, last_message_at";
const CHANNEL_CONNECTION_SELECT =
  "id, org_id, provider, external_page_id, external_ig_id, access_token_enc, status";
const CONTACT_SELECT = "id, org_id, page_scoped_id, ig_scoped_id";
const MESSAGE_SELECT =
  "id, org_id, conversation_id, direction, sender_type, created_at";
const META_OUTBOUND_SEND_SELECT =
  "id, org_id, inbound_message_id, conversation_id, status, provider_message_id, error_text";
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export class MetaSendJobService {
  private readonly env: Pick<Env, "TOKEN_ENCRYPTION_KEY">;
  private readonly featureFlags: FeatureFlagReader;
  private readonly graph: GraphMessenger;
  private readonly now: () => Date;
  private readonly supabase: SupabaseLike;

  constructor(options: MetaSendJobOptions = {}) {
    this.env = options.env ?? loadEnv();
    this.graph = options.graph ?? createGraphClientFromEnv();
    this.supabase = options.supabase ?? createSupabaseServiceClient();
    this.featureFlags =
      options.featureFlags ?? new FeatureFlagsService(this.supabase);
    this.now = options.now ?? (() => new Date());
  }

  async send(input: MetaSendInput) {
    const event = parseMetaSendEvent(input);
    const conversation = await this.loadConversation(
      event.orgId,
      event.conversationId,
    );
    if (!conversation) {
      return { ok: true, action: "dropped", reason: "conversation_not_found" };
    }
    if (conversation.bot_epoch !== event.botEpoch) {
      return { ok: true, action: "dropped", reason: "epoch_mismatch" };
    }
    if (conversation.bot_paused) {
      return { ok: true, action: "dropped", reason: "bot_paused" };
    }

    const [connection, contact, inboundMessage] = await Promise.all([
      this.loadChannelConnection(event.orgId, conversation.channel_connection_id),
      this.loadContact(event.orgId, conversation.contact_id),
      this.loadInboundMessage(event.orgId, event.inboundMessageId),
    ]);
    if (!connection || connection.status !== "active") {
      return { ok: true, action: "dropped", reason: "channel_inactive" };
    }
    if (!contact) {
      return { ok: true, action: "dropped", reason: "contact_not_found" };
    }
    if (
      !inboundMessage ||
      inboundMessage.conversation_id !== conversation.id ||
      inboundMessage.direction !== "inbound" ||
      inboundMessage.sender_type !== "customer"
    ) {
      return { ok: true, action: "dropped", reason: "inbound_message_not_found" };
    }

    const recipientId = recipientForChannel(conversation.channel, contact);
    const senderId = senderForChannel(conversation.channel, connection);
    if (!recipientId || !senderId) {
      return { ok: true, action: "dropped", reason: "missing_meta_identity" };
    }

    const reservation = await this.reserveOutboundSend({
      conversationId: conversation.id,
      inboundMessageId: inboundMessage.id,
      orgId: event.orgId,
    });
    const sendRecord = reservation.record;
    if (!reservation.inserted) {
      if (sendRecord.status === "sent") {
        return {
          ok: true,
          action: "already_sent",
          providerMessageId: sendRecord.provider_message_id,
        };
      }
      if (sendRecord.status === "failed") {
        return {
          ok: true,
          action: "failed",
          reason: sendRecord.error_text ?? "send_failed",
        };
      }

      return { ok: true, action: "already_reserved", reason: "send_in_progress" };
    }

    if (isOutsideMessagingWindow(inboundMessage, this.now())) {
      await this.markOutboundSendFailed(
        sendRecord.id,
        "messaging_window_expired",
      );
      return {
        ok: true,
        action: "failed",
        reason: "messaging_window_expired",
      };
    }

    const latestConversation = await this.loadConversation(
      event.orgId,
      event.conversationId,
    );
    if (!latestConversation || latestConversation.bot_epoch !== event.botEpoch) {
      await this.markOutboundSendFailed(sendRecord.id, "epoch_mismatch");
      return { ok: true, action: "dropped", reason: "epoch_mismatch" };
    }
    if (latestConversation.bot_paused) {
      await this.markOutboundSendFailed(sendRecord.id, "bot_paused");
      return { ok: true, action: "dropped", reason: "bot_paused" };
    }
    if (await this.featureFlags.isEnabled("kill_ai_all", event.orgId)) {
      await this.markOutboundSendFailed(sendRecord.id, "kill_ai_all");
      return { ok: true, action: "dropped", reason: "kill_ai_all" };
    }
    if (await this.featureFlags.isEnabled("kill_ai_outbound", event.orgId)) {
      await this.markOutboundSendFailed(sendRecord.id, "kill_ai_outbound");
      return { ok: true, action: "dropped", reason: "kill_ai_outbound" };
    }

    const accessToken = decryptToken(
      connection.access_token_enc,
      this.env.TOKEN_ENCRYPTION_KEY,
    );
    let sent: Awaited<ReturnType<GraphMessenger["sendMessage"]>>;
    try {
      sent = await this.graph.sendMessage({
        accessToken,
        recipientId,
        senderId,
        text: event.replyText,
      });
    } catch (error) {
      await this.markOutboundSendFailed(sendRecord.id, errorToText(error));
      throw error;
    }
    await this.markOutboundSendSent(sendRecord.id, sent.message_id ?? null);

    return {
      ok: true,
      action: "sent",
      providerMessageId: sent.message_id ?? null,
    };
  }

  private async loadConversation(orgId: string, conversationId: string) {
    const { data, error } = await this.supabase
      .from("conversations")
      .select(CONVERSATION_SELECT)
      .eq("id", conversationId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      throwSendError(error, "Could not read conversation for Meta send");
    }

    return data as ConversationRow | null;
  }

  private async loadChannelConnection(orgId: string, connectionId: string) {
    const { data, error } = await this.supabase
      .from("channel_connections")
      .select(CHANNEL_CONNECTION_SELECT)
      .eq("id", connectionId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      throwSendError(error, "Could not read channel connection for Meta send");
    }

    return data as ChannelConnectionRow | null;
  }

  private async loadContact(orgId: string, contactId: string) {
    const { data, error } = await this.supabase
      .from("contacts")
      .select(CONTACT_SELECT)
      .eq("id", contactId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      throwSendError(error, "Could not read contact for Meta send");
    }

    return data as ContactRow | null;
  }

  private async loadInboundMessage(orgId: string, messageId: string) {
    const { data, error } = await this.supabase
      .from("messages")
      .select(MESSAGE_SELECT)
      .eq("id", messageId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      throwSendError(error, "Could not read inbound message for Meta send");
    }

    return data as MessageRow | null;
  }

  private async reserveOutboundSend(input: {
    conversationId: string;
    inboundMessageId: string;
    orgId: string;
  }) {
    const { data, error } = await this.supabase
      .from("meta_outbound_sends")
      .insert({
        org_id: input.orgId,
        inbound_message_id: input.inboundMessageId,
        conversation_id: input.conversationId,
        status: "sending",
      })
      .select(META_OUTBOUND_SEND_SELECT)
      .single();

    if (isDuplicateError(error)) {
      const existing = await this.loadOutboundSend(
        input.orgId,
        input.inboundMessageId,
      );
      if (existing) {
        return { inserted: false, record: existing };
      }
    }
    if (error) {
      throwSendError(error, "Could not reserve Meta outbound send");
    }

    return { inserted: true, record: data as MetaOutboundSendRow };
  }

  private async loadOutboundSend(orgId: string, inboundMessageId: string) {
    const { data, error } = await this.supabase
      .from("meta_outbound_sends")
      .select(META_OUTBOUND_SEND_SELECT)
      .eq("org_id", orgId)
      .eq("inbound_message_id", inboundMessageId)
      .maybeSingle();

    if (error) {
      throwSendError(error, "Could not read Meta outbound send");
    }

    return data as MetaOutboundSendRow | null;
  }

  private async markOutboundSendSent(id: string, providerMessageId: string | null) {
    const { error } = await this.supabase
      .from("meta_outbound_sends")
      .update({
        provider_message_id: providerMessageId,
        status: "sent",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (error) {
      throwSendError(error, "Could not mark Meta outbound send sent");
    }
  }

  private async markOutboundSendFailed(id: string, errorText: string) {
    const { error } = await this.supabase
      .from("meta_outbound_sends")
      .update({
        error_text: errorText,
        status: "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (error) {
      throwSendError(error, "Could not mark Meta outbound send failed");
    }
  }
}

export const metaSend = inngest.createFunction(
  { id: "meta-send", triggers: { event: "meta/send" } },
  async ({ event }) => {
    const service = new MetaSendJobService();
    return service.send((event.data ?? {}) as MetaSendInput);
  },
);

function parseMetaSendEvent(input: MetaSendInput) {
  return {
    orgId: toUuid(input.orgId, "orgId"),
    conversationId: toUuid(input.conversationId, "conversationId"),
    inboundMessageId: toUuid(input.inboundMessageId, "inboundMessageId"),
    botEpoch: toInteger(input.botEpoch, "botEpoch"),
    replyText: toNonEmptyString(input.replyText, "replyText"),
  };
}

function recipientForChannel(channel: ConversationRow["channel"], contact: ContactRow) {
  return channel === "instagram" ? contact.ig_scoped_id : contact.page_scoped_id;
}

function senderForChannel(
  channel: ConversationRow["channel"],
  connection: ChannelConnectionRow,
) {
  return channel === "instagram"
    ? connection.external_ig_id
    : connection.external_page_id;
}

function toUuid(value: unknown, fieldName: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`meta/send requires UUID ${fieldName}`);
  }

  return value;
}

function toInteger(value: unknown, fieldName: string) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`meta/send requires integer ${fieldName}`);
  }

  return value as number;
}

function toNonEmptyString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`meta/send requires ${fieldName}`);
  }

  return value.trim();
}

function isOutsideMessagingWindow(message: MessageRow, now: Date) {
  const createdAt = new Date(message.created_at).getTime();
  return (
    !Number.isFinite(createdAt) ||
    now.getTime() - createdAt > MESSAGING_WINDOW_MS
  );
}

function isDuplicateError(error: SupabaseError | null | undefined) {
  return error?.code === "23505";
}

function errorToText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function throwSendError(error: SupabaseError, message: string): never {
  throw new Error(`${message}: ${error.message ?? error.code ?? "unknown"}`);
}

function createSupabaseServiceClient() {
  const env = loadEnv() as MetaSendEnv;
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
