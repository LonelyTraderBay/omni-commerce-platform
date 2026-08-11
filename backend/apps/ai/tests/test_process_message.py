from fastapi.testclient import TestClient

from app.api.v1 import process_message as process_message_api
from app.config import settings
from app.domain.orchestrator import ProcessMessageOrchestrator, PromptTemplate
from app.infra.llm.provider import LlmCompletion
from app.infra.llm.spend import LlmSpendEstimate, estimate_tokens
from app.main import app

ORG_ID = "11111111-1111-1111-1111-111111111111"
PRODUCT_ID = "22222222-2222-2222-2222-222222222222"
VARIANT_ID = "33333333-3333-3333-3333-333333333333"
CONVERSATION_ID = "44444444-4444-4444-4444-444444444444"
CONTACT_ID = "55555555-5555-5555-5555-555555555555"
MESSAGE_ID = "66666666-6666-6666-6666-666666666666"

client = TestClient(app)


class FakeEmbeddings:
    def __init__(self):
        self.texts: list[str] = []
        self.calls: int = 0

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        self.texts = texts
        return [[0.02] * 768 for _ in texts]


class FakeRetriever:
    def __init__(self, chunks: list[dict]):
        self.chunks = chunks
        self.calls: list[dict] = []

    def retrieve_chunks(self, **kwargs) -> list[dict]:
        self.calls.append(kwargs)
        return self.chunks


DEFAULT_LLM_JSON = (
    '{"replyText":"Ao thun nay co mau den [1].",'
    '"citedIndices":[1],"escalate":false}'
)


class FakeLlm:
    def __init__(self, text: str = DEFAULT_LLM_JSON):
        self.calls: list[dict] = []
        self.text = text

    def complete(self, **kwargs) -> LlmCompletion:
        self.calls.append(kwargs)
        return LlmCompletion(
            text=self.text,
            model=kwargs["model"],
            prompt_tokens=10,
            completion_tokens=7,
            total_tokens=17,
        )


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


EMBED_ESTIMATE = LlmSpendEstimate(input_tokens=6, output_tokens=0, usd=0.0006)


class FakeSpendBudget:
    def __init__(self, *, exceeded: bool = False, embedding_exceeded: bool = False):
        self.exceeded = exceeded
        self.embedding_exceeded = embedding_exceeded
        self.estimate_calls: list[list[dict[str, str]]] = []
        self.embedding_estimate_calls: list[list[str]] = []
        self.check_calls: list[object] = []
        self.record_calls: list[dict] = []
        self.record_embedding_calls: list[dict] = []

    def estimate_messages(self, messages: list[dict[str, str]]):
        self.estimate_calls.append(messages)
        return {"usd": 0.01}

    def estimate_embedding(self, texts: list[str]):
        self.embedding_estimate_calls.append(texts)
        return EMBED_ESTIMATE

    def would_exceed_cap(self, estimate) -> bool:
        self.check_calls.append(estimate)
        if isinstance(estimate, LlmSpendEstimate):
            return self.embedding_exceeded
        return self.exceeded

    def record_completion(self, **kwargs) -> None:
        self.record_calls.append(kwargs)

    def record_embedding(self, **kwargs) -> None:
        self.record_embedding_calls.append(kwargs)


class FakeCoreTools:
    def __init__(self):
        self.get_product_calls: list[dict] = []
        self.create_draft_order_calls: list[dict] = []

    def get_product(self, **kwargs) -> dict:
        self.get_product_calls.append(kwargs)
        return {
            "product": {
                "id": PRODUCT_ID,
                "title": "Ao thun den",
                "status": "active",
                "variants": [
                    {
                        "id": VARIANT_ID,
                        "title": "Mac dinh",
                        "sku": "AO-DEN",
                        "priceVnd": "120000",
                        "stockQty": 9,
                    }
                ],
            }
        }

    def create_draft_order(self, **kwargs) -> dict:
        self.create_draft_order_calls.append(kwargs)
        return {
            "order": {
                "id": "77777777-7777-7777-7777-777777777777",
                "totalVnd": "240000",
            },
            "items": [],
        }


