-- Plan F Wave 2A: stock_movements ledger + adjust RPC + order lifecycle writes ledger.

alter table public.organizations
  add column if not exists low_stock_threshold int not null default 5;

alter table public.organizations
  drop constraint if exists organizations_low_stock_threshold_check;

alter table public.organizations
  add constraint organizations_low_stock_threshold_check
  check (low_stock_threshold >= 0);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  movement_type text not null,
  qty_delta int not null,
  stock_after int not null,
  order_id uuid references public.orders (id) on delete set null,
  reason text,
  actor_user_id uuid,
  created_at timestamptz not null default now(),
  constraint stock_movements_type_check check (
    movement_type in (
      'confirm',
      'cancel_restore',
      'adjust',
      'inbound',
      'outbound'
    )
  ),
  constraint stock_movements_qty_delta_nonzero check (qty_delta <> 0),
  constraint stock_movements_stock_after_nonneg check (stock_after >= 0)
);

create index if not exists stock_movements_org_created_idx
  on public.stock_movements (org_id, created_at desc);

create index if not exists stock_movements_org_variant_created_idx
  on public.stock_movements (org_id, variant_id, created_at desc);

alter table public.stock_movements enable row level security;

drop policy if exists stock_movements_select_member on public.stock_movements;
create policy stock_movements_select_member
  on public.stock_movements
  for select
  to authenticated
  using (private.is_org_member(org_id));

revoke all on table public.stock_movements from anon, authenticated;
grant select on table public.stock_movements to authenticated;
grant all on table public.stock_movements to service_role;

