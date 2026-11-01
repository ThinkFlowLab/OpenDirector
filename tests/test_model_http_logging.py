import asyncio
import json

import httpx
import pytest

from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS
from opendirector.integrations.generation_errors import transport_failure


def test_logs_each_query_submission_poll_and_cancel(caplog):
    caplog.set_level('DEBUG', logger='opendirector.integrations.http_settings')

    async def run():
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'ok': True}))) as client:
            for method, path in [('GET', '/models'), ('POST', '/chat/completions'), ('GET', '/videos/1'), ('GET', '/videos/1/content'), ('DELETE', '/videos/1')]:
                async with client.stream(method, 'http://model.test' + path, json={'prompt': 'hello'}) as response:
                    assert json.loads(await response.aread()) == {'ok': True}
    asyncio.run(run())
    events = [(record.message.split(' ', 1)[0], json.loads(record.message.split(' ', 1)[1])) for record in caplog.records]
    assert [name for name, _ in events] == ['model.request', 'model.response'] * 5
    assert len({event['call_id'] for name, event in events if name == 'model.request'}) == 5
    assert [event['method'] for name, event in events if name == 'model.request'] == ['GET', 'POST', 'GET', 'GET', 'DELETE']


def test_logs_timeout_without_credentials_or_media(caplog):
    caplog.set_level('DEBUG', logger='opendirector.integrations.http_settings')

    async def fail(request):
        raise httpx.ReadTimeout('private-error', request=request)

    async def run():
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=httpx.MockTransport(fail)) as client:
            try:
                async with client.stream('POST', 'http://model.test/images/edits?token=private-query',
                    headers={'Authorization': 'Bearer private-key'}, data={'prompt': 'edit'},
                    files=[('image', ('ref.png', b'private-media', 'image/png'))]):
                    pass
            except httpx.ReadTimeout:
                transport_failure('submit', timeout=True)
            else:
                pytest.fail('Expected timeout')
    asyncio.run(run())
    assert all(secret not in caplog.text for secret in ['private-error', 'private-query', 'private-key', 'private-media'])
    assert 'model.request' in caplog.text and 'model.error' in caplog.text
    assert 'TimeoutException' in caplog.text


def test_malformed_url_in_prompt_does_not_prevent_request(caplog):
    caplog.set_level('DEBUG', logger='opendirector.integrations.http_settings')
    received = []

    def handle(request):
        received.append(json.loads(request.content))
        return httpx.Response(200, json={'ok': True})

    async def run():
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=httpx.MockTransport(handle)) as client:
            async with client.stream('POST', 'http://model.test/images/generations', json={'prompt': 'https://[reference'}) as response:
                assert response.status_code == 200
    asyncio.run(run())
    assert received == [{'prompt': 'https://[reference'}]
    assert 'model.request' in caplog.text and 'model.response' in caplog.text


def test_redirect_hops_and_convenience_methods_are_logged(caplog):
    caplog.set_level('DEBUG', logger='opendirector.integrations.http_settings')

    def handle(request):
        if request.url.path == '/start':
            return httpx.Response(302, headers={'location': '/final'})
        return httpx.Response(200, json={'ok': True})

    async def run():
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=httpx.MockTransport(handle)) as client:
            response = await client.get('http://model.test/start', follow_redirects=True)
            assert response.json() == {'ok': True}
    asyncio.run(run())
    events = [(record.message.split(' ', 1)[0], json.loads(record.message.split(' ', 1)[1])) for record in caplog.records]
    assert [name for name, _ in events] == ['model.request', 'model.response'] * 2
    assert events[0][1]['url'].endswith('/start') and events[2][1]['url'].endswith('/final')
    assert events[1][1]['status'] == 302 and events[3][1]['status'] == 200
    assert events[0][1]['call_id'] == events[1][1]['call_id']
    assert events[2][1]['call_id'] == events[3][1]['call_id']
    assert events[0][1]['call_id'] != events[2][1]['call_id']


def test_entrypoint_uses_one_logging_format():
    from opendirector_api.server import logging_config

    config = logging_config('debug')
    assert config['loggers']['opendirector']['level'] == 'DEBUG'
    assert config['loggers']['uvicorn']['level'] == 'DEBUG'
    assert config['root']['handlers'] == ['console']
    assert config['handlers']['console']['formatter'] == 'console'


def test_info_level_omits_request_parameters(caplog):
    caplog.set_level('INFO', logger='opendirector.integrations.http_settings')

    async def run():
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=httpx.MockTransport(lambda request: httpx.Response(200))) as client:
            await client.post('http://model.test/image', json={'prompt': 'debug-only-prompt'})
    asyncio.run(run())
    assert 'model.response' in caplog.text
    assert 'model.request' not in caplog.text
    assert 'debug-only-prompt' not in caplog.text
