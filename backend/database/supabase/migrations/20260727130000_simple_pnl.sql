-- Plan F Wave 2E: simple P&L with variant COGS and order-item COGS snapshots.

alter table public.product_variants
  add column if not exists cogs_vnd bigint not null default 0;

alter table public.product_variants
  drop constraint if exists product_variants_cogs_vnd_nonnegative_check;

alter table public.product_variants
  add constraint product_variants_cogs_vnd_nonnegative_check
  check (cogs_vnd >= 0);

alter table public.order_items
  add column if not exists cogs_unit_vnd bigint not null default 0;

alter table public.order_items
  drop constraint if exists order_items_cogs_unit_vnd_nonnegative_check;

alter table public.order_items
  add constraint order_items_cogs_unit_vnd_nonnegative_check
  check (cogs_unit_vnd >= 0);

create or replace function public.create_product_with_variants_and_reindex(
  p_org_id uuid,
  p_title text,
  p_description text,
  p_status text,
  p_attrs_json jsonb,
  p_variants jsonb
)
returns table (
  product jsonb,
  variants jsonb,
  outbox_event_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_variants jsonb := '[]'::jsonb;
  v_outbox_event_id uuid;
begin
  insert into public.products (org_id, title, description, status, attrs_json)
  values (
    p_org_id,
    p_title,
    p_description,
    p_status,
    coalesce(p_attrs_json, '{}'::jsonb)
  )
  returning * into v_product;

  if p_variants is not null and jsonb_array_length(p_variants) > 0 then
    insert into public.product_variants (
      org_id,
      product_id,
      sku,
      title,
      price_vnd,
      stock_qty,
      cogs_vnd,
      attrs_json
    )
    select
      p_org_id,
      v_product.id,
      v.sku,
      v.title,
      v.price_vnd::bigint,
      coalesce(v.stock_qty, 0),
      coalesce(nullif(v.cogs_vnd, ''), '0')::bigint,
      coalesce(v.attrs_json, '{}'::jsonb)
    from jsonb_to_recordset(p_variants) as v(
      sku text,
      title text,
      price_vnd text,
      stock_qty int,
      cogs_vnd text,
      attrs_json jsonb
    );

    select coalesce(jsonb_agg(to_jsonb(pv) order by pv.created_at), '[]'::jsonb)
    into v_variants
    from public.product_variants pv
    where pv.product_id = v_product.id;
  end if;

  insert into public.outbox_events (
    org_id,
    event_name,
    payload_json,
    published_at,
    attempts
  )
  values (
    p_org_id,
    'knowledge.reindex',
    jsonb_build_object(
      'orgId', p_org_id,
      'sourceType', 'product',
      'sourceId', v_product.id
    ),
    null,
    0
  )
  returning id into v_outbox_event_id;

  return query
  select to_jsonb(v_product), v_variants, v_outbox_event_id;
end;
$$;

revoke all on function public.create_product_with_variants_and_reindex(
  uuid,
  text,
  text,
  text,
  jsonb,
  jsonb
)
from public, anon, authenticated;

grant execute on function public.create_product_with_variants_and_reindex(
  uuid,
  text,
  text,
  text,
  jsonb,
  jsonb
)
to service_role;

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
          'lineTotalVnd', oi.line_total_vnd::text,
          'cogsUnitVnd', oi.cogs_unit_vnd::text
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
      'shippingFeeVnd', o.shipping_fee_vnd::text,
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

create or replace function public.create_draft_order(
  p_org_id uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_payment_method text,
  p_customer_name text,
  p_phone_e164 text,
  p_address_text text,
  p_address_json jsonb,
  p_idempotency_key text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_items jsonb;
  v_subtotal bigint;
begin
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'draft order requires at least one item'
      using errcode = '22023';
  end if;

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
    p_idempotency_key,
    now()
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
    line_total_vnd,
    cogs_unit_vnd
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
    (item->>'line_total_vnd')::bigint,
    coalesce(nullif(item->>'cogs_unit_vnd', ''), '0')::bigint
  from jsonb_array_elements(p_items) as items(item);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'productId', product_id,
        'variantId', variant_id,
        'titleSnapshot', title_snapshot,
        'skuSnapshot', sku_snapshot,
        'qty', qty,
        'unitPriceVnd', unit_price_vnd::text,
        'lineTotalVnd', line_total_vnd::text,
        'cogsUnitVnd', cogs_unit_vnd::text
      )
      order by id
    ),
    '[]'::jsonb
  )
  into v_items
  from public.order_items
  where order_id = v_order.id;

  return jsonb_build_object(
    'order',
    jsonb_build_object(
      'id', v_order.id,
      'orgId', v_order.org_id,
      'conversationId', v_order.conversation_id,
      'contactId', v_order.contact_id,
      'status', v_order.status,
      'paymentMethod', v_order.payment_method,
      'customerName', v_order.customer_name,
      'phoneE164', v_order.phone_e164,
      'addressText', v_order.address_text,
      'addressJson', v_order.address_json,
      'currency', v_order.currency,
      'subtotalVnd', v_order.subtotal_vnd::text,
      'shippingFeeVnd', v_order.shipping_fee_vnd::text,
      'totalVnd', v_order.total_vnd::text,
      'idempotencyKey', v_order.idempotency_key,
      'confirmedAt', v_order.confirmed_at,
      'shippedAt', v_order.shipped_at,
      'cancelledAt', v_order.cancelled_at,
      'doneAt', v_order.done_at,
      'createdAt', v_order.created_at,
      'updatedAt', v_order.updated_at
    ),
    'items',
    v_items
  );
end;
$$;

revoke all on function public.create_draft_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb
)
from public, anon, authenticated;

grant execute on function public.create_draft_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb
)
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
    line_total_vnd,
    cogs_unit_vnd
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
    (item->>'line_total_vnd')::bigint,
    coalesce(nullif(item->>'cogs_unit_vnd', ''), '0')::bigint
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

revoke all on function public.create_and_confirm_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb, text, text, int, timestamptz
)
from public, anon, authenticated;

grant execute on function public.create_and_confirm_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb, text, text, int, timestamptz
)
to service_role;
