import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enqueueOutbox,
  OutboxPublisher,
  type InngestSender,
  type SupabaseLike,
} from "./outbox.publisher";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const OUTBOX_ID = "22222222-2222-2222-2222-222222222222";
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

type QueryResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

type SupabaseCall = {
  op: string;
  table?: string;
  columns?: string;
  values?: unknown;
  field?: string;
  value?: unknown;
};

/**
 * Evaluates the PostgREST `.or()` expression the publisher uses for backoff,
 * e.g. `next_attempt_at.is.null,next_attempt_at.lte.2026-07-24T11:00:00.000Z`.
 * The value segment is rejoined because ISO timestamps contain dots.
 */
function evaluateOrFilter(
  expression: string,
  row: Record<string, unknown>,
): boolean {
  return expression.split(",").some((clause) => {
    const [field, op, ...rest] = clause.split(".");
    const value = rest.join(".");
    const actual = row[field as string];

    if (op === "is" && value === "null") {
      return actual === null || actual === undefined;
    }
    if (op === "lte") {
      return typeof actual === "string" && actual <= value;
    }
    return false;
  });
}

function mockSupabase(input: {
  selectResults?: QueryResult[];
  insertResults?: QueryResult[];
  updateResults?: QueryResult[];
}) {
  const calls: SupabaseCall[] = [];
  const selectResults = [...(input.selectResults ?? [])];
  const insertResults = [...(input.insertResults ?? [])];
  const updateResults = [...(input.updateResults ?? [])];

  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          calls.push({ op: "select", table, columns });
          const query = {
            is(field: string, value: unknown) {
              calls.push({ op: "is", field, value });
              return query;
            },
            lt(field: string, value: unknown) {
              calls.push({ op: "lt", field, value });
              return query;
            },
            or(expression: string) {
              calls.push({ op: "or", value: expression });
              return query;
            },
            order(field: string, value: unknown) {
              calls.push({ op: "order", field, value });
              return query;
            },
            limit: async (value: unknown) => {
              calls.push({ op: "limit", value });
              return selectResults.shift() ?? { data: [], error: null };
            },
          };
          return query;
        },
        insert(values: unknown) {
          calls.push({ op: "insert", table, values });
          return {
            select(columns: string) {
              calls.push({ op: "select", table, columns });
              return {
                single: async () =>
                  insertResults.shift() ?? { data: { id: "inserted" }, error: null },
              };
            },
          };
        },
        update(values: unknown) {
          calls.push({ op: "update", table, values });
          const query = {
            eq(field: string, value: unknown) {
              calls.push({ op: "eq", field, value });
              return query;
            },
            is(field: string, value: unknown) {
              calls.push({ op: "is", field, value });
              return query;
            },
            select(columns: string) {
              calls.push({ op: "select", table, columns });
              return {
                maybeSingle: async () =>
                  updateResults.shift() ?? { data: { id: "updated" }, error: null },
              };
            },
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

function outboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OUTBOX_ID,
    org_id: ORG_ID,
    event_name: "platform.noop",
    payload_json: { source: "test" },
    created_at: "2026-07-24T10:00:00.000Z",
    published_at: null,
    attempts: 0,
    next_attempt_at: null,
    ...overrides,
  };
}

/**
 * Supabase mock whose pending scan actually applies the `is`/`lt`/`or` filters
 * to a row set, so backoff eligibility can be asserted end to end rather than
 * by inspecting the filter string.
 */
function mockScanSupabase(rows: Array<Record<string, unknown>>) {
  return {
    from() {
      return {
        select() {
          const predicates: Array<
            (row: Record<string, unknown>) => boolean
          > = [];
          const query = {
            is(field: string, value: unknown) {
              predicates.push((row) => row[field] === value);
              return query;
            },
            lt(field: string, value: unknown) {
              predicates.push(
                (row) => (row[field] as number) < (value as number),
              );
              return query;
            },
            or(expression: string) {
              predicates.push((row) => evaluateOrFilter(expression, row));
              return query;
            },
            order() {
              return query;
            },
            limit: async () => ({
              data: rows.filter((row) =>
                predicates.every((predicate) => predicate(row)),
              ),
              error: null,
            }),
          };
          return query;
        },
        update() {
          const query = {
            eq: () => query,
            is: () => query,
            select: () => ({
              maybeSingle: async () => ({ data: { id: "updated" }, error: null }),
            }),
          };
          return query;
        },
        insert() {
          return {
            select: () => ({
              single: async () => ({ data: { id: "inserted" }, error: null }),
            }),
          };
        },
      };
    },
  } as unknown as SupabaseLike;
}

