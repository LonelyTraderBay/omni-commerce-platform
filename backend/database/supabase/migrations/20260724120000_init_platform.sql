create extension if not exists pgcrypto;

create schema if not exists private;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default 'free',
  settings_json jsonb not null default '{}'::jsonb,
  timezone text not null default 'Asia/Ho_Chi_Minh',
  locale text not null default 'vi',
  suspended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.organizations.settings_json is
  'Example shape: { "aiDraftMaxAmountVnd": 5000000, "allowCskhApprove": false }';

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_role_check check (role in ('owner', 'cskh', 'kho')),
  constraint memberships_org_id_user_id_key unique (org_id, user_id)
);

create index memberships_user_id_idx on public.memberships (user_id);

create table public.membership_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint membership_invites_role_check check (role in ('owner', 'cskh', 'kho'))
);

create index membership_invites_org_id_email_idx on public.membership_invites (org_id, email);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.entitlements (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  max_pages int not null default 0,
  ai_monthly_token_limit bigint not null default 0,
  auto_confirm_allowed boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  org_id uuid references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  payload_json jsonb not null default '{}'::jsonb,
  constraint feature_flags_key_org_id_key unique (key, org_id)
);

create unique index feature_flags_global_key_idx
  on public.feature_flags (key)
  where org_id is null;

create index feature_flags_org_id_idx on public.feature_flags (org_id);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null,
  quantity bigint not null,
  ref_type text,
  ref_id uuid,
  created_at timestamptz not null default now()
);

create index usage_events_org_id_created_at_idx on public.usage_events (org_id, created_at);

create table public.job_dead_letters (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  payload_json jsonb not null default '{}'::jsonb,
  error_text text not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  event_name text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts int not null default 0
);

create index outbox_events_published_at_unpublished_idx
  on public.outbox_events (published_at)
  where published_at is null;

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_type text not null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  meta_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_logs_actor_type_check check (actor_type in ('user', 'system', 'ai', 'platform'))
);

create index audit_logs_org_id_created_at_idx on public.audit_logs (org_id, created_at);

create or replace function private.is_org_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = check_org_id
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;
revoke all on function private.is_org_member(uuid) from public;
grant execute on function private.is_org_member(uuid) to authenticated, service_role;

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.membership_invites enable row level security;
alter table public.platform_admins enable row level security;
alter table public.entitlements enable row level security;
alter table public.feature_flags enable row level security;
alter table public.usage_events enable row level security;
alter table public.job_dead_letters enable row level security;
alter table public.outbox_events enable row level security;
alter table public.audit_logs enable row level security;

create policy organizations_select_member
  on public.organizations
  for select
  to authenticated
  using (private.is_org_member(id));

create policy organizations_update_member
  on public.organizations
  for update
  to authenticated
  using (private.is_org_member(id))
  with check (private.is_org_member(id));

create policy memberships_select_member
  on public.memberships
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy memberships_update_member
  on public.memberships
  for update
  to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

create policy membership_invites_select_member
  on public.membership_invites
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy membership_invites_update_member
  on public.membership_invites
  for update
  to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

create policy entitlements_select_member
  on public.entitlements
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy entitlements_update_member
  on public.entitlements
  for update
  to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

create policy feature_flags_select_member_or_global
  on public.feature_flags
  for select
  to authenticated
  using (org_id is null or private.is_org_member(org_id));

create policy feature_flags_update_member
  on public.feature_flags
  for update
  to authenticated
  using (org_id is not null and private.is_org_member(org_id))
  with check (org_id is not null and private.is_org_member(org_id));

create policy usage_events_select_member
  on public.usage_events
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy usage_events_update_member
  on public.usage_events
  for update
  to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

create policy outbox_events_select_member
  on public.outbox_events
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy outbox_events_update_member
  on public.outbox_events
  for update
  to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

create policy audit_logs_select_member
  on public.audit_logs
  for select
  to authenticated
  using (org_id is not null and private.is_org_member(org_id));

revoke all on table
  public.organizations,
  public.memberships,
  public.membership_invites,
  public.platform_admins,
  public.entitlements,
  public.feature_flags,
  public.usage_events,
  public.job_dead_letters,
  public.outbox_events,
  public.audit_logs
from anon, authenticated;

grant select, update on table
  public.organizations,
  public.memberships,
  public.membership_invites,
  public.entitlements,
  public.feature_flags,
  public.usage_events,
  public.outbox_events
to authenticated;

grant select on table public.audit_logs to authenticated;

grant all on table
  public.organizations,
  public.memberships,
  public.membership_invites,
  public.platform_admins,
  public.entitlements,
  public.feature_flags,
  public.usage_events,
  public.job_dead_letters,
  public.outbox_events,
  public.audit_logs
to service_role;
