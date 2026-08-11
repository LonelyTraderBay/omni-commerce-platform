# P0.5 — Apply migrations on staging

## Order

All files under `backend/database/supabase/migrations/` apply in filename order. After Plan D, critical ones include:

- `20260725*` meta / catalog / AI / draft orders  
- `20260726*` orders lifecycle / RPCs  

## Commands (local / CI-like)

```bash
# Link staging project (once)
npx supabase link --project-ref <STAGING_PROJECT_REF> --workdir backend/database

# Dry review
npx supabase db push --workdir backend/database --dry-run

# Apply
npx supabase db reset --workdir backend/database   # destructive, staging only — OR
npx supabase db push --workdir backend/database    # forward migrations
```

## Verify

```sql
select tablename from pg_tables where schemaname = 'public'
  and tablename in ('orders','order_items','idempotency_keys','knowledge_chunks','ai_runs');
```

## Status log

| Date | Operator | Command | Result |
|------|----------|---------|--------|
| 2026-07-25 | agent | GitHub **Migrate Check** (`supabase start` + `db reset` on CI) | **GREEN** — SQL migrations apply cleanly in CI |
| 2026-07-25 | agent | Remote staging `db push` → `lrcsbrmqlyvkxxspbezi` (`Phan_mem_ban_hang_online-staging`) | **GREEN** — repaired orphan remote history then pushed 26 local migrations; verified `public.organizations/orders/stock_movements/warehouses` |
| 2026-07-25 | agent | Note | Staging still has legacy schema `app.*` from prior product (left intact; new app uses `public.*`) |
| 2026-07-25 | agent | Remote staging `db push` → `tjsmpcgkeoglemptuymu` (`omni-commerce-staging`) | **GREEN** — pushed `20260727210000_ensure_default_warehouse_on_org.sql` (27 total); `migration list` local=remote for all 27 |
| 2026-07-25 | agent | Remote staging `db push` → `tjsmpcgkeoglemptuymu` (`omni-commerce-staging`) | **GREEN** — pushed `20260727220000_inbox_resume_rpc.sql` (28 total); `migration list` local=remote 28/28; verified `public.resume_inbox_conversation` RPC (SDD E2 Task 2) |
| 2026-07-25 | agent | Remote staging `db push` → `tjsmpcgkeoglemptuymu` (`omni-commerce-staging`) | **GREEN** — pushed `20260727230000_einvoice_http_sandbox_provider.sql` (29 total); `migration list` local=remote 29/29 (SDD E2 Task 5) |
