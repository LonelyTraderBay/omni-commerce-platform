-- Fix: public.receive_po() silently dropped one of two purchase_order_items
-- lines (and mis-attributed COGS) whenever a purchase order carried more
-- than one line for the same variant_id, then masked the data loss behind a
-- misleading 'purchase order receive mismatch' exception.
--
-- Nothing prevents duplicate-variant lines on one PO: SupplierPoService
-- .createPurchaseOrder (apps/api/src/modules/supplier-po/supplier-po.service.ts)
-- inserts body.items verbatim with no dedup/validation on variant_id, and
-- purchase_order_items (20260727200000_supplier_po_einvoice.sql) has no
-- unique constraint on (org_id, purchase_order_id, variant_id). A supplier
-- invoice legitimately listing the same SKU twice at two different unit
-- costs, or a simple operator/UI double-entry, both produce exactly this
-- shape, and receive_po must handle it correctly rather than reject it.
--
-- Root cause (confirmed empirically against local Postgres 17.6, not
-- guessed): the `received` and `totals` CTEs in
-- 20260728030000_fix_receive_po_stock_total.sql each join
-- variant_stocks / product_variants (one row per variant) directly against
-- the RAW purchase_order_items rows for the PO. Per Postgres's documented
-- UPDATE ... FROM semantics: "If a row of the target table joins to more
-- than one row of the from_list, only one of the join rows will be used to
-- update the target row, but which one will be used is not readily
-- predictable." With two purchase_order_items rows for the same variant,
-- each of those UPDATEs therefore applies only ONE of the two lines and
-- silently discards the other's qty/cost contribution entirely — this is
-- not a hypothetical: reproduced with two lines (qty 5 @ 4000 VND, qty 3 @
-- 7000 VND) for one variant, the `received` CTE's own RETURNING showed
-- exactly one row (qty=5, i.e. the qty=3 line vanished) and variant_stocks
-- was left at 5, not 8. `totals` picked cogs_vnd = 4000 (the same line, in
-- this run, but the two UPDATEs resolve their arbitrary pick independently,
-- so there was never a guarantee the two would even agree with each other).
--
-- v_required_count (raw `count(*)` of purchase_order_items rows = 2) then
-- caught the discrepancy against v_movement_count (the `logged` CTE only
-- produced 1 stock_movements row, because it joins the equally-collapsed
-- `received`/`totals` outputs) and raised 'purchase order receive mismatch',
-- rolling back the whole call. So today the exception genuinely does fire
-- exactly as suspected — but it is an accidental safety net over a deeper
-- silent-data-loss bug, not the real defect. A naive fix that only changed
-- the count comparison (e.g. to `count(distinct variant_id)`) without also
-- fixing the joins would remove the safety net and let the qty/COGS loss
-- through with no error at all. Confirmed with `npx supabase db reset` +
-- direct psql against the real local instance; see
-- receive-po.integration.spec.ts for the automated version of this repro.
--
-- Fix: pre-aggregate purchase_order_items by variant_id (sum(qty), and a
-- qty-weighted average of unit_cost_vnd rounded to the nearest VND — VND has
-- no subunit) in a new `poi_agg` CTE *before* joining to variant_stocks /
-- product_variants. Because poi_agg is grouped by variant_id it has at most
-- one row per variant, so every downstream join is guaranteed 1:1 and the
-- "arbitrary pick" hazard above cannot occur regardless of how many raw
-- lines a variant has. For a variant with only one line (the overwhelming
-- common case, and the only case the 2026-07-28 multi-warehouse regression
-- test exercises), the weighted average reduces to that line's exact
-- unit_cost_vnd, so this is fully backward compatible — re-verified the
-- 2026-07-28 test's own scenario against this fix (stock_qty 20, MAIN 17,
-- AUX 3 untouched, cogs_vnd unchanged at 5000) before writing this migration.
--
-- Movement granularity: exactly one stock_movements row per DISTINCT variant
-- actually received, not one per raw purchase_order_items line. Chosen
-- because variant_stocks/product_variants are each physically updated
-- exactly once per variant per receive_po call (a single delta) — one
-- ledger row per variant matches the one real state transition being
-- recorded, and `stock_after` is a snapshot that can only truthfully hold
-- one value per variant per call. Reproducing per-line granularity instead
-- would need an arbitrary ordering to assign two different `stock_after`
-- values to the same variant within one statement (raw PO lines have no
-- natural sequencing), forcing a row-by-row procedural rewrite in place of
-- this function's existing set-based CTE style. Per-line cost detail is not
-- lost: purchase_order_items itself (unaffected by this migration) still
-- holds each original line's own qty/unit_cost_vnd for audit purposes; the
-- stock ledger's job is to record physical stock deltas, not source-document
-- line detail.
--
-- v_movement_count's reconciliation invariant is redefined to match this
-- granularity: v_required_count now counts DISTINCT variant_id rather than
-- raw rows, so it equals the number of stock_movements rows this function is
-- now designed to produce, and no longer spuriously fires for a
-- legitimately-duplicated-variant PO.
--
-- The body below is otherwise reproduced verbatim from
-- 20260728030000_fix_receive_po_stock_total.sql: signature, language,
-- security definer, search_path and the revoke/grant pair are unchanged (the
-- revoke/grant are re-emitted verbatim per the established convention in
-- this migrations directory, e.g. 20260729040000, so the function's
-- privileges stay explicit in whichever migration last defined it — this
-- is a no-op since `create or replace` preserves them either way). The
-- `perform ... for update` lock-ordering statement is also left verbatim:
-- it already tolerates duplicate-variant lines correctly (it re-locks the
-- same variant_stocks row harmlessly when a variant has more than one PO
-- line), confirmed empirically alongside the rest of this investigation.

