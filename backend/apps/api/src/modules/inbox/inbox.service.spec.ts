import { describe, expect, it, vi } from 'vitest';

import { encryptToken } from '../../common/crypto/token-crypto';
import {
  InboxService,
  type GraphMessenger,
  type InboxEnv,
  type SupabaseLike,
} from './inbox.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';
const CHANNEL_CONNECTION_ID = '44444444-4444-4444-4444-444444444444';
const CONTACT_ID = '55555555-5555-5555-5555-555555555555';
const TOKEN_KEY = 'dev-token-encryption-key-32chars!!';

const env: InboxEnv = { TOKEN_ENCRYPTION_KEY: TOKEN_KEY };

function graphMock(overrides: Partial<GraphMessenger> = {}): GraphMessenger {
  return {
    sendMessage: async () => ({ message_id: 'mid-stub' }),
    ...overrides,
  };
}

type Row = Record<string, unknown>;
type SupabaseCall = {
  args?: Row;
  columns?: string;
  field?: string;
  fn?: string;
  op: string;
  table?: string;
  value?: unknown;
  values?: unknown;
};

function conversationRow(overrides: Row = {}) {
  return {
    id: CONVERSATION_ID,
    org_id: ORG_ID,
    channel: 'messenger',
    channel_connection_id: '44444444-4444-4444-4444-444444444444',
    contact_id: '55555555-5555-5555-5555-555555555555',
    status: 'open',
    bot_paused: false,
    bot_epoch: 4,
    assignee_user_id: null,
    last_message_at: '2026-07-24T10:00:00.000Z',
    created_at: '2026-07-24T09:00:00.000Z',
    updated_at: '2026-07-24T10:00:00.000Z',
    ...overrides,
  };
}

