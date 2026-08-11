-- Atomically pause bot handling and advance the epoch for human takeover.

create or replace function public.takeover_inbox_conversation(
  p_org_id uuid,
  p_conversation_id uuid,
  p_updated_at timestamptz default now()
)
returns table (
  id uuid,
  org_id uuid,
  channel text,
  channel_connection_id uuid,
  contact_id uuid,
  status text,
  bot_paused boolean,
  bot_epoch int,
  assignee_user_id uuid,
  last_message_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  update public.conversations
  set
    bot_paused = true,
    bot_epoch = bot_epoch + 1,
    updated_at = p_updated_at
  where id = p_conversation_id
    and org_id = p_org_id
  returning
    id,
    org_id,
    channel,
    channel_connection_id,
    contact_id,
    status,
    bot_paused,
    bot_epoch,
    assignee_user_id,
    last_message_at,
    created_at,
    updated_at;
$$;

revoke all on function public.takeover_inbox_conversation(
  uuid,
  uuid,
  timestamptz
)
from public, anon, authenticated;

grant execute on function public.takeover_inbox_conversation(
  uuid,
  uuid,
  timestamptz
)
to service_role;
