"""Select Gemini or local stub embeddings with production-safe guards."""

from __future__ import annotations

import logging

from app.config import settings
from app.infra.embeddings.gemini import EmbeddingProvider, GeminiEmbeddingProvider
from app.infra.embeddings.stub import StubEmbeddingProvider
from app.infra.llm.factory import external_ai_enabled

logger = logging.getLogger(__name__)

_PROD_ENVS = frozenset({"production", "prod"})
_LOCALISH_ENVS = frozenset({"local", "development", "dev", "test"})


def _env_name(value: str | None) -> str:
    return (value or "").strip().lower()


def is_production_env() -> bool:
    return (
        _env_name(settings.app_env) in _PROD_ENVS
        or _env_name(settings.node_env) in _PROD_ENVS
    )


def stub_embeddings_permitted() -> bool:
    """Stub never runs in production. Else: explicit flag or localish APP_ENV."""
    if is_production_env():
        return False
    if settings.embeddings_allow_stub:
        return True
    return _env_name(settings.app_env) in _LOCALISH_ENVS


def create_embedding_provider() -> EmbeddingProvider:
    api_key = (settings.gemini_api_key or "").strip()
    if api_key and external_ai_enabled():
        return GeminiEmbeddingProvider(api_key=api_key)

    if stub_embeddings_permitted():
        logger.warning(
            "GEMINI_API_KEY empty — using %s (APP_ENV=%r, EMBEDDINGS_ALLOW_STUB=%s)",
            StubEmbeddingProvider.label,
            settings.app_env,
            settings.embeddings_allow_stub,
        )
        return StubEmbeddingProvider()

    if is_production_env():
        raise RuntimeError(
            "GEMINI_API_KEY is required for embeddings in production "
            "(stub embeddings are refused when APP_ENV/NODE_ENV=production)"
        )

    raise RuntimeError(
        "GEMINI_API_KEY is required for embeddings, or enable local stub via "
        "EMBEDDINGS_ALLOW_STUB=1 with a non-production APP_ENV "
        "(e.g. APP_ENV=local). Stub vectors are local/dev only — not Gemini quality."
    )
