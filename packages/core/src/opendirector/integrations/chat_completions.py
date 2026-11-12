"""Chat Completions streaming, including provider-specific thinking parameters."""

import json
from urllib.parse import urlsplit

import httpx

from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, trust_environment

from opendirector.domain.projects import ProjectError
from opendirector.integrations.generation_errors import checked, provider_failure, transport_failure


def chat_payload(config: dict, messages: list[dict], thinking: str) -> dict:
    value = {"model": config["modelId"], "messages": messages, "stream": True, "max_tokens": 8192}
    thinking_map = {"auto": "high", "low": "low", "medium": "high", "high": "max"}
    hostname = urlsplit(config["url"]).hostname
    if hostname == "api.deepseek.com":
        value.update(thinking={"type": "enabled"}, reasoning_effort=thinking_map.get(thinking, thinking_map["auto"]))
    elif hostname == "open.bigmodel.cn":
        # GLM reasoning_effort accepts only low, high and max. Omit the parameter for
        # auto so the provider default applies, and fall back to high for unknown levels.
        if thinking != "auto":
            value["reasoning_effort"] = thinking_map.get(thinking, thinking_map["auto"])
    elif thinking != "auto":
        value["reasoning_effort"] = thinking
    if len(json.dumps(value, ensure_ascii=False).encode()) > 48 * 1024 * 1024:
        raise ProjectError("对话及参考图片过大，请在新项目中继续或减少参考图片。", 413)
    return value


class ChatCompletions:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        self.transport = transport

    async def stream(self, config: dict, payload: dict):
        url = config["url"].rstrip("/") + "/chat/completions"
        # No automatic retry: retrying a paid request after a timeout can duplicate it.
        try:
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(config['url'], config=config), timeout=httpx.Timeout(120, connect=15), follow_redirects=False) as client:
                async with client.stream("POST", url, headers=({"Authorization": f"Bearer {config['apiKey']}"} if config.get("apiKey") and config.get("authMode") != "none" else {}), json=payload) as response:
                    if response.status_code != 200:
                        await checked(response, stage='submit', secrets=(config.get('apiKey', ''),))
                    finished = False
                    thinking_sent = False
                    tool_mode = bool(payload.get("tools"))
                    answer, reasoning, calls = "", "", {}
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            if not finished:
                                raise ProjectError("模型流在完成标记前结束，请重试。", 502)
                            break
                        if not data:
                            continue
                        value = json.loads(data)
                        if value.get("error"):
                            raise provider_failure(value, stage='submit', headers=response.headers,
                                http_status=response.status_code, secrets=(config.get('apiKey', ''),))
                        choices = value.get("choices", [])
                        if not choices:
                            continue
                        choice = choices[0]
                        delta = choice.get("delta", {})
                        if delta.get("reasoning_content") and not thinking_sent:
                            thinking_sent = True
                            yield {"type": "thinking"}
                        if tool_mode and isinstance(delta.get("reasoning_content"), str):
                            reasoning += delta["reasoning_content"]
                            if len(reasoning) > 500000:
                                raise ProjectError("模型思考内容超过本次执行上限。", 502)
                        for part in delta.get("tool_calls") or []:
                            index = part["index"]
                            if not tool_mode or not isinstance(index, int) or not 0 <= index < 8:
                                raise ProjectError("模型返回的工具调用无效或过多。", 502)
                            call = calls.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                            call["id"] += part.get("id") or ""
                            function = part.get("function") or {}
                            call["function"]["name"] += function.get("name") or ""
                            call["function"]["arguments"] += function.get("arguments") or ""
                            if len(call["id"]) > 200 or len(call["function"]["name"]) > 100 or len(call["function"]["arguments"]) > 1024 * 1024:
                                raise ProjectError("工具调用参数超过上限。", 502)
                        text = delta.get("content")
                        if isinstance(text, str) and text:
                            if tool_mode:
                                answer += text
                            yield {"type": "delta", "text": text}
                        reason = choice.get("finish_reason")
                        if reason is not None:
                            if reason != "stop" and not (tool_mode and reason == "tool_calls" and calls):
                                raise ProjectError("模型回复未正常完成（可能达到长度限制或被内容规则拦截），已生成内容已保留。", 502)
                            finished = True
                    if not finished:
                        raise ProjectError("模型连接意外结束，已生成内容已保留。", 502)
                    if tool_mode:
                        message = {"role": "assistant", "content": answer or None, "reasoning_content": reasoning}
                        if calls:
                            message["tool_calls"] = [calls[index] for index in sorted(calls)]
                            if any(not call["id"] or not call["function"]["name"] for call in message["tool_calls"]):
                                raise ProjectError("模型工具调用不完整，未执行。", 502)
                        yield {"type": "assistant_message", "message": message}
        except httpx.TimeoutException:
            raise transport_failure('submit', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('submit', status=502) from None
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ProjectError("模型返回了无法识别的流式数据，请检查 Chat Completions 兼容性。", 502) from None
