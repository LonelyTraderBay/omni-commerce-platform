"""Deterministic local/dev stub embeddings — NOT production Gemini quality."""

from __future__ import annotations

import hashlib
import logging
import math

from app.infra.embeddings.gemini import EMBEDDING_DIMENSIONS

logger = logging.getLogger(__name__)

STUB_PROVIDER_LABEL = "local-stub-embeddings"


def stub_embed_text(text: str, dimensions: int = EMBEDDING_DIMENSIONS) -> list[float]:
    """Hash-expand text into a fixed-dim L2-normalized vector (local/dev only)."""
    if dimensions <= 0:
        raise ValueError("dimensions must be positive")

    values: list[float] = []
    seed = hashlib.sha256(text.encode("utf-8")).digest()
    while len(values) < dimensions:
        for byte in seed:
            values.append((byte / 127.5) - 1.0)
            if len(values) >= dimensions:
                break
        seed = hashlib.sha256(seed).digest()

    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return [v / norm for v in values]


class StubEmbeddingProvider:
    """Local/dev-only embeddings. Deterministic; not Gemini-quality retrieval."""

    label = STUB_PROVIDER_LABEL

    def __init__(self, dimensions: int = EMBEDDING_DIMENSIONS):
        self.dimensions = dimensions
        logger.warning(
            "%s active — deterministic local/dev vectors only; "
            "do not claim Gemini/CPC retrieval quality",
            STUB_PROVIDER_LABEL,
        )

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [stub_embed_text(text, self.dimensions) for text in texts]
