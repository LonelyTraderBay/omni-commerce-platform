import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MetaInboundPersistenceService,
  type SupabaseLike,
} from './meta-persist-inbound';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CONNECTION_ID = '22222222-2222-2222-2222-222222222222';
const CONTACT_ID = '33333333-3333-3333-3333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-4444-444444444444';
const MESSAGE_ID = '55555555-5555-5555-5555-555555555555';

type Row = Record<string, unknown>;
type TableName =
  | 'channel_connections'
  | 'contacts'
  | 'conversations'
  | 'messages'
  | 'outbox_events';

type SupabaseCall = {
  columns?: string;
  field?: string;
  op: string;
  table?: string;
  value?: unknown;
  values?: unknown;
};

type State = Record<TableName, Row[]>;

function loadMessengerFixture() {
  return JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../../../tests/fixtures/meta/messenger-inbound.json',
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

function createState(overrides: Partial<State> = {}): State {
  return {
    channel_connections: [
      {
        id: CONNECTION_ID,
        org_id: ORG_ID,
        provider: 'meta_page',
        external_page_id: 'page-1',
        external_ig_id: null,
        status: 'active',
      },
    ],
    contacts: [],
    conversations: [],
    messages: [],
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
          calls.push({ columns, op: 'select', table });
          return queryBuilder(state, calls, table);
        },
        insert(values: Row) {
          calls.push({ op: 'insert', table, values });
          return {
            select(columns: string) {
              calls.push({ columns, op: 'select', table });
              return {
                single: async () => {
                  const row = withDefaults(table, values);
                  state[table].push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        update(values: Row) {
          calls.push({ op: 'update', table, values });
          const filters: Array<{ field: string; value: unknown }> = [];
          const updateQuery = {
            eq(field: string, value: unknown) {
              calls.push({ field, op: 'eq', value });
              filters.push({ field, value });
              return updateQuery;
            },
            select(columns: string) {
              calls.push({ columns, op: 'select', table });
              return {
                single: async () => {
                  const row = state[table].find((candidate) =>
                    filters.every(
                      ({ field, value }) => candidate[field] === value,
                    ),
                  );
                  if (!row) {
                    return { data: null, error: null };
                  }
                  Object.assign(row, values);
                  return { data: row, error: null };
                },
              };
            },
          };
          return updateQuery;
        },
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

function queryBuilder(state: State, calls: SupabaseCall[], table: TableName) {
  const filters: Array<{
    field: string;
    op: 'contains' | 'eq';
    value: unknown;
  }> = [];
  const query = {
    eq(field: string, value: unknown) {
      calls.push({ field, op: 'eq', value });
      filters.push({ field, op: 'eq', value });
      return query;
    },
    contains(field: string, value: unknown) {
      calls.push({ field, op: 'contains', value });
      filters.push({ field, op: 'contains', value });
      return query;
    },
    maybeSingle: async () => {
      const data =
        state[table].find((candidate) =>
          filters.every((filter) => matchesFilter(candidate, filter)),
        ) ?? null;
      return { data, error: null };
    },
  };

  return query;
}

function matchesFilter(
  candidate: Row,
  filter: { field: string; op: 'contains' | 'eq'; value: unknown },
) {
  if (filter.op === 'eq') {
    return candidate[filter.field] === filter.value;
  }

  const actual = candidate[filter.field];
  if (!isRecord(actual) || !isRecord(filter.value)) {
    return false;
  }

  return Object.entries(filter.value).every(
    ([key, value]) => actual[key] === value,
  );
}

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withDefaults(table: TableName, values: Row) {
  if (table === 'contacts') {
    return {
      id: CONTACT_ID,
      created_at: '2026-07-24T10:00:00.000Z',
      ...values,
    };
  }
  if (table === 'conversations') {
    return {
      id: CONVERSATION_ID,
      bot_paused: false,
      bot_epoch: 0,
      assignee_user_id: null,
      created_at: '2026-07-24T10:00:00.000Z',
      ...values,
    };
  }
  if (table === 'messages') {
    return {
      id: MESSAGE_ID,
      ...values,
    };
  }
  if (table === 'outbox_events') {
    return {
      id: '66666666-6666-6666-6666-666666666666',
      created_at: '2026-07-24T10:00:00.000Z',
      ...values,
    };
  }

  return values;
}

describe('MetaInboundPersistenceService', () => {
  it('persists a Messenger fixture into contact, conversation, and message rows', async () => {
    const state = createState();
    const { client } = mockSupabase(state);
    const service = new MetaInboundPersistenceService(client);

    await expect(
      service.persist({ ...loadMessengerFixture(), orgId: ORG_ID }),
    ).resolves.toEqual({
      ok: true,
      processedMessages: 1,
      insertedMessages: 1,
      skippedMessages: 0,
    });

    expect(state.contacts).toContainEqual(
      expect.objectContaining({
        org_id: ORG_ID,
        page_scoped_id: 'customer-1',
        ig_scoped_id: null,
      }),
    );
    expect(state.conversations).toContainEqual(
      expect.objectContaining({
        org_id: ORG_ID,
        channel: 'messenger',
        channel_connection_id: CONNECTION_ID,
        contact_id: CONTACT_ID,
        status: 'open',
        last_message_at: '2024-07-24T12:33:20.000Z',
      }),
    );
    expect(state.messages).toContainEqual(
      expect.objectContaining({
        org_id: ORG_ID,
        conversation_id: CONVERSATION_ID,
        direction: 'inbound',
        sender_type: 'customer',
        raw_type: 'text',
        provider_message_id: 'm_page_1',
        body_text: 'hello from messenger',
      }),
    );
    expect(state.outbox_events).toContainEqual(
      expect.objectContaining({
        org_id: ORG_ID,
        event_name: 'ai.process_inbound',
        payload_json: {
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
        },
        published_at: null,
        attempts: 0,
      }),
    );
  });

  it('does not insert a duplicate provider message but ensures AI outbox exists', async () => {
    const state = createState({
      contacts: [
        {
          id: CONTACT_ID,
          org_id: ORG_ID,
          display_name: null,
          page_scoped_id: 'customer-1',
          ig_scoped_id: null,
        },
      ],
      conversations: [
        {
          id: CONVERSATION_ID,
          org_id: ORG_ID,
          channel: 'messenger',
          channel_connection_id: CONNECTION_ID,
          contact_id: CONTACT_ID,
          status: 'open',
          bot_paused: false,
          bot_epoch: 0,
          assignee_user_id: null,
          last_message_at: '2024-07-24T12:33:20.000Z',
        },
      ],
      messages: [
        {
          id: MESSAGE_ID,
          org_id: ORG_ID,
          conversation_id: CONVERSATION_ID,
          provider_message_id: 'm_page_1',
        },
      ],
    });
    const { calls, client } = mockSupabase(state);
    const service = new MetaInboundPersistenceService(client);

    await expect(
      service.persist({ ...loadMessengerFixture(), orgId: ORG_ID }),
    ).resolves.toMatchObject({
      insertedMessages: 0,
      skippedMessages: 1,
    });

    expect(
      calls.filter((call) => call.op === 'insert' && call.table === 'messages'),
    ).toHaveLength(0);
    expect(state.outbox_events).toContainEqual(
      expect.objectContaining({
        org_id: ORG_ID,
        event_name: 'ai.process_inbound',
        payload_json: {
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
        },
      }),
    );
  });
});