create or replace function public.receive_po(
  p_org_id uuid,
  p_purchase_order_id uuid,
  p_warehouse_id uuid,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchase_orders%rowtype;
  v_warehouse public.warehouses%rowtype;
  v_required_count int;
  v_movement_count int;
  v_at timestamptz := now();
begin
  select *
  into v_po
  from public.purchase_orders
  where org_id = p_org_id
    and id = p_purchase_order_id
  for update;

  if not found then
    raise exception 'purchase order not found'
      using errcode = 'P0001', hint = 'purchase_order_not_found';
  end if;

  if v_po.status = 'received' then
    return jsonb_build_object(
      'purchaseOrderId', v_po.id,
      'status', v_po.status,
      'receivedAt', v_po.received_at,
      'movements', jsonb_build_array()
    );
  end if;

  if v_po.status not in ('draft', 'ordered') then
    raise exception 'purchase order cannot be received from status %', v_po.status
      using errcode = 'P0001', hint = 'invalid_purchase_order_status';
  end if;

  select *
  into v_warehouse
  from public.warehouses
  where org_id = p_org_id
    and id = p_warehouse_id
  for update;

  if not found then
    raise exception 'warehouse not found'
      using errcode = 'P0001', hint = 'warehouse_not_found';
  end if;

  -- Counts DISTINCT variants, not raw purchase_order_items rows: a PO may
  -- legitimately carry two or more lines for the same variant_id, and this
  -- function logs exactly one stock_movements row per distinct variant
  -- actually received (see the poi_agg CTE below), not one per raw line.
  select count(distinct variant_id)::int
  into v_required_count
  from public.purchase_order_items
  where org_id = p_org_id
    and purchase_order_id = p_purchase_order_id;

  if v_required_count = 0 then
    raise exception 'purchase order requires at least one item'
      using errcode = '22023', hint = 'invalid_purchase_order_items';
  end if;

  insert into public.variant_stocks (org_id, warehouse_id, variant_id, qty)
  select p_org_id, p_warehouse_id, poi.variant_id, 0
  from public.purchase_order_items poi
  where poi.org_id = p_org_id
    and poi.purchase_order_id = p_purchase_order_id
  on conflict (org_id, warehouse_id, variant_id) do nothing;

  perform 1
  from public.variant_stocks vs
  join public.purchase_order_items poi
    on poi.org_id = vs.org_id
   and poi.variant_id = vs.variant_id
  where vs.org_id = p_org_id
    and vs.warehouse_id = p_warehouse_id
    and poi.purchase_order_id = p_purchase_order_id
  order by vs.variant_id
  for update;

  with poi_agg as (
    -- Pre-aggregate BEFORE joining to variant_stocks / product_variants
    -- below. Postgres's UPDATE ... FROM applies only one arbitrarily-chosen
    -- FROM-row per target row when several FROM rows match it (documented
    -- Postgres behavior, not a bug in Postgres) — so joining variant_stocks
    -- or product_variants directly against the raw, un-aggregated
    -- purchase_order_items silently drops every duplicate line but one, as
    -- this migration's header comment documents happened in practice.
    -- Aggregating first guarantees every join below is exactly 1:1.
    select
      poi.variant_id,
      sum(poi.qty)::int as qty,
      -- Quantity-weighted average unit cost across duplicate lines, rounded
      -- to the nearest VND (VND has no subunit). For a variant with a single
      -- line this reduces to that line's own unit_cost_vnd unchanged.
      round(
        sum(poi.qty::numeric * poi.unit_cost_vnd) / sum(poi.qty)
      )::bigint as unit_cost_vnd
    from public.purchase_order_items poi
    where poi.org_id = p_org_id
      and poi.purchase_order_id = p_purchase_order_id
    group by poi.variant_id
  ),
  received as (
    update public.variant_stocks vs
    set qty = vs.qty + agg.qty
    from poi_agg agg
    where vs.org_id = p_org_id
      and vs.warehouse_id = p_warehouse_id
      and vs.variant_id = agg.variant_id
    returning vs.variant_id, vs.qty as warehouse_stock_after, agg.qty, agg.unit_cost_vnd
  ),
  totals as (
    update public.product_variants pv
    set stock_qty = (
          r.warehouse_stock_after
          + coalesce(
              (
                select sum(vs_other.qty)
                from public.variant_stocks vs_other
                where vs_other.org_id = p_org_id
                  and vs_other.variant_id = r.variant_id
                  and vs_other.warehouse_id <> p_warehouse_id
              ),
              0
            )
        )::int,
        cogs_vnd = r.unit_cost_vnd,
        updated_at = v_at
    from received r
    where pv.org_id = p_org_id
      and pv.id = r.variant_id
    returning pv.id as variant_id, pv.stock_qty as stock_after
  ),
  logged as (
    insert into public.stock_movements (
      org_id,
      warehouse_id,
      variant_id,
      movement_type,
      qty_delta,
      stock_after,
      reason,
      actor_user_id,
      created_at
    )
    select
      p_org_id,
      p_warehouse_id,
      r.variant_id,
      'inbound',
      r.qty,
      t.stock_after,
      'receive_po:' || p_purchase_order_id::text,
      p_actor_user_id,
      v_at
    from received r
    join totals t on t.variant_id = r.variant_id
    returning id, variant_id, qty_delta, stock_after
  )
  select count(*)::int
  into v_movement_count
  from logged;

  if v_movement_count <> v_required_count then
    raise exception 'purchase order receive mismatch'
      using errcode = 'P0001', hint = 'purchase_order_receive_mismatch';
  end if;

  update public.purchase_orders
  set status = 'received',
      warehouse_id = p_warehouse_id,
      received_at = v_at,
      ordered_at = coalesce(ordered_at, v_at),
      updated_at = v_at
  where org_id = p_org_id
    and id = p_purchase_order_id
  returning * into v_po;

  return jsonb_build_object(
    'purchaseOrderId', v_po.id,
    'warehouseId', p_warehouse_id,
    'status', v_po.status,
    'receivedAt', v_po.received_at,
    'movements',
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', sm.id,
              'orgId', sm.org_id,
              'warehouseId', sm.warehouse_id,
              'variantId', sm.variant_id,
              'movementType', sm.movement_type,
              'qtyDelta', sm.qty_delta,
              'stockAfter', sm.stock_after,
              'orderId', sm.order_id,
              'reason', sm.reason,
              'actorUserId', sm.actor_user_id,
              'createdAt', sm.created_at
            )
            order by sm.created_at, sm.id
          )
          from public.stock_movements sm
          where sm.org_id = p_org_id
            and sm.warehouse_id = p_warehouse_id
            and sm.reason = 'receive_po:' || p_purchase_order_id::text
            and sm.created_at = v_at
        ),
        jsonb_build_array()
      )
  );
end;
$$;

revoke all on function public.receive_po(uuid, uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function public.receive_po(uuid, uuid, uuid, uuid)
to service_role;
