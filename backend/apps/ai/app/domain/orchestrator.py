import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.config import settings
from app.infra.embeddings.gemini import EMBEDDING_DIMENSIONS, EmbeddingProvider
from app.infra.llm.provider import LlmProvider, assert_model_allowed
from app.infra.llm.spend import estimate_tokens

PROMPT_PATH = Path(__file__).parent / "prompts" / "v1_grounded_process_message.md"
SAFE_ESCALATE_REPLY = (
    "Minh chua co du thong tin trong du lieu hien co de tra loi chinh xac. "
    "Minh se chuyen cho doi ngu ho tro kiem tra them."
)
FACTUAL_PRODUCT_TERMS = (
    "bao nhieu",
    "gia",
    "mau",
    "size",
    "kich co",
    "ton",
    "con hang",
    "san pham",
    "doi tra",
    "bao hanh",
    "ship",
    "giao hang",
    "price",
    "stock",
    "available",
    "product",
)
ORDER_INTENT_TERMS = (
    "dat hang",
    "dat don",
    "len don",
    "chot",
    "mua",
    "lay",
    "order",
)


class KnowledgeRetriever(Protocol):
    def retrieve_chunks(
        self,
        *,
        org_id: str,
        embedding: list[float],
        top_k: int,
    ) -> list[dict]:
        ...


class AiTokenQuotaClient(Protocol):
    def check_ai_token_quota(self, *, org_id: str) -> dict:
        ...

    def record_ai_token_usage(
        self,
        *,
        org_id: str,
        quantity: int,
        ref_type: str | None = None,
        ref_id: str | None = None,
    ) -> None:
        ...


class LlmSpendBudget(Protocol):
    def estimate_messages(self, messages: list[dict[str, str]]):
        ...

    def estimate_embedding(self, texts: list[str]):
        ...

    def would_exceed_cap(self, estimate) -> bool:
        ...

    def record_completion(self, *, prompt_tokens: int, completion_tokens: int) -> None:
        ...

    def record_embedding(self, *, input_tokens: int) -> None:
        ...


class CoreToolsClient(Protocol):
    def get_product(
        self,
        *,
        org_id: str,
        product_id: str,
    ) -> dict:
        ...

    def create_draft_order(
        self,
        *,
        org_id: str,
        conversation_id: str | None,
        contact_id: str | None,
        idempotency_key: str | None,
        items: list[dict],
    ) -> dict:
        ...


@dataclass(frozen=True)
class PromptTemplate:
    version: str
    text: str


@dataclass(frozen=True)
class LlmDecision:
    reply_text: str
    cited_indices: list[int]
    escalate: bool


