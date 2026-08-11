# ADR 0003: pgvector dimension N=768 for Gemini embeddings

## Status

Accepted

## Context

Knowledge retrieval stores embeddings in `public.knowledge_chunks.embedding` (`extensions.vector(N)`). The dimension must match the embedding model output exactly; changing `N` without a full re-embed breaks similarity search and invalidates existing rows.

Plan C Task 1 (C0) introduces catalog and RAG tables. The platform uses Google Gemini for LLM and embeddings. We need a single locked dimension before AI ingest and reindex jobs land.

## Decision

- **Embedding model:** `text-embedding-004` (Google Gemini / Vertex embedding API equivalent).
- **Vector dimension:** **N = 768**.
- **Database column:** `public.knowledge_chunks.embedding extensions.vector(768)`.
- **Similarity index:** HNSW with `extensions.vector_cosine_ops` (cosine distance; matches typical normalized embedding retrieval).

Environment variable for the AI service should reference the same model id (e.g. `GEMINI_EMBED_MODEL=text-embedding-004`). Do not change `N` or the model without a versioned migration, ADR update, and org-scoped reindex of all `knowledge_chunks`.

## Consequences

- Migrations and AI embed code must produce 768-dimensional vectors only.
- Switching to another embed model (e.g. different output size) requires a new ADR, schema migration, and full knowledge reindex.
- HNSW index is created at migration time and remains valid as rows are inserted; no IVFFlat `lists` tuning is required for empty databases.

## References

- Structure doc §8.5 (`knowledge_chunks`)
- Migration `backend/database/supabase/migrations/20260725100000_catalog_knowledge_ai.sql`
- [Gemini embeddings — text-embedding-004](https://ai.google.dev/gemini-api/docs/embeddings)
