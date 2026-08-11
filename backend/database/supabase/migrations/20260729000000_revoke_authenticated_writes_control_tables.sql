-- Security hardening: align api_keys / outbound_webhooks / content_calendar_items
-- with the rest of the control plane (see 20260724193000_harden_control_plane_and_org_bootstrap.sql).
--
-- 20260727180000_content_calendar_public_api.sql (lines 88-118) granted
-- insert/update/delete on these three control tables to `authenticated` and added
-- permissive `*_write_member` RLS policies (for all ... is_org_member(org_id)).
-- That let ANY authenticated org member write these rows straight through PostgREST
-- (valid Supabase JWT + public anon key), bypassing the Nest API's permission matrix
-- and audit logging. A low-privilege member (e.g. the `kho`/warehouse role, which the
-- matrix deliberately withholds `public_api.keys.manage` and `channels.connect` from)
-- could mint a working api_keys row to read all their org's order PII, or point an
-- outbound_webhooks row at an attacker URL — with no audit trail. RLS still confined
-- them to their own org, but this is a within-org privilege escalation + audit bypass.
--
-- Fix: revoke the write grants and drop the write policies. `authenticated` keeps
-- SELECT only (members reading their own org's rows is harmless and matches the
-- surviving `*_select_member` policies). All writes now flow exclusively through
-- `service_role`, which the Nest services (public-api.service.ts,
-- content-calendar.service.ts) already use and which bypasses RLS — so its existing
-- `grant ... to service_role` is left untouched and the app write path is unaffected.

drop policy if exists api_keys_write_member on public.api_keys;
drop policy if exists outbound_webhooks_write_member on public.outbound_webhooks;
drop policy if exists content_calendar_items_write_member on public.content_calendar_items;

revoke insert, update, delete on table
  public.api_keys,
  public.outbound_webhooks,
  public.content_calendar_items
from authenticated;
