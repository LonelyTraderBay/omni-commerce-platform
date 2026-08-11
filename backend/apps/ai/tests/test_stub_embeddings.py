import math

import pytest

from app.infra.embeddings import factory as embedding_factory
from app.infra.embeddings.factory import (
    create_embedding_provider,
    is_production_env,
    stub_embeddings_permitted,
)
from app.infra.embeddings.gemini import EMBEDDING_DIMENSIONS, GeminiEmbeddingProvider
from app.infra.embeddings.stub import (
    STUB_PROVIDER_LABEL,
    StubEmbeddingProvider,
    stub_embed_text,
)


def test_stub_embed_text_is_deterministic_768d_and_normalized():
    a = stub_embed_text("áo thun đen")
    b = stub_embed_text("áo thun đen")
    c = stub_embed_text("quần jean")

    assert len(a) == EMBEDDING_DIMENSIONS
    assert a == b
    assert a != c
    assert math.isclose(math.sqrt(sum(v * v for v in a)), 1.0, rel_tol=1e-9)


def test_stub_provider_label_and_batch():
    provider = StubEmbeddingProvider()
    vectors = provider.embed_texts(["one", "two"])

    assert provider.label == STUB_PROVIDER_LABEL
    assert len(vectors) == 2
    assert all(len(v) == EMBEDDING_DIMENSIONS for v in vectors)
    assert vectors[0] != vectors[1]


def test_stub_permitted_for_local_app_env(monkeypatch):
    monkeypatch.setattr(embedding_factory.settings, "app_env", "local")
    monkeypatch.setattr(embedding_factory.settings, "node_env", None)
    monkeypatch.setattr(embedding_factory.settings, "embeddings_allow_stub", False)

    assert stub_embeddings_permitted() is True
    assert is_production_env() is False


def test_stub_permitted_with_explicit_flag_outside_localish(monkeypatch):
    monkeypatch.setattr(embedding_factory.settings, "app_env", "staging")
    monkeypatch.setattr(embedding_factory.settings, "node_env", None)
    monkeypatch.setattr(embedding_factory.settings, "embeddings_allow_stub", True)

    assert stub_embeddings_permitted() is True


def test_stub_refused_in_production_even_with_allow_flag(monkeypatch):
    monkeypatch.setattr(embedding_factory.settings, "app_env", "production")
    monkeypatch.setattr(embedding_factory.settings, "node_env", None)
    monkeypatch.setattr(embedding_factory.settings, "embeddings_allow_stub", True)

    assert is_production_env() is True
    assert stub_embeddings_permitted() is False


def test_stub_refused_when_node_env_production(monkeypatch):
    monkeypatch.setattr(embedding_factory.settings, "app_env", "local")
    monkeypatch.setattr(embedding_factory.settings, "node_env", "production")
    monkeypatch.setattr(embedding_factory.settings, "embeddings_allow_stub", True)

    assert stub_embeddings_permitted() is False


def test_factory_uses_gemini_when_key_present(monkeypatch):
    monkeypatch.setattr(embedding_factory.settings, "gemini_api_key", "fake-key")
    monkeypatch.setattr(embedding_factory.settings, "app_env", "local")
    monkeypatch.setattr(embedding_factory.settings, "ai_provider", "gemini")

    provider = create_embedding_provider()
    assert isinstance(provider, GeminiEmbeddingProvider)


def test_factory_keeps_local_mode_offline_even_when_key_present(monkeypatch):
    monkeypatch.setattr(embedding_factory.settings, "gemini_api_key", "fake-key")
    monkeypatch.setattr(embedding_factory.settings, "app_env", "local")
    monkeypatch.setattr(embedding_factory.settings, "node_env", None)
    monkeypatch.setattr(embedding_factory.settings, "ai_provider", "auto")

    provider = create_embedding_provider()
    assert isinstance(provider, StubEmbeddingProvider)


def test_factory_uses_stub_when_key_empty_and_local(monkeypatch):
    monkeypatch.setattr(embedding_factory.settings, "gemini_api_key", "")
    monkeypatch.setattr(embedding_factory.settings, "app_env", "local")
    monkeypatch.setattr(embedding_factory.settings, "node_env", None)
    monkeypatch.setattr(embedding_factory.settings, "embeddings_allow_stub", False)

    provider = create_embedding_provider()
    assert isinstance(provider, StubEmbeddingProvider)


def test_factory_refuses_stub_in_production_without_key(monkeypatch):
    monkeypatch.setattr(embedding_factory.settings, "gemini_api_key", None)
    monkeypatch.setattr(embedding_factory.settings, "app_env", "production")
    monkeypatch.setattr(embedding_factory.settings, "node_env", None)
    monkeypatch.setattr(embedding_factory.settings, "embeddings_allow_stub", True)

    with pytest.raises(RuntimeError, match="refused when APP_ENV/NODE_ENV=production"):
        create_embedding_provider()


def test_factory_errors_when_key_empty_and_stub_not_permitted(monkeypatch):
    monkeypatch.setattr(embedding_factory.settings, "gemini_api_key", "")
    monkeypatch.setattr(embedding_factory.settings, "app_env", "staging")
    monkeypatch.setattr(embedding_factory.settings, "node_env", None)
    monkeypatch.setattr(embedding_factory.settings, "embeddings_allow_stub", False)

    with pytest.raises(RuntimeError, match="EMBEDDINGS_ALLOW_STUB=1"):
        create_embedding_provider()
