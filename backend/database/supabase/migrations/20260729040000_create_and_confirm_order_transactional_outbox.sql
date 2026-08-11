-- Wave P0.5d — the auto-confirm order path loses its lifecycle events.
--
-- public.create_and_confirm_order (20260727170000_order_attribution.sql) commits
-- the order, its items, the stock decrement and the 201 idempotency row in ONE
-- transaction. OrdersService.createDraftOrder then made three *separate*
-- PostgREST calls afterwards: enqueue `order.created`, write the confirm audit,
-- enqueue `order.confirmed`.
--
-- A process death (deploy, OOM, kill) between the commit and those calls left an
-- order that is `confirmed` with stock already decremented, but with no outbox
-- row at all. The retry could not repair it: the committed idempotency row makes
-- this function take its `_idempotencyReplayed = true` early return, and the
-- caller skips the enqueue on that path by design. The events were gone for
-- good and every subscribed merchant webhook missed the order.
--
-- (The plain-draft path self-heals — its idempotency key is released on failure
-- and the 23505 fallback re-runs the enqueue. Only auto-confirm was lossy.)
--
-- Fix: move the two enqueues INTO this function, so they commit or roll back
-- with the order. Same technique as
-- 20260725150000_catalog_create_product_atomic.sql, which already writes its
-- `knowledge.reindex` row inside the RPC transaction.
--
-- The body below is reproduced verbatim from 20260727170000_order_attribution.sql
-- except for the single `insert into public.outbox_events` block added between
-- `v_payload := private.order_lifecycle_payload(...)` and the
-- `update public.idempotency_keys`. The signature, `language`, `security
-- definer`, `set search_path` and the revoke/grant pair are unchanged; the
-- revoke/grant are re-emitted verbatim so the function's privileges stay
-- explicit in the migration that last defined it (`create or replace` preserves
-- them either way, so re-emitting is a no-op).
--
-- The matching TypeScript enqueues are removed in the same commit — leaving them
-- would emit each event twice.

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

  -- Lifecycle events are enqueued HERE, inside the same transaction that wrote
  -- the order, its items, the stock change and the idempotency row.
  --
  -- They used to be three separate PostgREST calls made by
  -- OrdersService.createDraftOrder *after* this function had already committed.
  -- If the process died in that window the order was `confirmed` and the stock
  -- was decremented, but no outbox row existed — and the retry could never
  -- repair it, because the committed idempotency row makes this function return
  -- `_idempotencyReplayed = true` on the early-return path above, which
  -- deliberately skips the caller's enqueue. The events were lost permanently
  -- and subscribed merchant webhooks never learned the order existed.
  --
  -- Same shape as the precedent in
  -- 20260725150000_catalog_create_product_atomic.sql, and byte-identical to the
  -- rows `enqueueOutbox` (apps/api/src/jobs/outbox.publisher.ts) writes, so
  -- `order-webhook-dispatch` cannot tell the two producers apart.
  --
  -- `order.created` carries status 'draft' even though this order was never a
  -- draft: that is exactly what the TypeScript enqueue asserted, and this change
  -- is about not losing the events, not about redefining them.
  --
  -- `created_at` is set explicitly with a per-row offset because the column
  -- default is `now()` = transaction start, which would be identical for both
  -- rows and leave OutboxPublisher's `order by created_at` free to emit
  -- `order.confirmed` before `order.created`. The offset preserves the ordering
  -- the two sequential TypeScript inserts produced.
  insert into public.outbox_events (
    org_id,
    event_name,
    payload_json,
    created_at,
    published_at,
    attempts
  )
  select
    p_org_id,
    e.event_name,
    jsonb_build_object(
      'event', e.event_name,
      'orderId', v_order.id,
      'status', e.status
    ),
    clock_timestamp() + (e.ord * interval '1 microsecond'),
    null,
    0
  from (
    values
      ('order.created'::text, 'draft'::text, 0),
      ('order.confirmed'::text, 'confirmed'::text, 1)
  ) as e(event_name, status, ord);

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
