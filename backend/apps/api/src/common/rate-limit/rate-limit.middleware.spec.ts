import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryRateLimiter } from "./in-memory-rate-limit";
import { createRateLimitMiddleware } from "./rate-limit.middleware";

type MockResponse = {
  ended: boolean;
  headers: Record<string, string | number>;
  statusCode?: number;
  body?: unknown;
  setHeader(name: string, value: string | number): void;
  end(body?: string): void;
};

function createMockResponse(): MockResponse {
  const response: MockResponse = {
    ended: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.ended = true;
      if (body) {
        this.body = JSON.parse(body);
      }
    },
  };
  return response;
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

describe("rateLimitMiddleware", () => {
  beforeEach(() => {
    stubRequiredEnv();
    vi.stubEnv("RATE_LIMIT_AUTH_MAX", "1");
    vi.stubEnv("RATE_LIMIT_WEBHOOK_MAX", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 429 with rate_limit_exceeded on auth-ish paths", () => {
    const limiter = new InMemoryRateLimiter();
    const middleware = createRateLimitMiddleware(limiter);
    const next = vi.fn();

    const req = {
      headers: {
        authorization: "Bearer token-a",
        "x-forwarded-for": "203.0.113.10",
      },
      originalUrl: "/v1/orgs",
      requestId: "req-auth-1",
    };
    const res = createMockResponse();

    middleware(req, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);

    middleware(req, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      code: "rate_limit_exceeded",
      status: 429,
    });
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("returns 429 with rate_limit_exceeded on webhook paths", () => {
    const limiter = new InMemoryRateLimiter();
    const middleware = createRateLimitMiddleware(limiter);
    const next = vi.fn();

    const req = {
      headers: { "x-forwarded-for": "198.51.100.4" },
      originalUrl: "/v1/webhooks/meta",
      requestId: "req-webhook-1",
    };
    const res = createMockResponse();

    middleware(req, res as never, next);
    middleware(req, res as never, next);

    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      code: "rate_limit_exceeded",
      detail: "Too many webhook requests",
    });
  });

  it("skips non-protected paths", () => {
    const limiter = new InMemoryRateLimiter();
    const middleware = createRateLimitMiddleware(limiter);
    const next = vi.fn();

    const req = {
      headers: {},
      originalUrl: "/v1/orders",
    };
    const res = createMockResponse();

    middleware(req, res as never, next);
    middleware(req, res as never, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.ended).toBe(false);
  });
});
