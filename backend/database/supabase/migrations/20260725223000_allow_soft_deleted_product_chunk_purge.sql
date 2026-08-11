-- Allow knowledge chunk purges for soft-deleted products while keeping inserts live-only.

create or replace function public.replace_knowledge_chunks(
  p_org_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_chunks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inserted int := 0;
  v_chunks jsonb := coalesce(p_chunks, '[]'::jsonb);
  v_has_chunks boolean;
begin
  if jsonb_typeof(v_chunks) <> 'array' then
    raise exception 'knowledge chunks must be an array'
      using errcode = '22023';
  end if;

  v_has_chunks := jsonb_array_length(v_chunks) > 0;

  if p_source_type = 'product' and not exists (
    select 1
    from public.products
    where id = p_source_id
      and org_id = p_org_id
      and (not v_has_chunks or deleted_at is null)
  ) then
    raise exception 'knowledge source not found'
      using errcode = 'P0002';
  end if;

  delete from public.knowledge_chunks
  where org_id = p_org_id
    and source_type = p_source_type
    and source_id = p_source_id;

  insert into public.knowledge_chunks (
    org_id,
    source_type,
    source_id,
    chunk_index,
    content,
    embedding,
    content_hash,
    updated_at
  )
  select
    p_org_id,
    p_source_type,
    p_source_id,
    (chunk->>'chunk_index')::int,
    chunk->>'content',
    (chunk->>'embedding')::extensions.vector(768),
    chunk->>'content_hash',
    now()
  from jsonb_array_elements(v_chunks) as chunks(chunk);

  get diagnostics v_inserted = row_count;

  return jsonb_build_object(
    'ok', true,
    'deletedOld', true,
    'inserted', v_inserted
  );
end;
$$;

revoke all on function public.replace_knowledge_chunks(uuid, text, uuid, jsonb)
from public, anon, authenticated;

grant execute on function public.replace_knowledge_chunks(uuid, text, uuid, jsonb)
to service_role;
