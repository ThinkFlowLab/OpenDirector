"""Exercise HTTP framing and interrupted model transport with real loopback clients."""
import asyncio
from contextlib import asynccontextmanager
import json

import httpx
import pytest

from opendirector.agent.model_gateway import ModelGateway
from opendirector.domain.projects import ProjectError


class Stream(httpx.AsyncByteStream):
    def __init__(self, chunks, failure=None, gate=None):
        self.chunks, self.failure, self.gate = chunks, failure, gate
        self.closed = False

    async def __aiter__(self):
        for index, chunk in enumerate(self.chunks):
            yield chunk
            if index == 0 and self.gate:
                await self.gate.wait()
        if self.failure:
            raise self.failure

    async def aclose(self):
        self.closed = True


@asynccontextmanager
async def gateway_server(tmp_path, handler, *, broken_cleanup=False):
    trace = tmp_path / 'model.jsonl'
    gateway = ModelGateway(
        {'modelId': 'fixture', 'url': 'http://provider.invalid', 'authMode': 'none'},
        'auto', 'local-token', 'project', 'turn', httpx.MockTransport(handler), trace_path=trace,
    )
    def connect(reader, writer):
        if broken_cleanup:
            wait_closed = writer.wait_closed
            async def disconnected():
                await wait_closed()
                raise BrokenPipeError('downstream disconnected during cleanup')
            writer.wait_closed = disconnected
        gateway.connect(reader, writer)
    server = await asyncio.start_server(connect, '127.0.0.1', 0)
    try:
        yield gateway, f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}/chat/completions'
    finally:
        server.close()
        await server.wait_closed()
        tasks = list(gateway.active)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def records(tmp_path):
    return [json.loads(line) for line in (tmp_path / 'model.jsonl').read_text().splitlines()]


def request(client, url):
    return client.stream('POST', url, headers={'Authorization': 'Bearer local-token'},
                         json={'messages': [{'role': 'user', 'content': 'hello'}]})


