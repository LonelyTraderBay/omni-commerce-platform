-- Plan F Wave 2G: manual invoice packaging and billing status flags.

alter table public.organizations
  add column if not exists billing_customer_email text,
  add column if not exists billing_status text not null default 'active',
  add column if not exists plan_renews_at timestamptz;

update public.organizations
set billing_status = 'active'
where billing_status is null;

alter table public.organizations
  alter column billing_status set default 'active',
  alter column billing_status set not null;

alter table public.organizations
  drop constraint if exists organizations_billing_status_check;

alter table public.organizations
  add constraint organizations_billing_status_check
  check (billing_status in ('active', 'past_due', 'suspended'));

create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  amount_vnd bigint not null,
  status text not null default 'draft',
  issued_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_invoices_amount_vnd_nonnegative check (amount_vnd >= 0),
  constraint billing_invoices_period_check check (period_end > period_start),
  constraint billing_invoices_status_check check (status in ('draft', 'issued', 'paid', 'void'))
);

create index if not exists billing_invoices_org_id_period_start_idx
  on public.billing_invoices (org_id, period_start desc);

alter table public.billing_invoices enable row level security;

drop policy if exists billing_invoices_select_member on public.billing_invoices;

create policy billing_invoices_select_member
  on public.billing_invoices
  for select
  to authenticated
  using (private.is_org_member(org_id));

revoke all on table public.billing_invoices from anon, authenticated;
grant select on table public.billing_invoices to authenticated;
grant all on table public.billing_invoices to service_role;
