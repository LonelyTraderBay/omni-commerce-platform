import json

from app.infra.llm.spend import LlmSpendTracker, estimate_tokens


def make_tracker(tmp_path, **kwargs) -> LlmSpendTracker:
    return LlmSpendTracker(
        counter_path=tmp_path / ".llm-spend.json",
        daily_cap_usd=kwargs.pop("daily_cap_usd", 0.0),
        monthly_cap_usd=kwargs.pop("monthly_cap_usd", 0.0),
        input_usd_per_1k_tokens=kwargs.pop("input_usd_per_1k_tokens", 0.0001),
        output_usd_per_1k_tokens=kwargs.pop("output_usd_per_1k_tokens", 0.0004),
        embedding_usd_per_1k_tokens=kwargs.pop("embedding_usd_per_1k_tokens", 0.0002),
        **kwargs,
    )


def test_estimate_embedding_charges_input_tokens_only(tmp_path):
    tracker = make_tracker(tmp_path)

    estimate = tracker.estimate_embedding(["hello there", "second chunk"])

    expected_tokens = estimate_tokens("hello there") + estimate_tokens("second chunk")
    assert estimate.input_tokens == expected_tokens
    assert estimate.output_tokens == 0
    assert estimate.usd == (expected_tokens / 1000) * 0.0002


def test_record_embedding_adds_to_the_same_day_and_month_counters(tmp_path):
    counter_path = tmp_path / ".llm-spend.json"
    tracker = make_tracker(tmp_path)

    tracker.record_embedding(input_tokens=10_000)
    tracker.record_completion(prompt_tokens=1_000, completion_tokens=1_000)

    counters = json.loads(counter_path.read_text("utf-8"))
    expected = (10_000 / 1000) * 0.0002 + 0.0001 + 0.0004
    assert counters["day_usd"] == expected
    assert counters["month_usd"] == expected


def test_embedding_spend_can_trip_the_daily_cap(tmp_path):
    tracker = make_tracker(tmp_path, daily_cap_usd=0.005)

    # 20k embedding tokens at $0.0002/1k = $0.004, under the $0.005 cap.
    assert tracker.would_exceed_cap(
        tracker.estimate_embedding_cost(input_tokens=20_000)
    ) is False

    tracker.record_embedding(input_tokens=20_000)

    # A second identical batch would push the day over the cap.
    assert tracker.would_exceed_cap(
        tracker.estimate_embedding_cost(input_tokens=20_000)
    ) is True
