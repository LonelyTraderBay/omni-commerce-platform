export type RateLimitConsumeResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

type BucketState = {
  count: number;
  resetAt: number;
};

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  consume(
    key: string,
    max: number,
    windowMs: number,
    now = Date.now(),
  ): RateLimitConsumeResult {
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return {
        allowed: true,
        limit: max,
        remaining: Math.max(0, max - 1),
        retryAfterSeconds: 0,
      };
    }

    if (bucket.count >= max) {
      return {
        allowed: false,
        limit: max,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      limit: max,
      remaining: Math.max(0, max - bucket.count),
      retryAfterSeconds: 0,
    };
  }

  reset() {
    this.buckets.clear();
  }
}

export const defaultRateLimiter = new InMemoryRateLimiter();
