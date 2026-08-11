-- Plan G Wave 3A: ad spend imported per org/campaign/day.

create table if not exists public.ad_spend (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source text not null,
  date date not null,
  campaign_name text not null,
  amount_vnd bigint not null,
  external_id text,
  created_at timestamptz not null default now(),
  constraint ad_spend_source_check check (source in ('meta_ads', 'csv')),
  constraint ad_spend_campaign_name_nonempty check (btrim(campaign_name) <> ''),
  constraint ad_spend_amount_vnd_nonnegative check (amount_vnd >= 0)
);

create index if not exists ad_spend_org_date_idx
  on public.ad_spend (org_id, date desc);

create index if not exists ad_spend_org_campaign_date_idx
  on public.ad_spend (org_id, campaign_name, date desc);

create unique index if not exists ad_spend_org_source_external_id_idx
  on public.ad_spend (org_id, source, external_id)
  where external_id is not null;

alter table public.ad_spend enable row level security;

drop policy if exists ad_spend_select_member on public.ad_spend;
create policy ad_spend_select_member
  on public.ad_spend
  for select
  to authenticated
  using (private.is_org_member(org_id));

revoke all on table public.ad_spend from anon, authenticated;
grant select on table public.ad_spend to authenticated;
grant all on table public.ad_spend to service_role;
