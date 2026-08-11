# @omni/api-client — **DEPRECATED / STUB**

> **Source of truth for the web HTTP client is not this package.**
>
> Use **`frontend/apps/web/src/lib/api-client.ts`** (hand-written fetch wrappers used by Next.js).

## Status

| Claim | Reality |
|-------|---------|
| “Generated from OpenAPI” | **False today.** This folder is a **stub** — README only; no generated sources, no `package.json`, not in the pnpm workspace. |
| Codegen deferred | **Cancelled as a Gate A requirement.** OpenAPI remains the **contract SoT** at `backend/packages/contracts/openapi.yaml`; a future codegen wave may recreate this package, but web must not wait on it. |
| Invite / accept drift | **None for L2 paths.** `GET/POST /v1/orgs/{orgId}/invites` and `POST /v1/invites/accept` are already in OpenAPI (Wave L2). Web calls them via `frontend/apps/web/src/lib/api-client.ts`. |

## What to use

1. **Contract:** `backend/packages/contracts/openapi.yaml`
2. **Runtime client (web):** `frontend/apps/web/src/lib/api-client.ts`
3. **Do not import** `@omni/api-client` — it is not a published workspace package.

## Optional future work (not Gate A)

If eng wants generated types later: add codegen from OpenAPI into this package (or a new one), then migrate web imports. Until then, keep this README as the honest deprecation notice.
