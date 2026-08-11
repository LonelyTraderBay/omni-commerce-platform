-- Product + variants + knowledge.reindex outbox must commit atomically on create.

create or replace function public.create_product_with_variants_and_reindex(
  p_org_id uuid,
  p_title text,
  p_description text,
  p_status text,
  p_attrs_json jsonb,
  p_variants jsonb
)
returns table (
  product jsonb,
  variants jsonb,
  outbox_event_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_variants jsonb := '[]'::jsonb;
  v_outbox_event_id uuid;
begin
  insert into public.products (org_id, title, description, status, attrs_json)
  values (
    p_org_id,
    p_title,
    p_description,
    p_status,
    coalesce(p_attrs_json, '{}'::jsonb)
  )
  returning * into v_product;

  if p_variants is not null and jsonb_array_length(p_variants) > 0 then
    insert into public.product_variants (
      org_id,
      product_id,
      sku,
      title,
      price_vnd,
      stock_qty,
      attrs_json
    )
    select
      p_org_id,
      v_product.id,
      v.sku,
      v.title,
      v.price_vnd::bigint,
      coalesce(v.stock_qty, 0),
      coalesce(v.attrs_json, '{}'::jsonb)
    from jsonb_to_recordset(p_variants) as v(
      sku text,
      title text,
      price_vnd text,
      stock_qty int,
      attrs_json jsonb
    );

    select coalesce(jsonb_agg(to_jsonb(pv) order by pv.created_at), '[]'::jsonb)
    into v_variants
    from public.product_variants pv
    where pv.product_id = v_product.id;
  end if;

  insert into public.outbox_events (
    org_id,
    event_name,
    payload_json,
    published_at,
    attempts
  )
  values (
    p_org_id,
    'knowledge.reindex',
    jsonb_build_object(
      'orgId', p_org_id,
      'sourceType', 'product',
      'sourceId', v_product.id
    ),
    null,
    0
  )
  returning id into v_outbox_event_id;

  return query
  select to_jsonb(v_product), v_variants, v_outbox_event_id;
end;
$$;

revoke all on function public.create_product_with_variants_and_reindex(
  uuid,
  text,
  text,
  text,
  jsonb,
  jsonb
)
from public, anon, authenticated;

grant execute on function public.create_product_with_variants_and_reindex(
  uuid,
  text,
  text,
  text,
  jsonb,
  jsonb
)
to service_role;
