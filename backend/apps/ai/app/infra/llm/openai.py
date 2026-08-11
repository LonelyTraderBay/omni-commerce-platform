import json
from urllib import error, request

from app.config import settings
from app.infra.llm.provider import LlmCompletion, assert_model_allowed

# Documented Gemini -> OpenAI failover mapping. Whatever a request resolves to
# here is BOTH the model that gets allowlist-checked AND the model actually sent
# to OpenAI, so an org has to add the OpenAI model to AI_MODEL_ALLOWLIST before
# failover is allowed to spend on it.
GEMINI_TO_OPENAI_FALLBACK = {
    "gemini-1.5-flash": "gpt-4o-mini",
    "gemini-2.0-flash": "gpt-4o-mini",
    "gemini-2.0-flash-lite": "gpt-4o-mini",
    "gemini-2.5-flash": "gpt-4o-mini",
    "gemini-1.5-pro": "gpt-4o",
    "gemini-2.0-pro": "gpt-4o",
    "gemini-2.5-pro": "gpt-4o",
}
OPENAI_MODEL_PREFIXES = ("gpt-", "chatgpt-", "o1", "o3", "o4")


class OpenAiLlmProvider:
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        allowlist: str | None = None,
        opener=request.urlopen,
    ):
        self.api_key = api_key if api_key is not None else settings.openai_api_key
        self.model = model if model is not None else settings.openai_model
        self.allowlist = (
            allowlist if allowlist is not None else settings.ai_model_allowlist
        )
        self.opener = opener

    def resolve_model(self, model: str) -> str:
        """Map a requested model onto the OpenAI model that will actually run.

        1. An OpenAI model asked for by the caller is honored as-is.
        2. A Gemini model uses the documented ``GEMINI_TO_OPENAI_FALLBACK``.
        3. Anything else falls back to the configured ``OPENAI_MODEL``.

        The result is always allowlist-checked by :meth:`complete`.
        """
        if model.startswith(OPENAI_MODEL_PREFIXES):
            return model
        return GEMINI_TO_OPENAI_FALLBACK.get(model, self.model)

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
    ) -> LlmCompletion:
        resolved_model = self.resolve_model(model)
        # Enforce on the model that is actually used, not on the one requested.
        assert_model_allowed(resolved_model, self.allowlist)

        if not self.api_key:
            raise RuntimeError("OPENAI_API_KEY is required for LLM fallback")
        if not messages:
            raise ValueError("messages must not be empty")

        payload = {
            "model": resolved_model,
            "messages": [
                {
                    "role": _map_role(message["role"]),
                    "content": message["content"],
                }
                for message in messages
            ],
        }
        req = request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with self.opener(req, timeout=60) as response:
                body = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenAI completion failed: {exc.code} {detail}") from exc

        text = _extract_text(body)
        usage = body.get("usage") or {}
        return LlmCompletion(
            text=text,
            model=str(body.get("model") or resolved_model),
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            total_tokens=int(usage.get("total_tokens") or 0),
        )


def _map_role(role: str) -> str:
    if role == "model":
        return "assistant"
    if role in ("system", "user", "assistant"):
        return role
    raise ValueError(f"Unsupported message role: {role!r}")


def _extract_text(body: dict) -> str:
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("OpenAI completion response had no choices")

    message = choices[0].get("message") or {}
    text = message.get("content")
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("OpenAI completion response had empty text")
    return text
