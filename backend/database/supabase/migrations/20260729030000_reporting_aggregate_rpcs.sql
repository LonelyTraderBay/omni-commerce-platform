-- Wave P0.6 — reporting correctness: totals that must never be computed over a
-- truncated page.
--
-- 1. `BillingService.sumAiTokens` and `AiTokenUsageService.loadMonthlyUsage`
--    both fetched raw `usage_events` rows and summed them in Node with no
--    `.limit()`. PostgREST caps a response at `db-max-rows` (1000 by default),
--    so past that cap an org's AI token usage was silently under-summed: the
--    billing screen under-reported it *and* the quota gate built on the same
--    number under-counted, letting an org run past its entitlement.
-- 2. `CodService.getReport` computed `expectedVnd`, `collectedVnd`, `deltaVnd`
--    and `openCount` over only the first 100 expectations it fetched, and
--    `discrepancyCount` over only the first 100 discrepancies — then presented
--    all of them as complete totals.
--
-- Both are the same defect: an aggregate derived from a capped row fetch. Fixed
-- by aggregating in SQL, where there is no row cap to trip over.
--
-- Money sums come back as `text` on purpose. `sum(bigint)` is `numeric` and can
-- exceed JavaScript's safe integer range; PostgREST would serialize it as a
-- JSON number and the API would lose precision on exactly the large-org case
-- these functions exist to get right.

create or replace function public.sum_usage_event_quantity(
  p_org_id uuid,
  p_kind text,
  p_since timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(u.quantity), 0)::text
  from public.usage_events u
  where u.org_id = p_org_id
    and u.kind = p_kind
    and u.created_at >= p_since;
$$;

revoke all on function public.sum_usage_event_quantity(uuid, text, timestamptz)
from public, anon, authenticated;

grant execute on function public.sum_usage_event_quantity(uuid, text, timestamptz)
to service_role;

-- The billing/quota read filters on (org_id, kind, created_at). The existing
-- usage_events_org_id_created_at_idx cannot serve the `kind` predicate.
create index if not exists usage_events_org_id_kind_created_at_idx
  on public.usage_events (org_id, kind, created_at);

create or replace function public.cod_report_summary(p_org_id uuid)
returns table (
  open_count bigint,
  discrepancy_count bigint,
  expectation_count bigint,
  expected_vnd text,
  collected_vnd text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (
      select count(*)
      from public.cod_expectations e
      where e.org_id = p_org_id
        and e.status = 'open'
    ),
    (
      select count(*)
      from public.cod_discrepancies d
      where d.org_id = p_org_id
        and d.status = 'open'
    ),
    -- Rows the report's `expectations` list is drawn from, so the API can say
    -- whether that list is a complete picture or just its first page.
    (
      select count(*)
      from public.cod_expectations e
      where e.org_id = p_org_id
        and e.status in ('open', 'discrepancy')
    ),
    (
      select coalesce(sum(e.expected_vnd), 0)::text
      from public.cod_expectations e
      where e.org_id = p_org_id
        and e.status in ('open', 'discrepancy')
    ),
    -- Mirrors what the service used to compute in Node: collections belonging
    -- to an order that still has an open or discrepant expectation.
    (
      select coalesce(sum(c.amount_vnd), 0)::text
      from public.cod_collections c
      where c.org_id = p_org_id
        and exists (
          select 1
          from public.cod_expectations e
          where e.org_id = c.org_id
            and e.order_id = c.order_id
            and e.status in ('open', 'discrepancy')
        )
    );
$$;

revoke all on function public.cod_report_summary(uuid)
from public, anon, authenticated;

grant execute on function public.cod_report_summary(uuid)
to service_role;
