"""Video roles and parameters through real acceptance, HTTP uploads and saved results."""
import asyncio
from contextlib import contextmanager
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest

from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.model_availability import ModelAvailability
from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector_api.main import create_app
from test_model_availability import document
from test_tool_native_mask import multipart
from test_tool_tasks import png, project, sound_mp4, upload
from test_creation_canvas_service import project as generation_project


@pytest.fixture(scope='module')
def clip():
    return sound_mp4(5)


@contextmanager
def video_service(clip, mode):
    state = {'mode': mode, 'queries': 0, 'posts': []}
    def declaration():
        value = document('video_generation', 'video_to_video', '/v1/videos', 'video',
                         model='MiniMaxAI/MiniMax-H3', now=time.time())
        operation = value['models'][0]['operations']['video_generation']
        profile = operation['profiles'][0]
        profile['required_inputs'] = ['video']
        roles = {key: {'support': 'supported'} for key in ('source_video', 'video_noise_mask', 'audio_noise_mask')}
        if state['mode'] == 'reference_only':
            roles = {'reference_video': {'support': 'supported'}}
        if state['mode'] == 'mask_denied':
            roles['audio_noise_mask']['support'] = 'unsupported'
        if state['mode'] == 'h3_old':
            profile['support'] = 'unsupported'
        if state['mode'] == 'h3_unknown':
            profile['support'] = 'unknown'
        route = profile['routes'][0]
        route.update(exposure='enabled', request={'inputs': roles, 'parameters': {}})
        if state['mode'] == 'task_denied':
            route['request']['parameters']['task'] = {'type': 'string', 'enum': ['ref2va']}
        if state['mode'] == 'frames_denied':
            route['request']['parameters']['num_frames'] = {'type': 'integer', 'maximum': 100}
        if state['mode'].startswith('poster_'):
            profile.update(id='image_to_video', required_inputs=['text', 'image'])
            route['request'] = {'inputs': {
                'image': {'support': 'supported', 'min_count': 1, 'max_count': 1},
                'first_frame': {'support': 'supported', 'max_count': 1},
            }, 'parameters': {'num_frames': {'type': 'integer', 'maximum': int(state['mode'].split('_')[1])}}}
        return value
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def reply(self, value, content_type='application/json'):
            payload = value if isinstance(value, bytes) else json.dumps(value).encode()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def do_GET(self):
            if self.path == '/v1/omni/capabilities':
                state['queries'] += 1
                self.reply(declaration())
            elif self.path.endswith('/content'):
                self.reply(clip, 'video/mp4')
            else:
                self.reply({'id': 'remote-video', 'status': 'completed'})
        def do_POST(self):
            assert self.path == '/v1/videos'
            request = httpx.Request('POST', 'http://fixture/v1/videos', headers=dict(self.headers),
                                    content=self.rfile.read(int(self.headers['Content-Length'])))
            state['posts'].append(multipart(request))
            self.reply({'id': 'remote-video', 'status': 'queued'})
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/v1', state
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


@pytest.mark.parametrize('maximum', [10, 124])
def test_dynamic_poster_checks_124_frames_before_acceptance_and_preserves_execution(project, clip, maximum):
    store, pid, session = project
    with video_service(clip, f'poster_{maximum}') as (url, state):
        configs = ModelConfigs(store.local.repository)
        config = configs.save('video', url, 'MiniMaxAI/MiniMax-H3', '', connection_type='self_hosted',
                              protocol='vllm_omni', auth_mode='none')
        picture = png((64, 48))
        source = upload(store, pid, session, 'poster.png', picture)
        value = {'id': str(uuid4()), 'tool': 'dynamic-poster', 'sourceAssetIds': [source],
                 'parameters': {'prompt': 'Animate the light'}, 'modelConfigIds': {'video.first_frame': config['id']}}
        before = store.snapshot(pid)
        probe = CapabilityProbe(transport=httpx.HTTPTransport())
        try:
            with TestClient(create_app(store.local, capability_probe=probe), headers={'X-OpenDirector-Request': '1',
                            'X-OpenDirector-Session': session, 'Accept-Language': 'en-US'}) as client:
                path = f'/api/creation/projects/{pid}/tool-tasks'
                response = client.post(path, json=value)
                if maximum == 10:
                    assert response.status_code == 409, response.text
                    assert response.json() == {'detail': 'Frame count does not meet the service requirements.',
                                               'code': 'capability_unavailable'}
                    assert client.get(path).json()['tasks'] == [] and state['posts'] == []
                    after = store.snapshot(pid)
                    assert after.jobs == before.jobs and after.assets == before.assets
                    return
                assert response.status_code == 202, response.text
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    task = client.get(path + '/' + value['id']).json()
                    if task['status'] in {'succeeded', 'failed'}:
                        break
                    time.sleep(.02)
                assert task['status'] == 'succeeded', task
                assert len(state['posts']) == 1
                fields, uploads = state['posts'][0]
                checked = task['videoExecution']['requests'][0]
                assert checked['num_frames'] == 124 and checked['fps'] == 24
                sent = {**fields, **json.loads(fields['extra_params'])}
                for key, expected in checked.items():
                    assert str(sent[key]) == str(expected), key
                assert [key for key, _ in uploads] == ['input_reference']
                assert task['parameters']['prompt'] == 'Animate the light'
                assert task['sourceAssetIds'] == [source]
                assert task['modelConfigIds']['video.first_frame'] == config['id']
                assert CreationToolAssets(store).read_bytes(pid, source) == picture
                assert task['outputs'][0]['kind'] == 'video' and task['outputs'][0]['durationMs'] > 0
                assert CreationToolAssets(store).read_bytes(pid, task['outputs'][0]['id'])
                state['mode'] = 'poster_10'
                probe.query(config, manual=True)
                queries = state['queries']
                replay = client.post(path, json=value)
                assert replay.status_code == 202 and replay.json()['id'] == task['id']
                assert replay.json()['videoExecution'] == task['videoExecution']
                assert state['queries'] == queries and len(state['posts']) == 1
                assert len(client.get(path).json()['tasks']) == 1
        finally:
            probe.close()


