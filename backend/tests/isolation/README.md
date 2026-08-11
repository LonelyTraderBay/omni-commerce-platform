# Isolation tests

## Suites

| File | What it proves |
|------|----------------|
| `cross-tenant.org.spec.ts` | Nest `OrgGuard` — API cannot use another tenant's `X-Org-Id` before writes |
| `cross-tenant.channels.spec.ts` | Channels + inbox routes respect the same org membership gate |
| `cross-tenant.rls.spec.ts` | **(A4)** Migration proof (always-on) + Docker Supabase Data API: user A cannot UPDATE org B `memberships` / `entitlements` / `feature_flags`, and cannot SELECT org B memberships |
| `cross-tenant.control-writes.spec.ts` | Migration proof (always-on) + Docker Supabase Data API: an authenticated member cannot INSERT `api_keys` / `outbound_webhooks` / `content_calendar_items` (writes go through `service_role` only), but can still SELECT its own org rows |

## Prerequisites for RLS E2E

Local Docker Supabase with migrations applied:

```powershell
supabase start --workdir backend/database
supabase db reset --workdir backend/database   # if needed
pnpm test:isolation
```

Env (optional — defaults to local demo keys on `http://127.0.0.1:54721`, see `infra/config/local-ports.json`):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

CI (`ci-isolation.yml`) starts Supabase the same way as `migrate-check.yml`.

## Run

```powershell
pnpm test:isolation
```

Expect **0 skipped** when local/CI Supabase is up.
