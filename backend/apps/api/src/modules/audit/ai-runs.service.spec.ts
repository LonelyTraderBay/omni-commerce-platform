import { BadRequestException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiRunsService, type SupabaseLike } from "./ai-runs.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "33333333-3333-3333-3333-333333333333";

type SupabaseCall = {
  op: string;
  table?: string;
  row?: unknown;
  values?: string;
};

function mockSupabase() {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          calls.push({ op: "insert", table, row });
          return {
            select(values: string) {
              calls.push({ op: "select", table, values });
              return {
                single: async () => ({
                  data: {
                    id: "44444444-4444-4444-4444-444444444444",
                    ...row,
                    created_at: "2026-07-24T00:00:00.000Z",
                  },
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

describe("AiRunsService", () => {
  beforeEach(() => {
    vi.stubEnv("AI_MODEL_ALLOWLIST", "gemini-2.0-flash,gemini-2.5-flash");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes ai_runs with prompt version, model, tokens, tools, citations, and status", async () => {
    const { calls, client } = mockSupabase();
    const service = new AiRunsService(client);

    await expect(
      service.writeRun({
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        promptVersion: "c5-grounded-sales-v1",
        model: "gemini-2.0-flash",
        tokens: { prompt: 12, completion: 7, total: 19 },
        tools: [{ name: "get-product" }],
        citations: [{ sourceId: "55555555-5555-5555-5555-555555555555" }],
        status: "succeeded",
      }),
    ).resolves.toEqual({
      aiRun: {
        id: "44444444-4444-4444-4444-444444444444",
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        promptVersion: "c5-grounded-sales-v1",
        model: "gemini-2.0-flash",
        inputTokens: 12,
        outputTokens: 7,
        tools: [{ name: "get-product" }],
        citations: [{ sourceId: "55555555-5555-5555-5555-555555555555" }],
        status: "succeeded",
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    });

    expect(calls).toContainEqual({
      op: "insert",
      table: "ai_runs",
      row: {
        org_id: ORG_ID,
        conversation_id: CONVERSATION_ID,
        message_id: MESSAGE_ID,
        prompt_version: "c5-grounded-sales-v1",
        model: "gemini-2.0-flash",
        input_tokens: 12,
        output_tokens: 7,
        tools_json: [{ name: "get-product" }],
        citations_json: [{ sourceId: "55555555-5555-5555-5555-555555555555" }],
        status: "succeeded",
      },
    });
  });

  it("rejects models outside AI_MODEL_ALLOWLIST", async () => {
    const { calls, client } = mockSupabase();
    const service = new AiRunsService(client);

    await expect(
      service.writeRun({
        orgId: ORG_ID,
        promptVersion: "c5-grounded-sales-v1",
        model: "not-allowed",
        status: "failed",
        tools: [],
        citations: [],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(calls).toEqual([]);
  });
});
