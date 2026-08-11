-- Plan F Wave 2B: shipping carrier connections and shipment records.

alter table public.orders
  add column if not exists shipping_fee_vnd bigint not null default 0;

alter table public.orders
  drop constraint if exists orders_shipping_fee_vnd_nonneg;

alter table public.orders
  add constraint orders_shipping_fee_vnd_nonneg
  check (shipping_fee_vnd >= 0);

create table if not exists public.carrier_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  display_name text not null,
  credentials_enc text,
  config_json jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carrier_connections_provider_check check (provider in ('manual', 'ghn')),
  constraint carrier_connections_config_object_check check (jsonb_typeof(config_json) = 'object'),
  constraint carrier_connections_org_provider_key unique (org_id, provider)
);

create index if not exists carrier_connections_org_id_idx
  on public.carrier_connections (org_id);

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete restrict,
  carrier_connection_id uuid references public.carrier_connections(id) on delete set null,
  provider text not null,
  external_shipment_id text,
  tracking_code text,
  status text not null default 'created',
  fee_vnd bigint not null default 0,
  label_url text,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipments_provider_check check (provider in ('manual', 'ghn')),
  constraint shipments_status_check check (
    status in (
      'created',
      'picking',
      'delivering',
      'delivered',
      'cancelled',
      'failed'
    )
  ),
  constraint shipments_fee_vnd_nonneg check (fee_vnd >= 0),
  constraint shipments_raw_object_check check (jsonb_typeof(raw_json) = 'object')
);

create index if not exists shipments_org_created_idx
  on public.shipments (org_id, created_at desc);

create index if not exists shipments_org_order_created_idx
  on public.shipments (org_id, order_id, created_at desc);

alter table public.carrier_connections enable row level security;
alter table public.shipments enable row level security;

drop policy if exists carrier_connections_select_member on public.carrier_connections;
create policy carrier_connections_select_member
  on public.carrier_connections
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists carrier_connections_service_role_all on public.carrier_connections;
create policy carrier_connections_service_role_all
  on public.carrier_connections
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists shipments_select_member on public.shipments;
create policy shipments_select_member
  on public.shipments
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists shipments_service_role_all on public.shipments;
create policy shipments_service_role_all
  on public.shipments
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table
  public.carrier_connections,
  public.shipments
from anon, authenticated;

grant select on table
  public.carrier_connections,
  public.shipments
to authenticated;

grant all on table
  public.carrier_connections,
  public.shipments
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
