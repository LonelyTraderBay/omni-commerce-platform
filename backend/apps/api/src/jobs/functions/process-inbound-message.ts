import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnv, type Env } from "../../config/env";
import { AiRunsService, type WriteAiRunInput } from "../../modules/audit/ai-runs.service";
import { AiTokenUsageService } from "../../modules/billing/ai-token-usage.service";
import { FeatureFlagsService } from "../../modules/feature-flags/feature-flags.service";
import { inngest } from "../inngest.client";
import { enqueueOutbox } from "../outbox.publisher";

// `rpc` is required because this client is handed to AiTokenUsageService, whose
// monthly-usage read is a SQL aggregate rather than a client-side sum.
export type SupabaseLike = Pick<SupabaseClient, "from" | "rpc">;
export type JsonObject = Record<string, unknown>;

type FetchLike = typeof fetch;

type ProcessInboundInput = JsonObject & {
  conversationId?: unknown;
  messageId?: unknown;
  orgId?: unknown;
};

type ServiceEnv = Pick<Env, "AI_BASE_URL" | "SERVICE_M2M_KEY">;

type FeatureFlagReader = {
  isEnabled(key: string, orgId: string | null): Promise<boolean>;
};

type AiRunWriter = {
  writeRun(input: WriteAiRunInput): Promise<unknown>;
};

type AiTokenQuotaReader = {
  getQuotaStatus(orgId: string): Promise<{
    allowed: boolean;
    exceeded: boolean;
    used: number;
    limit: number;
    periodStart: string;
  }>;
};

type ProcessInboundJobOptions = {
  aiRuns?: AiRunWriter;
  aiTokenUsage?: AiTokenQuotaReader;
  env?: ServiceEnv;
  featureFlags?: FeatureFlagReader;
  fetchFn?: FetchLike;
  supabase?: SupabaseLike;
};

type MessageRow = {
  id: string;
  org_id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  sender_type: "customer" | "ai" | "staff" | "system";
  body_text: string | null;
};

type ConversationRow = {
  id: string;
  org_id: string;
  channel: "messenger" | "instagram";
  channel_connection_id: string;
  contact_id: string;
  bot_paused: boolean;
  bot_epoch: number;
};

type AiProcessResponse = {
  replyText: string | null;
  citations: JsonObject[];
  toolsUsed: JsonObject[];
  promptVersion: string;
  model: string;
  tokens?: WriteAiRunInput["tokens"];
  escalate: boolean;
};

