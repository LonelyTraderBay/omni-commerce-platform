import { describe, expect, it, vi } from "vitest";

import {
  ProcessInboundMessageJobService,
  type SupabaseLike,
} from "./process-inbound-message";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "33333333-3333-3333-3333-333333333333";
const CONNECTION_ID = "44444444-4444-4444-4444-444444444444";
const CONTACT_ID = "55555555-5555-5555-5555-555555555555";

const allowedQuota = {
  getQuotaStatus: async () => ({
    allowed: true,
    exceeded: false,
    used: 0,
    limit: 1_000_000,
    periodStart: "2026-07-01T00:00:00.000Z",
  }),
};

type Row = Record<string, unknown>;
type TableName = "messages" | "conversations" | "outbox_events";

type SupabaseCall = {
  columns?: string;
  field?: string;
  op: string;
  table?: string;
  value?: unknown;
  values?: unknown;
};

type State = Record<TableName, Row[]>;

function createState(overrides: Partial<State> = {}): State {
  return {
    messages: [
      {
        id: MESSAGE_ID,
        org_id: ORG_ID,
        conversation_id: CONVERSATION_ID,
        direction: "inbound",
        sender_type: "customer",
        body_text: "Co ao mau den khong?",
      },
    ],
    conversations: [
      {
        id: CONVERSATION_ID,
        org_id: ORG_ID,
        channel: "messenger",
        channel_connection_id: CONNECTION_ID,
        contact_id: CONTACT_ID,
        bot_paused: false,
        bot_epoch: 3,
      },
    ],
    outbox_events: [],
    ...overrides,
  };
}

function mockSupabase(state: State) {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: TableName) {
      return {
        select(columns: string) {
          calls.push({ columns, op: "select", table });
          return queryBuilder(state, calls, table);
        },
        insert(values: Row) {
          calls.push({ op: "insert", table, values });
          return {
            select(columns: string) {
              calls.push({ columns, op: "select", table });
              return {
                single: async () => {
                  const row = {
                    id: "66666666-6666-6666-6666-666666666666",
                    created_at: "2026-07-24T10:00:00.000Z",
                    ...values,
                  };
                  state[table].push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

function queryBuilder(state: State, calls: SupabaseCall[], table: TableName) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const query = {
    eq(field: string, value: unknown) {
      calls.push({ field, op: "eq", value });
      filters.push({ field, value });
      return query;
    },
    maybeSingle: async () => {
      const data =
        state[table].find((candidate) =>
          filters.every(({ field, value }) => candidate[field] === value),
        ) ?? null;
      return { data, error: null };
    },
  };

  return query;
}

describe("ProcessInboundMessageJobService", () => {
  it("drops before AI processing when kill_ai_all is enabled", async () => {
    const state = createState();
    const { client } = mockSupabase(state);
    const fetchFn = vi.fn();
    const writeRun = vi.fn();
    const service = new ProcessInboundMessageJobService({
      aiRuns: { writeRun },
      aiTokenUsage: allowedQuota,
      env: {
        AI_BASE_URL: "https://ai.example.test",
        SERVICE_M2M_KEY: "service-key",
      },
      featureFlags: {
        isEnabled: async (key) => key === "kill_ai_all",
      },
      fetchFn,
      supabase: client,
    });

    await expect(
      service.process({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
      }),
    ).resolves.toEqual({
      ok: true,
      action: "dropped",
      reason: "kill_ai_all",
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(writeRun).not.toHaveBeenCalled();
    expect(state.outbox_events).toEqual([]);
  });

  it("drops outbound enqueue when bot_epoch changes after AI processing", async () => {
    const state = createState();
    const { client } = mockSupabase(state);
    const writeRun = vi.fn(async () => ({ aiRun: { id: "run-1" } }));
    const fetchFn = vi.fn(async () => {
      state.conversations[0].bot_epoch = 4;
      return {
        ok: true,
        json: async () => ({
          replyText: "Co, shop con ao mau den.",
          citations: [],
          toolsUsed: [],
          promptVersion: "v1_grounded_process_message",
          model: "gemini-2.0-flash",
          tokens: { prompt: 1, completion: 2, total: 3 },
          escalate: false,
        }),
      };
    });
    const service = new ProcessInboundMessageJobService({
      aiRuns: { writeRun },
      aiTokenUsage: allowedQuota,
      env: {
        AI_BASE_URL: "https://ai.example.test",
        SERVICE_M2M_KEY: "service-key",
      },
      featureFlags: {
        isEnabled: async () => false,
      },
      fetchFn: fetchFn as unknown as typeof fetch,
      supabase: client,
    });

    await expect(
      service.process({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
      }),
    ).resolves.toEqual({
      ok: true,
      action: "processed",
      outbound: "dropped_epoch",
    });

    expect(writeRun).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchFn.mock.calls[0][1].body as string)).toMatchObject({
      orgId: ORG_ID,
      message: "Co ao mau den khong?",
      conversationId: CONVERSATION_ID,
      contactId: CONTACT_ID,
      messageId: MESSAGE_ID,
      channel: "messenger",
      channelConnectionId: CONNECTION_ID,
    });
    expect(state.outbox_events).toEqual([]);
  });

  it("escalates without calling AI when monthly token quota is exceeded", async () => {
    const state = createState();
    const { client } = mockSupabase(state);
    const fetchFn = vi.fn();
    const writeRun = vi.fn(async () => ({ aiRun: { id: "run-quota" } }));
    const service = new ProcessInboundMessageJobService({
      aiRuns: { writeRun },
      aiTokenUsage: {
        getQuotaStatus: async () => ({
          allowed: false,
          exceeded: true,
          used: 100,
          limit: 100,
          periodStart: "2026-07-01T00:00:00.000Z",
        }),
      },
      env: {
        AI_BASE_URL: "https://ai.example.test",
        SERVICE_M2M_KEY: "service-key",
      },
      featureFlags: {
        isEnabled: async () => false,
      },
      fetchFn,
      supabase: client,
    });

    await expect(
      service.process({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: "processed",
      outbound: "enqueued",
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(writeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "quota_exceeded",
        promptVersion: "quota_gate_v1",
      }),
    );
    expect(state.outbox_events).toHaveLength(1);
    expect(state.outbox_events[0].payload_json).toMatchObject({
      replyText: expect.stringContaining("Minh se chuyen cho doi ngu ho tro"),
    });
  });
});
