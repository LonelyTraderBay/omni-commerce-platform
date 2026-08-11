import type { Env } from "./env";

/**
 * The web app (:4700) calls the API (:4701) cross-origin for its entire
 * login/dashboard/catalog/orders flow. Without this, the browser blocks
 * every request at the CORS preflight (OPTIONS -> 404 -> ERR_FAILED) even
 * though direct `fetch`/curl calls (and Node-based test suites) work fine —
 * see backend/apps/api/src/config/cors.integration.spec.ts for the regression test.
 */
export function buildCorsOptions(env: Pick<Env, "WEB_ORIGIN">) {
  return {
    origin: env.WEB_ORIGIN,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Org-Id", "Idempotency-Key"],
  };
}