type AiProcessContext = {
  conversationId: string;
  contactId: string;
  messageId: string;
  channel: ConversationRow["channel"];
  channelConnectionId: string;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

const MESSAGE_SELECT =
  "id, org_id, conversation_id, direction, sender_type, body_text";
const CONVERSATION_SELECT =
  "id, org_id, channel, channel_connection_id, contact_id, bot_paused, bot_epoch";

const QUOTA_ESCALATE_REPLY =
  "Minh chua co du thong tin trong du lieu hien co de tra loi chinh xac. " +
  "Minh se chuyen cho doi ngu ho tro kiem tra them.";
const QUOTA_GATE_PROMPT_VERSION = "quota_gate_v1";
const QUOTA_GATE_MODEL = "gemini-2.0-flash";

export class ProcessInboundMessageJobService {
  private readonly aiRuns: AiRunWriter;
  private readonly aiTokenUsage: AiTokenQuotaReader;
  private readonly env: ServiceEnv;
  private readonly featureFlags: FeatureFlagReader;
  private readonly fetchFn: FetchLike;
  private readonly supabase: SupabaseLike;

  constructor(options: ProcessInboundJobOptions = {}) {
    this.env = options.env ?? loadEnv();
    this.fetchFn = options.fetchFn ?? fetch;
    this.supabase = options.supabase ?? createSupabaseServiceClient();
    this.featureFlags =
      options.featureFlags ?? new FeatureFlagsService(this.supabase);
    this.aiRuns = options.aiRuns ?? new AiRunsService(this.supabase);
    this.aiTokenUsage =
      options.aiTokenUsage ?? new AiTokenUsageService(this.supabase);
  }

  async process(input: ProcessInboundInput) {
    const event = parseProcessInboundEvent(input);
    const message = await this.loadMessage(event.orgId, event.messageId);
    if (!message || message.conversation_id !== event.conversationId) {
      return { ok: true, action: "dropped", reason: "message_not_found" };
    }
    if (message.direction !== "inbound" || message.sender_type !== "customer") {
      return { ok: true, action: "dropped", reason: "not_customer_inbound" };
    }

    const conversation = await this.loadConversation(
      event.orgId,
      event.conversationId,
    );
    if (!conversation) {
      return { ok: true, action: "dropped", reason: "conversation_not_found" };
    }

    const botEpoch = conversation.bot_epoch;
    if (await this.featureFlags.isEnabled("kill_ai_all", event.orgId)) {
      return { ok: true, action: "dropped", reason: "kill_ai_all" };
    }
    if (conversation.bot_paused) {
      return { ok: true, action: "dropped", reason: "bot_paused" };
    }

    const inboundText = message.body_text?.trim();
    if (!inboundText) {
      return { ok: true, action: "dropped", reason: "empty_message" };
    }

    const quota = await this.aiTokenUsage.getQuotaStatus(event.orgId);
    const aiResponse = quota.exceeded
      ? buildQuotaExceededResponse()
      : await this.callAiProcessMessage(event.orgId, inboundText, {
          conversationId: conversation.id,
          contactId: conversation.contact_id,
          messageId: message.id,
          channel: conversation.channel,
          channelConnectionId: conversation.channel_connection_id,
        });

    await this.aiRuns.writeRun({
      orgId: event.orgId,
      conversationId: conversation.id,
      messageId: message.id,
      promptVersion: aiResponse.promptVersion,
      model: aiResponse.model,
      tokens: aiResponse.tokens,
      tools: aiResponse.toolsUsed,
      citations: aiResponse.citations,
      status: quota.exceeded
        ? "quota_exceeded"
        : aiResponse.escalate
          ? "escalated"
          : "succeeded",
    });

    const replyText = aiResponse.replyText?.trim();
    if (!replyText) {
      return { ok: true, action: "processed", outbound: "skipped_no_reply" };
    }

    const latestConversation = await this.loadConversation(
      event.orgId,
      event.conversationId,
    );
    if (!latestConversation || latestConversation.bot_epoch !== botEpoch) {
      return { ok: true, action: "processed", outbound: "dropped_epoch" };
    }
    if (latestConversation.bot_paused) {
      return { ok: true, action: "processed", outbound: "dropped_paused" };
    }
    if (await this.featureFlags.isEnabled("kill_ai_outbound", event.orgId)) {
      return { ok: true, action: "processed", outbound: "dropped_kill_outbound" };
    }

    const outboxEvent = await enqueueOutbox(this.supabase, {
      orgId: event.orgId,
      eventName: "meta.send",
      payload: {
        botEpoch,
        conversationId: latestConversation.id,
        inboundMessageId: message.id,
        replyText,
      },
    });

    return {
      ok: true,
      action: "processed",
      outbound: "enqueued",
      outboxEventId: outboxEvent.id,
    };
  }

  private async loadMessage(orgId: string, messageId: string) {
    const { data, error } = await this.supabase
      .from("messages")
      .select(MESSAGE_SELECT)
      .eq("id", messageId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      throwJobError(error, "Could not read inbound message");
    }

    return data as MessageRow | null;
  }

  private async loadConversation(orgId: string, conversationId: string) {
    const { data, error } = await this.supabase
      .from("conversations")
      .select(CONVERSATION_SELECT)
      .eq("id", conversationId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      throwJobError(error, "Could not read conversation");
    }

    return data as ConversationRow | null;
  }

  private async callAiProcessMessage(
    orgId: string,
    message: string,
    context: AiProcessContext,
  ) {
    const response = await this.fetchFn(
      `${this.env.AI_BASE_URL}/internal/v1/ai/process-message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Key": this.env.SERVICE_M2M_KEY,
        },
        body: JSON.stringify({
          orgId,
          message,
          conversationId: context.conversationId,
          contactId: context.contactId,
          messageId: context.messageId,
          channel: context.channel,
          channelConnectionId: context.channelConnectionId,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`AI process-message failed: ${response.status} ${body}`);
    }

    return parseAiProcessResponse(await response.json());
  }
}

export const processInboundMessage = inngest.createFunction(
  { id: "ai-process-inbound", triggers: { event: "ai/process_inbound" } },
  async ({ event }) => {
    const service = new ProcessInboundMessageJobService();
    return service.process((event.data ?? {}) as ProcessInboundInput);
  },
);

function buildQuotaExceededResponse(): AiProcessResponse {
  return {
    replyText: QUOTA_ESCALATE_REPLY,
    citations: [],
    toolsUsed: [],
    promptVersion: QUOTA_GATE_PROMPT_VERSION,
    model: QUOTA_GATE_MODEL,
    tokens: { prompt: 0, completion: 0, total: 0 },
    escalate: true,
  };
}

function parseProcessInboundEvent(input: ProcessInboundInput) {
  return {
    orgId: toUuid(input.orgId, "orgId"),
    conversationId: toUuid(input.conversationId, "conversationId"),
    messageId: toUuid(input.messageId, "messageId"),
  };
}

function parseAiProcessResponse(value: unknown): AiProcessResponse {
  const record = asRecord(value);
  const replyText =
    record && (typeof record.replyText === "string" || record.replyText === null)
      ? record.replyText
      : null;
  const promptVersion = toNonEmptyString(record?.promptVersion);
  const model = toNonEmptyString(record?.model);
  if (!promptVersion || !model) {
    throw new Error("AI process-message response is missing promptVersion or model");
  }

  return {
    replyText,
    citations: toRecordArray(record?.citations),
    toolsUsed: toRecordArray(record?.toolsUsed),
    promptVersion,
    model,
    tokens: parseTokens(record?.tokens),
    escalate: record?.escalate === true,
  };
}

function parseTokens(value: unknown): WriteAiRunInput["tokens"] {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    prompt: toSafeInteger(record.prompt),
    completion: toSafeInteger(record.completion),
    input: toSafeInteger(record.input),
    output: toSafeInteger(record.output),
    total: toSafeInteger(record.total),
  };
}

function toSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function toUuid(value: unknown, fieldName: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`ai/process_inbound requires UUID ${fieldName}`);
  }

  return value;
}

function asRecord(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function toRecordArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function toNonEmptyString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function throwJobError(error: SupabaseError, message: string): never {
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