def test_forwarding_is_incremental_and_terminates_after_upstream(tmp_path):
    async def run():
        gate = asyncio.Event()
        stream = Stream([b'first', '中文'.encode(), b'last'], gate=gate)
        async with gateway_server(tmp_path, lambda _: httpx.Response(
                200, headers={'content-type': 'text/event-stream'}, stream=stream)) as (_, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                async with request(client, url) as response:
                    assert response.headers['transfer-encoding'] == 'chunked'
                    assert 'content-length' not in response.headers
                    body = response.aiter_bytes()
                    assert await anext(body) == b'first'
                    assert not stream.closed
                    gate.set()
                    rest = b''.join([chunk async for chunk in body])
                    assert rest == '中文'.encode() + b'last'
            assert stream.closed
        end = records(tmp_path)[-1]
        assert end['event'] == 'model.completed'
        assert end['forwardedBytes'] == len(b'firstlast') + len('中文'.encode())
    asyncio.run(run())


@pytest.mark.parametrize('failure', [httpx.ReadTimeout('private'), httpx.RemoteProtocolError('private')])
def test_mid_stream_failure_is_not_a_completed_response(tmp_path, failure):
    async def run():
        stream = Stream([b'partial'], failure=failure)
        async with gateway_server(tmp_path, lambda _: httpx.Response(
                200, headers={'content-type': 'text/event-stream'}, stream=stream)) as (_, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                async with request(client, url) as response:
                    received = []
                    with pytest.raises(httpx.RemoteProtocolError):
                        async for chunk in response.aiter_bytes():
                            received.append(chunk)
                    assert b''.join(received) == b'partial'
            assert stream.closed
        rows = records(tmp_path)
        assert rows[-1]['event'] == 'model.error'
        assert rows[-1]['error'] == type(failure).__name__
        assert not any(row['event'] == 'model.completed' for row in rows)
        assert 'private' not in json.dumps(rows)
    asyncio.run(run())


@pytest.mark.parametrize('broken_cleanup', [False, True])
def test_cancellation_closes_upstream_without_completing_body(tmp_path, broken_cleanup):
    async def run():
        stream = Stream([b'partial', b'never'], gate=asyncio.Event())
        async with gateway_server(tmp_path, lambda _: httpx.Response(
                200, headers={'content-type': 'text/event-stream'}, stream=stream), broken_cleanup=broken_cleanup) as (gateway, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                async with request(client, url) as response:
                    body = response.aiter_bytes()
                    assert await anext(body) == b'partial'
                    tasks = list(gateway.active)
                    assert len(tasks) == 1
                    tasks[0].cancel()
                    result = await asyncio.gather(*tasks, return_exceptions=True)
                    assert isinstance(result[0], asyncio.CancelledError)
                    with pytest.raises(httpx.RemoteProtocolError):
                        await anext(body)
            assert stream.closed
        assert records(tmp_path)[-1]['event'] == 'model.cancelled'
    asyncio.run(run())


def test_provider_error_body_has_a_complete_response_boundary(tmp_path):
    async def run():
        raw = b'{"error":{"message":"bad input"}}'
        async with gateway_server(tmp_path, lambda _: httpx.Response(
                400, headers={'content-type': 'application/json'}, stream=Stream([raw[:7], raw[7:]]))) as (_, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                async with request(client, url) as response:
                    assert response.status_code == 400
                    assert await response.aread() == raw
        # This is transport completion of a 400 response, not successful generation.
        assert records(tmp_path)[-1]['event'] == 'model.completed'
    asyncio.run(run())


@pytest.mark.parametrize('kind, expected', [('transport', 502), ('validation', 413)])
def test_failure_before_response_headers_has_a_bounded_error(tmp_path, monkeypatch, kind, expected):
    async def run():
        def handler(_):
            raise httpx.ConnectError('private-token')
        if kind == 'validation':
            def rejected(*args):
                raise ProjectError('private-token', 413)
            monkeypatch.setattr('opendirector.agent.model_gateway.chat_payload', rejected)
        async with gateway_server(tmp_path, handler) as (_, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                async with request(client, url) as response:
                    assert response.status_code == expected
                    assert response.headers['content-length'] == '0'
                    assert await response.aread() == b''
    asyncio.run(run())


def test_malformed_reasoning_metadata_cannot_break_forwarding(tmp_path):
    async def run():
        values = [{'choices': None}, {'choices': [None, {'delta': None}]}]
        raw = ''.join('data: ' + json.dumps(value) + '\n\n' for value in values).encode()
        async with gateway_server(tmp_path, lambda _: httpx.Response(
                200, headers={'content-type': 'text/event-stream'}, stream=Stream([raw]))) as (_, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                async with request(client, url) as response:
                    assert await response.aread() == raw
        assert records(tmp_path)[-1]['event'] == 'model.completed'
    asyncio.run(run())


def test_empty_upstream_body_is_explicitly_terminated(tmp_path):
    async def run():
        async with gateway_server(tmp_path, lambda _: httpx.Response(
                400, headers={'content-type': 'application/json'}, stream=Stream([]))) as (_, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                async with request(client, url) as response:
                    assert response.status_code == 400
                    assert await response.aread() == b''
        assert records(tmp_path)[-1]['forwardedBytes'] == 0
    asyncio.run(run())


def test_sse_and_json_usage_observability_with_turn_summary(tmp_path):
    async def run():
        responses = iter([
            httpx.Response(
                200,
                headers={'content-type': 'text/event-stream'},
                stream=Stream([
                    b'data: {"choices":[{"index":0,"delta":{"reasoning_content":"step 1"}}]}\n\n',
                    b'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":120,"total_tokens":1120,'
                    b'"prompt_tokens_details":{"cached_tokens":750},'
                    b'"completion_tokens_details":{"reasoning_tokens":45}}}'
                ]),
            ),
            httpx.Response(
                200,
                headers={'content-type': 'application/json; charset=utf-8'},
                stream=Stream([
                    json.dumps({
                        'choices': [{'message': {'role': 'assistant', 'content': 'done'}}],
                        'usage': {
                            'prompt_tokens': 600,
                            'completion_tokens': 80,
                            'prompt_cache_hit_tokens': 450,
                            'prompt_cache_miss_tokens': 150,
                        },
                    }).encode()
                ]),
            ),
            httpx.Response(
                400,
                headers={'content-type': 'application/json'},
                stream=Stream([b'{"error":"bad request"}']),
            ),
        ])
        async with gateway_server(tmp_path, lambda _: next(responses)) as (gateway, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                for expected_status in (200, 200, 400):
                    async with request(client, url) as response:
                        assert response.status_code == expected_status
                        await response.aread()
            summary = gateway.close()
            assert gateway.close() == summary

        rows = records(tmp_path)
        completed = [row for row in rows if row['event'] == 'model.completed']
        assert len(completed) == 3
        assert completed[0]['usage'] == {
            'promptTokens': 1000,
            'completionTokens': 120,
            'totalTokens': 1120,
            'cachedPromptTokens': 750,
            'cacheMissPromptTokens': 250,
            'reasoningTokens': 45,
        }
        assert completed[1]['usage'] == {
            'promptTokens': 600,
            'completionTokens': 80,
            'totalTokens': 680,
            'cachedPromptTokens': 450,
            'cacheMissPromptTokens': 150,
        }
        assert 'usage' not in completed[2]

        summaries = [row for row in rows if row['event'] == 'turn.usage']
        assert len(summaries) == 1
        assert summaries[0]['requestCount'] == 3
        assert summaries[0]['completedRequests'] == 2
        assert summaries[0]['usageReportedRequests'] == 2
        assert summaries[0]['promptTokens'] == 1600
        assert summaries[0]['completionTokens'] == 200
        assert summaries[0]['totalTokens'] == 1800
        assert summaries[0]['cachedPromptTokens'] == 1200
        assert summaries[0]['reasoningTokens'] == 45
        assert summaries[0]['cacheHitRate'] == 0.75
    asyncio.run(run())


def test_malformed_or_oversized_json_usage_never_breaks_forwarding(tmp_path):
    from opendirector.agent.model_gateway import MAX_JSON_USAGE_BYTES, normalize_usage

    assert normalize_usage(None) is None
    assert normalize_usage({'prompt_tokens': True, 'completion_tokens': -1}) is None

    async def run():
        oversized = b'{"padding":"' + (b'x' * (MAX_JSON_USAGE_BYTES + 32)) + b'","usage":{"prompt_tokens":10}}'
        async with gateway_server(tmp_path, lambda _: httpx.Response(
                200, headers={'content-type': 'application/json'}, stream=Stream([oversized[:4096], oversized[4096:]]))) as (gateway, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                async with request(client, url) as response:
                    assert response.status_code == 200
                    assert await response.aread() == oversized
            summary = gateway.close()
            assert summary['completedRequests'] == 1
            assert summary['usageReportedRequests'] == 0
            assert summary['cacheHitRate'] is None
    asyncio.run(run())


def test_split_sse_chunks_and_cache_read_write_token_dialects(tmp_path):
    async def run():
        stream = Stream([
            b'data: {"choices":[{"index":0,"delta":{"content":"hello"}}],"usage":{"input_tokens":800,"cache_read_input_tokens":600,"cache_creation_input_tokens":120}}\n\n',
            b'data: {"choices":[{"index":0,"delta":{"content":" world"}}],"usage":null}\n\n',
            b'data: {"choices":[],"usage":{"output_tokens":95,"output_tokens_details":{"reasoning_tokens":30}}}\n\n',
            b'data: [DONE]\n\n',
        ])
        async with gateway_server(
            tmp_path, lambda _: httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=stream)
        ) as (gateway, url):
            async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                async with request(client, url) as response:
                    assert response.status_code == 200
                    await response.aread()
            summary = gateway.close()

        completed = [row for row in records(tmp_path) if row['event'] == 'model.completed']
        assert len(completed) == 1
        assert completed[0]['usage'] == {
            'promptTokens': 800,
            'completionTokens': 95,
            'totalTokens': 895,
            'cachedPromptTokens': 600,
            'cacheWritePromptTokens': 120,
            'cacheMissPromptTokens': 200,
            'reasoningTokens': 30,
        }
        assert summary['cachedPromptTokens'] == 600
        assert summary['cacheWritePromptTokens'] == 120
        assert summary['cacheHitRate'] == 0.75
    asyncio.run(run())
