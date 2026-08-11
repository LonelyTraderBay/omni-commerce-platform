-- Fix: private.apply_order_stock_change() (confirm/cancel/return order stock
-- adjustments — see OrdersService.confirmOrder/cancelOrder/returnOrder) left
-- product_variants.stock_qty stale whenever the variant had stock split
-- across more than one warehouse.
--
-- Root cause: same bug class as public.receive_po() before
-- 20260728000000_fix_receive_po_stock_total.sql. The latest definition
-- (20260727210000_ensure_default_warehouse_on_org.sql) aggregated the new
-- total inside a `totals` CTE that is a *sibling* of the `updated_stocks`
-- CTE (the UPDATE that actually adjusted variant_stocks.qty for the default
-- warehouse), both inside one multi-CTE `WITH ... UPDATE` statement:
--
--   with updated_stocks as (
--     update variant_stocks set qty = qty + (mult * required.qty) ... returning ...
--   ),
--   totals as (
--     update product_variants set stock_qty = (
--       select sum(qty) from variant_stocks vs join updated_stocks u on ... -- STALE
--     )
--     ...
--   )
--
-- Per Postgres's documented semantics for data-modifying WITH clauses, every
-- sub-statement in one WITH sees the *same* snapshot taken at the start of
-- the statement — a sibling CTE's own writes are visible only through its
-- RETURNING output, never through a fresh scan of the underlying table like
-- `totals` did. So `totals` always summed the PRE-change quantity for the
-- warehouse `updated_stocks` had just adjusted, meaning confirming/
-- cancelling/returning an order left stock_qty wrong (too high on confirm,
-- too low on cancel/return) whenever the variant also had stock in another
-- warehouse. This is exactly the pitfall `private.sync_variant_total_stock`
-- (20260727190000_multi_warehouse.sql) exists to avoid — apply_order_stock_change
-- just didn't reuse it (same as receive_po didn't).
--
-- Fix: compute total_qty from the `updated_stocks` CTE's own RETURNING value
-- (warehouse_stock_after, guaranteed correct) plus a fresh sum of the OTHER
-- warehouses' rows only (safe to read fresh since this statement never
-- touches them), same pattern as the receive_po fix.

create or replace function private.apply_order_stock_change(
  p_org_id uuid,
  p_order_id uuid,
  p_direction text,
  p_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required_count int;
  v_updated_count int;
  v_mult int;
  v_warehouse_id uuid;
begin
  if p_direction = 'confirm' then
    v_mult := -1;
  elsif p_direction in ('cancel_restore', 'return_restock') then
    v_mult := 1;
  else
    raise exception 'invalid stock direction %', p_direction
      using errcode = '22023';
  end if;

  v_warehouse_id := private.ensure_default_warehouse(p_org_id);

  insert into public.variant_stocks (org_id, warehouse_id, variant_id, qty)
  select p_org_id, v_warehouse_id, pv.id, 0
  from public.product_variants pv
  where pv.org_id = p_org_id
  on conflict (org_id, warehouse_id, variant_id) do nothing;

  with required as (
    select oi.variant_id, sum(oi.qty)::int as qty
    from public.order_items oi
    where oi.org_id = p_org_id
      and oi.order_id = p_order_id
    group by oi.variant_id
  ),
  updated_stocks as (
    update public.variant_stocks vs
    set qty = vs.qty + (v_mult * required.qty)
    from required
    where vs.org_id = p_org_id
      and vs.warehouse_id = v_warehouse_id
      and vs.variant_id = required.variant_id
      and (v_mult = 1 or vs.qty >= required.qty)
    returning
      vs.variant_id,
      vs.qty as warehouse_stock_after,
      required.qty
  ),
  totals as (
    update public.product_variants pv
    set stock_qty = summed.total_qty,
        updated_at = p_at
    from (
      select
        u.variant_id,
        (
          u.warehouse_stock_after
          + coalesce(
              (
                select sum(vs_other.qty)
                from public.variant_stocks vs_other
                where vs_other.org_id = p_org_id
                  and vs_other.variant_id = u.variant_id
                  and vs_other.warehouse_id <> v_warehouse_id
              ),
              0
            )
        )::int as total_qty
      from updated_stocks u
    ) summed
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
      order_id,
      created_at
    )
    select
      p_org_id,
      v_warehouse_id,
      u.variant_id,
      p_direction,
      v_mult * u.qty,
      t.stock_after,
      p_order_id,
      p_at
    from updated_stocks u
    join totals t on t.variant_id = u.variant_id
    returning id
  )
  select
    (select count(*)::int from required),
    (select count(*)::int from updated_stocks)
  into v_required_count, v_updated_count;

  if p_direction = 'confirm' then
    if v_required_count = 0 then
      raise exception 'order requires at least one item'
        using errcode = '22023', hint = 'invalid_order_items';
    end if;

    if v_required_count <> v_updated_count then
      raise exception 'insufficient stock for order'
        using errcode = 'P0001', hint = 'insufficient_stock';
    end if;
  end if;
end;
$$;

revoke all on function private.apply_order_stock_change(uuid, uuid, text, timestamptz)
from public, anon, authenticated;

grant execute on function private.apply_order_stock_change(uuid, uuid, text, timestamptz)
to service_role;
