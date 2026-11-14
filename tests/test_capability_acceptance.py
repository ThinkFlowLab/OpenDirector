"""Shared acceptance, HTTP, CLI and Agent tests with isolated model doubles."""
import asyncio
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import threading
import time
from unittest.mock import Mock
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest
from typer.testing import CliRunner
import uvicorn

from opendirector import cli
from opendirector.agent.tools import AgentTools
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.model_availability import ModelAvailability, requests_for
from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector.integrations.providers import GenerationProviders
from opendirector_api.main import create_app
from opendirector_api import agent
from test_creation_canvas_service import project, ver
from test_creation_generation_service import Provider, runtime, configure
from test_model_availability import document
from test_tool_tasks import png, upload, images_server, video_server, H3, configure as configure_tools
from test_generation_recovery import video
from generation_helpers import command as generation_command, settled


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


def test_missing_required_input_is_rejected_before_job_acceptance(project):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    declaration = document(model='test-agent')
    declaration['models'][0]['operations']['chat']['profiles'][0]['required_inputs'] = ['text', 'audio']
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=declaration)))
    runner.availability = ModelAvailability(runner.configs, probe)
    try:
        receipt = runner.prepare(command_for(project, config), session=session)
        assert receipt.status == 'rejected' and receipt.issues[0].code == 'capability_unavailable'
        assert not store.snapshot(pid).jobs and provider.calls == []
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


def deny_new_work(availability, config, declaration, mode):
    """Publish real negative evidence before forbidding re-admission calls."""
    operation = next(iter(declaration['models'][0]['operations'].values()))
    if mode == 'unsupported':
        operation['support'] = 'unsupported'
        for profile in operation['profiles']:
            profile['support'] = 'unsupported'
    else:
        operation['execution']['state'] = 'paused'
    availability.refresh([config['id']], manual=True)
    private = availability.configs.resolve(config['id'], config['kind'])
    request = next(item for item in requests_for(private) if item.profile == operation['profiles'][0]['id'])
    assert availability.decision(private, request)['status'] == 'unavailable'
    for method in ('prepare', 'prepare_many', 'require'):
        setattr(availability, method, Mock(side_effect=AssertionError('accepted work must not be readmitted')))


@pytest.mark.parametrize('denial', ['unsupported', 'paused'])
@pytest.mark.parametrize('action', ['remote', 'download', 'cancel'])
def test_accepted_generation_keeps_original_remote_work_after_capability_change(project, video, action, denial):
    store, pid, session = project
    kind = 'image' if action == 'download' else 'video'
    configs = ModelConfigs(store.local.repository)
    config = configs.save(kind, 'http://127.0.0.1:12345/v1', 'demo' if kind == 'image' else H3[2], '',
        connection_type='self_hosted', protocol='openai' if kind == 'image' else 'vllm_omni')
    declaration = document('image_generation' if kind == 'image' else 'video_generation',
        'text_to_image' if kind == 'image' else 'text_to_video',
        '/v1/images/generations' if kind == 'image' else '/v1/videos', kind, model=config['modelId'])
    queries, calls, state = [], [], {'healthy': False}
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda request: (
        queries.append(request) or httpx.Response(200, json=declaration))))
    availability = ModelAvailability(configs, probe)
    def handle(request):
        calls.append((request.method, request.url.path))
        if request.method == 'POST':
            return httpx.Response(200, json={'data': [{'url': config['url'] + '/result.png'}]} if kind == 'image'
                                  else {'id': 'accepted-remote-id', 'status': 'queued'})
        if request.method == 'DELETE':
            assert request.url.path == '/v1/videos/accepted-remote-id'
            return httpx.Response(200, json={'id': 'accepted-remote-id', 'status': 'cancelled'})
        if not state['healthy']:
            raise httpx.ReadTimeout('interrupted read', request=request)
        if request.url.path.endswith('/content') or kind == 'image':
            return httpx.Response(200, content=png() if kind == 'image' else video)
        assert request.url.path == '/v1/videos/accepted-remote-id'
        return httpx.Response(200, json={'id': 'accepted-remote-id', 'status': 'completed'})
    async def run():
        first = CreationGeneration(store, configs, availability=availability)
        first.provider = GenerationProviders(first.store, httpx.MockTransport(handle), poll_interval=0)
        second = None
        try:
            command = generation_command(project, config, prompt='Keep this accepted request')
            accepted = await first.execute(command, session=session)
            assert accepted.status == 'accepted'
            await settled(first)
            initial = store.snapshot(pid).jobs[0]
            assert initial.recovery == ('download' if action == 'download' else 'remote')
            frozen = initial.inputSnapshot.model_dump()
            await first.close()
            deny_new_work(availability, config, declaration, denial)
            state['healthy'] = True
            reopened = CreationProjects(LocalProjects(store.local.repository))
            second = CreationGeneration(reopened, configs, availability=availability)
            second.provider = GenerationProviders(second.store, httpx.MockTransport(handle), poll_interval=0)
            before = len(calls)
            if action == 'cancel':
                cancel = parse_command(dict(commandId=uuid4(), projectId=pid, type='job.cancel',
                    expectedVersions=[ver('job', initial)], payload=dict(jobId=initial.id)))
                receipt = await second.execute(cancel, session=session)
                assert receipt.status == 'applied'
                assert await second.execute(cancel, session=session) == receipt
                assert calls[before:] == [('DELETE', '/v1/videos/accepted-remote-id')]
            else:
                await second.start()
                await settled(second)
                assert calls[before:] == ([('GET', '/v1/result.png')] if kind == 'image' else
                    [('GET', '/v1/videos/accepted-remote-id'), ('GET', '/v1/videos/accepted-remote-id/content')])
            final = reopened.snapshot(pid)
            assert len(final.jobs) == 1 and final.jobs[0].id == accepted.jobIds[0]
            assert final.jobs[0].status == ('cancelled' if action == 'cancel' else 'succeeded')
            assert final.jobs[0].externalTaskId == initial.externalTaskId
            assert final.jobs[0].inputSnapshot.model_dump() == frozen
            assert len(final.results) == (0 if action == 'cancel' else 1)
            assert sum(method == 'POST' for method, _ in calls) == 1 and len(queries) == 2
            count = len(calls)
            assert second.prepare(command, session=session) == accepted and len(calls) == count
            for method in ('prepare', 'prepare_many', 'require'):
                getattr(availability, method).assert_not_called()
        finally:
            await first.close()
            if second:
                await second.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


