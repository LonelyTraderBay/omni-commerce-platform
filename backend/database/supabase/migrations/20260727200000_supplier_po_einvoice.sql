-- Plan H Waves 4B/4C: suppliers, purchase orders, PO receiving, and e-invoice jobs.

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  tax_code text,
  email text,
  phone text,
  address_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_org_id_id_key unique (org_id, id),
  constraint suppliers_name_nonempty_check check (btrim(name) <> ''),
  constraint suppliers_tax_code_nonempty_check check (
    tax_code is null or btrim(tax_code) <> ''
  )
);

create index if not exists suppliers_org_created_idx
  on public.suppliers (org_id, created_at desc);

create unique index if not exists suppliers_org_tax_code_key
  on public.suppliers (org_id, tax_code)
  where tax_code is not null;

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  supplier_id uuid not null,
  warehouse_id uuid,
  status text not null default 'draft',
  note text,
  ordered_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_orders_org_id_id_key unique (org_id, id),
  constraint purchase_orders_org_supplier_fkey foreign key (org_id, supplier_id)
    references public.suppliers (org_id, id) on delete restrict,
  constraint purchase_orders_org_warehouse_fkey foreign key (org_id, warehouse_id)
    references public.warehouses (org_id, id) on delete set null,
  constraint purchase_orders_status_check check (
    status in ('draft', 'ordered', 'received', 'cancelled')
  )
);

create index if not exists purchase_orders_org_status_created_idx
  on public.purchase_orders (org_id, status, created_at desc);

create index if not exists purchase_orders_org_supplier_created_idx
  on public.purchase_orders (org_id, supplier_id, created_at desc);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  purchase_order_id uuid not null,
  variant_id uuid not null,
  qty int not null,
  unit_cost_vnd bigint not null,
  created_at timestamptz not null default now(),
  constraint purchase_order_items_org_po_fkey foreign key (org_id, purchase_order_id)
    references public.purchase_orders (org_id, id) on delete cascade,
  constraint purchase_order_items_org_variant_fkey foreign key (org_id, variant_id)
    references public.product_variants (org_id, id) on delete restrict,
  constraint purchase_order_items_qty_positive_check check (qty > 0),
  constraint purchase_order_items_unit_cost_nonnegative_check check (unit_cost_vnd >= 0)
);

create index if not exists purchase_order_items_org_po_idx
  on public.purchase_order_items (org_id, purchase_order_id);

create index if not exists purchase_order_items_org_variant_idx
  on public.purchase_order_items (org_id, variant_id);

create table if not exists public.einvoice_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete restrict,
  provider text not null default 'stub',
  status text not null default 'pending',
  attempts int not null default 0,
  last_error text,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint einvoice_jobs_provider_check check (provider in ('stub')),
  constraint einvoice_jobs_status_check check (
    status in ('pending', 'sent', 'failed', 'dead')
  ),
  constraint einvoice_jobs_attempts_nonnegative_check check (attempts >= 0),
  constraint einvoice_jobs_payload_object_check check (
    jsonb_typeof(payload_json) = 'object'
  )
);

create index if not exists einvoice_jobs_org_status_created_idx
  on public.einvoice_jobs (org_id, status, created_at desc);

create index if not exists einvoice_jobs_org_order_created_idx
  on public.einvoice_jobs (org_id, order_id, created_at desc);

alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.einvoice_jobs enable row level security;

drop policy if exists suppliers_select_member on public.suppliers;
create policy suppliers_select_member
  on public.suppliers
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists purchase_orders_select_member on public.purchase_orders;
create policy purchase_orders_select_member
  on public.purchase_orders
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists purchase_order_items_select_member on public.purchase_order_items;
create policy purchase_order_items_select_member
  on public.purchase_order_items
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists einvoice_jobs_select_member on public.einvoice_jobs;
create policy einvoice_jobs_select_member
  on public.einvoice_jobs
  for select
  to authenticated
  using (private.is_org_member(org_id));

revoke all on table
  public.suppliers,
  public.purchase_orders,
  public.purchase_order_items,
  public.einvoice_jobs
from anon, authenticated;

grant select on table
  public.suppliers,
  public.purchase_orders,
  public.purchase_order_items,
  public.einvoice_jobs
to authenticated;

grant all on table
  public.suppliers,
  public.purchase_orders,
  public.purchase_order_items,
  public.einvoice_jobs
to service_role;

