import { describe, expect, it } from "vitest";

import { InMemoryRateLimiter } from "./in-memory-rate-limit";

describe("InMemoryRateLimiter", () => {
  it("allows requests until the window max is reached", () => {
    const limiter = new InMemoryRateLimiter();
    const now = 1_700_000_000_000;

    expect(limiter.consume("key", 2, 60_000, now)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(limiter.consume("key", 2, 60_000, now + 1)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.consume("key", 2, 60_000, now + 2)).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });
  });

  it("resets the bucket after the window expires", () => {
    const limiter = new InMemoryRateLimiter();
    const now = 1_700_000_000_000;

    limiter.consume("key", 1, 1_000, now);
    expect(limiter.consume("key", 1, 1_000, now + 500)).toMatchObject({
      allowed: false,
    });
    expect(limiter.consume("key", 1, 1_000, now + 1_000)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });
});
