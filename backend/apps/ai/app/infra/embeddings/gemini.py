import json
from typing import Protocol
from urllib import error, request

from app.config import settings

EMBEDDING_DIMENSIONS = 768


class EmbeddingProvider(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        ...


class GeminiEmbeddingProvider:
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        opener=request.urlopen,
    ):
        self.api_key = api_key if api_key is not None else settings.gemini_api_key
        self.model = model or settings.gemini_embed_model
        self.opener = opener

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY is required for embeddings")

        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:embedContent?key={self.api_key}"
        )
        payload = {
            "model": f"models/{self.model}",
            "content": {"parts": [{"text": text}]},
            "outputDimensionality": EMBEDDING_DIMENSIONS,
        }
        req = request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with self.opener(req, timeout=30) as response:
                body = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Gemini embedding failed: {exc.code} {detail}") from exc

        values = body.get("embedding", {}).get("values")
        if not isinstance(values, list) or len(values) != EMBEDDING_DIMENSIONS:
            raise RuntimeError("Gemini embedding response had unexpected dimensions")

        return [float(value) for value in values]