function mockSupabase(row: Row) {
  const calls: SupabaseCall[] = [];
  const state = { conversation: { ...row } };

  const client = {
    rpc(fn: string, args: Row) {
      calls.push({ args, fn, op: 'rpc' });
      if (
        fn !== 'takeover_inbox_conversation' &&
        fn !== 'resume_inbox_conversation'
      ) {
        throw new Error(`Unexpected RPC ${fn}`);
      }

      return {
        maybeSingle: async () => {
          if (
            state.conversation.id !== args.p_conversation_id ||
            state.conversation.org_id !== args.p_org_id
          ) {
            return { data: null, error: null };
          }

          state.conversation = {
            ...state.conversation,
            bot_paused: fn === 'takeover_inbox_conversation',
            bot_epoch: Number(state.conversation.bot_epoch) + 1,
            updated_at: args.p_updated_at,
          };
          return { data: state.conversation, error: null };
        },
      };
    },
    from(table: string) {
      if (table !== 'conversations') {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        select(columns: string) {
          calls.push({ columns, op: 'select', table });
          return filteredConversationQuery(calls, state.conversation);
        },
        update(values: Row) {
          calls.push({ op: 'update', table, values });
          const filters: Array<{ field: string; value: unknown }> = [];
          const query = {
            eq(field: string, value: unknown) {
              calls.push({ field, op: 'eq', value });
              filters.push({ field, value });
              return query;
            },
            select(columns: string) {
              calls.push({ columns, op: 'select', table });
              return {
                maybeSingle: async () => {
                  if (!matches(state.conversation, filters)) {
                    return { data: null, error: null };
                  }
                  Object.assign(state.conversation, values);
                  return { data: state.conversation, error: null };
                },
              };
            },
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client, state };
}

function filteredConversationQuery(calls: SupabaseCall[], row: Row) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const query = {
    eq(field: string, value: unknown) {
      calls.push({ field, op: 'eq', value });
      filters.push({ field, value });
      return query;
    },
    maybeSingle: async () => ({
      data: matches(row, filters) ? row : null,
      error: null,
    }),
  };

  return query;
}

function matches(row: Row, filters: Array<{ field: string; value: unknown }>) {
  return filters.every(({ field, value }) => row[field] === value);
}

describe('InboxService', () => {
  it('takeover pauses the bot, increments epoch, and writes audit', async () => {
    const fixedNow = new Date('2026-07-24T12:00:00.000Z');
    const { calls, client } = mockSupabase(conversationRow());
    const auditCalls: unknown[] = [];
    const service = new InboxService(
      client,
      {
        writeAudit: async (input) => {
          auditCalls.push(input);
          return { audit: { id: 'audit-1' } };
        },
      },
      env,
      graphMock(),
    );

    await expect(
      service.takeoverConversation({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        actorUserId: USER_ID,
        now: fixedNow,
      }),
    ).resolves.toMatchObject({
      conversation: {
        id: CONVERSATION_ID,
        botPaused: true,
        botEpoch: 5,
      },
    });

    expect(calls).toContainEqual({
      args: {
        p_org_id: ORG_ID,
        p_conversation_id: CONVERSATION_ID,
        p_updated_at: fixedNow.toISOString(),
      },
      fn: 'takeover_inbox_conversation',
      op: 'rpc',
    });
    expect(calls.some((call) => call.op === 'update')).toBe(false);
    expect(auditCalls).toEqual([
      {
        orgId: ORG_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        action: 'inbox.takeover',
        entityType: 'conversation',
        entityId: CONVERSATION_ID,
        meta: {
          previousBotEpoch: 4,
          nextBotEpoch: 5,
        },
      },
    ]);
  });

  it('resume unpauses the bot, increments epoch, and writes audit', async () => {
    const fixedNow = new Date('2026-07-24T12:05:00.000Z');
    const paused = conversationRow({ bot_paused: true, bot_epoch: 5 });
    const { calls, client } = mockSupabase(paused);
    const auditCalls: unknown[] = [];
    const service = new InboxService(
      client,
      {
        writeAudit: async (input) => {
          auditCalls.push(input);
          return { audit: { id: 'audit-2' } };
        },
      },
      env,
      graphMock(),
    );

    await expect(
      service.resumeConversation({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        actorUserId: USER_ID,
        now: fixedNow,
      }),
    ).resolves.toMatchObject({
      conversation: {
        id: CONVERSATION_ID,
        botPaused: false,
        botEpoch: 6,
      },
    });

    expect(calls).toContainEqual({
      args: {
        p_org_id: ORG_ID,
        p_conversation_id: CONVERSATION_ID,
        p_updated_at: fixedNow.toISOString(),
      },
      fn: 'resume_inbox_conversation',
      op: 'rpc',
    });
    expect(auditCalls).toEqual([
      {
        orgId: ORG_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        action: 'inbox.resume',
        entityType: 'conversation',
        entityId: CONVERSATION_ID,
        meta: {
          previousBotEpoch: 5,
          nextBotEpoch: 6,
        },
      },
    ]);
  });

  it('surfaces audit write failures after takeover', async () => {
    const { client } = mockSupabase(conversationRow());
    const service = new InboxService(
      client,
      {
        writeAudit: async () => {
          throw new Error('audit unavailable');
        },
      },
      env,
      graphMock(),
    );

    await expect(
      service.takeoverConversation({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        actorUserId: USER_ID,
      }),
    ).rejects.toThrow('audit unavailable');
  });
});

function baseContact(overrides: Row = {}): Row {
  return {
    id: CONTACT_ID,
    display_name: 'Nguyễn Văn A',
    page_scoped_id: 'psid-123',
    ig_scoped_id: 'igsid-456',
    ...overrides,
  };
}

function baseConnection(overrides: Row = {}): Row {
  return {
    id: CHANNEL_CONNECTION_ID,
    provider: 'meta_page',
    external_page_id: 'page-999',
    external_ig_id: 'ig-777',
    access_token_enc: encryptToken('page-access-token', TOKEN_KEY),
    status: 'active',
    ...overrides,
  };
}

function conversationWithRelations(overrides: Row = {}): Row {
  return {
    id: CONVERSATION_ID,
    org_id: ORG_ID,
    channel: 'messenger',
    channel_connection_id: CHANNEL_CONNECTION_ID,
    contact_id: CONTACT_ID,
    status: 'open',
    bot_paused: true,
    bot_epoch: 4,
    assignee_user_id: null,
    last_message_at: '2026-07-24T10:00:00.000Z',
    created_at: '2026-07-24T09:00:00.000Z',
    updated_at: '2026-07-24T10:00:00.000Z',
    contact: baseContact(),
    channel_connection: baseConnection(),
    ...overrides,
  };
}

/**
 * A minimal fake Supabase client for `sendMessage` tests: supports reading a
 * conversation with embedded contact/channel_connection relations, a
 * best-effort `conversations` touch (`last_message_at`/`updated_at`), and
 * inserting into `messages`. Kept separate from `mockSupabase` above because
 * the operations (insert vs. rpc) don't overlap.
 */
function mockSendMessageSupabase(row: Row) {
  const calls: SupabaseCall[] = [];
  const messagesInserted: Row[] = [];
  let messageSeq = 0;

  const client = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select(columns: string) {
            calls.push({ columns, op: 'select', table });
            return filteredConversationQuery(calls, row);
          },
          update(values: Row) {
            calls.push({ op: 'update', table, values });
            const query = {
              eq(field: string, value: unknown) {
                calls.push({ field, op: 'eq', value });
                return query;
              },
            };
            return query;
          },
        };
      }

      if (table === 'messages') {
        return {
          insert(values: Row) {
            calls.push({ op: 'insert', table, values });
            return {
              select(columns: string) {
                calls.push({ columns, op: 'select', table });
                return {
                  single: async () => {
                    messageSeq += 1;
                    const messageRow = {
                      id: `msg-${messageSeq}`,
                      created_at: '2026-07-28T12:00:00.000Z',
                      ...values,
                    };
                    messagesInserted.push(messageRow);
                    return { data: messageRow, error: null };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown as SupabaseLike;

  return { calls, client, messagesInserted };
}

describe('InboxService sendMessage', () => {
  it('sends a Messenger reply: resolves recipient/sender, decrypts the token, persists a staff message, touches the conversation, and writes audit', async () => {
    const row = conversationWithRelations();
    const { calls, client } = mockSendMessageSupabase(row);
    const sendMessage = vi.fn(async () => ({ message_id: 'mid-1' }));
    const auditCalls: unknown[] = [];
    const service = new InboxService(
      client,
      {
        writeAudit: async (input) => {
          auditCalls.push(input);
          return { audit: { id: 'audit-3' } };
        },
      },
      env,
      { sendMessage },
    );

    const result = await service.sendMessage({
      orgId: ORG_ID,
      conversationId: CONVERSATION_ID,
      actorUserId: USER_ID,
      body: { text: 'Xin chào!' },
    });

    expect(sendMessage).toHaveBeenCalledWith({
      accessToken: 'page-access-token',
      recipientId: 'psid-123',
      senderId: 'page-999',
      text: 'Xin chào!',
    });

    expect(result).toMatchObject({
      message: {
        conversationId: CONVERSATION_ID,
        direction: 'outbound',
        senderType: 'staff',
        bodyText: 'Xin chào!',
        providerMessageId: 'mid-1',
      },
    });

    const insertCall = calls.find(
      (call) => call.op === 'insert' && call.table === 'messages',
    );
    expect(insertCall?.values).toMatchObject({
      org_id: ORG_ID,
      conversation_id: CONVERSATION_ID,
      direction: 'outbound',
      sender_type: 'staff',
      raw_type: 'text',
      body_text: 'Xin chào!',
      provider_message_id: 'mid-1',
    });

    const updateCall = calls.find(
      (call) => call.op === 'update' && call.table === 'conversations',
    );
    expect(updateCall?.values).toMatchObject({
      last_message_at: expect.any(String),
      updated_at: expect.any(String),
    });

    expect(auditCalls).toEqual([
      {
        orgId: ORG_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        action: 'inbox.reply',
        entityType: 'conversation',
        entityId: CONVERSATION_ID,
        meta: { messageId: expect.any(String) },
      },
    ]);
  });

  it('sends an Instagram reply using ig_scoped_id/external_ig_id instead of the Messenger identifiers', async () => {
    const row = conversationWithRelations({ channel: 'instagram' });
    const { calls, client } = mockSendMessageSupabase(row);
    const sendMessage = vi.fn(async () => ({ message_id: 'mid-2' }));
    const service = new InboxService(
      client,
      { writeAudit: async () => ({ audit: { id: 'audit-4' } }) },
      env,
      { sendMessage },
    );

    const result = await service.sendMessage({
      orgId: ORG_ID,
      conversationId: CONVERSATION_ID,
      actorUserId: USER_ID,
      body: { text: 'Xin chào IG!' },
    });

    expect(sendMessage).toHaveBeenCalledWith({
      accessToken: 'page-access-token',
      recipientId: 'igsid-456',
      senderId: 'ig-777',
      text: 'Xin chào IG!',
    });
    expect(result).toMatchObject({
      message: { senderType: 'staff', bodyText: 'Xin chào IG!' },
    });

    const insertCall = calls.find(
      (call) => call.op === 'insert' && call.table === 'messages',
    );
    expect(insertCall?.values).toMatchObject({
      sender_type: 'staff',
      body_text: 'Xin chào IG!',
      provider_message_id: 'mid-2',
    });
  });

  it('rejects Zalo conversations with a Vietnamese message and never calls the Graph client', async () => {
    const row = conversationWithRelations({ channel: 'zalo' });
    const { client } = mockSendMessageSupabase(row);
    const sendMessage = vi.fn();
    const service = new InboxService(
      client,
      { writeAudit: vi.fn() },
      env,
      { sendMessage },
    );

    await expect(
      service.sendMessage({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        actorUserId: USER_ID,
        body: { text: 'hi' },
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'channel_not_supported',
        message:
          'Gửi tin nhắn thủ công cho Zalo chưa được hỗ trợ — vui lòng trả lời trực tiếp qua Zalo OA.',
      }),
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects when the channel connection needs reauth, without calling the Graph client', async () => {
    const row = conversationWithRelations({
      channel_connection: baseConnection({ status: 'needs_reauth' }),
    });
    const { client } = mockSendMessageSupabase(row);
    const sendMessage = vi.fn();
    const service = new InboxService(
      client,
      { writeAudit: vi.fn() },
      env,
      { sendMessage },
    );

    await expect(
      service.sendMessage({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        actorUserId: USER_ID,
        body: { text: 'hi' },
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'channel_inactive' }),
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects when the channel connection is revoked, without calling the Graph client', async () => {
    const row = conversationWithRelations({
      channel_connection: baseConnection({ status: 'revoked' }),
    });
    const { client } = mockSendMessageSupabase(row);
    const sendMessage = vi.fn();
    const service = new InboxService(
      client,
      { writeAudit: vi.fn() },
      env,
      { sendMessage },
    );

    await expect(
      service.sendMessage({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        actorUserId: USER_ID,
        body: { text: 'hi' },
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'channel_inactive' }),
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects with a Vietnamese message_send_failed error when the Graph client throws, and never inserts a message row', async () => {
    const row = conversationWithRelations();
    const { client, messagesInserted } = mockSendMessageSupabase(row);
    const sendMessage = vi.fn(async () => {
      throw new Error('Meta sendMessage failed: 400');
    });
    const service = new InboxService(
      client,
      { writeAudit: vi.fn() },
      env,
      { sendMessage },
    );

    await expect(
      service.sendMessage({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        actorUserId: USER_ID,
        body: { text: 'hi' },
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'message_send_failed',
        message:
          'Không gửi được tin nhắn — có thể đã quá 24 giờ kể từ tin nhắn cuối của khách, hoặc kênh kết nối gặp sự cố.',
      }),
    });
    expect(messagesInserted).toHaveLength(0);
  });
});
