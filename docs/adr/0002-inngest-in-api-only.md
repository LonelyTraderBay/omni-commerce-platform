# ADR 0002: Inngest integration lives in the API only

## Status

Accepted

## Context

Background orchestration is needed for durable jobs and event handling. The platform also has web and AI services, but allowing each service to publish or host Inngest functions would spread secrets, retries, and operational ownership across multiple runtimes.

## Decision

Inngest SDK usage, event publication, signing keys, and function routes live only in `backend/apps/api`.

Other services must call the API when they need work queued or events published. The web app must not call Inngest directly. The AI service must not host Inngest functions or own Inngest credentials.

## Consequences

- `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are API runtime secrets.
- Job authorization, idempotency, audit logging, and outbox publishing remain in the core API boundary.
- AI work that needs orchestration is requested through API endpoints or internal service calls.
- Adding Inngest to another app requires a new ADR.
