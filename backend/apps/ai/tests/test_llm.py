import json
from urllib import error

import pytest

from app.infra.llm.gemini import GeminiLlmProvider
from app.infra.llm.openai import OpenAiLlmProvider
from app.infra.llm.provider import (
    FailoverLlmProvider,
    LlmCompletion,
    ModelNotAllowedError,
)


class FakeResponse:
    def __init__(self, body: dict):
        self._body = json.dumps(body).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def test_rejects_model_not_in_allowlist():
    provider = GeminiLlmProvider(api_key="test-key", allowlist="gemini-2.0-flash")

    with pytest.raises(ValueError, match="not in AI_MODEL_ALLOWLIST"):
        provider.complete(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
        )


def test_complete_success_with_mocked_http():
    captured: dict = {}

    def fake_opener(req, timeout=60):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return FakeResponse(
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [{"text": "Xin chao!"}],
                            "role": "model",
                        }
                    }
                ],
                "usageMetadata": {
                    "promptTokenCount": 5,
                    "candidatesTokenCount": 7,
                    "totalTokenCount": 12,
                },
            }
        )

    provider = GeminiLlmProvider(
        api_key="test-key",
        allowlist="gemini-2.0-flash",
        opener=fake_opener,
    )
    result = provider.complete(
        model="gemini-2.0-flash",
        messages=[{"role": "user", "content": "hello"}],
    )

    assert result.text == "Xin chao!"
    assert result.model == "gemini-2.0-flash"
    assert result.prompt_tokens == 5
    assert result.completion_tokens == 7
    assert result.total_tokens == 12
    assert "gemini-2.0-flash:generateContent" in captured["url"]
    assert captured["body"]["contents"][0]["parts"][0]["text"] == "hello"


def test_failover_provider_uses_secondary_when_primary_fails():
    class FailingPrimary:
        def complete(self, **kwargs):
            raise RuntimeError("primary failed")

    class Secondary:
        def __init__(self):
            self.calls: list[dict] = []

        def complete(self, **kwargs):
            self.calls.append(kwargs)
            return LlmCompletion(
                text="ok",
                model="gpt-4o-mini",
                prompt_tokens=1,
                completion_tokens=1,
                total_tokens=2,
            )

    secondary = Secondary()
    provider = FailoverLlmProvider(FailingPrimary(), secondary)

    result = provider.complete(
        model="gemini-2.0-flash",
        messages=[{"role": "user", "content": "hello"}],
    )

    assert result.model == "gpt-4o-mini"
    assert secondary.calls == [
        {
            "model": "gemini-2.0-flash",
            "messages": [{"role": "user", "content": "hello"}],
        }
    ]


def test_openai_rejects_model_not_in_allowlist_instead_of_using_settings_model():
    def forbidden_opener(req, timeout=60):
        raise AssertionError("OpenAI must not be called for a disallowed model")

    provider = OpenAiLlmProvider(
        api_key="test-key",
        model="gpt-4o-mini",
        allowlist="gemini-2.0-flash",
        opener=forbidden_opener,
    )

    # gemini-2.0-flash maps to gpt-4o-mini, which is NOT allowlisted, so the
    # configured OPENAI_MODEL cannot be used as a silent bypass.
    with pytest.raises(ModelNotAllowedError, match="'gpt-4o-mini'"):
        provider.complete(
            model="gemini-2.0-flash",
            messages=[{"role": "user", "content": "hi"}],
        )

    with pytest.raises(ModelNotAllowedError, match="'gpt-4o'"):
        provider.complete(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
        )


def test_openai_honors_requested_openai_model_when_allowlisted():
    captured: dict = {}

    def fake_opener(req, timeout=60):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return FakeResponse(
            {
                "model": "gpt-4o-2024-11-20",
                "choices": [{"message": {"content": "hi there"}}],
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 4,
                    "total_tokens": 7,
                },
            }
        )

    provider = OpenAiLlmProvider(
        api_key="test-key",
        model="gpt-4o-mini",
        allowlist="gemini-2.0-flash,gpt-4o",
        opener=fake_opener,
    )
    result = provider.complete(
        model="gpt-4o",
        messages=[{"role": "user", "content": "hello"}],
    )

    # The `model` argument is no longer ignored in favour of settings.openai_model.
    assert captured["body"]["model"] == "gpt-4o"
    assert result.model == "gpt-4o-2024-11-20"
    assert result.total_tokens == 7


def test_openai_applies_documented_gemini_fallback_mapping():
    captured: dict = {}

    def fake_opener(req, timeout=60):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return FakeResponse(
            {
                "choices": [{"message": {"content": "hi there"}}],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            }
        )

    provider = OpenAiLlmProvider(
        api_key="test-key",
        model="gpt-4o-mini",
        allowlist="gemini-1.5-pro,gpt-4o",
        opener=fake_opener,
    )
    result = provider.complete(
        model="gemini-1.5-pro",
        messages=[{"role": "user", "content": "hello"}],
    )

    assert provider.resolve_model("gemini-1.5-pro") == "gpt-4o"
    assert captured["body"]["model"] == "gpt-4o"
    assert result.model == "gpt-4o"


def test_failover_does_not_trigger_on_allowlist_rejection():
    class RefusingPrimary:
        def complete(self, **kwargs):
            raise ModelNotAllowedError("Model 'gpt-4o' is not in AI_MODEL_ALLOWLIST")

    class Secondary:
        def __init__(self):
            self.calls: list[dict] = []

        def complete(self, **kwargs):
            self.calls.append(kwargs)
            raise AssertionError("secondary must not run on a policy refusal")

    secondary = Secondary()
    provider = FailoverLlmProvider(RefusingPrimary(), secondary)

    with pytest.raises(ModelNotAllowedError, match="not in AI_MODEL_ALLOWLIST"):
        provider.complete(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hello"}],
        )

    assert secondary.calls == []


def test_failover_surfaces_config_error_when_fallback_model_not_allowed():
    class DownPrimary:
        def complete(self, **kwargs):
            raise RuntimeError("gemini unreachable")

    provider = FailoverLlmProvider(
        DownPrimary(),
        OpenAiLlmProvider(
            api_key="test-key",
            model="gpt-4o-mini",
            allowlist="gemini-2.0-flash",
            opener=lambda req, timeout=60: pytest.fail("must not call OpenAI"),
        ),
    )

    # Not a ValueError/400: the caller did nothing wrong, the config has no
    # approved fallback.
    with pytest.raises(RuntimeError, match="fallback model is not allowed") as exc:
        provider.complete(
            model="gemini-2.0-flash",
            messages=[{"role": "user", "content": "hello"}],
        )

    assert not isinstance(exc.value, ValueError)


def test_failover_still_triggers_on_genuine_primary_network_failure():
    class DownPrimary:
        def complete(self, **kwargs):
            raise error.URLError("connection refused")

    def fake_opener(req, timeout=60):
        return FakeResponse(
            {
                "choices": [{"message": {"content": "fallback reply"}}],
                "usage": {
                    "prompt_tokens": 2,
                    "completion_tokens": 3,
                    "total_tokens": 5,
                },
            }
        )

    provider = FailoverLlmProvider(
        DownPrimary(),
        OpenAiLlmProvider(
            api_key="test-key",
            model="gpt-4o-mini",
            allowlist="gemini-2.0-flash,gpt-4o-mini",
            opener=fake_opener,
        ),
    )

    result = provider.complete(
        model="gemini-2.0-flash",
        messages=[{"role": "user", "content": "hello"}],
    )

    assert result.text == "fallback reply"
    assert result.model == "gpt-4o-mini"
