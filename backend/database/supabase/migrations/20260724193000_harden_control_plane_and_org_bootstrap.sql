-- Browser clients never use the service-role key. Core/Nest uses service-role
-- only for privileged writes after JwtAuthGuard/OrgGuard/authz have run.

drop policy if exists organizations_update_member on public.organizations;
drop policy if exists memberships_update_member on public.memberships;
drop policy if exists membership_invites_update_member on public.membership_invites;
drop policy if exists entitlements_update_member on public.entitlements;
drop policy if exists feature_flags_update_member on public.feature_flags;
drop policy if exists usage_events_update_member on public.usage_events;
drop policy if exists outbox_events_update_member on public.outbox_events;

revoke insert, update, delete on table
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

grant select on table
  public.organizations,
  public.memberships,
  public.membership_invites,
  public.entitlements,
  public.feature_flags,
  public.usage_events,
  public.outbox_events,
  public.audit_logs
to authenticated;

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

create or replace function public.create_organization_with_owner(
  p_owner_user_id uuid,
  p_name text,
  p_slug text
)
returns table (
  organization jsonb,
  membership jsonb,
  entitlements jsonb
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_organization public.organizations%rowtype;
  v_membership public.memberships%rowtype;
  v_entitlements public.entitlements%rowtype;
begin
  insert into public.organizations (name, slug)
  values (p_name, p_slug)
  returning * into v_organization;

  insert into public.memberships (org_id, user_id, role)
  values (v_organization.id, p_owner_user_id, 'owner')
  returning * into v_membership;

  insert into public.entitlements (org_id)
  values (v_organization.id)
  returning * into v_entitlements;

  return query
  select
    to_jsonb(v_organization),
    to_jsonb(v_membership),
    to_jsonb(v_entitlements);
end;
$$;

revoke all on function public.create_organization_with_owner(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.create_organization_with_owner(uuid, text, text)
to service_role;
