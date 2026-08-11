-- Plan H Wave 4A: multi-warehouse stock by variant + atomic transfers.

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  code text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  constraint warehouses_org_id_code_key unique (org_id, code),
  constraint warehouses_org_id_id_key unique (org_id, id),
  constraint warehouses_name_nonempty_check check (btrim(name) <> ''),
  constraint warehouses_code_nonempty_check check (btrim(code) <> '')
);

create unique index if not exists warehouses_one_default_per_org_idx
  on public.warehouses (org_id)
  where is_default;

create index if not exists warehouses_org_created_idx
  on public.warehouses (org_id, created_at desc);

insert into public.warehouses (org_id, name, code, is_default)
select o.id, 'Kho chính', 'MAIN', true
from public.organizations o
where not exists (
  select 1
  from public.warehouses w
  where w.org_id = o.id
    and w.code = 'MAIN'
)
on conflict (org_id, code) do nothing;

alter table public.product_variants
  add constraint product_variants_org_id_id_key unique (org_id, id);

create table if not exists public.variant_stocks (
  org_id uuid not null references public.organizations (id) on delete cascade,
  warehouse_id uuid not null,
  variant_id uuid not null,
  qty int not null default 0,
  constraint variant_stocks_pkey primary key (org_id, warehouse_id, variant_id),
  constraint variant_stocks_warehouse_variant_key unique (warehouse_id, variant_id),
  constraint variant_stocks_org_warehouse_fkey foreign key (org_id, warehouse_id)
    references public.warehouses (org_id, id) on delete cascade,
  constraint variant_stocks_org_variant_fkey foreign key (org_id, variant_id)
    references public.product_variants (org_id, id) on delete cascade,
  constraint variant_stocks_qty_nonnegative_check check (qty >= 0)
);

create index if not exists variant_stocks_org_variant_idx
  on public.variant_stocks (org_id, variant_id);

insert into public.variant_stocks (org_id, warehouse_id, variant_id, qty)
select pv.org_id, w.id, pv.id, pv.stock_qty
from public.product_variants pv
join public.warehouses w
  on w.org_id = pv.org_id
 and w.code = 'MAIN'
on conflict (org_id, warehouse_id, variant_id) do update
set qty = excluded.qty;

alter table public.stock_movements
  add column if not exists warehouse_id uuid;

alter table public.stock_movements
  drop constraint if exists stock_movements_org_warehouse_fkey;

alter table public.stock_movements
  add constraint stock_movements_org_warehouse_fkey foreign key (org_id, warehouse_id)
  references public.warehouses (org_id, id);

create index if not exists stock_movements_org_warehouse_created_idx
  on public.stock_movements (org_id, warehouse_id, created_at desc);

alter table public.stock_movements
  drop constraint if exists stock_movements_type_check;

alter table public.stock_movements
  add constraint stock_movements_type_check check (
    movement_type in (
      'confirm',
      'cancel_restore',
      'return_restock',
      'adjust',
      'inbound',
      'outbound',
      'transfer_out',
      'transfer_in'
    )
  );

alter table public.warehouses enable row level security;
alter table public.variant_stocks enable row level security;

drop policy if exists warehouses_select_member on public.warehouses;
create policy warehouses_select_member
  on public.warehouses
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists variant_stocks_select_member on public.variant_stocks;
create policy variant_stocks_select_member
  on public.variant_stocks
  for select
  to authenticated
  using (private.is_org_member(org_id));

revoke all on table public.warehouses, public.variant_stocks from anon, authenticated;
grant select on table public.warehouses, public.variant_stocks to authenticated;
grant all on table public.warehouses, public.variant_stocks to service_role;

