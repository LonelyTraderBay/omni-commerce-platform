"""Deterministic local LLM provider.

This provider keeps the complete AI request path runnable without Gemini or
OpenAI credentials. It returns valid grounded-decision JSON so the domain
orchestrator, tool calls, citations, audit and quota paths are still exercised.
It is never selected automatically in production.
"""

from __future__ import annotations

import json
import re

from app.infra.llm.provider import LlmCompletion


class StubLlmProvider:
    label = "advisor-stub"

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
    ) -> LlmCompletion:
        if not messages:
            raise ValueError("messages must not be empty")

        prompt = "\n".join(message.get("content", "") for message in messages)
        cited_indices = _available_citation_indices(prompt)
        grounded = bool(cited_indices)
        body = {
            "replyText": (
                "Đây là phản hồi AI local để kiểm tra luồng phát triển. "
                "Hãy đối chiếu lại thông tin với dữ liệu sản phẩm trước khi chốt đơn."
                if grounded
                else "Chưa có đủ dữ liệu local để trả lời chính xác; cần nhân viên kiểm tra thêm."
            ),
            "citedIndices": cited_indices[:1],
            "escalate": not grounded,
        }

        return LlmCompletion(
            text=json.dumps(body, ensure_ascii=False),
            model=self.label,
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
        )


def _available_citation_indices(prompt: str) -> list[int]:
    values = {int(value) for value in re.findall(r"\[(\d+)\]", prompt)}
    return sorted(value for value in values if value > 0)
