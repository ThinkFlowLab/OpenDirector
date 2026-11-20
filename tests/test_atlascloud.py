"""Atlas Cloud chat requests send reasoning_effort only at the level every model family accepts."""
from opendirector.integrations.chat_completions import chat_payload


ATLAS = {"modelId": "deepseek-ai/deepseek-v4-flash", "url": "https://api.atlascloud.ai/v1"}


def test_atlascloud_sends_reasoning_effort_only_for_high():
    assert chat_payload(ATLAS, [], "high")["reasoning_effort"] == "high"
    for level in ("auto", "low", "medium"):
        assert "reasoning_effort" not in chat_payload(ATLAS, [], level)


def test_atlascloud_base_fields_and_other_hosts_unchanged():
    payload = chat_payload(ATLAS, [{"role": "user", "content": "hi"}], "high")
    assert payload["model"] == "deepseek-ai/deepseek-v4-flash"
    assert payload["stream"] is True
    assert payload["max_tokens"] == 8192
    assert "thinking" not in payload
    assert payload["messages"] == [{"role": "user", "content": "hi"}]
    other = chat_payload({"modelId": "x", "url": "https://api.example.com/v1"}, [], "medium")
    assert other["reasoning_effort"] == "medium"
