import { loadEnv, type Env } from "../../config/env";

export type RateLimitBucketConfig = {
  max: number;
  windowMs: number;
};

export type RateLimitConfig = {
  enabled: boolean;
  auth: RateLimitBucketConfig;
  webhook: RateLimitBucketConfig;
  tools: RateLimitBucketConfig;
};

export function loadRateLimitConfig(env: Env = loadEnv()): RateLimitConfig {
  return {
    enabled: env.RATE_LIMIT_ENABLED,
    auth: {
      max: env.RATE_LIMIT_AUTH_MAX,
      windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
    },
    webhook: {
      max: env.RATE_LIMIT_WEBHOOK_MAX,
      windowMs: env.RATE_LIMIT_WEBHOOK_WINDOW_MS,
    },
    tools: {
      max: env.RATE_LIMIT_TOOLS_MAX,
      windowMs: env.RATE_LIMIT_TOOLS_WINDOW_MS,
    },
  };
}
