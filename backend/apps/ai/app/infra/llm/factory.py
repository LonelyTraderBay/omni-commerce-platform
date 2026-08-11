"""Select local or external LLM providers from the environment."""

from __future__ import annotations

from app.config import settings
from app.infra.llm.gemini import GeminiLlmProvider
from app.infra.llm.openai import OpenAiLlmProvider
from app.infra.llm.provider import FailoverLlmProvider, LlmProvider
from app.infra.llm.stub import StubLlmProvider

_LOCALISH_ENVS = frozenset({"local", "development", "dev", "test"})


def external_ai_enabled() -> bool:
    mode = settings.ai_provider.strip().lower()
    if mode in {"stub", "local"}:
        return False
    if mode in {"gemini", "openai"}:
        return True
    if mode != "auto":
        raise RuntimeError(
            "AI_PROVIDER must be one of: auto, stub, gemini, openai"
        )

    # Local development must be offline by default, even if a developer has a
    # provider key in the parent shell or .env file.
    app_env = (settings.app_env or settings.node_env or "").strip().lower()
    return app_env not in _LOCALISH_ENVS


def create_llm_provider() -> LlmProvider:
    if not external_ai_enabled():
        return StubLlmProvider()

    mode = settings.ai_provider.strip().lower()
    if mode == "openai":
        return OpenAiLlmProvider()

    primary = GeminiLlmProvider()
    secondary = OpenAiLlmProvider() if settings.openai_api_key else None
    return FailoverLlmProvider(primary, secondary)
