"""Shared acceptance, HTTP, CLI and Agent tests with isolated model doubles."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
from unittest.mock import Mock
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest
from typer.testing import CliRunner

from opendirector import cli
from opendirector.agent.tools import AgentTools
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.model_availability import ModelAvailability
from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector_api.main import create_app
from opendirector_api import agent
from test_creation_canvas_service import project, ver
from test_creation_generation_service import Provider, runtime, configure
from test_model_availability import document, NOW
from test_tool_tasks import png, upload, images_server


def command_for(project, config):
    _, project_id, _ = project
    target, spec = configure(project, config)
    return parse_command(dict(commandId=uuid4(), projectId=project_id, type='generation.submit',
        expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))


def test_generation_rejection_creates_no_job_or_provider_call(project):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json=document(model='test-agent', support='unsupported'))
    probe = CapabilityProbe(transport=httpx.MockTransport(respond))
    runner.availability = ModelAvailability(runner.configs, probe)
    command = command_for(project, config)
    async def run():
        try:
            receipt = await runner.execute(command, session=session)
            assert receipt.status == 'rejected'
            assert receipt.issues[0].code == 'capability_unavailable'
            assert not store.snapshot(pid).jobs and provider.calls == []
            assert len(calls) == 1 and calls[0].method == 'GET'
        finally:
            await runner.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


def test_generation_identity_change_during_query_is_rejected_under_commit(project):
    store, pid, session = project
    runner, config = runtime(project, Provider())
    def respond(request):
        # This save must complete while the HTTP query is in progress.
        runner.configs.save('agent', 'http://changed.test/v1', 'test-agent', '', config['id'], connection_type='self_hosted')
        return httpx.Response(200, json=document(model='test-agent'))
    probe = CapabilityProbe(transport=httpx.MockTransport(respond))
    runner.availability = ModelAvailability(runner.configs, probe)
    try:
        result = runner.prepare(command_for(project, config), session=session)
        assert result.status == 'rejected'
        assert result.issues[0].code == 'capability_connection_changed'
        assert not store.snapshot(pid).jobs
    finally:
        probe.close()


def test_generation_replay_precedes_changed_declaration_and_preserves_snapshot(project):
    store, pid, session = project
    runner, config = runtime(project, Provider())
    state = {'support': 'supported', 'calls': 0}
    def respond(request):
        state['calls'] += 1
        return httpx.Response(200, json=document(model='test-agent', support=state['support']))
    probe = CapabilityProbe(transport=httpx.MockTransport(respond))
    runner.availability = ModelAvailability(runner.configs, probe)
    try:
        command = command_for(project, config)
        receipt = runner.prepare(command, session=session)
        assert receipt.status == 'accepted'
        frozen = store.snapshot(pid).jobs[0].inputSnapshot.model_dump()
        state['support'] = 'unsupported'
        runner.availability.refresh([config['id']], manual=True)
        calls = state['calls']
        replay = runner.prepare(command, session=session)
        assert replay.jobIds == receipt.jobIds and state['calls'] == calls
        assert store.snapshot(pid).jobs[0].inputSnapshot.model_dump() == frozen
        assert 'availability' not in str(frozen) and 'capabilityAutoCheck' not in str(frozen)
    finally:
        probe.close()


def test_tools_reject_new_remote_work_and_keep_local_work_and_replays(project):
    store, project_id, session = project
    pid = str(project_id)
    configs = ModelConfigs(store.local.repository)
    configs.save('image', 'http://image.test/v1', 'Tongyi-MAI/Z-Image-Turbo', '', connection_type='self_hosted')
    source = upload(store, pid, session, 'source.png', png())
    calls = []
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda request: httpx.Response(200,
        json=document('image_edit', 'image_to_image', '/v1/images/edits', 'image', model='Tongyi-MAI/Z-Image-Turbo', support='unsupported'))))
    availability = ModelAvailability(configs, probe)
    tools = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store,
        transport=httpx.MockTransport(images_server(calls)), availability=availability)
    async def run():
        try:
            with pytest.raises(ProjectError) as error:
                await tools.submit(pid, {'id': str(uuid4()), 'tool': 'outpaint', 'sourceAssetIds': [source], 'parameters': {}}, session)
            assert error.value.code == 'capability_unavailable'
            assert not tools.list(pid) and calls == []
            value = {'id': str(uuid4()), 'tool': 'image-hd', 'sourceAssetIds': [source],
                     'parameters': {'kind': 'normal', 'resolution': '2K'}}
            task = await tools.submit(pid, value, session)
            await asyncio.gather(*tools.jobs.values())
            assert tools.get(pid, task['id'])['status'] == 'succeeded'
            availability.prepare = Mock(side_effect=AssertionError('replay queried capability'))
            replay = await tools.submit(pid, value, session)
            assert replay['id'] == task['id'] and calls == []
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


def test_tool_edit_uses_its_real_route_and_skips_unsupported_optional_chat(project):
    store, project_id, session = project
    pid = str(project_id)
    configs = ModelConfigs(store.local.repository)
    image = configs.save('image', 'http://image.test/v1', 'Tongyi-MAI/Z-Image-Turbo', '', connection_type='self_hosted')
    configs.save('agent', 'http://chat.test/v1', 'demo', '', connection_type='self_hosted')
    source = upload(store, pid, session, 'source.png', png())
    calls = []
    def respond(request):
        value = (document('image_edit', 'image_to_image', '/v1/images/edits', 'image', model=image['modelId'])
                 if request.url.host == 'image.test' else document(support='unsupported'))
        return httpx.Response(200, json=value)
    probe = CapabilityProbe(transport=httpx.MockTransport(respond))
    tools = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store,
        transport=httpx.MockTransport(images_server(calls)), availability=ModelAvailability(configs, probe))
    async def run():
        try:
            task = await tools.submit(pid, {'id': str(uuid4()), 'tool': 'outpaint', 'sourceAssetIds': [source],
                'parameters': {'left': 0, 'right': 1, 'top': 0, 'bottom': 0}}, session)
            await asyncio.gather(*tools.jobs.values())
            result = tools.get(pid, task['id'])
            assert result['status'] == 'succeeded', result['error']
            assert len(calls) == 1 and 'text.chat' not in result['modelConfigIds']
            assert 'capabilityAutoCheck' not in str(result['modelSnapshots'])
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


def test_saved_http_api_and_draft_checks_share_parser_but_not_observations(tmp_path):
    calls = []
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda request: (calls.append(request) or httpx.Response(200, json=document()))))
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}
    with TestClient(create_app(LocalProjects(tmp_path), capability_probe=probe), headers=headers) as client:
        payload = {'kind': 'agent', 'url': 'http://models.test/v1', 'modelId': 'demo', 'apiKey': '', 'connectionType': 'self_hosted'}
        saved = client.post('/api/model-configs', json=payload).json()
        assert client.get('/api/model-configs/availability').json()['models'][0]['status'] == 'unknown'
        assert calls == []
        draft = client.post('/api/model-configs/availability/check', json=payload)
        assert draft.status_code == 200, draft.text
        assert draft.json()['status'] == 'available' and draft.json()['configId'] is None
        assert client.get('/api/model-configs/availability').json()['models'][0]['status'] == 'unknown'
        observed = client.post('/api/model-configs/availability', json={'configIds': [saved['id']], 'manual': True})
        assert observed.status_code == 200, observed.text
        assert observed.json()['models'][0]['status'] == 'available'
        assert client.get('/api/model-configs').json()[0]['availability']['status'] == 'available'
        assert len(calls) == 2


@pytest.mark.parametrize('scenario', ['unsupported', 'changed_before_acceptance', 'native'])
def test_assistant_admission_and_native_runtime_boundary(tmp_path, monkeypatch, scenario):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('agent', 'http://assistant.test/v1', 'demo', '', connection_type='self_hosted')
    calls, turns = [], []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json=document(support='unsupported' if scenario == 'unsupported' else 'supported'))
    probe = CapabilityProbe(transport=httpx.MockTransport(respond))
    async def stream(self, context):
        turns.append(context)
        yield {'type': 'delta', 'text': 'Fixture response'}
    async def skills(*args):
        if scenario == 'changed_before_acceptance':
            configs.save('agent', 'http://changed.test/v1', 'demo', '', saved['id'], connection_type='self_hosted')
        return []
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', skills)
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}
    with TestClient(create_app(LocalProjects(tmp_path), capability_probe=probe), headers=headers) as client:
        pid = str(uuid4())
        base = f'/api/creation/projects/{pid}'
        client.post(base + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': 'Capability assistant'}}).raise_for_status()
        client.post(base + '/open').raise_for_status()
        response = client.post(base + '/assistant/turns', json={'id': str(uuid4()), 'text': 'Hello',
            'modelId': saved['id'], 'runtime': 'codex' if scenario == 'native' else 'default'})
        if scenario == 'unsupported':
            assert response.status_code == 409 and turns == []
            assert client.get(base + '/assistant').json()['messages'] == []
        elif scenario == 'changed_before_acceptance':
            assert response.status_code == 200 and turns == []
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            assert not any(item['type'] == 'start' for item in events)
            assert client.get(base + '/assistant').json()['messages'] == []
        else:
            assert response.status_code == 200 and len(turns) == 1 and calls == []


def test_loopback_http_discovery_checks_real_route_without_inference(tmp_path):
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append((self.command, self.path))
            data = json.dumps(document()).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    configs = ModelConfigs(tmp_path)
    configs.save('agent', f'http://127.0.0.1:{server.server_port}/v1', 'demo', '', connection_type='self_hosted')
    probe = CapabilityProbe(transport=httpx.HTTPTransport())
    try:
        result = ModelAvailability(configs, probe).refresh()
        assert result['models'][0]['status'] == 'available'
        assert calls == [('GET', '/v1/omni/capabilities')]
    finally:
        probe.close()
        server.shutdown()
        server.server_close()
        thread.join(2)


@pytest.mark.parametrize('live', [False, True])
def test_cli_availability_uses_shared_read_or_refresh(live, monkeypatch):
    client = Mock(live=live, opened=False)
    client.request.return_value = client.call.return_value = {'revision': 'test', 'models': []}
    monkeypatch.setattr(cli, 'Client', Mock(return_value=client))
    model = str(uuid4())
    result = CliRunner().invoke(cli.app, ['model', 'availability', '--refresh', '--manual', '--model', model])
    assert result.exit_code == 0, result.output
    if live:
        client.call.assert_called_once_with('model_availability', {'refresh': True, 'manual': True, 'configIds': [model]})
    else:
        client.request.assert_called_once_with('POST', '/api/model-configs/availability', json={'manual': True, 'configIds': [model]})


def test_agent_reads_and_refreshes_the_same_availability(project):
    store, pid, session = project
    runner, config = runtime(project, Provider())
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=document(model='test-agent'))))
    runner.availability = ModelAvailability(runner.configs, probe)
    tools = AgentTools(store, runner, runner.configs)
    async def run():
        result = await tools.execute(pid, uuid4(), session, 'read', 'model_availability', {}, [], None)
        assert result['models'][0]['status'] == 'unknown'
        result = await tools.execute(pid, uuid4(), session, 'refresh', 'model_availability', {'refresh': True}, [], None)
        assert result['models'][0]['status'] == 'available'
    try:
        asyncio.run(run())
    finally:
        probe.close()
