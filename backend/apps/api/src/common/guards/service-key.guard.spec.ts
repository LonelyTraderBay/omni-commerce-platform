import type { ExecutionContext } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceKeyGuard } from "./service-key.guard";

type MockRequest = {
  headers: Record<string, string | string[] | undefined>;
};

function mockContext(request: MockRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

describe("ServiceKeyGuard", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "x".repeat(32));
    vi.stubEnv("SERVICE_M2M_KEY", "correct-service-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a bad service key", async () => {
    const guard = new ServiceKeyGuard();

    await expect(
      guard.canActivate(
        mockContext({
          headers: { "x-service-key": "wrong-service-key" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
