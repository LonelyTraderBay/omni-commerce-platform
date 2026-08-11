from app.infra.llm.stub import StubLlmProvider


def test_local_llm_returns_valid_grounded_decision_json():
    result = StubLlmProvider().complete(
        model="gemini-2.0-flash",
        messages=[{"role": "user", "content": "Context [2]: áo thun đen"}],
    )

    assert result.model == "advisor-stub"
    assert '"citedIndices": [2]' in result.text
    assert '"escalate": false' in result.text
    assert result.total_tokens == 0


def test_local_llm_escalates_when_no_grounding_is_available():
    result = StubLlmProvider().complete(
        model="advisor-stub",
        messages=[{"role": "user", "content": "No catalog context"}],
    )

    assert '"citedIndices": []' in result.text
    assert '"escalate": true' in result.text
