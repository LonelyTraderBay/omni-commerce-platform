from fastapi.testclient import TestClient

from app.api.v1 import advise as advise_api
from app.config import settings
from app.infra.llm.provider import LlmCompletion
from app.main import app

ORG_ID = "11111111-1111-1111-1111-111111111111"

client = TestClient(app)


class FakeQuotaClient:
    def __init__(self, *, exceeded: bool = False):
        self.exceeded = exceeded
        self.check_calls: list[dict] = []
        self.record_calls: list[dict] = []

    def check_ai_token_quota(self, *, org_id: str) -> dict:
        self.check_calls.append({"org_id": org_id})
        return {"exceeded": self.exceeded, "used": 100, "limit": 100}

    def record_ai_token_usage(self, **kwargs) -> None:
        self.record_calls.append(kwargs)


class FakeSpendBudget:
    """Keeps the real tracker (and its .llm-spend.json file) out of tests."""

    def __init__(self, *, exceeded: bool = False):
        self.exceeded = exceeded
        self.estimate_calls: list[list[dict[str, str]]] = []
        self.check_calls: list[object] = []
        self.record_calls: list[dict] = []

    def estimate_messages(self, messages: list[dict[str, str]]):
        self.estimate_calls.append(messages)
        return {"usd": 0.02}

    def would_exceed_cap(self, estimate) -> bool:
        self.check_calls.append(estimate)
        return self.exceeded

    def record_completion(self, **kwargs) -> None:
        self.record_calls.append(kwargs)


def install_advisor_governance(
    monkeypatch,
    *,
    quota: FakeQuotaClient | None = None,
    spend: FakeSpendBudget | None = None,
) -> tuple[FakeQuotaClient, FakeSpendBudget]:
    quota = quota or FakeQuotaClient()
    spend = spend or FakeSpendBudget()
    monkeypatch.setattr(advise_api, "quota_client", quota)
    monkeypatch.setattr(advise_api, "spend_budget", spend)
    return quota, spend


