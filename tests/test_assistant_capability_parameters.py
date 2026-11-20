"""Assistant admission checks the parameters forwarded by the real model gateway."""
import asyncio
import json
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest

from opendirector.agent.model_gateway import ModelGateway
from opendirector.application.model_availability import ModelAvailability
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector_api import agent
from opendirector_api.main import create_app
from test_model_availability import document, NOW


@pytest.mark.parametrize('locale', ['en-US', 'zh-CN'])
@pytest.mark.parametrize('scenario', [
    'limited', 'boundary', 'above', 'expired', 'unknown', 'unknown_with_limit', 'missing', 'failed',
    'changed', 'narrowed', 'native',
])
def test_assistant_parameters_at_admission_and_gateway(tmp_path, monkeypatch, locale, scenario):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('agent', 'http://assistant.test/v1', 'demo', '',
                         connection_type='self_hosted', auth_mode='none')
    queries, checked, posts, turns = [], [], [], []
    state = {'maximum': 8192 if scenario in {'boundary', 'changed', 'narrowed'} else
             8193 if scenario == 'above' else 1024}

    def discover(request):
        queries.append(request)
        value = document(now=NOW - (30 if scenario == 'expired' else 0),
                         support='unknown' if scenario.startswith('unknown') else 'supported')
        route = value['models'][0]['operations']['chat']['profiles'][0]['routes'][0]
        route['request'] = {'parameters': {'max_tokens': {'type': 'integer', 'maximum': state['maximum']}}}
        if scenario == 'unknown':
            del route['request']
        return httpx.Response(404 if scenario == 'missing' else 503 if scenario == 'failed' else 200, json=value)

    probe = CapabilityProbe(transport=httpx.MockTransport(discover), clock=lambda: NOW, wall_clock=lambda: NOW)
    original = ModelAvailability.require

    def require(self, config, request, prepared=None):
        checked.append(dict(request.parameters))
        return original(self, config, request, prepared)

    def respond(request):
        assert request.method == 'POST' and request.url.path == '/v1/chat/completions'
        posts.append(json.loads(request.content))
        return httpx.Response(200, json={'text': 'Fixture response'})

    async def stream(self, context):
        turns.append(context)
        if context.config is None:
            yield {'type': 'delta', 'text': 'Native fixture response'}
            return
        gateway = ModelGateway(context.config, context.thinking, 'fixture-token',
                               str(context.project_id), str(context.turn_id), httpx.MockTransport(respond))
        server = await asyncio.start_server(gateway.connect, '127.0.0.1', 0)
        try:
            port = server.sockets[0].getsockname()[1]
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await client.post(f'http://127.0.0.1:{port}/chat/completions',
                    headers={'Authorization': 'Bearer fixture-token'},
                    json={'messages': context.messages, 'max_tokens': 1})
                response.raise_for_status()
                yield {'type': 'delta', 'text': response.json()['text']}
        finally:
            server.close()
            await server.wait_closed()
            await asyncio.gather(*list(gateway.active))

    async def skills(*args):
        if scenario == 'changed':
            configs.save('agent', 'http://changed.test/v1', 'demo', '', saved['id'], connection_type='self_hosted')
        elif scenario == 'narrowed':
            state['maximum'] = 1024
            await asyncio.to_thread(probe.query, configs.resolve(saved['id'], 'agent'), manual=True)
        return []

    monkeypatch.setattr(ModelAvailability, 'require', require)
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', skills)
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4()), 'Accept-Language': locale}
    with TestClient(create_app(LocalProjects(tmp_path), capability_probe=probe), headers=headers) as client:
        pid = str(uuid4())
        base = f'/api/creation/projects/{pid}'
        client.post(base + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': 'Assistant parameter review'}}).raise_for_status()
        client.post(base + '/open').raise_for_status()
        response = client.post(base + '/assistant/turns', json={'id': str(uuid4()), 'text': 'Keep this prompt',
            'modelId': saved['id'], 'runtime': 'codex' if scenario == 'native' else 'default'})
        messages = client.get(base + '/assistant').json()['messages']
        parameter_error = ('The selected parameter does not meet the service requirements.'
                           if locale == 'en-US' else '所选参数不符合服务要求。')
        if scenario in {'limited', 'unknown_with_limit', 'changed', 'narrowed'}:
            assert not turns and not posts and not messages
            if scenario in {'limited', 'unknown_with_limit'}:
                assert response.status_code == 409 and response.json()['detail'] == parameter_error
            else:
                assert response.status_code == 200
                events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
                assert not any(item['type'] == 'start' for item in events)
                assert events[-1]['type'] == 'end' and events[-1]['error']
                if scenario == 'narrowed':
                    assert parameter_error in json.dumps(events[-1]['error'], ensure_ascii=False)
        else:
            assert response.status_code == 200 and len(turns) == 1
            assert messages[0]['text'] == 'Keep this prompt'
            assert messages[-1]['status'] == 'complete'
            if scenario != 'native':
                assert len(posts) == 1 and posts[0]['max_tokens'] == 8192
        if scenario == 'native':
            assert not queries and not checked and not posts
        else:
            assert checked == [{'max_tokens': 8192}] * (1 if scenario in {'limited', 'unknown_with_limit'} else 2)
