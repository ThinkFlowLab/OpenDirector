"""A fresh, exact HTTP closure is evidence even without model/operation facts."""
import asyncio
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest

from opendirector.agent.tools import AgentTools
from opendirector.application.model_availability import ModelAvailability, requests_for
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector.integrations.providers import GenerationProviders
from opendirector_api.main import create_app
from test_capability_acceptance import command_for
from test_creation_canvas_service import project
from test_creation_generation_service import runtime, Provider
from test_model_availability import document, private, service
from generation_helpers import settled


def missing_declaration(missing, **kwargs):
    value = document(**kwargs)
    if missing == 'model':
        value['models'][0]['id'] = 'another-model'
    else:
        value['models'][0]['operations'] = {}
    value['routes'][0]['exposure'] = 'disabled'
    return value


@pytest.mark.parametrize('missing', ['model', 'operation'])
@pytest.mark.parametrize('variant,blocked', [
    ('exact', True), ('method', False), ('path', False), ('transport', False),
    ('unknown', False), ('absent', False), ('expired', False),
])
def test_only_fresh_exact_route_closure_blocks_missing_declarations(service, missing, variant, blocked):
    configs, saved, observed, availability = service
    raw = missing_declaration(missing, now=observed['clock'])
    route = raw['routes'][0]
    if variant == 'method': route['method'] = 'GET'
    if variant == 'path': route['path'] = '/v1/videos'
    if variant == 'transport': route['transport'] = 'websocket'
    if variant == 'unknown': route['exposure'] = 'unknown'
    if variant == 'absent': raw['routes'] = []
    observed['document'] = raw
    config = private(configs, saved)
    availability.prepare(config)
    if variant == 'expired': observed['clock'] += 30
    result = availability.decision(config, requests_for(config)[0])
    assert result['status'] == ('unavailable' if blocked else 'unknown')
    if blocked:
        assert result['reasonCode'] == result['declaration']['reasonCode'] == 'route_disabled'
    assert 'execution' not in result


@pytest.mark.parametrize('missing', ['model', 'operation'])
@pytest.mark.parametrize('entry', ['service', 'http', 'agent'])
def test_missing_facts_do_not_send_to_a_closed_chat_endpoint(project, missing, entry):
    store, pid, session = project
    runner, config = runtime(project, Provider())
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': 'Unexpected call'}}]})
    provider = GenerationProviders(store, httpx.MockTransport(respond))
    runner.provider = provider
    raw = missing_declaration(missing, model='test-agent')
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=raw)))
    runner.availability = ModelAvailability(runner.configs, probe)
    command = command_for(project, config)
    before = store.snapshot(pid)
    async def run():
        try:
            if entry == 'agent':
                tools = AgentTools(store, runner, runner.configs)
                result = await tools.execute(pid, uuid4(), session, 'submit', 'execute_command',
                    command.model_dump(mode='json', exclude={'commandId', 'projectId'}), [], None)
            else:
                result = (await runner.execute(command, session=session)).model_dump(mode='json')
            await settled(runner)
            return result
        finally:
            await runner.close()
    try:
        if entry == 'http':
            with TestClient(create_app(store.local, generation_provider=provider, capability_probe=probe),
                headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}) as client:
                response = client.post(f'/api/creation/projects/{pid}/commands', json=command.model_dump(mode='json'))
                assert response.status_code == 200, response.text
                result = response.json()
        else:
            result = asyncio.run(run())
        assert result['status'] == 'rejected', result
        assert result['issues'][0]['code'] == 'capability_unavailable'
        after = store.snapshot(pid)
        assert after.jobs == before.jobs and not after.jobs
        assert after.assets == before.assets and after.generationSpecs == before.generationSpecs
        assert calls == []
    finally:
        probe.close()
