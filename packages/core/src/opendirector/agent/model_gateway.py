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

    def trace_reasoning(self, request_id: str, data: str) -> None:
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            return
        if not isinstance(event, dict):
            return
        choices = event.get("choices")
        if not isinstance(choices, list):
            return
        for choice in choices:
            if not isinstance(choice, dict) or not isinstance(choice.get("delta"), dict):
                continue
            text = choice["delta"].get("reasoning_content")
            if isinstance(text, str) and text:
                self.trace("model.reasoning", request_id, choiceIndex=choice.get("index", 0), text=text)

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
                self.trace("model.request", request_id, payload=payload)
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
                            if "text/event-stream" not in content_type:
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
                                        self.trace_reasoning(request_id, data)
                # Only successful exhaustion and cleanup may terminate this response.
                # Sending this in finally would disguise a truncated body as complete.
                writer.write(b"0\r\n\r\n")
                await writer.drain()
                self.trace("model.completed", request_id, forwardedBytes=forwarded_bytes,
                           elapsedMs=round((monotonic() - started) * 1000))
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
