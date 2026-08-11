-- Plan D Task 2: human-facing order lifecycle RPCs.
-- Core API calls these with service_role after Nest authz/org checks.

create or replace function private.order_lifecycle_payload(
  p_org_id uuid,
  p_order_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with order_row as (
    select o.*
    from public.orders o
    where o.org_id = p_org_id
      and o.id = p_order_id
  ),
  items_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', oi.id,
          'productId', oi.product_id,
          'variantId', oi.variant_id,
          'titleSnapshot', oi.title_snapshot,
          'skuSnapshot', oi.sku_snapshot,
          'qty', oi.qty,
          'unitPriceVnd', oi.unit_price_vnd::text,
          'lineTotalVnd', oi.line_total_vnd::text
        )
        order by oi.id
      ),
      '[]'::jsonb
    ) as items
    from public.order_items oi
    where oi.org_id = p_org_id
      and oi.order_id = p_order_id
  )
  select jsonb_build_object(
    'order',
    jsonb_build_object(
      'id', o.id,
      'orgId', o.org_id,
      'conversationId', o.conversation_id,
      'contactId', o.contact_id,
      'status', o.status,
      'paymentMethod', o.payment_method,
      'customerName', o.customer_name,
      'phoneE164', o.phone_e164,
      'addressText', o.address_text,
      'addressJson', o.address_json,
      'currency', o.currency,
      'subtotalVnd', o.subtotal_vnd::text,
      'totalVnd', o.total_vnd::text,
      'idempotencyKey', o.idempotency_key,
      'confirmedAt', o.confirmed_at,
      'shippedAt', o.shipped_at,
      'cancelledAt', o.cancelled_at,
      'doneAt', o.done_at,
      'createdAt', o.created_at,
      'updatedAt', o.updated_at
    ),
    'items',
    items_json.items
  )
  from order_row o
  cross join items_json;
$$;

revoke all on function private.order_lifecycle_payload(uuid, uuid)
from public, anon, authenticated;

grant execute on function private.order_lifecycle_payload(uuid, uuid)
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
  v_required_count int;
  v_updated_count int;
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

  with required as (
    select oi.variant_id, sum(oi.qty)::int as qty
    from public.order_items oi
    where oi.org_id = p_org_id
      and oi.order_id = p_order_id
    group by oi.variant_id
  ),
  updated as (
    update public.product_variants pv
    set stock_qty = pv.stock_qty - required.qty,
        updated_at = v_at
    from required
    where pv.org_id = p_org_id
      and pv.id = required.variant_id
      and pv.stock_qty >= required.qty
    returning pv.id
  )
  select
    (select count(*) from required),
    (select count(*) from updated)
  into v_required_count, v_updated_count;

  if v_required_count = 0 then
    raise exception 'order requires at least one item'
      using errcode = '22023', hint = 'invalid_order_items';
  end if;

  if v_required_count <> v_updated_count then
    raise exception 'insufficient stock for order'
      using errcode = 'P0001', hint = 'insufficient_stock';
  end if;

  update public.orders
  set status = 'confirmed',
      confirmed_at = v_at,
      updated_at = v_at
  where org_id = p_org_id
    and id = p_order_id;

  return private.order_lifecycle_payload(p_org_id, p_order_id);
end;
$$;

revoke all on function public.confirm_order(uuid, uuid, timestamptz)
from public, anon, authenticated;

grant execute on function public.confirm_order(uuid, uuid, timestamptz)
to service_role;

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
  v_required_count int;
  v_updated_count int;
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

  with required as (
    select oi.variant_id, sum(oi.qty)::int as qty
    from public.order_items oi
    where oi.org_id = p_org_id
      and oi.order_id = v_order.id
    group by oi.variant_id
  ),
  updated as (
    update public.product_variants pv
    set stock_qty = pv.stock_qty - required.qty,
        updated_at = v_at
    from required
    where pv.org_id = p_org_id
      and pv.id = required.variant_id
      and pv.stock_qty >= required.qty
    returning pv.id
  )
  select
    (select count(*) from required),
    (select count(*) from updated)
  into v_required_count, v_updated_count;

  if v_required_count = 0 then
    raise exception 'order requires at least one item'
      using errcode = '22023', hint = 'invalid_order_items';
  end if;

  if v_required_count <> v_updated_count then
    raise exception 'insufficient stock for order'
      using errcode = 'P0001', hint = 'insufficient_stock';
  end if;

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

revoke all on function public.create_and_confirm_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb, text, text, int, timestamptz
)
from public, anon, authenticated;

grant execute on function public.create_and_confirm_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb, text, text, int, timestamptz
)
to service_role;

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
    with required as (
      select oi.variant_id, sum(oi.qty)::int as qty
      from public.order_items oi
      where oi.org_id = p_org_id
        and oi.order_id = p_order_id
      group by oi.variant_id
    )
    update public.product_variants pv
    set stock_qty = pv.stock_qty + required.qty,
        updated_at = v_at
    from required
    where pv.org_id = p_org_id
      and pv.id = required.variant_id;
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

revoke all on function public.cancel_order(uuid, uuid, timestamptz)
from public, anon, authenticated;

grant execute on function public.cancel_order(uuid, uuid, timestamptz)
to service_role;

create or replace function public.ship_order(
  p_org_id uuid,
  p_order_id uuid,
  p_shipped_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_at timestamptz := coalesce(p_shipped_at, now());
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

  if v_order.status in ('shipped', 'done') then
    return private.order_lifecycle_payload(p_org_id, p_order_id);
  end if;

  if v_order.status <> 'confirmed' then
    raise exception 'order cannot be shipped from status %', v_order.status
      using errcode = 'P0001', hint = 'invalid_order_status';
  end if;

  update public.orders
  set status = 'shipped',
      shipped_at = v_at,
      updated_at = v_at
  where org_id = p_org_id
    and id = p_order_id;

  return private.order_lifecycle_payload(p_org_id, p_order_id);
end;
$$;

revoke all on function public.ship_order(uuid, uuid, timestamptz)
from public, anon, authenticated;

grant execute on function public.ship_order(uuid, uuid, timestamptz)
to service_role;