-- Apply confirm (-qty) or cancel_restore (+qty) for all order lines + ledger rows.
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
  elsif p_direction = 'cancel_restore' then
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

  select *
  into v_variant
  from public.product_variants
  where org_id = p_org_id
    and id = p_variant_id
  for update;

  if not found then
    return null;
  end if;

  v_new := v_variant.stock_qty + p_qty_delta;
  if v_new < 0 then
    raise exception 'insufficient stock for adjust'
      using errcode = 'P0001', hint = 'insufficient_stock';
  end if;

  update public.product_variants
  set stock_qty = v_new,
      updated_at = v_at
  where org_id = p_org_id
    and id = p_variant_id;

  insert into public.stock_movements (
    org_id,
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
    p_variant_id,
    v_type,
    p_qty_delta,
    v_new,
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
      'stockQty', v_new,
      'attrs', v_variant.attrs_json,
      'createdAt', v_variant.created_at,
      'updatedAt', v_at
    ),
    'movement',
    jsonb_build_object(
      'id', v_movement.id,
      'orgId', v_movement.org_id,
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

create or replace function public.confirm_order(
  p_org_id uuid,
  p_order_id uuid,
  p_confirmed_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_at timestamptz := coalesce(p_confirmed_at, now());
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

  if v_order.status in ('confirmed', 'shipped', 'done') then
    return private.order_lifecycle_payload(p_org_id, p_order_id);
  end if;

  if v_order.status <> 'draft' then
    raise exception 'order cannot be confirmed from status %', v_order.status
      using errcode = 'P0001', hint = 'invalid_order_status';
  end if;

  perform private.apply_order_stock_change(p_org_id, p_order_id, 'confirm', v_at);

  update public.orders
  set status = 'confirmed',
      confirmed_at = v_at,
      updated_at = v_at
  where org_id = p_org_id
    and id = p_order_id;

  return private.order_lifecycle_payload(p_org_id, p_order_id);
end;
$$;

create or replace function public.create_and_confirm_order(
  p_org_id uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_payment_method text,
  p_customer_name text,
  p_phone_e164 text,
  p_address_text text,
  p_address_json jsonb,
  p_idempotency_key text,
  p_items jsonb,
  p_method text,
  p_path text,
  p_status_code int,
  p_confirmed_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_existing public.idempotency_keys%rowtype;
  v_payload jsonb;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_subtotal bigint;
  v_at timestamptz := coalesce(p_confirmed_at, now());
begin
  if v_key = '' or length(v_key) > 128 then
    raise exception 'Idempotency-Key is invalid'
      using errcode = '22023', hint = 'invalid_idempotency_key';
  end if;

  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'order requires at least one item'
      using errcode = '22023', hint = 'invalid_order_items';
  end if;

  begin
    insert into public.idempotency_keys (
      org_id,
      key,
      method,
      path,
      status_code,
      response_json,
      expires_at
    )
    values (
      p_org_id,
      v_key,
      p_method,
      p_path,
      102,
      '{"_pending": true}'::jsonb,
      now() + interval '1 day'
    );
  exception
    when unique_violation then
      select *
      into v_existing
      from public.idempotency_keys
      where org_id = p_org_id
        and key = v_key
      for update;

      if not found or v_existing.status_code = 102 then
        raise exception 'idempotent request is already in progress'
          using errcode = 'P0001', hint = 'idempotency_conflict';
      end if;

      if v_existing.method <> p_method or v_existing.path <> p_path then
        raise exception 'Idempotency-Key was already used for another request'
          using errcode = 'P0001', hint = 'idempotency_key_reused';
      end if;

      return v_existing.response_json
        || jsonb_build_object('_idempotencyReplayed', true);
  end;

  select coalesce(sum((item->>'line_total_vnd')::bigint), 0)
  into v_subtotal
  from jsonb_array_elements(p_items) as items(item);

  insert into public.orders (
    org_id,
    conversation_id,
    contact_id,
    status,
    payment_method,
    customer_name,
    phone_e164,
    address_text,
    address_json,
    currency,
    subtotal_vnd,
    total_vnd,
    idempotency_key,
    updated_at
  )
  values (
    p_org_id,
    p_conversation_id,
    p_contact_id,
    'draft',
    p_payment_method,
    p_customer_name,
    p_phone_e164,
    p_address_text,
    coalesce(p_address_json, '{}'::jsonb),
    'VND',
    v_subtotal,
    v_subtotal,
    v_key,
    v_at
  )
  returning * into v_order;

  insert into public.order_items (
    org_id,
    order_id,
    product_id,
    variant_id,
    title_snapshot,
    sku_snapshot,
    qty,
    unit_price_vnd,
    line_total_vnd
  )
  select
    p_org_id,
    v_order.id,
    (item->>'product_id')::uuid,
    (item->>'variant_id')::uuid,
    item->>'title_snapshot',
    item->>'sku_snapshot',
    (item->>'qty')::int,
    (item->>'unit_price_vnd')::bigint,
    (item->>'line_total_vnd')::bigint
  from jsonb_array_elements(p_items) as items(item);

  perform private.apply_order_stock_change(p_org_id, v_order.id, 'confirm', v_at);

  update public.orders
  set status = 'confirmed',
      confirmed_at = v_at,
      updated_at = v_at
  where org_id = p_org_id
    and id = v_order.id;

  v_payload := private.order_lifecycle_payload(p_org_id, v_order.id);

  update public.idempotency_keys
  set status_code = coalesce(p_status_code, 201),
      response_json = v_payload
  where org_id = p_org_id
    and key = v_key;

  return v_payload || jsonb_build_object('_idempotencyReplayed', false);
end;
$$;

create or replace function public.cancel_order(
  p_org_id uuid,
  p_order_id uuid,
  p_cancelled_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_at timestamptz := coalesce(p_cancelled_at, now());
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

  if v_order.status = 'cancelled' then
    return private.order_lifecycle_payload(p_org_id, p_order_id);
  end if;

  if v_order.status in ('shipped', 'done', 'returned') then
    raise exception 'order cannot be cancelled from status %', v_order.status
      using errcode = 'P0001', hint = 'invalid_order_status';
  end if;

  if v_order.status = 'confirmed' then
    perform private.apply_order_stock_change(
      p_org_id,
      p_order_id,
      'cancel_restore',
      v_at
    );
  end if;

  update public.orders
  set status = 'cancelled',
      cancelled_at = v_at,
      updated_at = v_at
  where org_id = p_org_id
    and id = p_order_id;

  return private.order_lifecycle_payload(p_org_id, p_order_id);
end;
$$;
