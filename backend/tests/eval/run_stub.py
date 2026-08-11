from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AI_ROOT = ROOT / "apps" / "ai"
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))

from app.domain.orchestrator import ProcessMessageOrchestrator, PromptTemplate
from app.infra.llm.provider import LlmCompletion

EVAL_ROOT = Path(__file__).parent
ADVERSARIAL_DIR = EVAL_ROOT / "adversarial"
GOLDEN_DIR = EVAL_ROOT / "golden"
ORG_ID = "11111111-1111-1111-1111-111111111111"
DEFAULT_SCORE = 0.95

REQUIRED_GOLDEN_SECTIONS = (
    "## Prompt",
    "## Knowledge chunks",
    "## Expected",
    "## Expected grounded behavior",
)


@dataclass(frozen=True)
class GoldenCase:
    path: Path
    prompt: str
    chunks: list[dict]
    mock_llm_response: str | None
    expected: dict[str, str]


class FakeEmbeddings:
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [[0.02] * 768 for _ in texts]


class FakeRetriever:
    def __init__(self, chunks: list[dict]):
        self.chunks = chunks
        self.calls: list[dict] = []

    def retrieve_chunks(self, **kwargs) -> list[dict]:
        self.calls.append(kwargs)
        return self.chunks


class FakeLlm:
    def __init__(self, text: str):
        self.text = text
        self.calls: list[dict] = []

    def complete(self, **kwargs) -> LlmCompletion:
        self.calls.append(kwargs)
        return LlmCompletion(
            text=self.text,
            model=kwargs["model"],
            prompt_tokens=10,
            completion_tokens=7,
            total_tokens=17,
        )


def _section(text: str, heading: str) -> str:
    pattern = re.compile(rf"^{re.escape(heading)}\s*$", re.MULTILINE)
    match = pattern.search(text)
    if match is None:
        raise AssertionError(f"missing section {heading}")

    start = match.end()
    next_heading = re.search(r"\n## ", text[start:])
    end = start + next_heading.start() if next_heading else len(text)
    return text[start:end].strip()


def _parse_expected(raw: str) -> dict[str, str]:
    expected: dict[str, str] = {}
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        expected[key.strip()] = value.strip()
    return expected


def _parse_chunks(raw: str) -> list[dict]:
    chunks: list[dict] = []
    for index, line in enumerate(raw.splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        match = re.match(r"^\d+\.\s+(?P<content>.+)$", stripped)
        if not match:
            continue
        content = match.group("content")
        score = DEFAULT_SCORE
        score_match = re.search(r"score:\s*([0-9.]+)", content, re.IGNORECASE)
        if score_match:
            score = float(score_match.group(1))
            content = re.sub(r"\s*score:\s*[0-9.]+\s*", "", content, flags=re.IGNORECASE)
        chunks.append(
            {
                "sourceType": "product",
                "sourceId": f"{index:032x}",
                "chunkIndex": index - 1,
                "content": content.strip(),
                "score": score,
            }
        )
    return chunks


def _parse_mock_llm(raw: str) -> str | None:
    if not raw:
        return None
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if fence:
        return fence.group(1).strip()
    stripped = raw.strip()
    return stripped or None


def load_golden_case(path: Path) -> GoldenCase:
    text = path.read_text(encoding="utf-8")
    for heading in REQUIRED_GOLDEN_SECTIONS:
        if heading not in text:
            raise AssertionError(f"{path.name} missing {heading}")

    return GoldenCase(
        path=path,
        prompt=_section(text, "## Prompt"),
        chunks=_parse_chunks(_section(text, "## Knowledge chunks")),
        mock_llm_response=_parse_mock_llm(_section(text, "## Mock LLM response")),
        expected=_parse_expected(_section(text, "## Expected")),
    )


def run_golden_case(case: GoldenCase) -> None:
    skip_llm = case.expected.get("skip_llm", "false").lower() == "true"
    mock_llm = case.mock_llm_response or "{}"
    orchestrator = ProcessMessageOrchestrator(
        embedding_provider=FakeEmbeddings(),
        retriever=FakeRetriever(case.chunks),
        llm_provider=FakeLlm(mock_llm),
        prompt=PromptTemplate(version="eval_golden_v1", text="Only use context."),
    )
    llm = orchestrator.llm_provider
    assert isinstance(llm, FakeLlm)

    result = orchestrator.process_message(
        org_id=ORG_ID,
        message=case.prompt,
        model="gemini-2.0-flash",
    )

    expected_escalate = case.expected.get("escalate", "false").lower() == "true"
    assert result["escalate"] is expected_escalate, case.path.name

    if skip_llm:
        assert llm.calls == [], case.path.name
    elif case.chunks:
        assert llm.calls, case.path.name

    if "min_citations" in case.expected:
        min_citations = int(case.expected["min_citations"])
        assert len(result["citations"]) >= min_citations, case.path.name

    if "reply_contains" in case.expected:
        needle = case.expected["reply_contains"]
        assert needle in result["replyText"], case.path.name


def main() -> None:
    adversarial = sorted(ADVERSARIAL_DIR.glob("*.md"))
    golden = sorted(GOLDEN_DIR.glob("*.md"))

    assert len(adversarial) >= 10, len(adversarial)
    assert len(golden) >= 5, len(golden)

    for case_path in golden:
        run_golden_case(load_golden_case(case_path))

    print(f"ok:adversarial={len(adversarial)} golden={len(golden)}")


if __name__ == "__main__":
    main()
