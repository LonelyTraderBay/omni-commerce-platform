-- Wave P0.5b — money-correctness fixes.
--
-- Problem: P&L (`PnlService.loadSoldOrders`) and the accounting export
-- (`AccountingService.loadOrders`) both fetched `.limit(10_000)` with **no date
-- predicate** and then filtered `coalesce(done_at, shipped_at, created_at)` in
-- Node. Past 10k sold orders an org silently received a truncated — not empty —
-- financial report, with no signal that numbers were wrong.
--
-- Fix: materialise the revenue-recognition timestamp as a generated column so
-- the date range can be pushed into SQL and indexed. The expression only
-- references immutable column values, so `generated always as … stored` is
-- valid and is recomputed automatically on every update of the source columns.

alter table public.orders
  add column if not exists sold_at timestamptz
  generated always as (coalesce(done_at, shipped_at, created_at)) stored;

comment on column public.orders.sold_at is
  'Generated: coalesce(done_at, shipped_at, created_at). Revenue-recognition timestamp; the only column P&L and accounting exports may filter/bucket on.';

-- Reporting reads are always org-scoped and status-scoped, newest first.
create index if not exists orders_org_status_sold_at_idx
  on public.orders (org_id, status, sold_at desc);
