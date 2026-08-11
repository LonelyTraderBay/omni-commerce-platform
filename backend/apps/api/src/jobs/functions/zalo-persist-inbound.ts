import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadEnv } from '../../config/env';
import { inngest } from '../inngest.client';
import { enqueueOutbox } from '../outbox.publisher';

export type SupabaseLike = Pick<SupabaseClient, 'from'>;
export type JsonObject = Record<string, unknown>;

type SupabaseError = {
  code?: string;
  message?: string;
};

type ChannelConnectionRow = {
  id: string;
  org_id: string;
  provider: 'zalo_oa';
  external_page_id: string;
};

type ContactRow = {
  id: string;
  org_id: string;
  display_name: string | null;
  page_scoped_id: string | null;
  created_at: string;
  updated_at: string;
};

type ConversationRow = {
  id: string;
  org_id: string;
  channel: 'zalo';
  channel_connection_id: string;
  contact_id: string;
  status: string;
  bot_paused: boolean;
  bot_epoch: number;
  assignee_user_id: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  org_id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: 'customer' | 'ai' | 'staff' | 'system';
  raw_type: string;
  body_text: string | null;
  payload_json: JsonObject;
  provider_message_id: string | null;
  created_at: string;
};

type ParsedInboundMessage = {
  connectionLookupId: string;
  contactScopedId: string;
  providerMessageId: string;
  bodyText: string | null;
  rawType: string;
  payload: JsonObject;
  createdAt: string;
};

type PersistInboundInput = JsonObject & {
  orgId?: unknown;
};

const CHANNEL_CONNECTION_SELECT = 'id, org_id, provider, external_page_id';
const CONTACT_SELECT =
  'id, org_id, display_name, page_scoped_id, created_at, updated_at';
const CONVERSATION_SELECT =
  'id, org_id, channel, channel_connection_id, contact_id, status, bot_paused, bot_epoch, assignee_user_id, last_message_at, created_at, updated_at';
const MESSAGE_SELECT =
  'id, org_id, conversation_id, direction, sender_type, raw_type, body_text, payload_json, provider_message_id, created_at';
const OUTBOX_SELECT =
  'id, org_id, event_name, payload_json, created_at, published_at, attempts';

export class ZaloInboundPersistenceService {
  private readonly supabase: SupabaseLike;

  constructor(supabase?: SupabaseLike) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async persist(input: PersistInboundInput) {
    const orgId = toNonEmptyString(input.orgId);
    if (!orgId) {
      throw new Error('zalo/inbound/received requires orgId');
    }

    const messages = parseInboundMessages(input);
    let insertedMessages = 0;
    let skippedMessages = 0;

    for (const message of messages) {
      const connection = await this.findChannelConnection(orgId, message);
      if (!connection) {
        skippedMessages += 1;
        continue;
      }

      const contact = await this.findOrCreateContact(orgId, message);
      const conversation = await this.findOrCreateConversation({
        orgId,
        channelConnectionId: connection.id,
        contactId: contact.id,
        lastMessageAt: message.createdAt,
      });
      const persistedMessage = await this.insertMessageIfNew({
        orgId,
        conversationId: conversation.id,
        message,
      });

      if (persistedMessage.inserted) {
        insertedMessages += 1;
      } else {
        skippedMessages += 1;
      }

      if (!conversation.bot_paused) {
        await this.ensureAiProcessInboundOutbox({
          orgId,
          conversationId: persistedMessage.message.conversation_id,
          messageId: persistedMessage.message.id,
        });
      }
    }

    return {
      ok: true,
      processedMessages: messages.length,
      insertedMessages,
      skippedMessages,
    };
  }

  private async findChannelConnection(
    orgId: string,
    message: ParsedInboundMessage,
  ) {
    const { data, error } = await this.supabase
      .from('channel_connections')
      .select(CHANNEL_CONNECTION_SELECT)
      .eq('org_id', orgId)
      .eq('provider', 'zalo_oa')
      .eq('status', 'active')
      .eq('external_page_id', message.connectionLookupId)
      .maybeSingle();

    if (error) {
      throwPersistError(error, 'Could not find Zalo channel connection');
    }

    return data as ChannelConnectionRow | null;
  }

