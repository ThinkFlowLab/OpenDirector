"""Zhipu BigModel chat requests map the shared thinking setting to GLM reasoning_effort."""
from opendirector.integrations.chat_completions import chat_payload


ZHIPU = {"modelId": "glm-5.3", "url": "https://open.bigmodel.cn/api/paas/v4"}


def test_zhipu_reasoning_effort_accepts_only_glm_levels():
    assert chat_payload(ZHIPU, [], "low")["reasoning_effort"] == "low"
    assert chat_payload(ZHIPU, [], "medium")["reasoning_effort"] == "high"
    assert chat_payload(ZHIPU, [], "high")["reasoning_effort"] == "max"
    assert chat_payload(ZHIPU, [], "xhigh")["reasoning_effort"] == "high"


def test_zhipu_auto_keeps_provider_default():
    payload = chat_payload(ZHIPU, [], "auto")
    assert "reasoning_effort" not in payload
    assert "thinking" not in payload


def test_zhipu_base_fields_and_other_hosts_unchanged():
    payload = chat_payload(ZHIPU, [{"role": "user", "content": "hi"}], "high")
    assert payload["model"] == "glm-5.3"
    assert payload["stream"] is True
    assert payload["max_tokens"] == 8192
    assert payload["messages"] == [{"role": "user", "content": "hi"}]
    other = chat_payload({"modelId": "x", "url": "https://api.example.com/v1"}, [], "medium")
    assert other["reasoning_effort"] == "medium"
    deepseek = chat_payload({"modelId": "x", "url": "https://api.deepseek.com/v1"}, [], "high")
    assert deepseek["thinking"] == {"type": "enabled"}
    assert deepseek["reasoning_effort"] == "max"
