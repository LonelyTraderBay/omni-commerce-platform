from fastapi.testclient import TestClient

from app.api.v1 import reindex as reindex_api
from app.config import settings
from app.infra.llm.spend import LlmSpendEstimate, estimate_tokens
from app.main import app

ORG_ID = "11111111-1111-1111-1111-111111111111"
SOURCE_ID = "22222222-2222-2222-2222-222222222222"

client = TestClient(app)


class FakeEmbeddings:
    def __init__(self):
        self.texts: list[str] = []

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        self.texts = texts
        return [[0.01] * 768 for _ in texts]


class FakeCore:
    def __init__(self):
        self.calls: list[dict] = []
        self.usage_calls: list[dict] = []

    def replace_chunks(self, **kwargs):
        self.calls.append(kwargs)
        return {"ok": True, "inserted": len(kwargs["chunks"])}

    def record_ai_token_usage(self, **kwargs):
        self.usage_calls.append(kwargs)


class FakeSpendBudget:
    """Keeps the real tracker (and its .llm-spend.json file) out of tests."""

    def __init__(self, *, exceeded: bool = False):
        self.exceeded = exceeded
        self.estimate_calls: list[list[str]] = []
        self.check_calls: list[object] = []
        self.record_calls: list[dict] = []

    def estimate_embedding(self, texts: list[str]) -> LlmSpendEstimate:
        self.estimate_calls.append(texts)
        return LlmSpendEstimate(
            input_tokens=sum(estimate_tokens(text) for text in texts),
            output_tokens=0,
            usd=0.01,
        )

    def would_exceed_cap(self, estimate) -> bool:
        self.check_calls.append(estimate)
        return self.exceeded

    def record_embedding(self, **kwargs) -> None:
        self.record_calls.append(kwargs)


def test_reindex_embeds_and_posts_chunks_to_core(monkeypatch):
    fake_embeddings = FakeEmbeddings()
    fake_core = FakeCore()
    fake_spend = FakeSpendBudget()
    monkeypatch.setattr(reindex_api, "embedding_provider", fake_embeddings)
    monkeypatch.setattr(reindex_api, "core_client", fake_core)
    monkeypatch.setattr(reindex_api, "spend_budget", fake_spend)

    r = client.post(
        "/internal/v1/reindex",
        headers={"x-service-key": settings.service_m2m_key},
        json={
            "orgId": ORG_ID,
            "sourceType": "product",
            "sourceId": SOURCE_ID,
            "documents": [{"id": SOURCE_ID, "content": "Product\nTitle: T-shirt"}],
        },
    )

    assert r.status_code == 200
    assert r.json()["chunksWritten"] == 1
    assert fake_embeddings.texts == ["Product\nTitle: T-shirt"]
    assert fake_core.calls[0]["org_id"] == ORG_ID
    assert fake_core.calls[0]["source_type"] == "product"
    assert fake_core.calls[0]["source_id"] == SOURCE_ID
    assert fake_core.calls[0]["chunks"][0]["chunkIndex"] == 0
    assert fake_core.calls[0]["chunks"][0]["embedding"] == [0.01] * 768

    # Embedding spend is metered once per batch and reported to Core.
    batch_tokens = estimate_tokens("Product\nTitle: T-shirt")
    assert fake_spend.estimate_calls == [["Product\nTitle: T-shirt"]]
    assert fake_spend.record_calls == [{"input_tokens": batch_tokens}]
    assert fake_core.usage_calls == [
        {
            "org_id": ORG_ID,
            "quantity": batch_tokens,
            "ref_type": "embedding_reindex",
            "ref_id": SOURCE_ID,
        }
    ]


def test_reindex_refuses_batch_when_spend_cap_is_exceeded(monkeypatch):
    fake_embeddings = FakeEmbeddings()
    fake_core = FakeCore()
    fake_spend = FakeSpendBudget(exceeded=True)
    monkeypatch.setattr(reindex_api, "embedding_provider", fake_embeddings)
    monkeypatch.setattr(reindex_api, "core_client", fake_core)
    monkeypatch.setattr(reindex_api, "spend_budget", fake_spend)

    r = client.post(
        "/internal/v1/reindex",
        headers={"x-service-key": settings.service_m2m_key},
        json={
            "orgId": ORG_ID,
            "sourceType": "product",
            "sourceId": SOURCE_ID,
            "documents": [{"id": SOURCE_ID, "content": "Product\nTitle: T-shirt"}],
        },
    )

    assert r.status_code == 429
    assert fake_embeddings.texts == []
    assert fake_spend.record_calls == []
    assert fake_core.calls == []
    assert fake_core.usage_calls == []


def test_reindex_rejects_wrong_service_key():
    r = client.post(
        "/internal/v1/reindex",
        headers={"x-service-key": "wrong-key"},
        json={
            "orgId": ORG_ID,
            "sourceType": "product",
            "sourceId": SOURCE_ID,
            "documents": [],
        },
    )

    assert r.status_code == 401


def test_reindex_posts_empty_chunks_when_source_has_no_documents(monkeypatch):
    fake_embeddings = FakeEmbeddings()
    fake_core = FakeCore()
    fake_spend = FakeSpendBudget()
    monkeypatch.setattr(reindex_api, "embedding_provider", fake_embeddings)
    monkeypatch.setattr(reindex_api, "core_client", fake_core)
    monkeypatch.setattr(reindex_api, "spend_budget", fake_spend)

    r = client.post(
        "/internal/v1/reindex",
        headers={"x-service-key": settings.service_m2m_key},
        json={
            "orgId": ORG_ID,
            "sourceType": "product",
            "sourceId": SOURCE_ID,
            "documents": [],
        },
    )

    assert r.status_code == 200
    assert r.json()["chunksWritten"] == 0
    assert fake_embeddings.texts == []
    assert fake_core.calls[0]["chunks"] == []
    assert fake_spend.check_calls == []
    assert fake_spend.record_calls == []
    assert fake_core.usage_calls == []
