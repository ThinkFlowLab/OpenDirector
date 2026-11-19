import asyncio
import codecs
from contextlib import suppress
import json
import logging
import os
import secrets
from pathlib import Path
from time import monotonic, time

import httpx

from opendirector.domain.projects import ProjectError
from opendirector.integrations.chat_completions import chat_payload
from opendirector.integrations.http_settings import (
    MODEL_HTTP_HOOKS,
    MODEL_JOB_CONTEXT,
    auth_headers,
    trust_environment,
)

logger = logging.getLogger(__name__)
MAX_JSON_USAGE_BYTES = 2 * 1024 * 1024


def _token_count(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def normalize_usage(raw: object) -> dict[str, int] | None:
    """Extract provider-neutral token and KV-cache counters without trusting wire types."""
    if not isinstance(raw, dict):
        return None
    prompt = _token_count(raw.get("prompt_tokens"))
    if prompt is None:
        prompt = _token_count(raw.get("input_tokens"))
    completion = _token_count(raw.get("completion_tokens"))
    if completion is None:
        completion = _token_count(raw.get("output_tokens"))
    total = _token_count(raw.get("total_tokens"))
    if total is None and prompt is not None and completion is not None:
        total = prompt + completion

    prompt_details = raw.get("prompt_tokens_details")
    if not isinstance(prompt_details, dict):
        prompt_details = raw.get("input_tokens_details")
    if not isinstance(prompt_details, dict):
        prompt_details = {}
    completion_details = raw.get("completion_tokens_details")
    if not isinstance(completion_details, dict):
        completion_details = raw.get("output_tokens_details")
    if not isinstance(completion_details, dict):
        completion_details = {}

    cached = _token_count(prompt_details.get("cached_tokens"))
    if cached is None:
        cached = _token_count(raw.get("prompt_cache_hit_tokens"))
    if cached is None:
        cached = _token_count(raw.get("cache_read_input_tokens"))
    cache_write = _token_count(raw.get("cache_creation_input_tokens"))
    cache_miss = _token_count(raw.get("prompt_cache_miss_tokens"))
    if cache_miss is None and prompt is not None and cached is not None:
        cache_miss = max(0, prompt - cached)
    reasoning = _token_count(completion_details.get("reasoning_tokens"))
    if reasoning is None:
        reasoning = _token_count(raw.get("reasoning_tokens"))

    if (
        prompt is None
        and completion is None
        and total is None
        and cached is None
        and cache_write is None
    ):
        return None

    usage: dict[str, int] = {}
    if prompt is not None:
        usage["promptTokens"] = prompt
    if completion is not None:
        usage["completionTokens"] = completion
    if total is not None:
        usage["totalTokens"] = total
    if cached is not None:
        usage["cachedPromptTokens"] = cached
    if cache_write is not None:
        usage["cacheWritePromptTokens"] = cache_write
    if cache_miss is not None:
        usage["cacheMissPromptTokens"] = cache_miss
    if reasoning is not None:
        usage["reasoningTokens"] = reasoning
    return usage


def _merge_usage(previous: dict[str, int] | None, observed: dict[str, int] | None) -> dict[str, int] | None:
    if observed is None:
        return previous
    if previous is None:
        return dict(observed)
    merged = {**previous, **observed}
    prompt = merged.get("promptTokens")
    completion = merged.get("completionTokens")
    if prompt is not None and completion is not None and "totalTokens" not in observed:
        merged["totalTokens"] = max(merged.get("totalTokens", 0), prompt + completion)
    cached = merged.get("cachedPromptTokens")
    if prompt is not None and cached is not None and "cacheMissPromptTokens" not in observed:
        merged["cacheMissPromptTokens"] = max(0, prompt - cached)
    return merged


class ModelGateway:
    """Loopback-only OpenAI transport for the bundled runtime's configured model."""

    def __init__(self, config: dict, thinking: str, token: str, project_id: str,
                 turn_id: str, transport: httpx.AsyncBaseTransport | None = None,
                 *, trace_path: Path | None = None):
        self.config, self.thinking, self.token = config, thinking, token
        self.project_id, self.turn_id, self.transport = project_id, turn_id, transport
        self.trace_path = trace_path
        self.active: set[asyncio.Task] = set()
        self.closed = False
        self._summary_written = False
        self.request_count = 0
        self.completed_requests = 0
        self.usage_reported_requests = 0
        self._cache_reported = False
        self._totals = {
            "promptTokens": 0,
            "completionTokens": 0,
            "totalTokens": 0,
            "cachedPromptTokens": 0,
            "cacheWritePromptTokens": 0,
            "reasoningTokens": 0,
        }

    def usage_summary(self) -> dict[str, int | float | None]:
        prompt = self._totals["promptTokens"]
        cached = self._totals["cachedPromptTokens"]
        hit_rate = round(min(cached, prompt) / prompt, 4) if self._cache_reported and prompt > 0 else None
        return {
            "requestCount": self.request_count,
            "completedRequests": self.completed_requests,
            "usageReportedRequests": self.usage_reported_requests,
            **self._totals,
            "cacheHitRate": hit_rate,
        }

    def close(self) -> dict[str, int | float | None]:
        self.closed = True
        summary = self.usage_summary()
        if not self._summary_written and self.request_count > 0:
            self._summary_written = True
            self.trace("turn.usage", "summary", **summary)
        return summary

    def _record_completion(self, status_code: int, usage: dict[str, int] | None) -> None:
        if 200 <= status_code < 300:
            self.completed_requests += 1
        if usage is None:
            return
        self.usage_reported_requests += 1
        if "cachedPromptTokens" in usage:
            self._cache_reported = True
        for key in self._totals:
            self._totals[key] += usage.get(key, 0)

    def trace(self, event: str, request_id: str, **details: object) -> None:
        if self.trace_path is None:
            return
        record = {
            "event": event,
            "turnId": self.turn_id,
            "requestId": request_id,
            "timestamp": time(),
            **details,
        }
        try:
            fd = os.open(self.trace_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as output:
                output.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            logger.exception("Cannot write model trace for turn %s", self.turn_id)

    def trace_reasoning(self, request_id: str, data: str) -> dict[str, int] | None:
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            return None
        if not isinstance(event, dict):
            return None
        choices = event.get("choices")
        if isinstance(choices, list):
            for choice in choices:
                if not isinstance(choice, dict) or not isinstance(choice.get("delta"), dict):
                    continue
                text = choice["delta"].get("reasoning_content")
                if isinstance(text, str) and text:
                    self.trace("model.reasoning", request_id, choiceIndex=choice.get("index", 0), text=text)
        return normalize_usage(event.get("usage"))

    def connect(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.create_task(self.request(reader, writer))
        self.active.add(task)
        task.add_done_callback(self.active.discard)

    async def request(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        status_sent = False
        request_id = None
        started = monotonic()
        forwarded_bytes = 0
        context = MODEL_JOB_CONTEXT.set((self.project_id, self.turn_id))
        try:
            async with asyncio.timeout(180):
                request = await reader.readuntil(b"\r\n\r\n")
                lines = request.decode("ascii").split("\r\n")
                headers = {
                    key.lower(): value
                    for key, value in (
                        line.split(":", 1) for line in lines[1:] if ":" in line
                    )
                }
                method, path, _ = lines[0].split(" ")
                authorized = secrets.compare_digest(
                    headers.get("authorization", "").strip(), f"Bearer {self.token}"
                )
                length = int(headers.get("content-length", "0"))
                if (
                    method != "POST"
                    or path != "/chat/completions"
                    or not authorized
                    or self.closed
                    or not 0 < length <= 48 * 1024 * 1024
                ):
                    writer.write(
                        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    await writer.drain()
                    return
                payload = json.loads(await reader.readexactly(length))
                payload.update(
                    chat_payload(
                        self.config, payload["messages"], self.thinking
                    )
                )
                payload["model"] = self.config["modelId"]
                url = self.config["url"].rstrip("/") + "/chat/completions"
                request_id = secrets.token_hex(8)
                self.request_count += 1
                self.trace("model.request", request_id, payload=payload)
                usage: dict[str, int] | None = None
                response_status = 0
                async with httpx.AsyncClient(
                    transport=self.transport,
                    event_hooks=MODEL_HTTP_HOOKS,
                    trust_env=trust_environment(url, config=self.config),
                    timeout=httpx.Timeout(120, connect=15),
                ) as client:
                    async with client.stream(
                        "POST",
                        url,
                        headers=auth_headers(self.config),
                        json=payload,
                    ) as response:
                        response_status = response.status_code
                        self.trace(
                            "model.response", request_id,
                            status=response.status_code,
                            elapsedMs=round((monotonic() - started) * 1000),
                        )
                        content_type = response.headers.get(
                            "content-type", "application/json"
                        )
                        writer.write(
                            f"HTTP/1.1 {response.status_code} Response\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".encode()
                        )
                        status_sent = True
                        await writer.drain()
                        is_sse = "text/event-stream" in content_type
                        collect_json = (
                            not is_sse
                            and 200 <= response.status_code < 300
                            and "json" in content_type.lower()
                        )
                        json_body = bytearray() if collect_json else None
                        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
                        buffer = ""
                        event_lines = []
                        async for chunk in response.aiter_bytes():
                            if not chunk:
                                continue
                            # Frame decoded upstream bytes, not the provider's wire chunks.
                            writer.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                            await writer.drain()
                            forwarded_bytes += len(chunk)
                            if json_body is not None:
                                if len(json_body) + len(chunk) <= MAX_JSON_USAGE_BYTES:
                                    json_body.extend(chunk)
                                else:
                                    json_body = None
                                continue
                            if not is_sse:
                                continue
                            buffer += decoder.decode(chunk)
                            while "\n" in buffer:
                                line, _, buffer = buffer.partition("\n")
                                line = line.rstrip("\r")
                                if line.startswith("data:"):
                                    event_lines.append(line[5:].lstrip(" "))
                                elif not line and event_lines:
                                    data = "\n".join(event_lines)
                                    event_lines.clear()
                                    if data != "[DONE]":
                                        observed = self.trace_reasoning(request_id, data)
                                        usage = _merge_usage(usage, observed)
                        if is_sse:
                            buffer += decoder.decode(b"", final=True)
                            for line in buffer.splitlines():
                                line = line.rstrip("\r")
                                if line.startswith("data:"):
                                    event_lines.append(line[5:].lstrip(" "))
                            if event_lines:
                                data = "\n".join(event_lines)
                                event_lines.clear()
                                if data != "[DONE]":
                                    observed = self.trace_reasoning(request_id, data)
                                    usage = _merge_usage(usage, observed)
                        elif json_body:
                            with suppress(UnicodeDecodeError, json.JSONDecodeError):
                                parsed = json.loads(json_body.decode("utf-8"))
                                if isinstance(parsed, dict):
                                    usage = normalize_usage(parsed.get("usage"))
                # Only successful exhaustion and cleanup may terminate this response.
                # Sending this in finally would disguise a truncated body as complete.
                writer.write(b"0\r\n\r\n")
                await writer.drain()
                self._record_completion(response_status, usage)
                self.trace("model.completed", request_id, forwardedBytes=forwarded_bytes,
                           elapsedMs=round((monotonic() - started) * 1000),
                           **({"usage": usage} if usage is not None else {}))
        except asyncio.CancelledError:
            if request_id is not None:
                self.trace("model.cancelled", request_id, forwardedBytes=forwarded_bytes)
            raise
        except (
            ProjectError,
            TypeError,
            httpx.HTTPError,
            OSError,
            ValueError,
            KeyError,
            asyncio.IncompleteReadError,
            asyncio.LimitOverrunError,
            TimeoutError,
        ) as failure:
            if request_id is not None:
                self.trace("model.error", request_id, error=type(failure).__name__,
                           forwardedBytes=forwarded_bytes)
            logger.error(
                f"agent.model.error turn_id={self.turn_id} failure={type(failure).__name__}"
            )
            if not status_sent:
                status = failure.status if isinstance(failure, ProjectError) else 502
                # Do not expose provider credentials or local exception messages.
                with suppress(OSError):
                    writer.write(
                        f"HTTP/1.1 {status} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode()
                    )
                    await writer.drain()
        finally:
            MODEL_JOB_CONTEXT.reset(context)
            writer.close()
            # A broken downstream connection must not replace the original failure
            # or cancellation with a cleanup error.
            with suppress(OSError, TimeoutError):
                await asyncio.wait_for(writer.wait_closed(), 5)
