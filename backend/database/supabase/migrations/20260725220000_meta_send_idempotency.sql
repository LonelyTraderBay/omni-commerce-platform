-- Idempotency records for Meta outbound sends and AI inbound processing.

create table public.meta_outbound_sends (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  inbound_message_id uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  status text not null,
  provider_message_id text,
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_outbound_sends_inbound_message_id_key unique (inbound_message_id),
  constraint meta_outbound_sends_status_check check (status in ('sending', 'sent', 'failed'))
);

create index meta_outbound_sends_org_id_idx
  on public.meta_outbound_sends (org_id);

create unique index outbox_events_ai_process_inbound_message_id_idx
  on public.outbox_events (
    org_id,
    event_name,
    ((payload_json ->> 'messageId'))
  )
  where event_name = 'ai.process_inbound'
    and payload_json ? 'messageId';

alter table public.meta_outbound_sends enable row level security;

create policy meta_outbound_sends_select_member
  on public.meta_outbound_sends
  for select
  to authenticated
  using (private.is_org_member(org_id));

revoke all on table public.meta_outbound_sends from anon, authenticated;
grant select on table public.meta_outbound_sends to authenticated;
grant all on table public.meta_outbound_sends to service_role;
