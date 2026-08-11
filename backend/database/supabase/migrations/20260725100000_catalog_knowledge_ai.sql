-- Catalog (products, variants), RAG knowledge chunks (pgvector), AI run audit trail.
-- Embedding dimension N=768 locked in docs/adr/0003-embedding-dims.md (text-embedding-004).
-- RLS: Plan A harden — authenticated SELECT via org membership; writes via service_role only.

create extension if not exists vector with schema extensions;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'active',
  attrs_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint products_status_check check (status in ('active', 'archived'))
);

create index products_org_id_idx on public.products (org_id);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  sku text not null,
  title text not null,
  price_vnd bigint not null,
  stock_qty int not null default 0,
  attrs_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_variants_org_id_sku_key unique (org_id, sku)
);

create index product_variants_org_id_idx on public.product_variants (org_id);
create index product_variants_product_id_idx on public.product_variants (product_id);

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_type text not null,
  source_id uuid not null,
  chunk_index int not null,
  content text not null,
  embedding extensions.vector(768),
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_chunks_source_chunk_key
    unique (org_id, source_type, source_id, chunk_index),
  constraint knowledge_chunks_source_type_check
    check (source_type in ('product', 'faq', 'policy'))
);

create index knowledge_chunks_org_source_idx
  on public.knowledge_chunks (org_id, source_type, source_id);

-- HNSW works on empty/small datasets; IVFFlat needs sufficient rows for list training.
create index knowledge_chunks_embedding_hnsw_idx
  on public.knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  prompt_version text not null,
  model text not null,
  input_tokens int,
  output_tokens int,
  tools_json jsonb not null default '{}'::jsonb,
  citations_json jsonb not null default '{}'::jsonb,
  status text,
  created_at timestamptz not null default now()
);

create index ai_runs_org_id_created_at_idx on public.ai_runs (org_id, created_at);
create index ai_runs_conversation_id_idx on public.ai_runs (conversation_id);

alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.ai_runs enable row level security;

create policy products_select_member
  on public.products
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy product_variants_select_member
  on public.product_variants
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy knowledge_chunks_select_member
  on public.knowledge_chunks
  for select
  to authenticated
  using (private.is_org_member(org_id));

create policy ai_runs_select_member
  on public.ai_runs
  for select
  to authenticated
  using (private.is_org_member(org_id));

revoke all on table
  public.products,
  public.product_variants,
  public.knowledge_chunks,
  public.ai_runs
from anon, authenticated;

grant select on table
  public.products,
  public.product_variants,
  public.knowledge_chunks,
  public.ai_runs
to authenticated;

grant all on table
  public.products,
  public.product_variants,
  public.knowledge_chunks,
  public.ai_runs
to service_role;

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
begin
  if p_source_type = 'product' and not exists (
    select 1
    from public.products
    where id = p_source_id
      and org_id = p_org_id
      and deleted_at is null
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
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) as chunks(chunk);

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