create or replace function private.default_warehouse_id(p_org_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select w.id
  from public.warehouses w
  where w.org_id = p_org_id
    and w.is_default
  order by w.created_at asc
  limit 1
$$;

revoke all on function private.default_warehouse_id(uuid) from public, anon, authenticated;
grant execute on function private.default_warehouse_id(uuid) to service_role;

create or replace function private.ensure_variant_stock_main()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_warehouse_id uuid;
begin
  v_warehouse_id := private.default_warehouse_id(new.org_id);
  if v_warehouse_id is null then
    return new;
  end if;

  insert into public.variant_stocks (org_id, warehouse_id, variant_id, qty)
  values (new.org_id, v_warehouse_id, new.id, new.stock_qty)
  on conflict (org_id, warehouse_id, variant_id) do nothing;

  return new;
end;
$$;

drop trigger if exists product_variants_insert_variant_stocks on public.product_variants;
create trigger product_variants_insert_variant_stocks
  after insert on public.product_variants
  for each row
  execute function private.ensure_variant_stock_main();

create or replace function private.sync_variant_total_stock(
  p_org_id uuid,
  p_variant_id uuid,
  p_at timestamptz default now()
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
begin
  select coalesce(sum(vs.qty), 0)::int
  into v_total
  from public.variant_stocks vs
  where vs.org_id = p_org_id
    and vs.variant_id = p_variant_id;

  update public.product_variants
  set stock_qty = v_total,
      updated_at = coalesce(p_at, now())
  where org_id = p_org_id
    and id = p_variant_id;

  return v_total;
end;
$$;

revoke all on function private.sync_variant_total_stock(uuid, uuid, timestamptz)
from public, anon, authenticated;
grant execute on function private.sync_variant_total_stock(uuid, uuid, timestamptz)
to service_role;

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

  v_warehouse_id := private.default_warehouse_id(p_org_id);
  if v_warehouse_id is null then
    raise exception 'default warehouse not found'
      using errcode = 'P0001', hint = 'warehouse_not_found';
  end if;

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

revoke all on function private.apply_order_stock_change(uuid, uuid, text, timestamptz)
from public, anon, authenticated;

grant execute on function private.apply_order_stock_change(uuid, uuid, text, timestamptz)
to service_role;

create or replace function public.adjust_variant_stock(
  p_org_id uuid,
  p_variant_id uuid,
  p_qty_delta int,
  p_reason text default null,
  p_actor_user_id uuid default null,
  p_movement_type text default 'adjust'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.product_variants%rowtype;
  v_type text := coalesce(nullif(btrim(p_movement_type), ''), 'adjust');
  v_new int;
  v_total int;
  v_warehouse_id uuid;
  v_movement public.stock_movements%rowtype;
  v_at timestamptz := now();
begin
  if p_qty_delta = 0 then
    raise exception 'qty_delta must be non-zero'
      using errcode = '22023', hint = 'invalid_qty_delta';
  end if;

  if v_type not in ('adjust', 'inbound', 'outbound') then
    raise exception 'invalid movement_type %', v_type
      using errcode = '22023', hint = 'invalid_movement_type';
  end if;

  if v_type = 'inbound' and p_qty_delta < 0 then
    raise exception 'inbound requires positive qty_delta'
      using errcode = '22023', hint = 'invalid_qty_delta';
  end if;

  if v_type = 'outbound' and p_qty_delta > 0 then
    raise exception 'outbound requires negative qty_delta'
      using errcode = '22023', hint = 'invalid_qty_delta';
  end if;

  v_warehouse_id := private.default_warehouse_id(p_org_id);
  if v_warehouse_id is null then
    raise exception 'default warehouse not found'
      using errcode = 'P0001', hint = 'warehouse_not_found';
  end if;

  select *
  into v_variant
  from public.product_variants
  where org_id = p_org_id
    and id = p_variant_id
  for update;

  if not found then
    return null;
  end if;

  insert into public.variant_stocks (org_id, warehouse_id, variant_id, qty)
  values (p_org_id, v_warehouse_id, p_variant_id, v_variant.stock_qty)
  on conflict (org_id, warehouse_id, variant_id) do nothing;

  select qty + p_qty_delta
  into v_new
  from public.variant_stocks
  where org_id = p_org_id
    and warehouse_id = v_warehouse_id
    and variant_id = p_variant_id
  for update;

  if v_new < 0 then
    raise exception 'insufficient stock for adjust'
      using errcode = 'P0001', hint = 'insufficient_stock';
  end if;

  update public.variant_stocks
  set qty = v_new
  where org_id = p_org_id
    and warehouse_id = v_warehouse_id
    and variant_id = p_variant_id;

  v_total := private.sync_variant_total_stock(p_org_id, p_variant_id, v_at);

  select *
  into v_variant
  from public.product_variants
  where org_id = p_org_id
    and id = p_variant_id;

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
  values (
    p_org_id,
    v_warehouse_id,
    p_variant_id,
    v_type,
    p_qty_delta,
    v_total,
    nullif(btrim(coalesce(p_reason, '')), ''),
    p_actor_user_id,
    v_at
  )
  returning * into v_movement;

  return jsonb_build_object(
    'variant',
    jsonb_build_object(
      'id', v_variant.id,
      'orgId', v_variant.org_id,
      'productId', v_variant.product_id,
      'sku', v_variant.sku,
      'title', v_variant.title,
      'priceVnd', v_variant.price_vnd::text,
      'stockQty', v_variant.stock_qty,
      'attrs', v_variant.attrs_json,
      'createdAt', v_variant.created_at,
      'updatedAt', v_variant.updated_at
    ),
    'movement',
    jsonb_build_object(
      'id', v_movement.id,
      'orgId', v_movement.org_id,
      'warehouseId', v_movement.warehouse_id,
      'variantId', v_movement.variant_id,
      'movementType', v_movement.movement_type,
      'qtyDelta', v_movement.qty_delta,
      'stockAfter', v_movement.stock_after,
      'orderId', v_movement.order_id,
      'reason', v_movement.reason,
      'actorUserId', v_movement.actor_user_id,
      'createdAt', v_movement.created_at
    )
  );
end;
$$;

revoke all on function public.adjust_variant_stock(
  uuid, uuid, int, text, uuid, text
)
from public, anon, authenticated;

grant execute on function public.adjust_variant_stock(
  uuid, uuid, int, text, uuid, text
)
to service_role;

create or replace function public.transfer_stock(
  p_org_id uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_variant_id uuid,
  p_qty int,
  p_actor_user_id uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_wh public.warehouses%rowtype;
  v_to_wh public.warehouses%rowtype;
  v_variant public.product_variants%rowtype;
  v_from_qty int;
  v_to_qty int;
  v_total int;
  v_out_movement public.stock_movements%rowtype;
  v_in_movement public.stock_movements%rowtype;
  v_at timestamptz := now();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'qty must be positive'
      using errcode = '22023', hint = 'invalid_qty';
  end if;

  if p_from_warehouse_id = p_to_warehouse_id then
    raise exception 'from and to warehouses must differ'
      using errcode = '22023', hint = 'invalid_warehouse';
  end if;

  select *
  into v_from_wh
  from public.warehouses
  where org_id = p_org_id
    and id = p_from_warehouse_id
  for update;

  if not found then
    raise exception 'from warehouse not found'
      using errcode = 'P0001', hint = 'warehouse_not_found';
  end if;

  select *
  into v_to_wh
  from public.warehouses
  where org_id = p_org_id
    and id = p_to_warehouse_id
  for update;

  if not found then
    raise exception 'to warehouse not found'
      using errcode = 'P0001', hint = 'warehouse_not_found';
  end if;

  select *
  into v_variant
  from public.product_variants
  where org_id = p_org_id
    and id = p_variant_id
  for update;

  if not found then
    raise exception 'product variant not found'
      using errcode = 'P0001', hint = 'variant_not_found';
  end if;

  insert into public.variant_stocks (org_id, warehouse_id, variant_id, qty)
  values
    (p_org_id, p_from_warehouse_id, p_variant_id, 0),
    (p_org_id, p_to_warehouse_id, p_variant_id, 0)
  on conflict (org_id, warehouse_id, variant_id) do nothing;

  perform 1
  from public.variant_stocks vs
  where vs.org_id = p_org_id
    and vs.variant_id = p_variant_id
    and vs.warehouse_id in (p_from_warehouse_id, p_to_warehouse_id)
  order by vs.warehouse_id
  for update;

  select qty
  into v_from_qty
  from public.variant_stocks
  where org_id = p_org_id
    and warehouse_id = p_from_warehouse_id
    and variant_id = p_variant_id;

  if v_from_qty < p_qty then
    raise exception 'insufficient stock for transfer'
      using errcode = 'P0001', hint = 'insufficient_stock';
  end if;

  update public.variant_stocks
  set qty = qty - p_qty
  where org_id = p_org_id
    and warehouse_id = p_from_warehouse_id
    and variant_id = p_variant_id
  returning qty into v_from_qty;

  update public.variant_stocks
  set qty = qty + p_qty
  where org_id = p_org_id
    and warehouse_id = p_to_warehouse_id
    and variant_id = p_variant_id
  returning qty into v_to_qty;

  v_total := private.sync_variant_total_stock(p_org_id, p_variant_id, v_at);

  select *
  into v_variant
  from public.product_variants
  where org_id = p_org_id
    and id = p_variant_id;

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
  values (
    p_org_id,
    p_from_warehouse_id,
    p_variant_id,
    'transfer_out',
    -p_qty,
    v_from_qty,
    v_reason,
    p_actor_user_id,
    v_at
  )
  returning * into v_out_movement;

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
  values (
    p_org_id,
    p_to_warehouse_id,
    p_variant_id,
    'transfer_in',
    p_qty,
    v_to_qty,
    v_reason,
    p_actor_user_id,
    v_at
  )
  returning * into v_in_movement;

  return jsonb_build_object(
    'variant',
    jsonb_build_object(
      'id', v_variant.id,
      'orgId', v_variant.org_id,
      'productId', v_variant.product_id,
      'sku', v_variant.sku,
      'title', v_variant.title,
      'priceVnd', v_variant.price_vnd::text,
      'stockQty', v_total,
      'attrs', v_variant.attrs_json,
      'createdAt', v_variant.created_at,
      'updatedAt', v_variant.updated_at
    ),
    'fromStock',
    jsonb_build_object(
      'warehouseId', p_from_warehouse_id,
      'variantId', p_variant_id,
      'qty', v_from_qty
    ),
    'toStock',
    jsonb_build_object(
      'warehouseId', p_to_warehouse_id,
      'variantId', p_variant_id,
      'qty', v_to_qty
    ),
    'movements',
    jsonb_build_array(
      jsonb_build_object(
        'id', v_out_movement.id,
        'orgId', v_out_movement.org_id,
        'warehouseId', v_out_movement.warehouse_id,
        'variantId', v_out_movement.variant_id,
        'movementType', v_out_movement.movement_type,
        'qtyDelta', v_out_movement.qty_delta,
        'stockAfter', v_out_movement.stock_after,
        'orderId', v_out_movement.order_id,
        'reason', v_out_movement.reason,
        'actorUserId', v_out_movement.actor_user_id,
        'createdAt', v_out_movement.created_at
      ),
      jsonb_build_object(
        'id', v_in_movement.id,
        'orgId', v_in_movement.org_id,
        'warehouseId', v_in_movement.warehouse_id,
        'variantId', v_in_movement.variant_id,
        'movementType', v_in_movement.movement_type,
        'qtyDelta', v_in_movement.qty_delta,
        'stockAfter', v_in_movement.stock_after,
        'orderId', v_in_movement.order_id,
        'reason', v_in_movement.reason,
        'actorUserId', v_in_movement.actor_user_id,
        'createdAt', v_in_movement.created_at
      )
    )
  );
end;
$$;

revoke all on function public.transfer_stock(uuid, uuid, uuid, uuid, int, uuid, text)
from public, anon, authenticated;

grant execute on function public.transfer_stock(uuid, uuid, uuid, uuid, int, uuid, text)
to service_role;
