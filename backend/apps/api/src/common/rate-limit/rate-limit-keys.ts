import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

function getHeader(headers: IncomingHttpHeaders, name: string) {
  const direct = headers[name.toLowerCase()];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct[0] : direct;
  }

  const header = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(header) ? header[0] : header;
}

export function getClientIp(headers: IncomingHttpHeaders, remoteAddress?: string) {
  const forwarded = getHeader(headers, "x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  if (forwarded) {
    return forwarded;
  }

  const realIp = getHeader(headers, "x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }

  return remoteAddress?.trim() || "unknown";
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildAuthRateLimitKey(
  headers: IncomingHttpHeaders,
  remoteAddress?: string,
) {
  const ip = getClientIp(headers, remoteAddress);
  const authorization = getHeader(headers, "authorization")?.trim() ?? "";
  const actor = authorization ? fingerprint(authorization) : "anon";
  return `auth:${ip}:${actor}`;
}

export function buildWebhookRateLimitKey(
  headers: IncomingHttpHeaders,
  remoteAddress?: string,
) {
  return `webhook:${getClientIp(headers, remoteAddress)}`;
}

export function buildToolsRateLimitKey(orgId: string, path: string) {
  return `tools:${orgId}:${path}`;
}