class ProcessMessageOrchestrator:
    def __init__(
        self,
        *,
        embedding_provider: EmbeddingProvider,
        retriever: KnowledgeRetriever,
        llm_provider: LlmProvider,
        prompt: PromptTemplate | None = None,
        min_relevance_similarity: float | None = None,
        quota_client: AiTokenQuotaClient | None = None,
        core_tools_client: CoreToolsClient | None = None,
        spend_budget: LlmSpendBudget | None = None,
    ):
        self.embedding_provider = embedding_provider
        self.retriever = retriever
        self.llm_provider = llm_provider
        self.prompt = prompt or load_prompt()
        self.min_relevance_similarity = (
            settings.ai_relevance_min_similarity
            if min_relevance_similarity is None
            else min_relevance_similarity
        )
        self.quota_client = quota_client
        self.core_tools_client = core_tools_client
        self.spend_budget = spend_budget

    def process_message(
        self,
        *,
        org_id: str,
        message: str,
        top_k: int = 5,
        model: str | None = None,
        conversation_id: str | None = None,
        contact_id: str | None = None,
        message_id: str | None = None,
        channel: str | None = None,
        channel_connection_id: str | None = None,
    ) -> dict:
        selected_model = model or default_model()
        assert_model_allowed(selected_model, settings.ai_model_allowlist)

        # Embedding is a *paid* Gemini call, so both the org quota gate and the
        # spend cap gate must run before it — not after.
        if self.quota_client is not None:
            quota = self.quota_client.check_ai_token_quota(org_id=org_id)
            if quota.get("exceeded") is True:
                return self._escalation_response(
                    model=selected_model,
                    tokens={"prompt": 0, "completion": 0, "total": 0},
                )

        embed_estimate = (
            self.spend_budget.estimate_embedding([message])
            if self.spend_budget is not None
            else None
        )
        if embed_estimate is not None and self.spend_budget.would_exceed_cap(
            embed_estimate
        ):
            return self._escalation_response(
                model=selected_model,
                tokens={"prompt": 0, "completion": 0, "total": 0},
            )

        query_embedding = self._embed_query(message)
        embed_tokens = (
            embed_estimate.input_tokens
            if embed_estimate is not None
            else estimate_tokens(message)
        )
        if self.spend_budget is not None:
            self.spend_budget.record_embedding(input_tokens=embed_tokens)
        if self.quota_client is not None and embed_tokens > 0:
            self.quota_client.record_ai_token_usage(
                org_id=org_id,
                quantity=embed_tokens,
                ref_type="embedding",
            )

        chunks = self.retriever.retrieve_chunks(
            org_id=org_id,
            embedding=query_embedding,
            top_k=top_k,
        )
        relevant_chunks = self._filter_relevant_chunks(chunks)

        if not relevant_chunks:
            return self._escalation_response(
                model=selected_model,
                tokens={"prompt": 0, "completion": 0, "total": 0},
            )

        tools_used, tool_context = self._run_core_tools(
            org_id=org_id,
            message=message,
            chunks=relevant_chunks,
            conversation_id=conversation_id,
            contact_id=contact_id,
            message_id=message_id,
            channel=channel,
            channel_connection_id=channel_connection_id,
        )
        messages = [
            {
                "role": "user",
                "content": self._build_grounded_prompt(
                    message,
                    relevant_chunks,
                    tool_context=tool_context,
                ),
            }
        ]
        if self.spend_budget is not None:
            estimate = self.spend_budget.estimate_messages(messages)
            if self.spend_budget.would_exceed_cap(estimate):
                return self._escalation_response(
                    model=selected_model,
                    tokens={"prompt": 0, "completion": 0, "total": 0},
                    tools_used=tools_used,
                )

        completion = self.llm_provider.complete(model=selected_model, messages=messages)
        tokens = {
            "prompt": completion.prompt_tokens,
            "completion": completion.completion_tokens,
            "total": completion.total_tokens,
        }
        if self.spend_budget is not None:
            self.spend_budget.record_completion(
                prompt_tokens=completion.prompt_tokens,
                completion_tokens=completion.completion_tokens,
            )
        if self.quota_client is not None and completion.total_tokens > 0:
            self.quota_client.record_ai_token_usage(
                org_id=org_id,
                quantity=completion.total_tokens,
                ref_type="completion",
            )
        decision = _parse_llm_decision(completion.text)
        if decision is None:
            return self._escalation_response(
                model=completion.model,
                tokens=tokens,
                tools_used=tools_used,
            )

        cited_indices = _valid_cited_indices(
            decision.cited_indices,
            chunk_count=len(relevant_chunks),
        )
        escalate_without_citations = (
            _is_factual_product_question(message)
            and not cited_indices
            and not _has_successful_tool(tools_used)
        )
        escalate = decision.escalate or escalate_without_citations or not decision.reply_text

        return {
            "replyText": SAFE_ESCALATE_REPLY
            if escalate_without_citations or not decision.reply_text
            else decision.reply_text,
            "citations": [
                _citation_for(index, relevant_chunks[index - 1])
                for index in cited_indices
            ]
            if not escalate
            else [],
            "toolsUsed": tools_used,
            "promptVersion": self.prompt.version,
            "model": completion.model,
            "tokens": tokens,
            "escalate": escalate,
        }

    def _embed_query(self, message: str) -> list[float]:
        embeddings = self.embedding_provider.embed_texts([message])
        if len(embeddings) != 1:
            raise RuntimeError("Embedding provider returned unexpected count")
        embedding = embeddings[0]
        if len(embedding) != EMBEDDING_DIMENSIONS:
            raise RuntimeError("Embedding provider returned unexpected dimensions")
        return embedding

    def _build_grounded_prompt(
        self,
        message: str,
        chunks: list[dict],
        *,
        tool_context: list[str] | None = None,
    ) -> str:
        context = "\n\n".join(
            f"[{index}] {chunk.get('content', '')}"
            for index, chunk in enumerate(chunks, 1)
        )
        tools = "\n".join(tool_context or []) or "No Core tools were used."
        return (
            f"{self.prompt.text}\n\n"
            "Knowledge chunks:\n"
            f"{context}\n\n"
            "Core tool results:\n"
            f"{tools}\n\n"
            "Customer message:\n"
            f"{message}"
        )

    def _filter_relevant_chunks(self, chunks: list[dict]) -> list[dict]:
        return [
            chunk
            for chunk in chunks
            if _chunk_similarity(chunk) >= self.min_relevance_similarity
        ]

    def _escalation_response(
        self,
        *,
        model: str,
        tokens: dict[str, int],
        tools_used: list[dict] | None = None,
    ) -> dict:
        return {
            "replyText": SAFE_ESCALATE_REPLY,
            "citations": [],
            "toolsUsed": tools_used or [],
            "promptVersion": self.prompt.version,
            "model": model,
            "tokens": tokens,
            "escalate": True,
        }

    def _run_core_tools(
        self,
        *,
        org_id: str,
        message: str,
        chunks: list[dict],
        conversation_id: str | None,
        contact_id: str | None,
        message_id: str | None,
        channel: str | None,
        channel_connection_id: str | None,
    ) -> tuple[list[dict], list[str]]:
        if self.core_tools_client is None:
            return [], []

        product_id = _first_product_source_id(chunks)
        if product_id is None or not _needs_product_tool(message):
            return [], []

        tools_used: list[dict] = []
        tool_context: list[str] = []
        try:
            product_result = self.core_tools_client.get_product(
                org_id=org_id,
                product_id=product_id,
            )
        except RuntimeError:
            return [
                {"name": "getProduct", "productId": product_id, "ok": False}
            ], []

        product = (
            product_result.get("product") if isinstance(product_result, dict) else None
        )
        tools_used.append({"name": "getProduct", "productId": product_id, "ok": True})
        if isinstance(product, dict):
            tool_context.append(_format_product_tool_context(product))

        if not isinstance(product, dict) or not _is_order_intent(message):
            return tools_used, tool_context

        draft_item = _draft_item_from_product(product, message)
        if draft_item is None:
            return tools_used, tool_context

        idempotency_key = f"ai:{message_id}" if message_id else None
        try:
            draft_result = self.core_tools_client.create_draft_order(
                org_id=org_id,
                conversation_id=conversation_id,
                contact_id=contact_id,
                idempotency_key=idempotency_key,
                items=[draft_item],
            )
        except RuntimeError:
            tools_used.append(
                {
                    "name": "createDraftOrder",
                    "productId": product_id,
                    "ok": False,
                }
            )
            return tools_used, tool_context

        order = draft_result.get("order") if isinstance(draft_result, dict) else None
        order_id = order.get("id") if isinstance(order, dict) else None
        total_vnd = order.get("totalVnd") if isinstance(order, dict) else None
        tools_used.append(
            {
                "name": "createDraftOrder",
                "productId": product_id,
                "orderId": order_id,
                "ok": True,
            }
        )
        tool_context.append(
            "Draft order created by Core"
            f"; orderId={order_id}; totalVnd={total_vnd};"
            f" conversationId={conversation_id}; contactId={contact_id};"
            f" channel={channel}; channelConnectionId={channel_connection_id}."
        )
        return tools_used, tool_context


