create table public.content_calendar_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  body text,
  planned_at timestamptz not null,
  status text not null default 'idea',
  channel_hint text,
  auto_post_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_calendar_items_status_check
    check (status in ('idea', 'scheduled', 'posted', 'cancelled')),
  constraint content_calendar_items_title_length_check
    check (length(btrim(title)) between 1 and 300),
  constraint content_calendar_items_body_length_check
    check (body is null or length(body) <= 10000),
  constraint content_calendar_items_channel_hint_length_check
    check (channel_hint is null or length(channel_hint) <= 120)
);

create index content_calendar_items_org_planned_at_idx
  on public.content_calendar_items (org_id, planned_at desc);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  key_prefix text not null unique,
  key_hash text not null unique,
  scopes text[] not null default array[]::text[],
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint api_keys_name_length_check
    check (length(btrim(name)) between 1 and 120),
  constraint api_keys_prefix_check
    check (key_prefix like 'omni_%' and length(key_prefix) between 13 and 40),
  constraint api_keys_hash_check
    check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint api_keys_scopes_check
    check (scopes <@ array['orders.read']::text[])
);

create index api_keys_org_created_at_idx
  on public.api_keys (org_id, created_at desc);

create table public.outbound_webhooks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  url text not null,
  secret_enc text not null,
  events text[] not null default array[]::text[],
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outbound_webhooks_url_check
    check (url ~ '^https://'),
  constraint outbound_webhooks_events_check
    check (events <@ array['order.created','order.updated','order.cancelled','order.returned','webhook.test']::text[])
);

create index outbound_webhooks_org_created_at_idx
  on public.outbound_webhooks (org_id, created_at desc);

alter table public.content_calendar_items enable row level security;
alter table public.api_keys enable row level security;
alter table public.outbound_webhooks enable row level security;

create policy content_calendar_items_select_member
  on public.content_calendar_items
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy content_calendar_items_write_member
  on public.content_calendar_items
  for all
  to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

create policy api_keys_select_member
  on public.api_keys
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy api_keys_write_member
  on public.api_keys
  for all
  to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

create policy outbound_webhooks_select_member
  on public.outbound_webhooks
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy outbound_webhooks_write_member
  on public.outbound_webhooks
  for all
  to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

revoke all on table
  public.content_calendar_items,
  public.api_keys,
  public.outbound_webhooks
from public, anon;

grant select, insert, update, delete on table
  public.content_calendar_items,
  public.api_keys,
  public.outbound_webhooks
to authenticated, service_role;
