# ADR 0001: Host web, API, and AI on Render

## Status

Accepted

## Context

The platform needs one default hosting vendor for the web app, core API, and AI service so deployment, secrets, logs, and runbooks stay simple while the product foundation is still small.

## Decision

Render is the single approved hosting vendor for:

- `frontend/apps/web`
- `backend/apps/api`
- `backend/apps/ai`

Render may be used on free or paid plans. Production, staging, preview, and smoke-test documentation should assume Render unless a later ADR replaces this decision.

Fly.io is fallback only. Moving any app to Fly.io requires a new ADR that explains the reason, scope, rollback path, and operational owner.

## Consequences

- One vendor dashboard owns runtime config for web, API, and AI.
- Secrets and health checks are documented once for Render services.
- Vendor-specific scripts should not add support for additional hosts without a new ADR.
- Supabase remains the database/Auth provider and is not changed by this hosting decision.
