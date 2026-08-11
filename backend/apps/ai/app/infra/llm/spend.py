import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock

from app.config import settings


@dataclass(frozen=True)
class LlmSpendEstimate:
    input_tokens: int
    output_tokens: int
    usd: float


class LlmSpendTracker:
    def __init__(
        self,
        *,
        counter_path: str | Path | None = None,
        daily_cap_usd: float | None = None,
        monthly_cap_usd: float | None = None,
        input_usd_per_1k_tokens: float | None = None,
        output_usd_per_1k_tokens: float | None = None,
        embedding_usd_per_1k_tokens: float | None = None,
    ):
        self.counter_path = Path(counter_path or settings.llm_spend_counter_path)
        self.daily_cap_usd = (
            settings.llm_daily_spend_cap_usd
            if daily_cap_usd is None
            else daily_cap_usd
        )
        self.monthly_cap_usd = (
            settings.llm_monthly_spend_cap_usd
            if monthly_cap_usd is None
            else monthly_cap_usd
        )
        self.input_usd_per_1k_tokens = (
            settings.gemini_usd_per_1k_input_tokens
            if input_usd_per_1k_tokens is None
            else input_usd_per_1k_tokens
        )
        self.output_usd_per_1k_tokens = (
            settings.gemini_usd_per_1k_output_tokens
            if output_usd_per_1k_tokens is None
            else output_usd_per_1k_tokens
        )
        self.embedding_usd_per_1k_tokens = (
            settings.gemini_usd_per_1k_embedding_tokens
            if embedding_usd_per_1k_tokens is None
            else embedding_usd_per_1k_tokens
        )
        self._lock = Lock()

    def estimate_messages(
        self,
        messages: list[dict[str, str]],
        *,
        output_token_reserve: int = 512,
    ) -> LlmSpendEstimate:
        input_tokens = sum(
            estimate_tokens(f"{message.get('role', '')} {message.get('content', '')}")
            for message in messages
        )
        return self.estimate_cost(
            input_tokens=input_tokens,
            output_tokens=output_token_reserve,
        )

    def estimate_cost(self, *, input_tokens: int, output_tokens: int) -> LlmSpendEstimate:
        usd = (
            (input_tokens / 1000) * self.input_usd_per_1k_tokens
            + (output_tokens / 1000) * self.output_usd_per_1k_tokens
        )
        return LlmSpendEstimate(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            usd=usd,
        )

    def estimate_embedding(self, texts: list[str]) -> LlmSpendEstimate:
        """Estimate the cost of embedding ``texts`` as one batch."""
        return self.estimate_embedding_cost(
            input_tokens=sum(estimate_tokens(text) for text in texts),
        )

    def estimate_embedding_cost(self, *, input_tokens: int) -> LlmSpendEstimate:
        tokens = max(input_tokens, 0)
        return LlmSpendEstimate(
            input_tokens=tokens,
            output_tokens=0,
            usd=(tokens / 1000) * self.embedding_usd_per_1k_tokens,
        )

    def would_exceed_cap(self, estimate: LlmSpendEstimate) -> bool:
        if self.daily_cap_usd <= 0 and self.monthly_cap_usd <= 0:
            return False

        with self._lock:
            counters = self._read_counters()
            return (
                self.daily_cap_usd > 0
                and counters["day_usd"] + estimate.usd > self.daily_cap_usd
            ) or (
                self.monthly_cap_usd > 0
                and counters["month_usd"] + estimate.usd > self.monthly_cap_usd
            )

    def record_completion(self, *, prompt_tokens: int, completion_tokens: int) -> None:
        actual = self.estimate_cost(
            input_tokens=max(prompt_tokens, 0),
            output_tokens=max(completion_tokens, 0),
        )
        self._add_usd(actual.usd)

    def record_embedding(self, *, input_tokens: int) -> None:
        """Charge embedding tokens against the same day/month counters."""
        actual = self.estimate_embedding_cost(input_tokens=input_tokens)
        self._add_usd(actual.usd)

    def _add_usd(self, usd: float) -> None:
        if usd <= 0:
            return

        with self._lock:
            counters = self._read_counters()
            counters["day_usd"] += usd
            counters["month_usd"] += usd
            self.counter_path.parent.mkdir(parents=True, exist_ok=True)
            self.counter_path.write_text(json.dumps(counters, sort_keys=True), "utf-8")

    def _read_counters(self) -> dict[str, float | str]:
        now = datetime.now(UTC)
        day = now.strftime("%Y-%m-%d")
        month = now.strftime("%Y-%m")

        raw: dict[str, float | str]
        try:
            raw = json.loads(self.counter_path.read_text("utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            raw = {}

        if raw.get("day") != day:
            raw["day"] = day
            raw["day_usd"] = 0.0
        if raw.get("month") != month:
            raw["month"] = month
            raw["month_usd"] = 0.0

        raw["day_usd"] = _as_non_negative_float(raw.get("day_usd"))
        raw["month_usd"] = _as_non_negative_float(raw.get("month_usd"))
        return raw


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def _as_non_negative_float(value: object) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
        return float(value)
    return 0.0
