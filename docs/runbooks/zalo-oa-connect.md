# Zalo OA connect runbook

## Scope

Wave 2F + E1 ship a working Zalo OA inbound path for inbox multi-channel readiness:

- `POST /v1/channels/zalo/connect` stores an existing OA access token encrypted in `channel_connections` (token-paste connect; not full OAuth yet).
- `POST /v1/channels/zalo/webhook` verifies an optional shared secret, records `webhook_receipts`, and atomically enqueues `zalo/inbound.received`.
- Outbox publisher maps `zalo/inbound.received` → Inngest `zalo/inbound/received`.
- Worker `zalo-persist-inbound` (`backend/apps/api/src/jobs/functions/zalo-persist-inbound.ts`) persists contacts, conversations, and inbound messages for mapped OAs.

Status:

- **Inbound persistence:** GREEN (worker shipped).
- **Connect UX:** AMBER until full Zalo OAuth replaces token paste.
- **Production hardening:** AMBER until live OA credentials + webhook secret are verified in the target environment.

## Connect an OA

1. In Web, open **Cài đặt -> Kênh**.
2. Fill **Kết nối Zalo OA**:
   - `OA ID`
   - optional display name
   - existing Zalo OA access token
3. Submit. The list should show provider `Zalo OA`.

The token is encrypted with `TOKEN_ENCRYPTION_KEY` and is never returned by API DTOs.

Full OAuth (authorize URL → callback → refresh) is the remaining gap; operators currently paste an existing OA access token.

## Webhook setup

API endpoint:

```text
POST https://<api-host>/v1/channels/zalo/webhook
```

Optional hardening:

```text
ZALO_WEBHOOK_SECRET=<shared-secret>
```

When configured, Zalo webhook calls must include:

```text
x-zalo-webhook-secret: <shared-secret>
```

Ensure Inngest is reachable locally (`pnpm dev:local` starts the Inngest dev server and registers `/api/inngest`) so `zalo-persist-inbound` can run after webhook intake.

## Verify intake

1. Confirm the OA connection exists:

```sql
select org_id, provider, external_page_id, status, updated_at
from public.channel_connections
where provider = 'zalo_oa';
```

2. Confirm webhook receipts:

```sql
select id, provider, receipt_key, org_id, payload_hash, received_at
from public.webhook_receipts
where provider = 'zalo'
order by received_at desc
limit 20;
```

3. Confirm outbox events for mapped OAs:

```sql
select id, org_id, event_name, payload_json, published_at, attempts, created_at
from public.outbox_events
where event_name = 'zalo/inbound.received'
order by created_at desc
limit 20;
```

4. Confirm persisted inbox rows after the worker runs:

```sql
select id, org_id, channel, contact_id, last_message_at, updated_at
from public.conversations
where channel = 'zalo'
order by updated_at desc
limit 20;
```

If `org_id` is null on the receipt, the inbound OA ID did not match an active `zalo_oa` connection.