@pytest.mark.parametrize('entry', ['service', 'http'])
@pytest.mark.parametrize('mode,accepted', [
    ('complete', True), ('reference_only', True), ('h3_unknown', True),
    ('mask_denied', False), ('h3_old', False), ('task_denied', False), ('frames_denied', False),
])
def test_video_edits_check_actual_uploads_before_acceptance(project, clip, entry, mode, accepted):
    store, pid, session = project
    with video_service(clip, mode) as (url, state):
        configs = ModelConfigs(store.local.repository)
        config = configs.save('video', url, 'MiniMaxAI/MiniMax-H3', '', connection_type='self_hosted',
                              protocol='vllm_omni', auth_mode='none')
        source = upload(store, pid, session, 'source.mp4', clip)
        value = {'id': str(uuid4()), 'tool': 'video-subtitle-erasure', 'sourceAssetIds': [source],
                 'parameters': {'confirmed': True}, 'modelConfigIds': {'video.edit': config['id']}}
        before = store.snapshot(pid)
        # conftest disables accidental discovery; explicitly enable loopback HTTP.
        probe = CapabilityProbe(transport=httpx.HTTPTransport())
        if entry == 'http':
            with TestClient(create_app(store.local, capability_probe=probe), headers={'X-OpenDirector-Request': '1',
                            'X-OpenDirector-Session': session, 'Accept-Language': 'en-US'}) as client:
                path = f'/api/creation/projects/{pid}/tool-tasks'
                response = client.post(path, json=value)
                assert response.status_code == (202 if accepted else 409), response.text
                if accepted:
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        task = client.get(path + '/' + value['id']).json()
                        if task['status'] in {'succeeded', 'failed'}:
                            break
                        time.sleep(.02)
                    state['mode'] = 'h3_old'
                    calls = state['queries']
                    assert client.post(path, json=value).json()['id'] == task['id']
                    assert state['queries'] == calls  # Accepted replay bypasses discovery.
                else:
                    assert client.get(path).json()['tasks'] == []
                    if mode == 'mask_denied':
                        assert 'audio editing mask' in response.text.lower(), response.text
        else:
            tools = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store,
                              availability=ModelAvailability(configs, probe), poll_interval=0)
            async def run():
                try:
                    if not accepted:
                        with pytest.raises(ProjectError) as error:
                            await tools.submit(pid, value, session)
                        assert error.value.code.startswith('capability_')
                        assert tools.list(pid) == []
                        return None
                    task = await tools.submit(pid, value, session)
                    await asyncio.gather(*tools.jobs.values())
                    result = tools.get(pid, task['id'])
                    state['mode'] = 'h3_old'
                    tools.availability.refresh([config['id']], manual=True)
                    calls = state['queries']
                    replay = await tools.submit(pid, value, session)
                    assert replay['videoExecution'] == result['videoExecution']
                    assert state['queries'] == calls
                    return result
                finally:
                    await tools.close()
                    probe.close()
            task = asyncio.run(run())
        assert state['queries'] >= 1
        if not accepted:
            assert state['posts'] == []
            assert store.snapshot(pid).assets == before.assets
            return
        assert task['status'] == 'succeeded', task.get('error')
        assert len(state['posts']) == len(task['videoExecution']['requests']) == 1
        fields, uploads = state['posts'][0]
        checked = task['videoExecution']['requests'][0]
        sent = {**fields, **json.loads(fields['extra_params'])}
        for key, val in checked.items():
            if key not in {'width', 'height'}:
                assert str(sent[key]) == str(val), key
        assert fields['size'] == f"{checked['width']}x{checked['height']}"
        assert fields['model'] == config['modelId']
        assert [key for key, _ in uploads] == ['source_video', 'video_noise_mask', 'audio_noise_mask']
        assert json.loads(dict(uploads)['audio_noise_mask']) == 0.0
        assert task['sourceAssetIds'] == [source] and task['modelConfigIds']['video.edit'] == config['id']
        assert len(task['outputs']) == 1 and abs(task['outputs'][0]['durationMs'] - 5000) < 300
        assert CreationToolAssets(store).read_bytes(pid, task['outputs'][0]['id'])