describe("outbox publisher", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
  });

  it("inserts the expected outbox event shape", async () => {
    const { calls, client } = mockSupabase({
      insertResults: [{ data: outboxRow(), error: null }],
    });

    const row = await enqueueOutbox(client, {
      orgId: ORG_ID,
      eventName: "platform.noop",
      payload: { source: "test" },
    });

    expect(calls).toContainEqual({
      op: "insert",
      table: "outbox_events",
      values: {
        org_id: ORG_ID,
        event_name: "platform.noop",
        payload_json: { source: "test" },
        published_at: null,
        attempts: 0,
      },
    });
    expect(row).toMatchObject({
      eventName: "platform.noop",
      publishedAt: null,
      attempts: 0,
    });
  });

  it("sends pending events to Inngest and marks them published", async () => {
    const fixedNow = new Date("2026-07-24T11:00:00.000Z");
    const { calls, client } = mockSupabase({
      selectResults: [{ data: [outboxRow()], error: null }],
    });
    const sentEvents: unknown[] = [];
    const inngestClient: InngestSender = {
      send: async (event) => {
        sentEvents.push(event);
        return { ids: ["evt_1"] };
      },
    };
    const publisher = new OutboxPublisher(client, inngestClient, {
      now: () => fixedNow,
    });

    await expect(publisher.publishPending(10)).resolves.toEqual({
      published: 1,
      failed: 0,
      deadLettered: 0,
    });
    expect(sentEvents).toEqual([
      {
        id: OUTBOX_ID,
        name: "platform/noop",
        data: {
          source: "test",
          orgId: ORG_ID,
          outboxEventId: OUTBOX_ID,
        },
      },
    ]);
    expect(calls).toContainEqual({
      op: "update",
      table: "outbox_events",
      values: { published_at: fixedNow.toISOString() },
    });
  });

  it("maps zalo/inbound.received to the Zalo persist inbound Inngest event", async () => {
    const { client } = mockSupabase({
      selectResults: [
        {
          data: [
            outboxRow({
              event_name: "zalo/inbound.received",
              payload_json: { oa_id: "oa-1", message: { msg_id: "zalo-1" } },
            }),
          ],
          error: null,
        },
      ],
    });
    const sentEvents: unknown[] = [];
    const publisher = new OutboxPublisher(client, {
      send: async (event) => {
        sentEvents.push(event);
        return { ids: ["evt_1"] };
      },
    });

    await publisher.publishPending(10);

    expect(sentEvents).toEqual([
      {
        id: OUTBOX_ID,
        name: "zalo/inbound/received",
        data: {
          oa_id: "oa-1",
          message: { msg_id: "zalo-1" },
          orgId: ORG_ID,
          outboxEventId: OUTBOX_ID,
        },
      },
    ]);
  });

  it("maps meta.inbound to the persist inbound Inngest event", async () => {
    const { client } = mockSupabase({
      selectResults: [
        {
          data: [
            outboxRow({
              event_name: "meta.inbound",
              payload_json: { object: "page", entry: [] },
            }),
          ],
          error: null,
        },
      ],
    });
    const sentEvents: unknown[] = [];
    const publisher = new OutboxPublisher(client, {
      send: async (event) => {
        sentEvents.push(event);
        return { ids: ["evt_1"] };
      },
    });

    await publisher.publishPending(10);

    expect(sentEvents).toEqual([
      {
        id: OUTBOX_ID,
        name: "meta/persist_inbound",
        data: {
          object: "page",
          entry: [],
          orgId: ORG_ID,
          outboxEventId: OUTBOX_ID,
        },
      },
    ]);
  });

  it("maps knowledge.reindex to the knowledge reindex Inngest event", async () => {
    const { client } = mockSupabase({
      selectResults: [
        {
          data: [
            outboxRow({
              event_name: "knowledge.reindex",
              payload_json: {
                sourceType: "product",
                sourceId: "33333333-3333-3333-3333-333333333333",
              },
            }),
          ],
          error: null,
        },
      ],
    });
    const sentEvents: unknown[] = [];
    const publisher = new OutboxPublisher(client, {
      send: async (event) => {
        sentEvents.push(event);
        return { ids: ["evt_1"] };
      },
    });

    await publisher.publishPending(10);

    expect(sentEvents).toEqual([
      {
        id: OUTBOX_ID,
        name: "knowledge/reindex",
        data: {
          sourceType: "product",
          sourceId: "33333333-3333-3333-3333-333333333333",
          orgId: ORG_ID,
          outboxEventId: OUTBOX_ID,
        },
      },
    ]);
  });

  it("maps AI inbound and Meta send outbox events to Inngest events", async () => {
    const { client } = mockSupabase({
      selectResults: [
        {
          data: [
            outboxRow({
              event_name: "ai.process_inbound",
              payload_json: {
                conversationId: "33333333-3333-3333-3333-333333333333",
                messageId: "44444444-4444-4444-4444-444444444444",
              },
            }),
            outboxRow({
              id: "55555555-5555-5555-5555-555555555555",
              event_name: "meta.send",
              payload_json: {
                botEpoch: 1,
                conversationId: "33333333-3333-3333-3333-333333333333",
                replyText: "Xin chao",
              },
            }),
          ],
          error: null,
        },
      ],
    });
    const sentEvents: unknown[] = [];
    const publisher = new OutboxPublisher(client, {
      send: async (event) => {
        sentEvents.push(event);
        return { ids: ["evt_1"] };
      },
    });

    await publisher.publishPending(10);

    expect(sentEvents).toEqual([
      {
        id: OUTBOX_ID,
        name: "ai/process_inbound",
        data: {
          conversationId: "33333333-3333-3333-3333-333333333333",
          messageId: "44444444-4444-4444-4444-444444444444",
          orgId: ORG_ID,
          outboxEventId: OUTBOX_ID,
        },
      },
      {
        id: "55555555-5555-5555-5555-555555555555",
        name: "meta/send",
        data: {
          botEpoch: 1,
          conversationId: "33333333-3333-3333-3333-333333333333",
          replyText: "Xin chao",
          orgId: ORG_ID,
          outboxEventId: "55555555-5555-5555-5555-555555555555",
        },
      },
    ]);
  });

  it("maps every order.* outbox event to the shared order webhook dispatch Inngest event", async () => {
    const { client } = mockSupabase({
      selectResults: [
        {
          data: [
            outboxRow({
              event_name: "order.confirmed",
              payload_json: {
                event: "order.confirmed",
                orderId: "33333333-3333-3333-3333-333333333333",
                status: "confirmed",
              },
            }),
            outboxRow({
              id: "55555555-5555-5555-5555-555555555555",
              event_name: "order.shipped",
              payload_json: {
                event: "order.shipped",
                orderId: "33333333-3333-3333-3333-333333333333",
                status: "shipped",
              },
            }),
          ],
          error: null,
        },
      ],
    });
    const sentEvents: unknown[] = [];
    const publisher = new OutboxPublisher(client, {
      send: async (event) => {
        sentEvents.push(event);
        return { ids: ["evt_1"] };
      },
    });

    await publisher.publishPending(10);

    expect(sentEvents).toEqual([
      {
        id: OUTBOX_ID,
        name: "order/webhook_dispatch",
        data: {
          event: "order.confirmed",
          orderId: "33333333-3333-3333-3333-333333333333",
          status: "confirmed",
          orgId: ORG_ID,
          outboxEventId: OUTBOX_ID,
        },
      },
      {
        id: "55555555-5555-5555-5555-555555555555",
        name: "order/webhook_dispatch",
        data: {
          event: "order.shipped",
          orderId: "33333333-3333-3333-3333-333333333333",
          status: "shipped",
          orgId: ORG_ID,
          outboxEventId: "55555555-5555-5555-5555-555555555555",
        },
      },
    ]);
  });

  it("increments attempts and dead-letters exhausted events", async () => {
    const fixedNow = new Date("2026-07-24T11:00:00.000Z");
    const { calls, client } = mockSupabase({
      selectResults: [{ data: [outboxRow()], error: null }],
    });
    const publisher = new OutboxPublisher(
      client,
      {
        send: async () => {
          throw new Error("inngest unavailable");
        },
      },
      { maxAttempts: 1, now: () => fixedNow },
    );

    await expect(publisher.publishPending()).resolves.toEqual({
      published: 0,
      failed: 1,
      deadLettered: 1,
    });
    expect(calls).toContainEqual({
      op: "update",
      table: "outbox_events",
      values: {
        attempts: 1,
        next_attempt_at: new Date(
          fixedNow.getTime() + 2_000,
        ).toISOString(),
      },
    });
    expect(calls).toContainEqual({
      op: "insert",
      table: "job_dead_letters",
      values: expect.objectContaining({
        job_name: "platform.noop",
        error_text: "inngest unavailable",
        attempts: 1,
      }),
    });
  });

  it("sends the outbox row id as the Inngest dedup id so redelivery cannot double-invoke", async () => {
    const { client } = mockSupabase({
      selectResults: [{ data: [outboxRow()], error: null }],
    });
    const sentEvents: Array<{ id: string }> = [];
    const publisher = new OutboxPublisher(client, {
      send: async (event) => {
        sentEvents.push(event);
        return { ids: ["evt_1"] };
      },
    });

    await publisher.publishPending(10);

    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]?.id).toBe(OUTBOX_ID);
  });

  it("does not mislabel a delivered event as failed when markPublished throws", async () => {
    const { calls, client } = mockSupabase({
      selectResults: [{ data: [outboxRow()], error: null }],
      updateResults: [{ data: null, error: { message: "db blip" } }],
    });
    const publisher = new OutboxPublisher(client, {
      send: async () => ({ ids: ["evt_1"] }),
    });

    // The event WAS delivered; a bookkeeping failure must not become a
    // delivery failure.
    await expect(publisher.publishPending(10)).resolves.toEqual({
      published: 1,
      failed: 0,
      deadLettered: 0,
    });

    const attemptBumps = calls.filter(
      (call) =>
        call.op === "update" &&
        call.table === "outbox_events" &&
        Object.prototype.hasOwnProperty.call(
          call.values as object,
          "attempts",
        ),
    );
    expect(attemptBumps).toEqual([]);
    expect(
      calls.some(
        (call) => call.op === "insert" && call.table === "job_dead_letters",
      ),
    ).toBe(false);
  });

  it("writes the dead letter before the attempts bump that would exclude the row", async () => {
    const { calls, client } = mockSupabase({
      selectResults: [{ data: [outboxRow()], error: null }],
    });
    const publisher = new OutboxPublisher(
      client,
      {
        send: async () => {
          throw new Error("inngest unavailable");
        },
      },
      { maxAttempts: 1 },
    );

    await publisher.publishPending();

    const deadLetterIndex = calls.findIndex(
      (call) => call.op === "insert" && call.table === "job_dead_letters",
    );
    const attemptsIndex = calls.findIndex(
      (call) =>
        call.op === "update" &&
        call.table === "outbox_events" &&
        Object.prototype.hasOwnProperty.call(
          call.values as object,
          "attempts",
        ),
    );

    expect(deadLetterIndex).toBeGreaterThanOrEqual(0);
    expect(attemptsIndex).toBeGreaterThanOrEqual(0);
    expect(deadLetterIndex).toBeLessThan(attemptsIndex);
  });

  it("keeps an event retryable instead of excluding it when the dead-letter insert fails", async () => {
    const { calls, client } = mockSupabase({
      selectResults: [{ data: [outboxRow({ attempts: 0 })], error: null }],
      insertResults: [{ data: null, error: { message: "dead letter table down" } }],
    });
    const publisher = new OutboxPublisher(
      client,
      {
        send: async () => {
          throw new Error("inngest unavailable");
        },
      },
      { maxAttempts: 1 },
    );

    await expect(publisher.publishPending()).resolves.toEqual({
      published: 0,
      failed: 1,
      deadLettered: 0,
    });

    // attempts stays below the cap: the row must never be excluded from future
    // scans without a dead-letter artifact existing.
    const attemptBump = calls.find(
      (call) =>
        call.op === "update" &&
        call.table === "outbox_events" &&
        Object.prototype.hasOwnProperty.call(
          call.values as object,
          "attempts",
        ),
    );
    expect((attemptBump?.values as { attempts: number }).attempts).toBe(0);
    expect(
      (attemptBump?.values as { next_attempt_at: string }).next_attempt_at,
    ).toEqual(expect.any(String));
  });

  it("does not re-select a backed-off row until next_attempt_at has passed", async () => {
    const backedOff = outboxRow({
      attempts: 1,
      next_attempt_at: "2026-07-24T11:00:10.000Z",
    });
    const sentBefore: unknown[] = [];
    const beforeWindow = new OutboxPublisher(
      mockScanSupabase([backedOff]),
      {
        send: async (event) => {
          sentBefore.push(event);
          return { ids: ["evt_1"] };
        },
      },
      { now: () => new Date("2026-07-24T11:00:05.000Z") },
    );

    await expect(beforeWindow.publishPending(10)).resolves.toEqual({
      published: 0,
      failed: 0,
      deadLettered: 0,
    });
    expect(sentBefore).toEqual([]);

    const sentAfter: unknown[] = [];
    const afterWindow = new OutboxPublisher(
      mockScanSupabase([backedOff]),
      {
        send: async (event) => {
          sentAfter.push(event);
          return { ids: ["evt_1"] };
        },
      },
      { now: () => new Date("2026-07-24T11:00:11.000Z") },
    );

    await expect(afterWindow.publishPending(10)).resolves.toEqual({
      published: 1,
      failed: 0,
      deadLettered: 0,
    });
    expect(sentAfter).toHaveLength(1);
  });

  it("still selects never-attempted rows, whose next_attempt_at is null", async () => {
    const sent: unknown[] = [];
    const publisher = new OutboxPublisher(
      mockScanSupabase([outboxRow()]),
      {
        send: async (event) => {
          sent.push(event);
          return { ids: ["evt_1"] };
        },
      },
      { now: () => new Date("2026-07-24T11:00:00.000Z") },
    );

    await publisher.publishPending(10);

    expect(sent).toHaveLength(1);
  });

  it("backs off exponentially across consecutive failures", async () => {
    const fixedNow = new Date("2026-07-24T11:00:00.000Z");
    const expectedDelaysMs = [2_000, 8_000, 30_000, 120_000];

    for (const [index, delayMs] of expectedDelaysMs.entries()) {
      const { calls, client } = mockSupabase({
        selectResults: [{ data: [outboxRow({ attempts: index })], error: null }],
      });
      const publisher = new OutboxPublisher(
        client,
        {
          send: async () => {
            throw new Error("inngest unavailable");
          },
        },
        { maxAttempts: 5, now: () => fixedNow },
      );

      await publisher.publishPending();

      expect(calls).toContainEqual({
        op: "update",
        table: "outbox_events",
        values: {
          attempts: index + 1,
          next_attempt_at: new Date(
            fixedNow.getTime() + delayMs,
          ).toISOString(),
        },
      });
    }
  });

  it("publishes on an interval outside test env and clears on destroy", async () => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "development";
    const { client } = mockSupabase({});
    const publisher = new OutboxPublisher(
      client,
      { send: async () => ({ ids: [] }) },
      { publishIntervalMs: 2_000 },
    );
    const publishPending = vi
      .spyOn(publisher, "publishPending")
      .mockResolvedValue({ published: 0, failed: 0, deadLettered: 0 });

    publisher.onModuleInit();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(publishPending).toHaveBeenCalledTimes(1);

    publisher.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(publishPending).toHaveBeenCalledTimes(1);
  });
});
