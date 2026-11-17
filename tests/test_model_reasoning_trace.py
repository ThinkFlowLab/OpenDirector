"""Record streamed reasoning while preserving upstream bytes."""
import asyncio
import json

import httpx

from opendirector.agent.model_gateway import ModelGateway


def test_reasoning_trace_handles_fragmented_sse_without_changing_response(tmp_path):
    chunks = [
        {"choices": [{"index": 0, "delta": {"reasoning_content": "先检查"}}]},
        {"choices": [{"index": 0, "delta": {"reasoning_content": "工程状态。"}}]},
        {"choices": [{"index": 0, "delta": {"content": "已完成"}}]},
    ]
    body = b"".join(
        ("data: " + json.dumps(chunk, ensure_ascii=False) + "\r\n\r\n").encode()
        for chunk in chunks
    ) + b"data: [DONE]\r\n\r\n"

    class FragmentedStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for index in range(0, len(body), 7):
                yield body[index:index + 7]

    async def run():
        trace = tmp_path / "model.jsonl"
        gateway = ModelGateway(
            {"modelId": "fixture", "url": "http://model.test/v1", "authMode": "none"},
            "auto", "local-token", "project", "turn",
            httpx.MockTransport(lambda request: httpx.Response(
                200, headers={"Content-Type": "text/event-stream"}, stream=FragmentedStream())),
            trace_path=trace,
        )
        server = await asyncio.start_server(gateway.connect, "127.0.0.1", 0)
        try:
            port = server.sockets[0].getsockname()[1]
            async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
                response = await client.post(
                    f"http://127.0.0.1:{port}/chat/completions",
                    headers={"Authorization": "Bearer local-token"},
                    json={"messages": [{"role": "user", "content": "hello"}]},
                )
            assert response.status_code == 200
            assert response.headers["transfer-encoding"] == "chunked"
            assert response.content == body
            records = [json.loads(line) for line in trace.read_text().splitlines()]
            reasoning = [record for record in records if record["event"] == "model.reasoning"]
            assert "".join(record["text"] for record in reasoning) == "先检查工程状态。"
            assert len({record["requestId"] for record in reasoning}) == 1
            assert all(record["choiceIndex"] == 0 for record in reasoning)
        finally:
            server.close()
            await server.wait_closed()
            await asyncio.gather(*gateway.active)
    asyncio.run(run())
