-- Plan F Wave 2C: COD expectations, collections, and discrepancy queue.

create table if not exists public.cod_expectations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete restrict,
  expected_vnd bigint not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  constraint cod_expectations_expected_vnd_nonneg check (expected_vnd >= 0),
  constraint cod_expectations_status_check check (
    status in ('open', 'matched', 'discrepancy', 'written_off')
  ),
  constraint cod_expectations_org_order_key unique (org_id, order_id)
);

create index if not exists cod_expectations_org_status_created_idx
  on public.cod_expectations (org_id, status, created_at desc);

create table if not exists public.cod_collections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete restrict,
  amount_vnd bigint not null,
  collected_at timestamptz not null,
  source text not null default 'manual',
  note text,
  created_at timestamptz not null default now(),
  constraint cod_collections_amount_vnd_nonneg check (amount_vnd >= 0),
  constraint cod_collections_source_check check (
    source in ('manual', 'carrier_file', 'carrier_api')
  )
);

create index if not exists cod_collections_org_order_collected_idx
  on public.cod_collections (org_id, order_id, collected_at desc);

create table if not exists public.cod_discrepancies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete restrict,
  expected_vnd bigint not null,
  collected_vnd bigint not null,
  delta_vnd bigint not null,
  status text not null default 'open',
  note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint cod_discrepancies_amounts_nonneg check (
    expected_vnd >= 0 and collected_vnd >= 0
  ),
  constraint cod_discrepancies_status_check check (status in ('open', 'resolved')),
  constraint cod_discrepancies_org_order_key unique (org_id, order_id)
);

create index if not exists cod_discrepancies_org_status_created_idx
  on public.cod_discrepancies (org_id, status, created_at desc);

alter table public.cod_expectations enable row level security;
alter table public.cod_collections enable row level security;
alter table public.cod_discrepancies enable row level security;

drop policy if exists cod_expectations_select_member on public.cod_expectations;
create policy cod_expectations_select_member
  on public.cod_expectations
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists cod_expectations_service_role_all on public.cod_expectations;
create policy cod_expectations_service_role_all
  on public.cod_expectations
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists cod_collections_select_member on public.cod_collections;
create policy cod_collections_select_member
  on public.cod_collections
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists cod_collections_service_role_all on public.cod_collections;
create policy cod_collections_service_role_all
  on public.cod_collections
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists cod_discrepancies_select_member on public.cod_discrepancies;
create policy cod_discrepancies_select_member
  on public.cod_discrepancies
  for select
  to authenticated
  using (private.is_org_member(org_id));

drop policy if exists cod_discrepancies_service_role_all on public.cod_discrepancies;
create policy cod_discrepancies_service_role_all
  on public.cod_discrepancies
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table
  public.cod_expectations,
  public.cod_collections,
  public.cod_discrepancies
from anon, authenticated;

grant select on table
  public.cod_expectations,
  public.cod_collections,
  public.cod_discrepancies
to authenticated;

grant all on table
  public.cod_expectations,
  public.cod_collections,
  public.cod_discrepancies
to service_role;

insert into public.cod_expectations (org_id, order_id, expected_vnd)
select o.org_id, o.id, o.total_vnd
from public.orders o
where o.payment_method = 'cod'
  and o.status = 'shipped'
on conflict (org_id, order_id) do nothing;
