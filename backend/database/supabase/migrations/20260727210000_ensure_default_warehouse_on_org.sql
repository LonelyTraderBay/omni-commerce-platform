-- New orgs created after multi-warehouse migration had no MAIN warehouse,
-- so confirm_order failed with warehouse_not_found → API 500 orders_failed.

create or replace function private.ensure_default_warehouse(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select w.id
  into v_id
  from public.warehouses w
  where w.org_id = p_org_id
    and w.is_default
  order by w.created_at asc
  limit 1;

  if v_id is not null then
    return v_id;
  end if;

  insert into public.warehouses (org_id, name, code, is_default)
  values (p_org_id, 'Kho chính', 'MAIN', true)
  on conflict (org_id, code) do update
    set is_default = true
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function private.ensure_default_warehouse(uuid)
from public, anon, authenticated;

grant execute on function private.ensure_default_warehouse(uuid)
to service_role;

create or replace function private.ensure_org_default_warehouse_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform private.ensure_default_warehouse(new.id);
  return new;
end;
$$;

drop trigger if exists organizations_ensure_default_warehouse on public.organizations;
create trigger organizations_ensure_default_warehouse
  after insert on public.organizations
  for each row
  execute function private.ensure_org_default_warehouse_trg();

-- Product variant insert previously no-oped when warehouse missing.
create or replace function private.ensure_variant_stock_main()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_warehouse_id uuid;
begin
  v_warehouse_id := private.ensure_default_warehouse(new.org_id);

  insert into public.variant_stocks (org_id, warehouse_id, variant_id, qty)
  values (new.org_id, v_warehouse_id, new.id, new.stock_qty)
  on conflict (org_id, warehouse_id, variant_id) do nothing;

  return new;
end;
$$;

-- Backfill orgs that already exist without a default warehouse.
select private.ensure_default_warehouse(o.id)
from public.organizations o
where not exists (
  select 1
  from public.warehouses w
  where w.org_id = o.id
    and w.is_default
);

-- Backfill MAIN variant_stocks for variants created before warehouse existed.
insert into public.variant_stocks (org_id, warehouse_id, variant_id, qty)
select pv.org_id, w.id, pv.id, pv.stock_qty
from public.product_variants pv
join public.warehouses w
  on w.org_id = pv.org_id
 and w.is_default
where not exists (
  select 1
  from public.variant_stocks vs
  where vs.org_id = pv.org_id
    and vs.warehouse_id = w.id
    and vs.variant_id = pv.id
);

-- Confirm/cancel/return: auto-heal missing default warehouse instead of hard-fail.
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
      select vs.variant_id, coalesce(sum(vs.qty), 0)::int as total_qty
      from public.variant_stocks vs
      join updated_stocks u on u.variant_id = vs.variant_id
      where vs.org_id = p_org_id
      group by vs.variant_id
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