@pytest.mark.parametrize('denial', ['unsupported', 'paused'])
def test_remote_tool_frozen_execution_recovery_and_replay_ignore_new_capabilities(project, denial):
    store, project_id, session = project
    pid = str(project_id)
    configs = configure_tools(store, H3)
    config = configs.list()[0]
    source = upload(store, pid, session, 'poster.png', png((64, 36)))
    declaration = document('video_generation', 'image_to_video', '/v1/videos', 'video', model=config['modelId'])
    queries, calls = [], []
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda request: (
        queries.append(request) or httpx.Response(200, json=declaration))))
    availability = ModelAvailability(configs, probe)
    transport = httpx.MockTransport(video_server(calls, hold=True))
    async def run():
        first = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store,
            transport=transport, poll_interval=.01, concurrency=1, availability=availability)
        second = None
        await first.limit.acquire()
        try:
            value = {'id': str(uuid4()), 'tool': 'dynamic-poster', 'sourceAssetIds': [source], 'parameters': {}}
            accepted = await first.submit(pid, value, session)
            frozen = json.dumps(accepted['modelSnapshots'], sort_keys=True)
            deny_new_work(availability, config, declaration, denial)
            first.limit.release()
            async with asyncio.timeout(5):
                while ('GET', '/v1/videos/video_1') not in calls:
                    await asyncio.sleep(.01)
            await first.close()
            second = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store,
                transport=transport, poll_interval=0, availability=availability)
            before = len(calls)
            await second.recover()
            assert calls[before:] == [('GET', '/v1/videos/video_1')]
            recovered = second.get(pid, accepted['id'])
            assert recovered['status'] == 'interrupted'
            assert recovered['modelCalls'][0]['externalTaskId'] == 'video_1'
            assert json.dumps(recovered['modelSnapshots'], sort_keys=True) == frozen
            before = len(calls)
            replay = await second.submit(pid, value, session)
            assert replay['id'] == accepted['id'] and replay['modelCalls'] == recovered['modelCalls']
            assert len(calls) == before and calls.count(('POST', '/v1/videos')) == 1 and len(queries) == 2
            for method in ('prepare', 'prepare_many', 'require'):
                getattr(availability, method).assert_not_called()
        finally:
            await first.close()
            if second:
                await second.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


def test_tool_admission_shares_one_budget_for_image_and_optional_chat(project):
    store, project_id, session = project
    pid = str(project_id)
    configs = ModelConfigs(store.local.repository)
    configs.save('image', 'http://image.test/v1', 'Tongyi-MAI/Z-Image-Turbo', '', connection_type='self_hosted')
    configs.save('agent', 'http://chat.test/v1', 'demo', '', connection_type='self_hosted')
    source = upload(store, pid, session, 'source.png', png())
    finish, queried = threading.Event(), []
    def respond(request):
        queried.append(request.url.host)
        finish.wait(2)
        return httpx.Response(404)
    probe = CapabilityProbe(transport=httpx.MockTransport(respond), timeout=.4)
    async def run():
        tools = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store,
            concurrency=1, availability=ModelAvailability(configs, probe))
        await tools.limit.acquire()
        try:
            started = time.monotonic()
            task = await tools.submit(pid, {'id': str(uuid4()), 'tool': 'outpaint', 'sourceAssetIds': [source], 'parameters': {}}, session)
            assert time.monotonic() - started < .65
            assert sorted(queried) == ['chat.test', 'image.test']
            assert set(task['modelSnapshots']) == {'image.edit', 'text.chat'}
        finally:
            finish.set()
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


