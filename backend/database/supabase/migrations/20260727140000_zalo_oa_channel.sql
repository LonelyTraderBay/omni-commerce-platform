-- Zalo OA connector skeleton: allow provider/channel values and atomically
-- receipt inbound webhooks before enqueueing the provider-specific stub event.

alter table public.channel_connections
  drop constraint if exists channel_connections_provider_check;

alter table public.channel_connections
  add constraint channel_connections_provider_check
  check (provider in ('meta_page', 'meta_ig', 'zalo_oa'));

alter table public.conversations
  drop constraint if exists conversations_channel_check;

alter table public.conversations
  add constraint conversations_channel_check
  check (channel in ('messenger', 'instagram', 'zalo'));

create or replace function public.record_zalo_webhook_receipt_and_enqueue(
  p_org_id uuid,
  p_payload_hash text,
  p_payload_json jsonb,
  p_receipt_key text
)
returns table (
  receipt_inserted boolean,
  receipt_id uuid,
  outbox_event_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt_id uuid;
  v_outbox_event_id uuid;
begin
  insert into public.webhook_receipts (
    provider,
    receipt_key,
    org_id,
    payload_hash
  )
  values (
    'zalo',
    p_receipt_key,
    p_org_id,
    p_payload_hash
  )
  on conflict (provider, receipt_key) do nothing
  returning id into v_receipt_id;

  if v_receipt_id is null then
    return query
    select false, null::uuid, null::uuid;
    return;
  end if;

  if p_org_id is not null then
    insert into public.outbox_events (
      org_id,
      event_name,
      payload_json,
      published_at,
      attempts
    )
    values (
      p_org_id,
      'zalo/inbound.received',
      coalesce(p_payload_json, '{}'::jsonb),
      null,
      0
    )
    returning id into v_outbox_event_id;
  end if;

  return query
  select true, v_receipt_id, v_outbox_event_id;
end;
$$;

revoke all on function public.record_zalo_webhook_receipt_and_enqueue(
  uuid,
  text,
  jsonb,
  text
)
from public, anon, authenticated;

grant execute on function public.record_zalo_webhook_receipt_and_enqueue(
  uuid,
  text,
  jsonb,
  text
)
to service_role;