def test_advise_returns_advise_only_stub_suggestions(monkeypatch):
    monkeypatch.setattr(settings, "gemini_api_key", None)

    response = client.post(
        "/internal/v1/ai/advise",
        headers={"x-service-key": settings.service_m2m_key},
        json={
            "orgId": ORG_ID,
            "goal": "Đẩy áo thun cuối tuần",
            "catalogAggregates": {"note": "top stock stub"},
            "salesAggregates": {"note": "last 7d sales stub"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "advisor-stub"
    assert body["promptVersion"] == "advisor.v1"
    assert "không auto-post" in body["disclaimer"]
    assert "Người bán phải duyệt" in body["disclaimer"]
    assert "không tự đăng Meta" in body["suggestionsText"]
    assert body["toolsUsed"][0]["kind"] == "advisor"
    assert body["toolsUsed"][0]["mode"] == "stub"


def test_advise_uses_gemini_when_api_key_set(monkeypatch):
    class FakeGeminiProvider:
        def complete(self, *, model, messages):
            assert model == "gemini-2.0-flash"
            assert messages[0]["role"] == "user"
            assert "KHÔNG tự đăng bài Meta" in messages[0]["content"]
            return LlmCompletion(
                text="- Gợi ý từ Gemini\n- Người bán phải duyệt trước khi thực hiện.",
                model="gemini-2.0-flash",
                prompt_tokens=42,
                completion_tokens=18,
                total_tokens=60,
            )

    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(
        "app.api.v1.advise.create_llm_provider",
        lambda *args, **kwargs: FakeGeminiProvider(),
    )
    quota, spend = install_advisor_governance(monkeypatch)

    response = client.post(
        "/internal/v1/ai/advise",
        headers={"x-service-key": settings.service_m2m_key},
        json={
            "orgId": ORG_ID,
            "goal": "Đẩy áo thun cuối tuần",
            "catalogAggregates": {"note": "top stock"},
            "salesAggregates": {"note": "last 7d sales"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "gemini-2.0-flash"
    assert body["tokens"] == {"input": 42, "output": 18, "total": 60}
    assert body["toolsUsed"][0]["mode"] == "gemini"
    assert "Gợi ý từ Gemini" in body["suggestionsText"]
    assert "Người bán phải duyệt" in body["disclaimer"]

    # Cap checked before the call, completion recorded, usage reported to Core.
    assert quota.check_calls == [{"org_id": ORG_ID}]
    assert spend.check_calls == [{"usd": 0.02}]
    assert spend.record_calls == [{"prompt_tokens": 42, "completion_tokens": 18}]
    assert quota.record_calls == [
        {"org_id": ORG_ID, "quantity": 60, "ref_type": "advisor"}
    ]


def test_advise_uses_openai_when_provider_is_explicit(monkeypatch):
    class FakeOpenAiProvider:
        def complete(self, *, model, messages):
            assert model == "gpt-4o-mini"
            assert messages[0]["role"] == "user"
            return LlmCompletion(
                text="- Gợi ý từ OpenAI",
                model="gpt-4o-mini",
                prompt_tokens=20,
                completion_tokens=10,
                total_tokens=30,
            )

    monkeypatch.setattr(settings, "gemini_api_key", None)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    monkeypatch.setattr(settings, "openai_model", "gpt-4o-mini")
    monkeypatch.setattr(settings, "ai_provider", "openai")
    monkeypatch.setattr(
        settings,
        "ai_model_allowlist",
        "gemini-2.0-flash,advisor-stub,gpt-4o-mini",
    )
    monkeypatch.setattr(
        "app.api.v1.advise.create_llm_provider",
        lambda *args, **kwargs: FakeOpenAiProvider(),
    )
    install_advisor_governance(monkeypatch)

    response = client.post(
        "/internal/v1/ai/advise",
        headers={"x-service-key": settings.service_m2m_key},
        json={"orgId": ORG_ID},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "gpt-4o-mini"
    assert body["toolsUsed"][0]["mode"] == "openai"
    assert body["suggestionsText"] == "- Gợi ý từ OpenAI"


def test_advise_falls_back_to_stub_when_gemini_fails(monkeypatch):
    class FailingGeminiProvider:
        def complete(self, *, model, messages):
            raise RuntimeError("gemini down")

    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(
        "app.api.v1.advise.create_llm_provider",
        lambda *args, **kwargs: FailingGeminiProvider(),
    )
    quota, spend = install_advisor_governance(monkeypatch)

    response = client.post(
        "/internal/v1/ai/advise",
        headers={"x-service-key": settings.service_m2m_key},
        json={"orgId": ORG_ID},
    )

    assert response.status_code == 200
    assert response.json()["model"] == "advisor-stub"
    assert spend.record_calls == []
    assert quota.record_calls == []


def test_advise_skips_llm_call_when_spend_cap_is_exceeded(monkeypatch):
    class ForbiddenGeminiProvider:
        def complete(self, *, model, messages):
            raise AssertionError("advisor must not call the LLM over the spend cap")

    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(
        "app.api.v1.advise.create_llm_provider",
        lambda *args, **kwargs: ForbiddenGeminiProvider(),
    )
    quota, spend = install_advisor_governance(
        monkeypatch,
        spend=FakeSpendBudget(exceeded=True),
    )

    response = client.post(
        "/internal/v1/ai/advise",
        headers={"x-service-key": settings.service_m2m_key},
        json={"orgId": ORG_ID},
    )

    assert response.status_code == 200
    assert response.json()["model"] == "advisor-stub"
    assert spend.estimate_calls
    assert spend.check_calls == [{"usd": 0.02}]
    assert spend.record_calls == []
    assert quota.record_calls == []


def test_advise_skips_llm_call_when_org_token_quota_is_exceeded(monkeypatch):
    class ForbiddenGeminiProvider:
        def complete(self, *, model, messages):
            raise AssertionError("advisor must not call the LLM over quota")

    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(
        "app.api.v1.advise.create_llm_provider",
        lambda *args, **kwargs: ForbiddenGeminiProvider(),
    )
    quota, spend = install_advisor_governance(
        monkeypatch,
        quota=FakeQuotaClient(exceeded=True),
    )

    response = client.post(
        "/internal/v1/ai/advise",
        headers={"x-service-key": settings.service_m2m_key},
        json={"orgId": ORG_ID},
    )

    assert response.status_code == 200
    assert response.json()["model"] == "advisor-stub"
    assert quota.check_calls == [{"org_id": ORG_ID}]
    assert spend.check_calls == []
    assert quota.record_calls == []


def test_advise_keeps_completion_when_core_usage_reporting_fails(monkeypatch):
    class FakeGeminiProvider:
        def complete(self, *, model, messages):
            return LlmCompletion(
                text="- Gợi ý từ Gemini",
                model="gemini-2.0-flash",
                prompt_tokens=42,
                completion_tokens=18,
                total_tokens=60,
            )

    class FailingUsageQuotaClient(FakeQuotaClient):
        def record_ai_token_usage(self, **kwargs) -> None:
            super().record_ai_token_usage(**kwargs)
            raise RuntimeError("core unreachable")

    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(
        "app.api.v1.advise.create_llm_provider",
        lambda *args, **kwargs: FakeGeminiProvider(),
    )
    quota, spend = install_advisor_governance(
        monkeypatch,
        quota=FailingUsageQuotaClient(),
    )

    response = client.post(
        "/internal/v1/ai/advise",
        headers={"x-service-key": settings.service_m2m_key},
        json={"orgId": ORG_ID},
    )

    assert response.status_code == 200
    assert response.json()["model"] == "gemini-2.0-flash"
    assert spend.record_calls == [{"prompt_tokens": 42, "completion_tokens": 18}]
    assert quota.record_calls == [
        {"org_id": ORG_ID, "quantity": 60, "ref_type": "advisor"}
    ]


def test_advise_requires_service_key():
    response = client.post(
        "/internal/v1/ai/advise",
        headers={"x-service-key": "wrong"},
        json={"orgId": ORG_ID},
    )

    assert response.status_code == 401
