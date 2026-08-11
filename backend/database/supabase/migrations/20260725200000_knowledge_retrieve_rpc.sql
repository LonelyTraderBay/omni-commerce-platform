create or replace function public.retrieve_knowledge_chunks(
  p_org_id uuid,
  p_embedding extensions.vector(768),
  p_match_count int default 5
)
returns table (
  source_type text,
  source_id uuid,
  chunk_index int,
  content text,
  similarity double precision
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    kc.source_type,
    kc.source_id,
    kc.chunk_index,
    kc.content,
    1 - (kc.embedding <=> p_embedding) as similarity
  from public.knowledge_chunks kc
  where kc.org_id = p_org_id
    and kc.embedding is not null
  order by kc.embedding <=> p_embedding
  limit least(greatest(coalesce(p_match_count, 5), 1), 20);
$$;

revoke all on function public.retrieve_knowledge_chunks(uuid, extensions.vector, int)
from public, anon, authenticated;

grant execute on function public.retrieve_knowledge_chunks(uuid, extensions.vector, int)
to service_role;
