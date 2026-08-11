from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class LlmCompletion:
    text: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ModelNotAllowedError(ValueError):
    """A model was refused because it is not in AI_MODEL_ALLOWLIST.

    Subclasses ``ValueError`` so existing callers (and the FastAPI routes that
    map ``ValueError`` to HTTP 400) keep behaving the same, while
    :class:`FailoverLlmProvider` can tell a *policy refusal* apart from a
    *provider outage*.
    """


class LlmProvider(Protocol):
    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
    ) -> LlmCompletion:
        ...


class FailoverLlmProvider:
    def __init__(self, primary: LlmProvider, secondary: LlmProvider | None = None):
        self.primary = primary
        self.secondary = secondary

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
    ) -> LlmCompletion:
        try:
            return self.primary.complete(model=model, messages=messages)
        except ModelNotAllowedError:
            # Policy refusal, not an outage. Failing over here would send the
            # grounded prompt to a model the org has explicitly not approved,
            # which is exactly backwards. Fail closed.
            raise
        except Exception as primary_error:
            if self.secondary is None:
                raise
            try:
                return self.secondary.complete(model=model, messages=messages)
            except ModelNotAllowedError as secondary_error:
                # The primary is genuinely down but no approved fallback model
                # exists. That is a server/config problem, not a bad request,
                # so surface it as RuntimeError (HTTP 502) rather than 400.
                raise RuntimeError(
                    f"Primary LLM failed ({primary_error}) and the fallback"
                    f" model is not allowed: {secondary_error}"
                ) from primary_error


def parse_allowlist(allowlist: str) -> set[str]:
    return {item.strip() for item in allowlist.split(",") if item.strip()}


def assert_model_allowed(model: str, allowlist: str) -> None:
    if model not in parse_allowlist(allowlist):
        raise ModelNotAllowedError(f"Model {model!r} is not in AI_MODEL_ALLOWLIST")
