import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiRunsService, type SupabaseLike } from "./ai-runs.service";

/**
 * Regression test for a config drift bug: .env / .env.example shipped
 * AI_MODEL_ALLOWLIST=gemini-2.0-flash (missing "advisor-stub"), while
 * backend/apps/ai's advisor endpoint (backend/apps/ai/app/api/v1/advise.py::_stub_response)
 * unconditionally returns model: "advisor-stub" whenever GEMINI_API_KEY is
 * empty — the expected/default local dev setup (see EMBEDDINGS_ALLOW_STUB
 * comment in the same env file).
 *
 * Because AiRunsService.assertModelAllowed() rejects any model outside the
 * configured allowlist, every /v1/advisor/suggest request in local/dev mode
 * failed with 400 "ai_model_not_allowed" *after* the AI service had already
 * returned a valid stub suggestion — the whole /advisor page was unusable
 * out of the box. render.yaml's deployed config already carried the correct
 * value (gemini-2.0-flash,advisor-stub,gpt-4o-mini), confirming this was drift in the
 * local template rather than an intentional restriction.
 *
 * This test parses the real, tracked .env.example (the template new local
 * setups and CI copy from) and feeds its literal AI_MODEL_ALLOWLIST value
 * through the real AiRunsService — not a hand-picked value — so it fails
 * again if the template ever regresses to omitting "advisor-stub".
 */

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ENV_EXAMPLE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  ".env.example",
);

function readAiModelAllowlistFromEnvExample(): string {
  const contents = readFileSync(ENV_EXAMPLE_PATH, "utf8");
  const match = contents.match(/^AI_MODEL_ALLOWLIST=(.*)$/m);
  if (!match) {
    throw new Error("AI_MODEL_ALLOWLIST not found in .env.example");
  }
  return match[1].trim();
}

function mockSupabase(): SupabaseLike {
  return {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          return {
            select() {
              return {
                single: async () => ({
                  data: {
                    id: "44444444-4444-4444-4444-444444444444",
                    ...row,
                    created_at: "2026-07-28T00:00:00.000Z",
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
}

describe("AI_MODEL_ALLOWLIST local dev template (regression: advisor stub was rejected)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(".env.example allows the literal model name the local/stub AI advisor returns", async () => {
    const allowlist = readAiModelAllowlistFromEnvExample();
    vi.stubEnv("AI_MODEL_ALLOWLIST", allowlist);

    expect(allowlist.split(",")).toContain("gpt-4o-mini");

    const service = new AiRunsService(mockSupabase());

    await expect(
      service.writeRun({
        orgId: ORG_ID,
        promptVersion: "advisor.v1",
        model: "advisor-stub",
        status: "succeeded",
        tools: [],
        citations: [],
      }),
    ).resolves.toMatchObject({ aiRun: { model: "advisor-stub" } });
  });
});