def make_orchestrator(
    chunks: list[dict],
    *,
    llm_text: str = DEFAULT_LLM_JSON,
    quota_client: FakeQuotaClient | None = None,
    core_tools_client: FakeCoreTools | None = None,
    spend_budget: FakeSpendBudget | None = None,
):
    embeddings = FakeEmbeddings()
    retriever = FakeRetriever(chunks)
    llm = FakeLlm(llm_text)
    orchestrator = ProcessMessageOrchestrator(
        embedding_provider=embeddings,
        retriever=retriever,
        llm_provider=llm,
        prompt=PromptTemplate(version="test_prompt_v1", text="Only use context."),
        quota_client=quota_client,
        core_tools_client=core_tools_client,
        spend_budget=spend_budget,
    )
    return orchestrator, embeddings, retriever, llm


def test_process_message_escalates_without_context_and_skips_llm():
    orchestrator, _, retriever, llm = make_orchestrator([])

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message="Gia san pham la bao nhieu?",
        model="gemini-2.0-flash",
    )

    assert retriever.calls[0]["org_id"] == ORG_ID
    assert llm.calls == []
    assert result["replyText"].startswith("Minh chua co du thong tin")
    assert result["citations"] == []
    assert result["toolsUsed"] == []
    assert result["tokens"] == {"prompt": 0, "completion": 0, "total": 0}
    assert result["escalate"] is True


def test_process_message_escalates_when_monthly_token_quota_is_exceeded():
    quota = FakeQuotaClient(exceeded=True)
    orchestrator, embeddings, retriever, llm = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Ao thun co mau den.",
                "score": 0.92,
            }
        ],
        quota_client=quota,
    )

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        model="gemini-2.0-flash",
    )

    assert quota.check_calls == [{"org_id": ORG_ID}]
    # The quota gate must run BEFORE the paid embedContent call.
    assert embeddings.calls == 0
    assert retriever.calls == []
    assert llm.calls == []
    assert quota.record_calls == []
    assert result["escalate"] is True
    assert result["tokens"] == {"prompt": 0, "completion": 0, "total": 0}


def test_process_message_escalates_before_embedding_when_spend_cap_is_exceeded():
    spend_budget = FakeSpendBudget(embedding_exceeded=True)
    orchestrator, embeddings, retriever, llm = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Ao thun co mau den.",
                "score": 0.92,
            }
        ],
        spend_budget=spend_budget,
    )

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        model="gemini-2.0-flash",
    )

    assert spend_budget.embedding_estimate_calls == [["Ao nay co mau den khong?"]]
    assert spend_budget.check_calls == [EMBED_ESTIMATE]
    assert embeddings.calls == 0
    assert spend_budget.record_embedding_calls == []
    assert retriever.calls == []
    assert llm.calls == []
    assert result["escalate"] is True


def test_process_message_meters_embedding_usage_in_spend_tracker_and_core():
    quota = FakeQuotaClient()
    spend_budget = FakeSpendBudget()
    orchestrator, embeddings, _, _ = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Ao thun co mau den.",
                "score": 0.92,
            }
        ],
        quota_client=quota,
        spend_budget=spend_budget,
    )

    orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        model="gemini-2.0-flash",
    )

    assert embeddings.calls == 1
    assert spend_budget.record_embedding_calls == [
        {"input_tokens": EMBED_ESTIMATE.input_tokens}
    ]
    assert quota.record_calls == [
        {
            "org_id": ORG_ID,
            "quantity": EMBED_ESTIMATE.input_tokens,
            "ref_type": "embedding",
        },
        {"org_id": ORG_ID, "quantity": 17, "ref_type": "completion"},
    ]


def test_process_message_records_token_usage_after_successful_llm():
    quota = FakeQuotaClient()
    orchestrator, _, _, _ = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Ao thun co mau den.",
                "score": 0.92,
            }
        ],
        quota_client=quota,
    )

    orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        model="gemini-2.0-flash",
    )

    # No spend budget wired: embedding tokens are still counted for Core.
    assert quota.record_calls == [
        {
            "org_id": ORG_ID,
            "quantity": estimate_tokens("Ao nay co mau den khong?"),
            "ref_type": "embedding",
        },
        {"org_id": ORG_ID, "quantity": 17, "ref_type": "completion"},
    ]


