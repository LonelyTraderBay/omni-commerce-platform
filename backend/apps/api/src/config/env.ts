import { z } from 'zod';

export const DEFAULT_AI_DRAFT_MAX_AMOUNT_VND = 5_000_000;

export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().default(4701),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  SERVICE_M2M_KEY: z.string().min(16),
  AI_BASE_URL: z.string().url().default('http://127.0.0.1:4702'),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:4700'),
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  PLATFORM_ADMIN_EMAILS: z.string().default(''),
  AI_MODEL_ALLOWLIST: z.string().default('gemini-2.0-flash,advisor-stub'),
  DEFAULT_AI_DRAFT_MAX_AMOUNT_VND: z.coerce
    .number()
    .int()
    .nonnegative()
    .safe()
    .default(DEFAULT_AI_DRAFT_MAX_AMOUNT_VND),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(8),
  META_REDIRECT_URI: z.string().url(),
  META_GRAPH_VERSION: z.string().default('v21.0'),
  META_INTEGRATION_MODE: z.enum(['live', 'stub']).default('live'),
  ZALO_WEBHOOK_SECRET: z.string().optional(),
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_WEBHOOK_MAX: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_WEBHOOK_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  RATE_LIMIT_TOOLS_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_TOOLS_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(raw);
}