@pytest.mark.parametrize('entry', ['service', 'http', 'agent'])
@pytest.mark.parametrize('mode,kind,role,accepted', [
    ('first_frame', 'image', 'first_frame', False),
    ('reference', 'image', 'reference_image', True),
    ('reference', 'video', 'reference_video', False),  # H3 adapter prohibits uploaded reference videos.
])
def test_generation_entries_distinguish_references_from_fixed_or_editing_inputs(
        generation_project, clip, entry, mode, kind, role, accepted):
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.integrations.providers import GenerationProviders
    from generation_helpers import command
    from test_creation_canvas_service import send, ver
    from opendirector.domain.creation.commands import parse_command
    from test_request_capability_acceptance import submit
    from test_tool_tasks import png
    store, pid, session = generation_project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('video', 'http://video.test/v1', 'MiniMaxAI/MiniMax-H3', '',
                          connection_type='self_hosted', protocol='vllm_omni', auth_mode='none')
    declaration = document('video_generation', 'image_to_video' if kind == 'image' else 'video_to_video',
                           '/v1/videos', 'video', model=config['modelId'])
    route = declaration['models'][0]['operations']['video_generation']['profiles'][0]['routes'][0]
    route.update(exposure='enabled', request={'inputs': {
        'first_frame': {'support': 'unsupported'}, 'source_video': {'support': 'unsupported'},
        'reference_image': {'support': 'supported'}, 'reference_video': {'support': 'supported'}}})
    queries, posts = [], []
    def discover(request):
        queries.append(request)
        return httpx.Response(200, json=declaration)
    def generate(request):
        if request.method == 'POST':
            posts.append(multipart(request))
            return httpx.Response(200, json={'id': 'video-reference', 'status': 'queued'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=clip, headers={'content-type': 'video/mp4'})
        return httpx.Response(200, json={'id': 'video-reference', 'status': 'completed'})
    probe = CapabilityProbe(transport=httpx.MockTransport(discover))
    runner = CreationGeneration(store, configs, availability=ModelAvailability(configs, probe))
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(generate), poll_interval=0)
    source = upload(store, str(pid), session, 'source.png' if kind == 'image' else 'source.mp4',
                    png() if kind == 'image' else clip)
    try:
        request = command(generation_project, config, references=[source],
                          parameters={'videoMode': mode, 'durationSeconds': 5})
        if mode == 'first_frame':
            ref = store.snapshot(pid).references[0]
            assert send(store, pid, 'reference.update', session=session, versions=[ver('reference', ref)],
                        reference=ref.model_copy(update={'role': 'first_frame'})).status == 'applied'
            snapshot = store.snapshot(pid)
            spec = snapshot.generationSpecs[0]
            item = next(item for item in snapshot.canvasItems if item.id == request.payload.originItemId)
            request = parse_command({**request.model_dump(),
                'expectedVersions': [ver('generation_spec', spec), ver('canvas_item', item)],
                'payload': {**request.payload.model_dump(), 'expectedSpecRevision': spec.revision}})
        receipt = submit(entry, generation_project, runner, probe, request)
        assert receipt['status'] == ('accepted' if accepted else 'rejected'), json.dumps(receipt, ensure_ascii=False)
        assert len(queries) == 1
        snapshot = store.snapshot(pid)
        if accepted:
            assert len(posts) == len(snapshot.jobs) == 1
            job = snapshot.jobs[0]
            assert job.status == 'succeeded', job
            assert str(job.inputSnapshot.references[0].asset.assetId) == source
            assert json.loads(posts[0][0]['extra_params'])['task'] == 'ref2va'
            assert len(posts[0][1]) == 1
        else:
            assert not posts and not snapshot.jobs
            assert role in str(route['request'])
            if kind == 'video':
                assert receipt['issues'][0]['code'] != 'capability_unavailable'
    finally:
        probe.close()