def test_process_message_escalates_when_llm_spend_cap_is_exceeded():
    spend_budget = FakeSpendBudget(exceeded=True)
    orchestrator, _, _, llm = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Ao thun co mau den.",
                "score": 0.92,
            }
        ],
        spend_budget=spend_budget,
    )

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        model="gemini-2.0-flash",
    )

    assert spend_budget.estimate_calls
    # Embedding gate passes, completion gate refuses.
    assert spend_budget.check_calls == [EMBED_ESTIMATE, {"usd": 0.01}]
    assert spend_budget.record_calls == []
    assert llm.calls == []
    assert result["escalate"] is True
    assert result["tokens"] == {"prompt": 0, "completion": 0, "total": 0}


def test_process_message_records_llm_spend_after_successful_llm():
    spend_budget = FakeSpendBudget()
    orchestrator, _, _, _ = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Ao thun co mau den.",
                "score": 0.92,
            }
        ],
        spend_budget=spend_budget,
    )

    orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        model="gemini-2.0-flash",
    )

    assert spend_budget.record_calls == [
        {"prompt_tokens": 10, "completion_tokens": 7}
    ]


def test_process_message_escalates_low_relevance_chunks_and_skips_llm():
    orchestrator, _, _, llm = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Quan jeans co mau xanh.",
                "distance": 0.80,
            }
        ]
    )

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        model="gemini-2.0-flash",
    )

    assert llm.calls == []
    assert result["citations"] == []
    assert result["tokens"] == {"prompt": 0, "completion": 0, "total": 0}
    assert result["escalate"] is True


def test_process_message_answers_with_subset_citations_from_good_chunks():
    orchestrator, embeddings, retriever, llm = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Ao thun co co tron.",
                "score": 0.92,
            },
            {
                "sourceType": "product",
                "sourceId": "33333333-3333-3333-3333-333333333333",
                "chunkIndex": 1,
                "content": "Ao thun co mau den.",
                "score": 0.91,
            }
        ],
        llm_text=(
            '{"replyText":"Ao thun nay co mau den [2].",'
            '"citedIndices":[2,99],"escalate":false}'
        ),
    )

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        top_k=2,
        model="gemini-2.0-flash",
    )

    assert embeddings.texts == ["Ao nay co mau den khong?"]
    assert retriever.calls[0]["org_id"] == ORG_ID
    assert retriever.calls[0]["top_k"] == 2
    assert llm.calls[0]["model"] == "gemini-2.0-flash"
    assert "[1] Ao thun co co tron." in llm.calls[0]["messages"][0]["content"]
    assert "[2] Ao thun co mau den." in llm.calls[0]["messages"][0]["content"]
    assert result == {
        "replyText": "Ao thun nay co mau den [2].",
        "citations": [
            {
                "index": 2,
                "sourceType": "product",
                "sourceId": "33333333-3333-3333-3333-333333333333",
                "chunkIndex": 1,
                "score": 0.91,
            }
        ],
        "toolsUsed": [],
        "promptVersion": "test_prompt_v1",
        "model": "gemini-2.0-flash",
        "tokens": {"prompt": 10, "completion": 7, "total": 17},
        "escalate": False,
    }


