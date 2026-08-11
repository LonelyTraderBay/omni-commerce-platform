-- Server-side, single-use CSRF binding for Meta OAuth.

create table public.oauth_states (
  state text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index oauth_states_org_user_idx
  on public.oauth_states (org_id, user_id);

create index oauth_states_expires_at_idx
  on public.oauth_states (expires_at);

alter table public.oauth_states enable row level security;

revoke all on table public.oauth_states
from anon, authenticated;

grant all on table public.oauth_states
to service_role;
