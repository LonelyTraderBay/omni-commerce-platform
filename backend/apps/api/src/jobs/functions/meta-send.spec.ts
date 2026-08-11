import { describe, expect, it, vi } from "vitest";

import { encryptToken } from "../../common/crypto/token-crypto";
import { MetaSendJobService, type SupabaseLike } from "./meta-send";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const CONNECTION_ID = "33333333-3333-3333-3333-333333333333";
const CONTACT_ID = "44444444-4444-4444-4444-444444444444";
const MESSAGE_ID = "55555555-5555-5555-5555-555555555555";
const SEND_ID = "66666666-6666-6666-6666-666666666666";
const SECRET = "x".repeat(32);
const NOW = new Date("2026-07-24T12:00:00.000Z");

type Row = Record<string, unknown>;
type TableName =
  | "conversations"
  | "channel_connections"
  | "contacts"
  | "messages"
  | "meta_outbound_sends";

type State = Record<TableName, Row[]>;

function createState(overrides: Partial<State> = {}): State {
  return {
    conversations: [
      {
        id: CONVERSATION_ID,
        org_id: ORG_ID,
        channel: "messenger",
        channel_connection_id: CONNECTION_ID,
        contact_id: CONTACT_ID,
        bot_paused: false,
        bot_epoch: 8,
        last_message_at: "2026-07-24T11:00:00.000Z",
      },
    ],
    channel_connections: [
      {
        id: CONNECTION_ID,
        org_id: ORG_ID,
        provider: "meta_page",
        external_page_id: "page-1",
        external_ig_id: null,
        access_token_enc: encryptToken("page-token", SECRET),
        status: "active",
      },
    ],
    contacts: [
      {
        id: CONTACT_ID,
        org_id: ORG_ID,
        page_scoped_id: "customer-1",
        ig_scoped_id: null,
      },
    ],
    messages: [
      {
        id: MESSAGE_ID,
        org_id: ORG_ID,
        conversation_id: CONVERSATION_ID,
        direction: "inbound",
        sender_type: "customer",
        created_at: "2026-07-24T11:00:00.000Z",
      },
    ],
    meta_outbound_sends: [],
    ...overrides,
  };
}

function mockSupabase(state: State) {
  const client = {
    from(table: TableName) {
      return {
        select() {
          return queryBuilder(state, table);
        },
        insert(values: Row) {
          return insertBuilder(state, table, values);
        },
        update(values: Row) {
          return updateBuilder(state, table, values);
        },
      };
    },
  } as unknown as SupabaseLike;

  return client;
}

function queryBuilder(state: State, table: TableName) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const query = {
    eq(field: string, value: unknown) {
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

function insertBuilder(state: State, table: TableName, values: Row) {
  return {
    select() {
      return {
        single: async () => {
          if (
            table === "meta_outbound_sends" &&
            state.meta_outbound_sends.some(
              (row) => row.inbound_message_id === values.inbound_message_id,
            )
          ) {
            return { data: null, error: { code: "23505" } };
          }

          const row = withDefaults(table, values);
          state[table].push(row);
          return { data: row, error: null };
        },
      };
    },
  };
}

function updateBuilder(state: State, table: TableName, values: Row) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const query = {
    eq(field: string, value: unknown) {
      filters.push({ field, value });
      return query;
    },
    select() {
      return {
        maybeSingle: async () => {
          const row =
            state[table].find((candidate) =>
              filters.every(({ field, value }) => candidate[field] === value),
            ) ?? null;
          if (row) {
            Object.assign(row, values);
          }
          return { data: row, error: null };
        },
      };
    },
  };

  return query;
}

function withDefaults(table: TableName, values: Row) {
  if (table === "meta_outbound_sends") {
    return {
      id: SEND_ID,
      provider_message_id: null,
      error_text: null,
      ...values,
    };
  }

  return values;
}

function createService(
  state: State,
  overrides: NonNullable<ConstructorParameters<typeof MetaSendJobService>[0]> = {},
) {
  return new MetaSendJobService({
    env: { TOKEN_ENCRYPTION_KEY: SECRET },
    featureFlags: { isEnabled: async () => false },
    graph: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: "graph-1" }),
    },
    now: () => NOW,
    supabase: mockSupabase(state),
    ...overrides,
  });
}

function sendInput() {
  return {
    orgId: ORG_ID,
    conversationId: CONVERSATION_ID,
    inboundMessageId: MESSAGE_ID,
    botEpoch: 8,
    replyText: "Co, shop con hang.",
  };
}

describe("MetaSendJobService", () => {
  it("drops before Graph send when bot_epoch does not match", async () => {
    const sendMessage = vi.fn();
    const service = createService(createState(), {
      graph: { sendMessage },
    });

    await expect(
      service.send({
        ...sendInput(),
        botEpoch: 7,
      }),
    ).resolves.toEqual({
      ok: true,
      action: "dropped",
      reason: "epoch_mismatch",
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reserves outbound send by inbound message so retries do not double-send", async () => {
    const state = createState();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: "graph-1" });
    const service = createService(state, { graph: { sendMessage } });

    await expect(service.send(sendInput())).resolves.toEqual({
      ok: true,
      action: "sent",
      providerMessageId: "graph-1",
    });
    await expect(service.send(sendInput())).resolves.toEqual({
      ok: true,
      action: "already_sent",
      providerMessageId: "graph-1",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(state.meta_outbound_sends).toContainEqual(
      expect.objectContaining({
        inbound_message_id: MESSAGE_ID,
        provider_message_id: "graph-1",
        status: "sent",
      }),
    );
  });

  it("does not Graph-send when a prior reservation is still in progress", async () => {
    const state = createState({
      meta_outbound_sends: [
        {
          id: SEND_ID,
          org_id: ORG_ID,
          conversation_id: CONVERSATION_ID,
          inbound_message_id: MESSAGE_ID,
          provider_message_id: null,
          error_text: null,
          status: "sending",
        },
      ],
    });
    const sendMessage = vi.fn();
    const service = createService(state, { graph: { sendMessage } });

    await expect(service.send(sendInput())).resolves.toEqual({
      ok: true,
      action: "already_reserved",
      reason: "send_in_progress",
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rechecks kill_ai_outbound immediately before Graph send", async () => {
    const state = createState();
    const sendMessage = vi.fn();
    const service = createService(state, {
      featureFlags: {
        isEnabled: async (key) => key === "kill_ai_outbound",
      },
      graph: { sendMessage },
    });

    await expect(service.send(sendInput())).resolves.toEqual({
      ok: true,
      action: "dropped",
      reason: "kill_ai_outbound",
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.meta_outbound_sends).toContainEqual(
      expect.objectContaining({
        error_text: "kill_ai_outbound",
        status: "failed",
      }),
    );
  });

  it("marks sends outside the 24 hour messaging window failed", async () => {
    const state = createState({
      messages: [
        {
          id: MESSAGE_ID,
          org_id: ORG_ID,
          conversation_id: CONVERSATION_ID,
          direction: "inbound",
          sender_type: "customer",
          created_at: "2026-07-23T11:59:00.000Z",
        },
      ],
    });
    const sendMessage = vi.fn();
    const service = createService(state, { graph: { sendMessage } });

    await expect(service.send(sendInput())).resolves.toEqual({
      ok: true,
      action: "failed",
      reason: "messaging_window_expired",
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.meta_outbound_sends).toContainEqual(
      expect.objectContaining({
        error_text: "messaging_window_expired",
        status: "failed",
      }),
    );
  });
});