def test_process_message_uses_core_tools_for_draft_order_intent():
    core_tools = FakeCoreTools()
    orchestrator, _, _, llm = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": PRODUCT_ID,
                "chunkIndex": 0,
                "content": "Ao thun den gia 120000.",
                "score": 0.95,
            }
        ],
        llm_text=(
            '{"replyText":"Shop da tao don nhap cho 2 ao thun den [1].",'
            '"citedIndices":[1],"escalate":false}'
        ),
        core_tools_client=core_tools,
    )

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message="Chot 2 cai nay giup minh",
        model="gemini-2.0-flash",
        conversation_id=CONVERSATION_ID,
        contact_id=CONTACT_ID,
        message_id=MESSAGE_ID,
        channel="messenger",
        channel_connection_id="88888888-8888-8888-8888-888888888888",
    )

    assert core_tools.get_product_calls == [
        {"org_id": ORG_ID, "product_id": PRODUCT_ID}
    ]
    assert core_tools.create_draft_order_calls == [
        {
            "org_id": ORG_ID,
            "conversation_id": CONVERSATION_ID,
            "contact_id": CONTACT_ID,
            "idempotency_key": f"ai:{MESSAGE_ID}",
            "items": [{"variantId": VARIANT_ID, "qty": 2}],
        }
    ]
    assert [tool["name"] for tool in result["toolsUsed"]] == [
        "getProduct",
        "createDraftOrder",
    ]
    assert result["toolsUsed"][1]["orderId"] == "77777777-7777-7777-7777-777777777777"
    assert "Product from Core" in llm.calls[0]["messages"][0]["content"]
    assert "Draft order created by Core" in llm.calls[0]["messages"][0]["content"]
    assert result["escalate"] is False


def test_process_message_honors_model_escalate_flag():
    orchestrator, _, _, llm = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Ao thun co mau den.",
                "score": 0.92,
            }
        ],
        llm_text=(
            '{"replyText":"Minh se chuyen doi ngu ho tro kiem tra them.",'
            '"citedIndices":[1],"escalate":true}'
        ),
    )

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        model="gemini-2.0-flash",
    )

    assert llm.calls[0]["model"] == "gemini-2.0-flash"
    assert result["replyText"] == "Minh se chuyen doi ngu ho tro kiem tra them."
    assert result["citations"] == []
    assert result["tokens"] == {"prompt": 10, "completion": 7, "total": 17}
    assert result["escalate"] is True


def test_process_message_escalates_factual_answer_without_citations():
    orchestrator, _, _, llm = make_orchestrator(
        [
            {
                "sourceType": "product",
                "sourceId": "22222222-2222-2222-2222-222222222222",
                "chunkIndex": 0,
                "content": "Ao thun co mau den.",
                "score": 0.92,
            }
        ],
        llm_text=(
            '{"replyText":"Ao thun nay co mau den.",'
            '"citedIndices":[],"escalate":false}'
        ),
    )

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message="Ao nay co mau den khong?",
        model="gemini-2.0-flash",
    )

    assert llm.calls[0]["model"] == "gemini-2.0-flash"
    assert result["replyText"].startswith("Minh chua co du thong tin")
    assert result["citations"] == []
    assert result["escalate"] is True


def test_process_message_route_uses_service_key(monkeypatch):
    class FakeOrchestrator:
        def __init__(self):
            self.calls: list[dict] = []

        def process_message(self, **kwargs):
            self.calls.append(kwargs)
            return {
                "replyText": "ok",
                "citations": [],
                "toolsUsed": [],
                "promptVersion": "test",
                "model": "gemini-2.0-flash",
                "tokens": {"prompt": 1, "completion": 1, "total": 2},
                "escalate": False,
            }

    fake = FakeOrchestrator()
    monkeypatch.setattr(process_message_api, "orchestrator", fake)

    r = client.post(
        "/internal/v1/ai/process-message",
        headers={"x-service-key": settings.service_m2m_key},
        json={"orgId": ORG_ID, "message": "hello", "topK": 4},
    )

    assert r.status_code == 200
    assert r.json()["replyText"] == "ok"
    assert fake.calls[0] == {
        "org_id": ORG_ID,
        "message": "hello",
        "top_k": 4,
        "model": None,
        "conversation_id": None,
        "contact_id": None,
        "message_id": None,
        "channel": None,
        "channel_connection_id": None,
    }


def test_process_message_route_rejects_wrong_service_key():
    r = client.post(
        "/internal/v1/ai/process-message",
        headers={"x-service-key": "wrong-key"},
        json={"orgId": ORG_ID, "message": "hello"},
    )

    assert r.status_code == 401
