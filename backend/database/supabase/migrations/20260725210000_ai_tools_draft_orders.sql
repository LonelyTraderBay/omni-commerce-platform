-- Minimal draft orders for Core-owned AI tools.
-- RLS: authenticated SELECT via org membership; writes via service_role RPC only.

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  status text not null default 'draft',
  payment_method text not null default 'cod',
  customer_name text,
  phone_e164 text,
  address_text text,
  address_json jsonb not null default '{}'::jsonb,
  currency text not null default 'VND',
  subtotal_vnd bigint not null default 0,
  total_vnd bigint not null default 0,
  idempotency_key text,
  confirmed_at timestamptz,
  shipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_status_check
    check (status in ('draft', 'confirmed', 'shipped', 'done', 'cancelled', 'returned')),
  constraint orders_payment_method_check
    check (payment_method in ('cod', 'bank_transfer', 'other')),
  constraint orders_currency_check check (currency = 'VND'),
  constraint orders_amounts_nonnegative_check
    check (subtotal_vnd >= 0 and total_vnd >= 0)
);

create index orders_org_id_created_at_idx on public.orders (org_id, created_at);
create index orders_conversation_id_idx on public.orders (conversation_id);
create unique index orders_org_id_idempotency_key_idx
  on public.orders (org_id, idempotency_key)
  where idempotency_key is not null;

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  title_snapshot text not null,
  sku_snapshot text not null,
  qty int not null,
  unit_price_vnd bigint not null,
  line_total_vnd bigint not null,
  constraint order_items_qty_check check (qty > 0),
  constraint order_items_amounts_nonnegative_check
    check (unit_price_vnd >= 0 and line_total_vnd >= 0)
);

create index order_items_org_id_idx on public.order_items (org_id);
create index order_items_order_id_idx on public.order_items (order_id);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create policy orders_select_member
  on public.orders
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy order_items_select_member
  on public.order_items
  for select
  to authenticated
  using (private.is_org_member(org_id));

revoke all on table
  public.orders,
  public.order_items
from anon, authenticated;

grant select on table
  public.orders,
  public.order_items
to authenticated;

grant all on table
  public.orders,
  public.order_items
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
        'lineTotalVnd', line_total_vnd::text
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
      'totalVnd', v_order.total_vnd::text,
      'idempotencyKey', v_order.idempotency_key,
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
