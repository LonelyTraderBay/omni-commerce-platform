import json
from urllib import error, request

from app.config import settings
from app.infra.llm.provider import LlmCompletion, assert_model_allowed


class GeminiLlmProvider:
    def __init__(
        self,
        api_key: str | None = None,
        allowlist: str | None = None,
        opener=request.urlopen,
    ):
        self.api_key = api_key if api_key is not None else settings.gemini_api_key
        self.allowlist = allowlist if allowlist is not None else settings.ai_model_allowlist
        self.opener = opener

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
    ) -> LlmCompletion:
        assert_model_allowed(model, self.allowlist)

        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY is required for LLM completion")

        if not messages:
            raise ValueError("messages must not be empty")

        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:generateContent?key={self.api_key}"
        )
        payload = {
            "contents": [
                {
                    "role": _map_role(message["role"]),
                    "parts": [{"text": message["content"]}],
                }
                for message in messages
            ]
        }
        req = request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with self.opener(req, timeout=60) as response:
                body = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Gemini completion failed: {exc.code} {detail}") from exc

        text = _extract_text(body)
        usage = body.get("usageMetadata") or {}

        return LlmCompletion(
            text=text,
            model=model,
            prompt_tokens=int(usage.get("promptTokenCount") or 0),
            completion_tokens=int(usage.get("candidatesTokenCount") or 0),
            total_tokens=int(usage.get("totalTokenCount") or 0),
        )


def _map_role(role: str) -> str:
    if role == "assistant":
        return "model"
    if role in ("user", "model"):
        return role
    raise ValueError(f"Unsupported message role: {role!r}")


def _extract_text(body: dict) -> str:
    candidates = body.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError("Gemini completion response had no candidates")

    content = candidates[0].get("content") or {}
    parts = content.get("parts")
    if not isinstance(parts, list) or not parts:
        raise RuntimeError("Gemini completion response had no text parts")

    text = parts[0].get("text")
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("Gemini completion response had empty text")

    return text
