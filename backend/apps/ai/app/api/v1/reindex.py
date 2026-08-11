import hashlib
import hmac
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.infra.core import CoreKnowledgeClient
from app.infra.embeddings.factory import create_embedding_provider
from app.infra.embeddings.gemini import EMBEDDING_DIMENSIONS, EmbeddingProvider
from app.infra.llm.spend import LlmSpendTracker

router = APIRouter(prefix="/internal/v1")
logger = logging.getLogger(__name__)

embedding_provider: EmbeddingProvider = create_embedding_provider()
core_client = CoreKnowledgeClient()
spend_budget = LlmSpendTracker()


class KnowledgeDocument(BaseModel):
    id: str
    content: str = Field(min_length=1, max_length=50_000)


class ReindexRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    org_id: UUID = Field(alias="orgId")
    source_type: Literal["product"] = Field(alias="sourceType")
    source_id: UUID = Field(alias="sourceId")
    documents: list[KnowledgeDocument] = Field(default_factory=list, max_length=50)


@router.post("/reindex")
def reindex(
    body: ReindexRequest,
    x_service_key: str | None = Header(default=None),
):
    if not hmac.compare_digest(x_service_key or "", settings.service_m2m_key):
        raise HTTPException(status_code=401, detail="invalid service key")

    texts = [
        chunk
        for document in body.documents
        for chunk in chunk_text(document.content)
    ]

    # Metered at batch granularity: one estimate/record for the whole request
    # rather than per chunk. Per-chunk accounting would multiply counter-file
    # writes by up to 50x per call for no extra accuracy — the estimator is
    # linear in characters, so the batch total equals the sum of the parts.
    estimate = spend_budget.estimate_embedding(texts)
    if texts and spend_budget.would_exceed_cap(estimate):
        raise HTTPException(
            status_code=429,
            detail="LLM spend cap reached; reindex embedding batch refused",
        )

    try:
        embeddings = embedding_provider.embed_texts(texts) if texts else []
        if estimate.input_tokens > 0:
            spend_budget.record_embedding(input_tokens=estimate.input_tokens)
        if len(embeddings) != len(texts):
            raise RuntimeError("Embedding provider returned unexpected count")
        for embedding in embeddings:
            assert_embedding_dimensions(embedding)
        chunks = [
            {
                "chunkIndex": index,
                "content": text,
                "contentHash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "embedding": embedding,
            }
            for index, (text, embedding) in enumerate(zip(texts, embeddings))
        ]
        core_response = core_client.replace_chunks(
            org_id=str(body.org_id),
            source_type=body.source_type,
            source_id=str(body.source_id),
            chunks=chunks,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if estimate.input_tokens > 0:
        try:
            core_client.record_ai_token_usage(
                org_id=str(body.org_id),
                quantity=estimate.input_tokens,
                ref_type="embedding_reindex",
                ref_id=str(body.source_id),
            )
        except RuntimeError:
            logger.exception("Reindex embedding usage reporting to Core failed")

    return {
        "ok": True,
        "sourceType": body.source_type,
        "sourceId": str(body.source_id),
        "chunksWritten": len(chunks),
        "core": core_response,
    }


def chunk_text(text: str, max_chars: int = 3_000) -> list[str]:
    normalized = "\n".join(line.strip() for line in text.splitlines()).strip()
    if not normalized:
        return []
    if len(normalized) <= max_chars:
        return [normalized]

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for paragraph in normalized.split("\n"):
        if current and current_len + len(paragraph) + 1 > max_chars:
            chunks.append("\n".join(current))
            current = []
            current_len = 0
        if len(paragraph) > max_chars:
            chunks.extend(
                paragraph[start : start + max_chars]
                for start in range(0, len(paragraph), max_chars)
            )
            continue
        current.append(paragraph)
        current_len += len(paragraph) + 1

    if current:
        chunks.append("\n".join(current))

    return chunks


def assert_embedding_dimensions(embedding: list[float]) -> None:
    if len(embedding) != EMBEDDING_DIMENSIONS:
        raise RuntimeError("Embedding provider returned unexpected dimensions")
