alter table public.orders
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists click_id text;

alter table public.orders
  drop constraint if exists orders_attribution_length_check,
  add constraint orders_attribution_length_check
    check (
      (utm_source is null or length(utm_source) <= 512)
      and (utm_medium is null or length(utm_medium) <= 512)
      and (utm_campaign is null or length(utm_campaign) <= 512)
      and (click_id is null or length(click_id) <= 512)
    );

create index if not exists orders_org_utm_source_created_at_idx
  on public.orders (org_id, utm_source, created_at desc)
  where utm_source is not null;

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
      'utmSource', o.utm_source,
      'utmMedium', o.utm_medium,
      'utmCampaign', o.utm_campaign,
      'clickId', o.click_id,
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

drop function if exists public.create_draft_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb
);

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
  p_items jsonb,
  p_utm_source text default null,
  p_utm_medium text default null,
  p_utm_campaign text default null,
  p_click_id text default null
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
    utm_source,
    utm_medium,
    utm_campaign,
    click_id,
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
    nullif(btrim(p_utm_source), ''),
    nullif(btrim(p_utm_medium), ''),
    nullif(btrim(p_utm_campaign), ''),
    nullif(btrim(p_click_id), ''),
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
      'utmSource', v_order.utm_source,
      'utmMedium', v_order.utm_medium,
      'utmCampaign', v_order.utm_campaign,
      'clickId', v_order.click_id,
      'createdAt', v_order.created_at,
      'updatedAt', v_order.updated_at
    ),
    'items',
    v_items
  );
end;
$$;

revoke all on function public.create_draft_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb, text, text, text, text
)
from public, anon, authenticated;

grant execute on function public.create_draft_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb, text, text, text, text
)
to service_role;

drop function if exists public.create_and_confirm_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb, text, text, int, timestamptz
);

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
  p_confirmed_at timestamptz default now(),
  p_utm_source text default null,
  p_utm_medium text default null,
  p_utm_campaign text default null,
  p_click_id text default null
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
    utm_source,
    utm_medium,
    utm_campaign,
    click_id,
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
    nullif(btrim(p_utm_source), ''),
    nullif(btrim(p_utm_medium), ''),
    nullif(btrim(p_utm_campaign), ''),
    nullif(btrim(p_click_id), ''),
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
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb, text, text, int, timestamptz, text, text, text, text
)
from public, anon, authenticated;

grant execute on function public.create_and_confirm_order(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, jsonb, text, text, int, timestamptz, text, text, text, text
)
to service_role;
