insert into public.feature_flags (id, key, org_id, enabled, payload_json)
values
  (gen_random_uuid(), 'kill_ai_outbound', null, false, '{}'),
  (gen_random_uuid(), 'kill_ai_all', null, false, '{}'),
  (gen_random_uuid(), 'kill_auto_confirm', null, false, '{}')
on conflict (key) where org_id is null
do update set
  enabled = excluded.enabled,
  payload_json = excluded.payload_json;

-- Local platform admins must be inserted after matching auth.users rows exist:
-- insert into public.platform_admins (user_id)
-- select id from auth.users where lower(email) in ('admin@example.com')
-- on conflict (user_id) do nothing;
