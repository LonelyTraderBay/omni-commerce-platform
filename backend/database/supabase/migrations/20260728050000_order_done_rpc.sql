-- Manual "mark done" lifecycle transition (shipped -> done).
--
-- `orders.status` and `orders.done_at` already exist (Plan D:
-- 20260725210000_ai_tools_draft_orders.sql / 20260726090000_orders_lifecycle_gapfill.sql),
-- and einvoice.service.ts has required order.status = 'done' since Plan F, but no RPC or
-- Nest endpoint ever transitioned an order to 'done'. This adds the RPC half of that gap
-- fix, mirroring public.ship_order's structure exactly (see 20260726100000_orders_lifecycle_rpcs.sql).

create or replace function public.done_order(
  p_org_id uuid,
  p_order_id uuid,
  p_done_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_at timestamptz := coalesce(p_done_at, now());
begin
  select *
  into v_order
  from public.orders
  where org_id = p_org_id
    and id = p_order_id
  for update;

  if not found then
    return null;
  end if;

  if v_order.status = 'done' then
    return private.order_lifecycle_payload(p_org_id, p_order_id);
  end if;

  if v_order.status <> 'shipped' then
    raise exception 'order cannot be marked done from status %', v_order.status
      using errcode = 'P0001', hint = 'invalid_order_status';
  end if;

  update public.orders
  set status = 'done',
      done_at = v_at,
      updated_at = v_at
  where org_id = p_org_id
    and id = p_order_id;

  return private.order_lifecycle_payload(p_org_id, p_order_id);
end;
$$;

revoke all on function public.done_order(uuid, uuid, timestamptz)
from public, anon, authenticated;

grant execute on function public.done_order(uuid, uuid, timestamptz)
to service_role;
