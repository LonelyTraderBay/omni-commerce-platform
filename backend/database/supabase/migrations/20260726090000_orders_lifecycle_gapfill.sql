-- Plan D Task 1: orders lifecycle gap-fill + HTTP idempotency persistence.
--
-- Already present from Plan C (20260725210000_ai_tools_draft_orders.sql):
--   public.orders — full §8.7 columns (status/payment checks, bigint VND, confirmed_at,
--     shipped_at, partial unique on (org_id, idempotency_key)); RLS select for org members;
--     writes revoked from authenticated (service_role + create_draft_order RPC only).
--   public.order_items — full §8.7 columns; matching RLS harden.
--   public.create_draft_order(...) — security definer RPC for AI draft creation.
--
-- This migration does NOT drop or recreate those objects.

-- Optional lifecycle timestamps (beyond §8.7 confirmed_at / shipped_at).
alter table public.orders
  add column if not exists cancelled_at timestamptz,
  add column if not exists done_at timestamptz;

-- List/filter orders by status within an org (lifecycle UI + export).
create index if not exists orders_org_id_status_created_at_idx
  on public.orders (org_id, status, created_at desc);

-- HTTP Idempotency-Key middleware persistence (Core service_role only).
create table public.idempotency_keys (
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  method text not null,
  path text not null,
  status_code int not null,
  response_json jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint idempotency_keys_pkey primary key (org_id, key),
  constraint idempotency_keys_method_check
    check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  constraint idempotency_keys_status_code_check
    check (status_code between 100 and 599)
);

create index idempotency_keys_expires_at_idx
  on public.idempotency_keys (expires_at)
  where expires_at is not null;

alter table public.idempotency_keys enable row level security;

revoke all on table public.idempotency_keys
from anon, authenticated;

grant all on table public.idempotency_keys
to service_role;
