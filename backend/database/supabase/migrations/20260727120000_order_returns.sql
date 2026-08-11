-- Plan F Wave 2D: returned orders, optional restock, and COD cleanup.

create table if not exists public.order_returns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete restrict,
  reason text,
  restocked boolean not null default true,
  created_at timestamptz not null default now(),
  actor_user_id uuid,
  constraint order_returns_org_order_key unique (org_id, order_id)
);

create index if not exists order_returns_org_created_idx
  on public.order_returns (org_id, created_at desc);

alter table public.order_returns enable row level security;

drop policy if exists order_returns_select_member on public.order_returns;
create policy order_returns_select_member
  on public.order_returns
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists order_returns_service_role_all on public.order_returns;
create policy order_returns_service_role_all
  on public.order_returns
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.order_returns from anon, authenticated;
grant select on table public.order_returns to authenticated;
grant all on table public.order_returns to service_role;

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
      'outbound'
    )
  );

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
begin
  if p_direction = 'confirm' then
    v_mult := -1;
  elsif p_direction in ('cancel_restore', 'return_restock') then
    v_mult := 1;
  else
    raise exception 'invalid stock direction %', p_direction
      using errcode = '22023';
  end if;

  with required as (
    select oi.variant_id, sum(oi.qty)::int as qty
    from public.order_items oi
    where oi.org_id = p_org_id
      and oi.order_id = p_order_id
    group by oi.variant_id
  ),
  updated as (
    update public.product_variants pv
    set stock_qty = pv.stock_qty + (v_mult * required.qty),
        updated_at = p_at
    from required
    where pv.org_id = p_org_id
      and pv.id = required.variant_id
      and (v_mult = 1 or pv.stock_qty >= required.qty)
    returning
      pv.id as variant_id,
      pv.stock_qty as stock_after,
      required.qty as qty
  ),
  logged as (
    insert into public.stock_movements (
      org_id,
      variant_id,
      movement_type,
      qty_delta,
      stock_after,
      order_id,
      created_at
    )
    select
      p_org_id,
      u.variant_id,
      p_direction,
      v_mult * u.qty,
      u.stock_after,
      p_order_id,
      p_at
    from updated u
    returning id
  )
  select
    (select count(*)::int from required),
    (select count(*)::int from updated)
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

create or replace function public.return_order(
  p_org_id uuid,
  p_order_id uuid,
  p_reason text default null,
  p_restock boolean default true,
  p_at timestamptz default now(),
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_at timestamptz := coalesce(p_at, now());
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note text;
begin
  select *
  into v_order
  from public.orders
  where org_id = p_org_id
    and id = p_order_id
  for update;

  if not found then
    return null;
  end if;

  if v_order.status = 'returned' then
    return private.order_lifecycle_payload(p_org_id, p_order_id);
  end if;

  if v_order.status not in ('shipped', 'done') then
    raise exception 'order cannot be returned from status %', v_order.status
      using errcode = 'P0001', hint = 'invalid_order_status';
  end if;

  if coalesce(p_restock, true) then
    perform private.apply_order_stock_change(
      p_org_id,
      p_order_id,
      'return_restock',
      v_at
    );
  end if;

  insert into public.order_returns (
    org_id,
    order_id,
    reason,
    restocked,
    created_at,
    actor_user_id
  )
  values (
    p_org_id,
    p_order_id,
    v_reason,
    coalesce(p_restock, true),
    v_at,
    p_actor_user_id
  );

  update public.orders
  set status = 'returned',
      updated_at = v_at
  where org_id = p_org_id
    and id = p_order_id;

  update public.cod_expectations
  set status = 'written_off'
  where org_id = p_org_id
    and order_id = p_order_id
    and status = 'open';

  v_note := case
    when v_reason is null then 'Order returned; COD discrepancy left open'
    else 'Order returned; COD discrepancy left open: ' || v_reason
  end;

  update public.cod_discrepancies
  set note = case
    when note is null or note = '' then v_note
    when position(v_note in note) > 0 then note
    else note || E'\n' || v_note
  end
  where org_id = p_org_id
    and order_id = p_order_id
    and status = 'open'
    and exists (
      select 1
      from public.cod_expectations ce
      where ce.org_id = p_org_id
        and ce.order_id = p_order_id
        and ce.status = 'discrepancy'
    );

  return private.order_lifecycle_payload(p_org_id, p_order_id);
end;
$$;

revoke all on function public.return_order(uuid, uuid, text, boolean, timestamptz, uuid)
from public, anon, authenticated;

grant execute on function public.return_order(uuid, uuid, text, boolean, timestamptz, uuid)
to service_role;