def load_prompt(path: Path = PROMPT_PATH) -> PromptTemplate:
    text = path.read_text(encoding="utf-8").strip()
    first_line, _, rest = text.partition("\n")
    prefix = "prompt_version:"
    if not first_line.startswith(prefix):
        raise RuntimeError("Prompt file must start with prompt_version")
    version = first_line.removeprefix(prefix).strip()
    if not version:
        raise RuntimeError("Prompt version is empty")
    return PromptTemplate(version=version, text=rest.strip())


def default_model(allowlist: str | None = None) -> str:
    raw_allowlist = allowlist if allowlist is not None else settings.ai_model_allowlist
    models = [
        item.strip()
        for item in raw_allowlist.split(",")
        if item.strip()
    ]
    if not models:
        raise RuntimeError("AI_MODEL_ALLOWLIST must include at least one model")
    return models[0]


def _parse_llm_decision(text: str) -> LlmDecision | None:
    try:
        body = json.loads(_strip_json_fence(text))
    except json.JSONDecodeError:
        return None

    if not isinstance(body, dict):
        return None
    reply_text = body.get("replyText")
    cited_indices = body.get("citedIndices")
    escalate = body.get("escalate")
    if not isinstance(reply_text, str):
        return None
    if not isinstance(cited_indices, list):
        return None
    if not isinstance(escalate, bool):
        return None

    return LlmDecision(
        reply_text=reply_text.strip(),
        cited_indices=[
            item
            for item in cited_indices
            if isinstance(item, int) and not isinstance(item, bool)
        ],
        escalate=escalate,
    )


