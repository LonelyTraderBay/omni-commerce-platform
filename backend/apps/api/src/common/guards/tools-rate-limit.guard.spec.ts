import type { ExecutionContext } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolsRateLimitGuard } from "./tools-rate-limit.guard";
import { InMemoryRateLimiter } from "../rate-limit/in-memory-rate-limit";

function mockContext(request: {
  body?: unknown;
  originalUrl?: string;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

function stubRequiredEnv() {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", "x".repeat(32));
  vi.stubEnv("SERVICE_M2M_KEY", "service-key-123456");
  vi.stubEnv("META_APP_ID", "meta-app-id");
  vi.stubEnv("META_APP_SECRET", "meta-app-secret");
  vi.stubEnv("META_VERIFY_TOKEN", "verify-token");
  vi.stubEnv("META_REDIRECT_URI", "http://127.0.0.1:3000/settings/channels/callback");
}

describe("ToolsRateLimitGuard", () => {
  beforeEach(() => {
    stubRequiredEnv();
    vi.stubEnv("RATE_LIMIT_TOOLS_MAX", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 429 when org tool quota is exceeded", () => {
    const limiter = new InMemoryRateLimiter();
    const guard = new ToolsRateLimitGuard(limiter);
    const orgId = "11111111-1111-4111-8111-111111111111";
    const request = {
      originalUrl: "/internal/v1/tools/get-product",
      body: { orgId, productId: "22222222-2222-4222-8222-222222222222" },
    };

    expect(guard.canActivate(mockContext(request))).toBe(true);
    expect(() => guard.canActivate(mockContext(request))).toThrowError(
      expect.objectContaining({
        status: 429,
        response: expect.objectContaining({
          code: "rate_limit_exceeded",
        }),
      }),
    );
  });

  it("tracks limits per org id", () => {
    const limiter = new InMemoryRateLimiter();
    const guard = new ToolsRateLimitGuard(limiter);

    expect(
      guard.canActivate(
        mockContext({
          originalUrl: "/internal/v1/tools/get-product",
          body: {
            orgId: "11111111-1111-4111-8111-111111111111",
            productId: "22222222-2222-4222-8222-222222222222",
          },
        }),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        mockContext({
          originalUrl: "/internal/v1/tools/get-product",
          body: {
            orgId: "33333333-3333-4333-8333-333333333333",
            productId: "22222222-2222-4222-8222-222222222222",
          },
        }),
      ),
    ).toBe(true);
  });
});
