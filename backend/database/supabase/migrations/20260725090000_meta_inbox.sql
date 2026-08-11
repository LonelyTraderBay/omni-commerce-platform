-- channel_connections, contacts, conversations, messages, webhook_receipts
-- RLS: authenticated SELECT where org membership; no INSERT/UPDATE/DELETE for authenticated

create table public.channel_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  external_page_id text not null,
  external_ig_id text,
  access_token_enc text not null,
  refresh_token_enc text,
  token_expires_at timestamptz,
  status text not null default 'active',
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_connections_provider_check check (provider in ('meta_page', 'meta_ig')),
  constraint channel_connections_status_check check (status in ('active', 'needs_reauth', 'revoked')),
  constraint channel_connections_org_id_provider_external_page_id_key
    unique (org_id, provider, external_page_id)
);

create index channel_connections_org_id_idx on public.channel_connections (org_id);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  display_name text,
  phone_e164 text,
  page_scoped_id text,
  ig_scoped_id text,
  tags_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contacts_org_id_idx on public.contacts (org_id);

create unique index contacts_org_id_page_scoped_id_idx
  on public.contacts (org_id, page_scoped_id)
  where page_scoped_id is not null;

create unique index contacts_org_id_ig_scoped_id_idx
  on public.contacts (org_id, ig_scoped_id)
  where ig_scoped_id is not null;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel text not null,
  channel_connection_id uuid not null references public.channel_connections(id) on delete restrict,
  contact_id uuid not null references public.contacts(id) on delete restrict,
  status text not null,
  bot_paused boolean not null default false,
  bot_epoch int not null default 0,
  assignee_user_id uuid references auth.users(id) on delete set null,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_channel_check check (channel in ('messenger', 'instagram'))
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  direction text not null,
  sender_type text not null,
  raw_type text not null,
  body_text text,
  payload_json jsonb not null default '{}'::jsonb,
  provider_message_id text,
  created_at timestamptz not null default now(),
  constraint messages_direction_check check (direction in ('inbound', 'outbound')),
  constraint messages_sender_type_check check (sender_type in ('customer', 'ai', 'staff', 'system'))
);

create unique index messages_org_id_provider_message_id_idx
  on public.messages (org_id, provider_message_id)
  where provider_message_id is not null;

create table public.webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  receipt_key text not null,
  org_id uuid references public.organizations(id) on delete set null,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  constraint webhook_receipts_provider_receipt_key_key unique (provider, receipt_key)
);

alter table public.channel_connections enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.webhook_receipts enable row level security;

create policy channel_connections_select_member
  on public.channel_connections
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy contacts_select_member
  on public.contacts
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy conversations_select_member
  on public.conversations
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy messages_select_member
  on public.messages
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy webhook_receipts_select_member
  on public.webhook_receipts
  for select
  to authenticated
  using (org_id is not null and private.is_org_member(org_id));

revoke all on table
  public.channel_connections,
  public.contacts,
  public.conversations,
  public.messages,
  public.webhook_receipts
from anon, authenticated;

grant select on table
  public.channel_connections,
  public.contacts,
  public.conversations,
  public.messages,
  public.webhook_receipts
to authenticated;

grant all on table
  public.channel_connections,
  public.contacts,
  public.conversations,
  public.messages,
  public.webhook_receipts
to service_role;