def _strip_json_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped

    lines = stripped.splitlines()
    if len(lines) >= 3 and lines[0].startswith("```") and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return stripped


def _valid_cited_indices(indices: list[int], *, chunk_count: int) -> list[int]:
    valid: list[int] = []
    seen: set[int] = set()
    for index in indices:
        if 1 <= index <= chunk_count and index not in seen:
            valid.append(index)
            seen.add(index)
    return valid


def _is_factual_product_question(message: str) -> bool:
    normalized = _normalize_search_text(message)
    return "?" in normalized or any(term in normalized for term in FACTUAL_PRODUCT_TERMS)


def _is_order_intent(message: str) -> bool:
    normalized = _normalize_search_text(message)
    return any(term in normalized for term in ORDER_INTENT_TERMS)


def _needs_product_tool(message: str) -> bool:
    return _is_factual_product_question(message) or _is_order_intent(message)


def _normalize_search_text(message: str) -> str:
    text = message.replace("\u0111", "d").replace("\u0110", "D")
    return (
        unicodedata.normalize("NFKD", text)
        .encode("ascii", "ignore")
        .decode("ascii")
        .casefold()
    )


def _first_product_source_id(chunks: list[dict]) -> str | None:
    for chunk in chunks:
        source_type = _first_present(chunk, "sourceType", "source_type")
        source_id = _first_present(chunk, "sourceId", "source_id")
        if source_type == "product" and isinstance(source_id, str) and source_id:
            return source_id
    return None


def _format_product_tool_context(product: dict) -> str:
    variants = product.get("variants")
    variant_lines: list[str] = []
    if isinstance(variants, list):
        for variant in variants[:5]:
            if not isinstance(variant, dict):
                continue
            variant_lines.append(
                "variant"
                f" id={variant.get('id')}"
                f" title={variant.get('title')}"
                f" sku={variant.get('sku')}"
                f" priceVnd={variant.get('priceVnd')}"
                f" stockQty={variant.get('stockQty')}"
            )
    variants_text = "; ".join(variant_lines) or "no variants"
    return (
        "Product from Core"
        f" id={product.get('id')}"
        f" title={product.get('title')}"
        f" status={product.get('status')}: {variants_text}."
    )


def _draft_item_from_product(product: dict, message: str) -> dict | None:
    variants = product.get("variants")
    if not isinstance(variants, list):
        return None
    available = [
        variant
        for variant in variants
        if isinstance(variant, dict) and _as_int(variant.get("stockQty")) > 0
    ]
    if len(available) != 1:
        return None
    variant_id = available[0].get("id")
    if not isinstance(variant_id, str) or not variant_id:
        return None
    return {"variantId": variant_id, "qty": _requested_qty(message)}


def _requested_qty(message: str) -> int:
    match = re.search(r"\b([1-9][0-9]{0,2})\b", message)
    if not match:
        return 1
    return min(int(match.group(1)), 999)


def _as_int(value) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, str) and re.fullmatch(r"-?\d+", value):
        return int(value)
    return 0


def _has_successful_tool(tools_used: list[dict]) -> bool:
    return any(tool.get("ok") is True for tool in tools_used)


def _chunk_similarity(chunk: dict) -> float:
    similarity = _as_float(_first_present(chunk, "score", "similarity"))
    if similarity is not None:
        return similarity

    distance = _as_float(
        _first_present_many(chunk, "distance", "cosineDistance", "cosine_distance")
    )
    if distance is not None:
        return 1.0 - distance

    return -1.0


def _citation_for(index: int, chunk: dict) -> dict:
    return {
        "index": index,
        "sourceType": _first_present(chunk, "sourceType", "source_type"),
        "sourceId": str(_first_present(chunk, "sourceId", "source_id")),
        "chunkIndex": _first_present(chunk, "chunkIndex", "chunk_index"),
        "score": _chunk_similarity(chunk),
    }


def _first_present(chunk: dict, first_key: str, second_key: str):
    if first_key in chunk:
        return chunk[first_key]
    return chunk.get(second_key)


def _first_present_many(chunk: dict, *keys: str):
    for key in keys:
        if key in chunk:
            return chunk[key]
    return None


def _as_float(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None
