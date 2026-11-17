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
