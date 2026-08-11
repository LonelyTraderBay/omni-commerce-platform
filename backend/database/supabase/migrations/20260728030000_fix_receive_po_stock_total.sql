-- Fix: public.receive_po() left product_variants.stock_qty stale after
-- receiving a purchase order.
--
-- Root cause: the original function (20260727200000_supplier_po_einvoice.sql)
-- aggregated the new total with
--   select vs.variant_id, coalesce(sum(vs.qty), 0)
--   from public.variant_stocks vs
--   join received r on r.variant_id = vs.variant_id
--   where vs.org_id = p_org_id
--   group by vs.variant_id
-- inside a `totals` CTE that is a sibling of the `received` CTE (which is
-- the UPDATE that actually incremented variant_stocks.qty for the receiving
-- warehouse) within the SAME multi-CTE WITH ... UPDATE statement. Per
-- Postgres's documented semantics for data-modifying WITH clauses, every
-- sub-statement in one WITH sees the *same* snapshot taken at the start of
-- the statement — a sibling CTE's own writes are only visible through its
-- RETURNING output, never through a fresh table scan like the one above.
-- So `totals` always summed the PRE-receive quantity for the just-updated
-- warehouse row, meaning stock_qty ended up unchanged by every PO receive
-- (verified manually: receiving 50 units into a warehouse that already held
-- 25, with another warehouse holding 5, left stock_qty at 30 instead of 80,
-- even though public.variant_stocks itself was correctly updated to 75).
-- This is exactly the bug pattern `private.sync_variant_total_stock` (see
-- 20260727190000_multi_warehouse.sql) exists to avoid for
-- adjust_variant_stock/transfer_stock, but receive_po didn't reuse it.
--
-- Fix: compute total_qty from the `received` CTE's own RETURNING value
-- (warehouse_stock_after, guaranteed correct) plus a fresh sum of the OTHER
-- warehouses' rows only (safe to read fresh since this statement never
-- touches them).

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

  select count(*)::int
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

  with received as (
    update public.variant_stocks vs
    set qty = vs.qty + poi.qty
    from public.purchase_order_items poi
    where vs.org_id = p_org_id
      and vs.warehouse_id = p_warehouse_id
      and vs.variant_id = poi.variant_id
      and poi.org_id = p_org_id
      and poi.purchase_order_id = p_purchase_order_id
    returning vs.variant_id, vs.qty as warehouse_stock_after, poi.qty
  ),
  totals as (
    update public.product_variants pv
    set stock_qty = summed.total_qty,
        cogs_vnd = poi.unit_cost_vnd,
        updated_at = v_at
    from (
      select
        r.variant_id,
        (
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
        )::int as total_qty
      from received r
    ) summed
    join public.purchase_order_items poi
      on poi.org_id = p_org_id
     and poi.purchase_order_id = p_purchase_order_id
     and poi.variant_id = summed.variant_id
    where pv.org_id = p_org_id
      and pv.id = summed.variant_id
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