create or replace function public.receive_po(
  p_org_id uuid,
  p_purchase_order_id uuid,
  p_warehouse_id uuid,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchase_orders%rowtype;
  v_warehouse public.warehouses%rowtype;
  v_required_count int;
  v_movement_count int;
  v_at timestamptz := now();
begin
  select *
  into v_po
  from public.purchase_orders
  where org_id = p_org_id
    and id = p_purchase_order_id
  for update;

  if not found then
    raise exception 'purchase order not found'
      using errcode = 'P0001', hint = 'purchase_order_not_found';
  end if;

  if v_po.status = 'received' then
    return jsonb_build_object(
      'purchaseOrderId', v_po.id,
      'status', v_po.status,
      'receivedAt', v_po.received_at,
      'movements', jsonb_build_array()
    );
  end if;

  if v_po.status not in ('draft', 'ordered') then
    raise exception 'purchase order cannot be received from status %', v_po.status
      using errcode = 'P0001', hint = 'invalid_purchase_order_status';
  end if;

  select *
  into v_warehouse
  from public.warehouses
  where org_id = p_org_id
    and id = p_warehouse_id
  for update;

  if not found then
    raise exception 'warehouse not found'
      using errcode = 'P0001', hint = 'warehouse_not_found';
  end if;

  select count(*)::int
  into v_required_count
  from public.purchase_order_items
  where org_id = p_org_id
    and purchase_order_id = p_purchase_order_id;

  if v_required_count = 0 then
    raise exception 'purchase order requires at least one item'
      using errcode = '22023', hint = 'invalid_purchase_order_items';
  end if;

  insert into public.variant_stocks (org_id, warehouse_id, variant_id, qty)
  select p_org_id, p_warehouse_id, poi.variant_id, 0
  from public.purchase_order_items poi
  where poi.org_id = p_org_id
    and poi.purchase_order_id = p_purchase_order_id
  on conflict (org_id, warehouse_id, variant_id) do nothing;

  perform 1
  from public.variant_stocks vs
  join public.purchase_order_items poi
    on poi.org_id = vs.org_id
   and poi.variant_id = vs.variant_id
  where vs.org_id = p_org_id
    and vs.warehouse_id = p_warehouse_id
    and poi.purchase_order_id = p_purchase_order_id
  order by vs.variant_id
  for update;

  with received as (
    update public.variant_stocks vs
    set qty = vs.qty + poi.qty
    from public.purchase_order_items poi
    where vs.org_id = p_org_id
      and vs.warehouse_id = p_warehouse_id
      and vs.variant_id = poi.variant_id
      and poi.org_id = p_org_id
      and poi.purchase_order_id = p_purchase_order_id
    returning vs.variant_id, vs.qty as warehouse_stock_after, poi.qty
  ),
  totals as (
    update public.product_variants pv
    set stock_qty = summed.total_qty,
        cogs_vnd = poi.unit_cost_vnd,
        updated_at = v_at
    from (
      select vs.variant_id, coalesce(sum(vs.qty), 0)::int as total_qty
      from public.variant_stocks vs
      join received r on r.variant_id = vs.variant_id
      where vs.org_id = p_org_id
      group by vs.variant_id
    ) summed
    join public.purchase_order_items poi
      on poi.org_id = p_org_id
     and poi.purchase_order_id = p_purchase_order_id
     and poi.variant_id = summed.variant_id
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
      reason,
      actor_user_id,
      created_at
    )
    select
      p_org_id,
      p_warehouse_id,
      r.variant_id,
      'inbound',
      r.qty,
      t.stock_after,
      'receive_po:' || p_purchase_order_id::text,
      p_actor_user_id,
      v_at
    from received r
    join totals t on t.variant_id = r.variant_id
    returning id, variant_id, qty_delta, stock_after
  )
  select count(*)::int
  into v_movement_count
  from logged;

  if v_movement_count <> v_required_count then
    raise exception 'purchase order receive mismatch'
      using errcode = 'P0001', hint = 'purchase_order_receive_mismatch';
  end if;

  update public.purchase_orders
  set status = 'received',
      warehouse_id = p_warehouse_id,
      received_at = v_at,
      ordered_at = coalesce(ordered_at, v_at),
      updated_at = v_at
  where org_id = p_org_id
    and id = p_purchase_order_id
  returning * into v_po;

  return jsonb_build_object(
    'purchaseOrderId', v_po.id,
    'warehouseId', p_warehouse_id,
    'status', v_po.status,
    'receivedAt', v_po.received_at,
    'movements',
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', sm.id,
              'orgId', sm.org_id,
              'warehouseId', sm.warehouse_id,
              'variantId', sm.variant_id,
              'movementType', sm.movement_type,
              'qtyDelta', sm.qty_delta,
              'stockAfter', sm.stock_after,
              'orderId', sm.order_id,
              'reason', sm.reason,
              'actorUserId', sm.actor_user_id,
              'createdAt', sm.created_at
            )
            order by sm.created_at, sm.id
          )
          from public.stock_movements sm
          where sm.org_id = p_org_id
            and sm.warehouse_id = p_warehouse_id
            and sm.reason = 'receive_po:' || p_purchase_order_id::text
            and sm.created_at = v_at
        ),
        jsonb_build_array()
      )
  );
end;
$$;

revoke all on function public.receive_po(uuid, uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function public.receive_po(uuid, uuid, uuid, uuid)
to service_role;