  private async findOrCreateContact(
    orgId: string,
    message: ParsedInboundMessage,
  ) {
    const existing = await this.findContact(orgId, message.contactScopedId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('contacts')
      .insert({
        org_id: orgId,
        display_name: null,
        page_scoped_id: message.contactScopedId,
        updated_at: now,
      })
      .select(CONTACT_SELECT)
      .single();

    if (isDuplicateError(error)) {
      const duplicate = await this.findContact(orgId, message.contactScopedId);
      if (duplicate) {
        return duplicate;
      }
    }
    if (error) {
      throwPersistError(error, 'Could not create Zalo contact');
    }

    return data as ContactRow;
  }

  private async findContact(orgId: string, contactScopedId: string) {
    const { data, error } = await this.supabase
      .from('contacts')
      .select(CONTACT_SELECT)
      .eq('org_id', orgId)
      .eq('page_scoped_id', contactScopedId)
      .maybeSingle();

    if (error) {
      throwPersistError(error, 'Could not find Zalo contact');
    }

    return data as ContactRow | null;
  }

  private async findOrCreateConversation(input: {
    orgId: string;
    channelConnectionId: string;
    contactId: string;
    lastMessageAt: string;
  }) {
    const existing = await this.findConversation(input);
    if (existing) {
      return this.touchConversation(
        input.orgId,
        existing.id,
        input.lastMessageAt,
      );
    }

    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('conversations')
      .insert({
        org_id: input.orgId,
        channel: 'zalo',
        channel_connection_id: input.channelConnectionId,
        contact_id: input.contactId,
        status: 'open',
        last_message_at: input.lastMessageAt,
        updated_at: now,
      })
      .select(CONVERSATION_SELECT)
      .single();

    if (isDuplicateError(error)) {
      const duplicate = await this.findConversation(input);
      if (duplicate) {
        return this.touchConversation(
          input.orgId,
          duplicate.id,
          input.lastMessageAt,
        );
      }
    }
    if (error) {
      throwPersistError(error, 'Could not create Zalo conversation');
    }

    return data as ConversationRow;
  }

  private async findConversation(input: {
    orgId: string;
    channelConnectionId: string;
    contactId: string;
  }) {
    const { data, error } = await this.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('org_id', input.orgId)
      .eq('channel_connection_id', input.channelConnectionId)
      .eq('contact_id', input.contactId)
      .maybeSingle();

    if (error) {
      throwPersistError(error, 'Could not find Zalo conversation');
    }

    return data as ConversationRow | null;
  }

  private async touchConversation(
    orgId: string,
    conversationId: string,
    lastMessageAt: string,
  ) {
    const { data, error } = await this.supabase
      .from('conversations')
      .update({
        last_message_at: lastMessageAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
      .eq('org_id', orgId)
      .select(CONVERSATION_SELECT)
      .single();

    if (error) {
      throwPersistError(error, 'Could not update Zalo conversation');
    }

    return data as ConversationRow;
  }

  private async insertMessageIfNew(input: {
    orgId: string;
    conversationId: string;
    message: ParsedInboundMessage;
  }) {
    const { data: existing, error: findError } = await this.supabase
      .from('messages')
      .select(MESSAGE_SELECT)
      .eq('org_id', input.orgId)
      .eq('provider_message_id', input.message.providerMessageId)
      .maybeSingle();

    if (findError) {
      throwPersistError(findError, 'Could not find Zalo message');
    }
    if (existing) {
      return { inserted: false, message: existing as MessageRow };
    }

    const { data, error } = await this.supabase
      .from('messages')
      .insert({
        org_id: input.orgId,
        conversation_id: input.conversationId,
        direction: 'inbound',
        sender_type: 'customer',
        raw_type: input.message.rawType,
        body_text: input.message.bodyText,
        payload_json: input.message.payload,
        provider_message_id: input.message.providerMessageId,
        created_at: input.message.createdAt,
      })
      .select(MESSAGE_SELECT)
      .single();

    if (isDuplicateError(error)) {
      const duplicate = await this.findMessageByProviderId(
        input.orgId,
        input.message.providerMessageId,
      );
      if (duplicate) {
        return { inserted: false, message: duplicate };
      }
    }
    if (error) {
      throwPersistError(error, 'Could not insert Zalo message');
    }

    return { inserted: true, message: data as MessageRow };
  }

  private async findMessageByProviderId(orgId: string, providerMessageId: string) {
    const { data, error } = await this.supabase
      .from('messages')
      .select(MESSAGE_SELECT)
      .eq('org_id', orgId)
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();

    if (error) {
      throwPersistError(error, 'Could not find Zalo message');
    }

    return data as MessageRow | null;
  }

  private async ensureAiProcessInboundOutbox(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
  }) {
    const existing = await this.findAiProcessInboundOutbox(input);
    if (existing) {
      return existing;
    }

    try {
      return await enqueueOutbox(this.supabase, {
        orgId: input.orgId,
        eventName: 'ai.process_inbound',
        payload: {
          conversationId: input.conversationId,
          messageId: input.messageId,
        },
      });
    } catch (error) {
      const duplicate = await this.findAiProcessInboundOutbox(input);
      if (duplicate) {
        return duplicate;
      }

      throw error;
    }
  }

  private async findAiProcessInboundOutbox(input: {
    orgId: string;
    messageId: string;
  }) {
    const { data, error } = await this.supabase
      .from('outbox_events')
      .select(OUTBOX_SELECT)
      .eq('org_id', input.orgId)
      .eq('event_name', 'ai.process_inbound')
      .contains('payload_json', { messageId: input.messageId })
      .maybeSingle();

    if (error) {
      throwPersistError(error, 'Could not find AI process_inbound outbox event');
    }

    return data;
  }
}

export const zaloPersistInbound = inngest.createFunction(
  { id: 'zalo-persist-inbound', triggers: { event: 'zalo/inbound/received' } },
  async ({ event }) => {
    const service = new ZaloInboundPersistenceService();
    return service.persist((event.data ?? {}) as PersistInboundInput);
  },
);

function parseInboundMessages(payload: JsonObject) {
  const oaId = getOaId(payload);
  const contactScopedId = getContactScopedId(payload);
  const providerMessageId = getProviderMessageId(payload);
  const message = asRecord(payload.message);

  if (!oaId || !contactScopedId || !providerMessageId || contactScopedId === oaId) {
    return [];
  }

  const bodyText = toNonEmptyString(message?.text) ?? null;

  return [
    {
      connectionLookupId: oaId,
      contactScopedId,
      providerMessageId,
      bodyText,
      rawType: bodyText ? 'text' : 'message',
      payload,
      createdAt: timestampToIso(payload.timestamp) ?? new Date().toISOString(),
    },
  ];
}

function getOaId(payload: JsonObject) {
  return (
    toNonEmptyString(payload.oaId) ??
    toNonEmptyString(payload.oa_id) ??
    toNonEmptyString(asRecord(payload.oa)?.id) ??
    toNonEmptyString(asRecord(payload.recipient)?.id)
  );
}

function getContactScopedId(payload: JsonObject) {
  return (
    toNonEmptyString(asRecord(payload.sender)?.id) ??
    toNonEmptyString(payload.user_id) ??
    toNonEmptyString(asRecord(payload.sender)?.user_id)
  );
}

function getProviderMessageId(payload: JsonObject) {
  const message = asRecord(payload.message);
  return (
    toNonEmptyString(message?.msg_id) ??
    toNonEmptyString(message?.mid) ??
    toNonEmptyString(payload.msg_id) ??
    toNonEmptyString(payload.message_id) ??
    toNonEmptyString(payload.event_id)
  );
}

function timestampToIso(value: unknown) {
  const timestamp =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  return new Date(timestamp).toISOString();
}

function asRecord(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function toNonEmptyString(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }

  return undefined;
}

function isDuplicateError(error: SupabaseError | null | undefined) {
  return error?.code === '23505';
}

function throwPersistError(error: SupabaseError, message: string): never {
  throw new Error(`${message}: ${error.message ?? error.code ?? 'unknown'}`);
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
