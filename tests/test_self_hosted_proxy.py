import asyncio
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from opendirector.integrations.chat_completions import ChatCompletions
from opendirector.integrations.http_settings import trust_environment
from opendirector.integrations.providers import GenerationProviders


@pytest.mark.parametrize('base, equivalent', [
    ('http://8.92.9.154:8094/v1', 'http://8.92.9.154:8094/videos/id/content'),
    ('http://192.168.1.20:8093/v1', 'http://192.168.1.20:8093/videos/id/content'),
    ('https://model.example/v1', 'https://MODEL.example:443/videos/id/content'),
    ('http://model.example:80/v1', 'http://model.example/videos/id/content'),
])
def test_self_hosted_origin_is_direct_for_vpn_lan_and_public_services(base, equivalent):
    config = {'connectionType': 'self_hosted', 'url': base}
    assert trust_environment(base, config=config) is False
    assert trust_environment(equivalent, config=config) is False
    assert trust_environment('https://cdn.example/content', config=config) is True
    assert trust_environment(base, config={**config, 'connectionType': 'api'}) is True
    assert trust_environment('http://127.0.0.1:9000/v1') is False
    assert trust_environment('http://8.92.9.154:9000/v1', config={**config, 'url': 'http://8.92.9.154:8094/v1'}) is True


@pytest.mark.parametrize('connection_type,proxy_mode', [('self_hosted', 'system'), ('api', 'direct')])
def test_non_loopback_service_works_with_broken_system_proxy(monkeypatch, connection_type, proxy_mode):
    """Use a local DNS alias to exercise real HTTPX proxy selection, without VPN."""
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'ok')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    lookup = socket.getaddrinfo
    def resolve(host, *args, **kwargs):
        return lookup('127.0.0.1' if host in {'model.test', b'model.test'} else host, *args, **kwargs)
    monkeypatch.setattr(socket, 'getaddrinfo', resolve)
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        monkeypatch.setenv(name, 'http://127.0.0.1:1')
    monkeypatch.setenv('NO_PROXY', '')
    monkeypatch.setenv('no_proxy', '')
    config = {'connectionType': connection_type, 'proxyMode': proxy_mode, 'url': f'http://model.test:{server.server_port}/v1'}
    async def run():
        async with httpx.AsyncClient(trust_env=trust_environment(config['url'], config=config)) as client:
            assert (await client.get(config['url'])).text == 'ok'
        api = {**config, 'connectionType': 'api', 'proxyMode': 'system'}
        async with httpx.AsyncClient(trust_env=trust_environment(api['url'], config=api), timeout=2) as client:
            with pytest.raises((httpx.ConnectError, httpx.ConnectTimeout)):
                await client.get(api['url'])
    try:
        asyncio.run(run())
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_all_model_kinds_submit_resume_and_cancel_use_direct_connection(monkeypatch):
    async_client = httpx.AsyncClient
    flags, calls = [], []
    def client(**kwargs):
        flags.append(kwargs['trust_env'])
        return async_client(**kwargs)
    monkeypatch.setattr(httpx, 'AsyncClient', client)
    prepared = {'prompt': 'test', 'images': [], 'audios': []}
    monkeypatch.setattr('opendirector.integrations.providers.generation_references', lambda *args: prepared)
    monkeypatch.setattr('opendirector.integrations.providers.references', lambda *args: [])
    monkeypatch.setattr('opendirector.integrations.vllm_omni.generation_references', lambda *args: prepared)
    def handle(request):
        calls.append((request.method, request.url.path))
        assert request.headers['authorization'] == 'Bearer test-token'
        if request.url.path.endswith('/chat/completions'):
            return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        if request.url.path.endswith('/audio/speech'):
            assert json.loads(request.content)['voice'] == 'default'
            return httpx.Response(200, content=b'audio')
        if request.url.path.endswith('/images/generations'):
            return httpx.Response(200, json={'data': [{'b64_json': 'aW1hZ2U='}]})
        if request.method == 'POST': return httpx.Response(200, json={'id': 'video-test'})
        if request.method == 'DELETE': return httpx.Response(200, json={'status': 'cancelled'})
        if request.url.path.endswith('/content'): return httpx.Response(200, content=b'mp4')
        return httpx.Response(200, json={'id': 'video-test', 'status': 'completed'})
    transport = httpx.MockTransport(handle)
    provider = GenerationProviders(None, transport, poll_interval=0)
    config = {'protocol': 'openai', 'connectionType': 'self_hosted', 'url': 'https://model.example/v1',
              'modelId': 'generic', 'apiKey': 'test-token', 'authMode': 'bearer'}
    async def run():
        parts = [part async for part in ChatCompletions(transport).stream(config, {'messages': [], 'stream': True})]
        assert any(part.get('text') == 'ok' for part in parts)
        accepted = []
        async def submitted(value): accepted.append(value)
        for kind, result in [('image', ('png', b'image')), ('audio', ('mp3', b'audio'))]:
            assert await provider.generate({**config, 'kind': kind},
                {'kind': kind, 'prompt': 'test', 'parameters': {}}, submitted) == result
        for model in ('FastH3-Omni-3090', 'MiniMaxAI/MiniMax-H3'):
            video_config = {**config, 'kind': 'video', 'protocol': 'vllm_omni', 'modelId': model}
            task = {'kind': 'video', 'prompt': 'test', 'projectId': 'owner', 'referenceIds': [], 'parameters': {}}
            assert await provider.generate(video_config, task, submitted) == ('mp4', b'mp4')
            before = len(calls)
            assert await provider.generate(video_config, {**task, 'externalTaskId': 'video-test'}, submitted) == ('mp4', b'mp4')
            assert all(method == 'GET' for method, _ in calls[before:])
            await provider.cancel(video_config, 'video-test')
        assert accepted == ['video-test', 'video-test']
    asyncio.run(run())
    assert flags and all(flag is False for flag in flags)


def test_external_result_cdn_keeps_proxy_and_never_receives_service_token(monkeypatch, public_cdn):
    async_client = httpx.AsyncClient
    flags = []
    def client(**kwargs):
        flags.append(kwargs['trust_env'])
        return async_client(**kwargs)
    monkeypatch.setattr(httpx, 'AsyncClient', client)
    def handle(request):
        assert 'authorization' not in request.headers
        return httpx.Response(200, content=b'image')
    provider = GenerationProviders(None, httpx.MockTransport(handle))
    config = {'kind': 'image', 'protocol': 'openai', 'connectionType': 'self_hosted',
              'url': 'https://model.example/v1', 'modelId': 'generic', 'apiKey': 'test-token'}
    assert asyncio.run(provider.resume_result(config, 'png', 'https://cdn.example/result.png')) == ('png', b'image')
    assert flags == [True]