@pytest.mark.parametrize('scenario', ['unsupported', 'missing_input', 'changed_before_acceptance', 'native'])
def test_assistant_admission_and_native_runtime_boundary(tmp_path, monkeypatch, scenario):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('agent', 'http://assistant.test/v1', 'demo', '', connection_type='self_hosted')
    calls, turns = [], []
    def respond(request):
        calls.append(request)
        value = document(support='unsupported' if scenario == 'unsupported' else 'supported')
        if scenario == 'missing_input':
            value['models'][0]['operations']['chat']['profiles'][0]['required_inputs'] = ['text', 'image']
        return httpx.Response(200, json=value)
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
        if scenario in {'unsupported', 'missing_input'}:
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


@contextmanager
def local_api(app):
    """Run the real API on an ephemeral loopback port for the real CLI client."""
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        url = f'http://127.0.0.1:{listener.getsockname()[1]}'
        server = uvicorn.Server(uvicorn.Config(app, log_level='warning', access_log=False))
        thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(.01)
            assert server.started, 'Local API did not start'
            yield url
        finally:
            server.should_exit = True
            thread.join(10)
            assert not thread.is_alive(), 'Local API did not shut down'


@pytest.mark.parametrize('entry', ['cli', 'agent'])
@pytest.mark.parametrize('state', ['supported', 'unsupported', 'paused'])
def test_cli_and_agent_generation_apply_real_admission(project, monkeypatch, entry, state):
    store, pid, session = project
    provider = Provider()
    provider.finish.set()
    runner, config = runtime(project, provider)
    declaration = document(model='test-agent', support='unsupported' if state == 'unsupported' else 'supported')
    if state == 'paused':
        declaration['models'][0]['operations']['chat']['execution']['state'] = 'paused'
    queries = []
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda request:
        queries.append(request) or httpx.Response(200, json=declaration)))
    runner.availability = ModelAvailability(runner.configs, probe)
    command = command_for(project, config)
    arguments = command.model_dump(mode='json', exclude={'commandId', 'projectId'})
    before = store.snapshot(pid)

    async def through_agent():
        tools = AgentTools(store, runner, runner.configs)
        try:
            value = await tools.execute(pid, uuid4(), session, 'submit', 'execute_command', arguments, [], None)
            await settled(runner)
            return value
        finally:
            await runner.close()

    try:
        if entry == 'agent':
            receipt = asyncio.run(through_agent())
        else:
            monkeypatch.delenv('OPENDIRECTOR_AGENT_SOCKET', raising=False)
            monkeypatch.delenv('OPENDIRECTOR_AGENT_HOST', raising=False)
            app = create_app(store.local, generation_provider=provider, capability_probe=probe)
            with local_api(app) as url:
                result = CliRunner().invoke(cli.app, ['--url', url, '--project', str(pid), '--session', session,
                    '--operation-id', str(command.commandId), 'generation', 'submit', '--file', '-'],
                    input=json.dumps(arguments))
                assert result.exit_code == (0 if state == 'supported' else 1), result.output
                receipt = json.loads(result.output)
                if state == 'supported':
                    deadline = time.monotonic() + 5
                    while store.snapshot(pid).jobs[0].status not in {'succeeded', 'failed'} and time.monotonic() < deadline:
                        time.sleep(.01)
        after = store.snapshot(pid)
        assert len(queries) == 1 and queries[0].method == 'GET'
        if state == 'supported':
            assert receipt['status'] == 'accepted'
            assert len(after.jobs) == len(provider.calls) == 1
            job = after.jobs[0]
            assert receipt['jobIds'] == [str(job.id)] and job.status == 'succeeded'
            assert job.inputSnapshot.spec.modelConfigId == before.generationSpecs[0].modelConfigId
            assert job.inputSnapshot.spec.prompt == before.generationSpecs[0].prompt
        else:
            assert receipt['status'] == 'rejected'
            assert receipt['issues'][0]['code'] == ('capability_paused' if state == 'paused' else 'capability_unavailable')
            assert not after.jobs and provider.calls == []
            assert after.generationSpecs == before.generationSpecs
            assert after.canvasItems == before.canvasItems
            assert after.assets == before.assets and after.results == before.results
    finally:
        probe.close()
