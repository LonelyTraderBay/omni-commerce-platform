import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiProxyService } from "./ai-proxy.service";

describe("AiProxyService", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "x".repeat(32));
    vi.stubEnv("SERVICE_M2M_KEY", "correct-service-key");
    vi.stubEnv("AI_BASE_URL", "https://ai.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("checks AI health with the service key and traceparent", async () => {
    const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ status: "ok", traceparent }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AiProxyService().checkAiHealth(traceparent)).resolves.toEqual(
      { status: "ok", traceparent },
    );
    expect(fetchMock).toHaveBeenCalledWith("https://ai.example.test/health", {
      headers: {
        "X-Service-Key": "correct-service-key",
        traceparent,
      },
    });
  });
});
