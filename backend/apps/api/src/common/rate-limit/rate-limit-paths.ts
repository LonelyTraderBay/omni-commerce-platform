const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getRequestPath(originalUrl?: string, url?: string) {
  return (originalUrl ?? url ?? "").split("?")[0];
}

export function isAuthishPath(path: string) {
  if (path === "/v1/orgs" || path.startsWith("/v1/orgs/")) {
    return true;
  }

  return (
    path === "/v1/channels/meta/oauth-url" ||
    path === "/v1/channels/meta/complete"
  );
}

export function isWebhookPath(path: string) {
  return (
    path === "/v1/webhooks/meta" ||
    path.startsWith("/v1/webhooks/meta/") ||
    path === "/v1/channels/zalo/webhook" ||
    path.startsWith("/v1/channels/zalo/webhook/")
  );
}

export function isToolsPath(path: string) {
  return path === "/internal/v1/tools" || path.startsWith("/internal/v1/tools/");
}

export function extractOrgIdFromBody(body: unknown) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const orgId = (body as Record<string, unknown>).orgId;
  if (typeof orgId !== "string" || !UUID_PATTERN.test(orgId)) {
    return undefined;
  }

  return orgId;
}
