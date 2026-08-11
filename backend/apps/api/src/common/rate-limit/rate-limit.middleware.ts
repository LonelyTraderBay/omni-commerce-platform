import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import {
  defaultRateLimiter,
  type InMemoryRateLimiter,
} from "./in-memory-rate-limit";
import { loadRateLimitConfig } from "./rate-limit-config";
import {
  buildAuthRateLimitKey,
  buildWebhookRateLimitKey,
} from "./rate-limit-keys";
import { getRequestPath, isAuthishPath, isWebhookPath } from "./rate-limit-paths";

type NextFunction = () => void;

type RateLimitRequest = IncomingMessage & {
  headers: IncomingHttpHeaders;
  originalUrl?: string;
  requestId?: string;
  socket?: { remoteAddress?: string };
  url?: string;
};

type RateLimitResponse = ServerResponse & {
  statusCode?: number;
  json?: (body: unknown) => void;
};

function getHeader(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function sendRateLimitResponse(
  req: RateLimitRequest,
  res: RateLimitResponse,
  retryAfterSeconds: number,
  scope: "auth" | "webhook",
) {
  const path = getRequestPath(req.originalUrl, req.url);
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.statusCode = 429;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      detail:
        scope === "auth"
          ? "Too many requests on authentication-related endpoints"
          : "Too many webhook requests",
      instance: path,
      requestId: req.requestId ?? getHeader(req.headers, "x-request-id") ?? "",
      code: "rate_limit_exceeded",
    }),
  );
}

export function createRateLimitMiddleware(
  limiter: InMemoryRateLimiter = defaultRateLimiter,
) {
  return (req: RateLimitRequest, res: RateLimitResponse, next: NextFunction) => {
    const config = loadRateLimitConfig();
    if (!config.enabled) {
      next();
      return;
    }

    const path = getRequestPath(req.originalUrl, req.url);
    let scope: "auth" | "webhook" | null = null;
    if (isWebhookPath(path)) {
      scope = "webhook";
    } else if (isAuthishPath(path)) {
      scope = "auth";
    }

    if (!scope) {
      next();
      return;
    }

    const bucket = config[scope];
    const key =
      scope === "webhook"
        ? buildWebhookRateLimitKey(req.headers, req.socket?.remoteAddress)
        : buildAuthRateLimitKey(req.headers, req.socket?.remoteAddress);
    const result = limiter.consume(key, bucket.max, bucket.windowMs);

    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      sendRateLimitResponse(req, res, result.retryAfterSeconds, scope);
      return;
    }

    next();
  };
}

export const rateLimitMiddleware = createRateLimitMiddleware();
