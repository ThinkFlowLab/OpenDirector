"""Kling native routes, immutable image inputs and shared durable jobs."""
import asyncio
import base64
from io import BytesIO
import json
import socket
import subprocess
from uuid import uuid4

import httpx
from PIL import Image
import pytest

from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.generation import GenerationError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.kling_models import kling_parameters, validate_kling_prompt
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.kling_video import KlingVideoGeneration
from opendirector.integrations.model_capabilities import read_service_models
from opendirector.integrations.providers import GenerationProviders
from generation_helpers import command as generation_command, new_project, prepared as prepare_command, settled
from test_creation_canvas_service import send, ver


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture(autouse=True)
def resolve_kling_cdn(monkeypatch):
    lookup = socket.getaddrinfo

    def resolve(host, port, *args, **kwargs):
        if host == 'cdn.example.test':
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', port))]
        return lookup(host, port, *args, **kwargs)

    monkeypatch.setattr(socket, 'getaddrinfo', resolve)


def config(model_id='kling-4.0'):
    return dict(kind='video', modelId=model_id, protocol='kling_video', url='https://api-beijing.klingai.com',
                apiKey='synthetic-kling-secret', authMode='bearer', connectionType='api')


def task(**changes):
    return {**dict(kind='video', id=str(uuid4()), projectId=str(uuid4()), prompt='Animate the scene', referenceIds=[],
                   videoMode='first_frame', parameters={}), **changes}


@pytest.fixture
def images(tmp_path):
    project = new_project(tmp_path)
    projects, pid, session = project
    assets = CreationToolAssets(projects)
    references = []
    for index, format in enumerate(('PNG', 'JPEG')):
        output = BytesIO()
        Image.new('RGB', (640, 640), 'blue' if index else 'red').save(output, format)
        references.append(assets.import_file(str(pid), str(uuid4()), f'image.{format.lower()}', output.getvalue(), session))
    facade = CreationGeneration(projects, ModelConfigs(tmp_path)).store
    return project, facade, references


def request_task(images, mode, roles):
    project, store, assets = images
    return task(projectId=str(project[1]), videoMode=mode, referenceIds=[assets[index]['id'] for index in range(len(roles))],
                referenceRoles=[dict(assetId=assets[index]['id'], role=role, referenceId=f'ref-{index}') for index, role in enumerate(roles)])


def test_optional_configuration_persists_native_capabilities_without_reordering_defaults(tmp_path):
    configs = ModelConfigs(tmp_path)
    previous = configs.save('video', 'http://localhost:1234/v1', 'MiniMax-H3', '', connection_type='self_hosted', protocol='vllm_omni', auth_mode='none')
    saved = configs.save('video', config()['url'], 'kling-4.0', config()['apiKey'], protocol='kling_video')
    assert [item['id'] for item in ModelConfigs(tmp_path).list()] == [previous['id'], saved['id']]
    assert 'apiKey' not in saved
    assert saved['inputRules']['profile'] == 'kling-official'
    assert saved['inputRules']['frameRoles'] == ['first_frame', 'last_frame']
    assert saved['inputRules']['allowedKinds'] == ['text', 'image']
    assert saved['inputRules']['generateAudioOptions'] == [True]
    assert saved['inputRules']['outputResolutions'] == ['720P', '1080P']
    for seconds in (3, 30):
        assert seconds in saved['inputRules']['videoCapabilities']['outputs'][0]['durations']
    with pytest.raises(ProjectError):
        configs.save('video', config()['url'], 'kling-unsupported', 'secret', protocol='kling_video')
    with pytest.raises(ProjectError):
        configs.save('video', config()['url'], 'kling-4.0', 'secret', protocol='kling_video', video_capabilities={
            'outputs': [{'resolution': '4K', 'durations': [5]}], 'defaultResolution': '4K'})
    assert len(configs.list()) == 2


@pytest.mark.anyio
async def test_catalog_is_a_supported_model_list_not_an_authentication_probe():
    def unexpected(request):
        pytest.fail('native model catalog must not query a guessed /models API')
    models = await read_service_models(config(), httpx.MockTransport(unexpected))
    assert [item['id'] for item in models] == ['kling-4.0', 'kling-4.0-flash']


def test_flash_native_capabilities_and_saved_limits(tmp_path):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('video', config()['url'], 'kling-4.0-flash', config()['apiKey'], protocol='kling_video')
    rules = saved['inputRules']
    assert rules['frameRoles'] == ['first_frame']
    assert rules['outputResolutions'] == ['720P']
    assert rules['videoCapabilities']['outputs'] == [{'resolution': '720P', 'durations': list(range(3, 21))}]
    assert rules['videoCapabilities']['defaultResolution'] == '720P'
    for resolution, seconds in [('1080P', 5), ('720P', 21)]:
        with pytest.raises(ProjectError) as failure:
            configs.save('video', config()['url'], 'kling-4.0-flash', config()['apiKey'], protocol='kling_video',
                video_capabilities={'outputs': [{'resolution': resolution, 'durations': [seconds]}],
                                    'defaultResolution': resolution, 'defaultDuration': seconds})
        assert failure.value.code == 'kling_output'
    assert len(configs.list()) == 1


@pytest.mark.parametrize(('mode', 'roles', 'route'), [
    ('first_frame', [], 'text-to-video'), ('first_frame', ['first_frame'], 'image-to-video'),
    ('reference', ['reference', 'reference'], 'omni-video'),
])
def test_flash_routes_use_model_specific_endpoint_and_output(images, mode, roles, route):
    _, store, _ = images
    adapter = KlingVideoGeneration(store)
    value = request_task(images, mode, roles)
    selected = config('kling-4.0-flash')
    prepared = adapter.prepare_inputs(value['projectId'], value, selected)
    path, payload = adapter.payload(selected, value, prepared)
    assert path == f'/{route}/kling-4.0-flash'
    assert payload['settings']['resolution'] == '720p'
    assert payload['settings']['duration'] == 5
    assert ('aspect_ratio' in payload['settings']) == (route != 'image-to-video')


def test_flash_rejects_last_frame_and_unsupported_output_before_job(images):
    project, store, _ = images
    projects, pid, session = project
    selected = config('kling-4.0-flash')
    value = request_task(images, 'first_frame', ['first_frame', 'last_frame'])
    with pytest.raises(ProjectError):
        KlingVideoGeneration(store).prepare_inputs(value['projectId'], value, selected)
    configs = ModelConfigs(projects.local.repository)
    model = configs.save('video', selected['url'], selected['modelId'], selected['apiKey'], protocol='kling_video')
    runner = CreationGeneration(projects, configs)
    for parameters in ({'resolution': '1080P'}, {'resolution': '720P', 'durationSeconds': 21}):
        command = generation_command(project, model, parameters=parameters)
        receipt = runner.prepare(command, session=session)
        assert receipt.status == 'rejected'
    assert not projects.snapshot(pid).jobs


def test_narrowed_auto_output_selects_a_real_supported_bucket():
    narrowed = {**config(), 'videoCapabilities': {'outputs': [{'resolution': '720P', 'durations': [5]}],
                'defaultResolution': 'auto', 'defaultDuration': 5}}
    assert kling_parameters(narrowed, {'resolution': 'auto'}, False)['resolution'] == '720P'
    validate_kling_prompt('a' * 26000)
    validate_kling_prompt('中' * 11000)
    with pytest.raises(ProjectError, match='提示词'):
        validate_kling_prompt('a' * 13000 + '中' * 5501)


@pytest.mark.parametrize(('mode', 'roles', 'route', 'types'), [
    ('first_frame', [], 'text-to-video', []),
    ('first_frame', ['first_frame'], 'image-to-video', ['first_frame']),
    ('first_frame', ['first_frame', 'last_frame'], 'image-to-video', ['first_frame', 'last_frame']),
    ('reference', ['reference', 'reference'], 'omni-video', ['refer_image', 'refer_image']),
])
def test_all_routes_preserve_actual_png_jpeg_bytes_and_reference_roles(images, mode, roles, route, types):
    _, store, assets = images
    adapter = KlingVideoGeneration(store)
    value = request_task(images, mode, roles)
    prepared = adapter.prepare_inputs(value['projectId'], value, config())
    path, payload = adapter.payload(config(), value, prepared)
    assert path == f'/{route}/kling-4.0'
    assert payload['settings']['duration'] == 5
    assert payload['settings']['resolution'] == '1080p'
    assert payload['options']['external_task_id'] == value['id']
    assert ('aspect_ratio' in payload['settings']) == (route != 'image-to-video')
    if route == 'text-to-video':
        assert payload['prompt'] == value['prompt'] and 'contents' not in payload
    else:
        assert [item['type'] for item in payload['contents'][1:]] == types
        for index, item in enumerate(payload['contents'][1:]):
            assert base64.b64decode(item['url'], validate=True) == store.asset(value['projectId'], assets[index]['id'])[0]


def test_inline_reference_identity_is_not_the_asset_identity(images):
    _, store, assets = images
    value = task(projectId=str(images[0][1]), videoMode='reference', referenceIds=[assets[0]['id']],
        klingReferences=[dict(assetId=assets[0]['id'], role='reference', referenceId='subject', subjectRole=role) for role in ('main', 'front')],
        klingPromptContent=[dict(type='reference', assetId=assets[0]['id'], referenceId='subject', subjectRole=role, name='same') for role in ('main', 'front')])
    prepared = KlingVideoGeneration(store).prepare_inputs(value['projectId'], value, config())
    assert prepared['prompt'] == '@image_1@image_2'
    assert [item['id'] for item in prepared['contents'][1:]] == ['image_1', 'image_2']


@pytest.mark.parametrize(('format', 'dimensions'), [('PNG', (100, 100)), ('WEBP', (640, 640))])
def test_invalid_real_image_is_rejected_before_any_job_is_created(images, format, dimensions):
    project, _, _ = images
    projects, pid, session = project
    output = BytesIO()
    Image.new('RGB', dimensions, 'blue').save(output, format)
    asset = CreationToolAssets(projects).import_file(str(pid), str(uuid4()), f'invalid.{format.lower()}', output.getvalue(), session)
    configs = ModelConfigs(projects.local.repository)
    model = configs.save('video', config()['url'], 'kling-4.0', config()['apiKey'], protocol='kling_video')
    runner = CreationGeneration(projects, configs)
    command = generation_command(project, model, parameters={'videoMode': 'reference'}, references=[asset['id']])
    receipt = runner.prepare(command, session=session)
    assert receipt.status == 'rejected' and receipt.issues[0].code == 'kling_image'
    assert not projects.snapshot(pid).jobs


@pytest.mark.parametrize(('mode', 'roles', 'code'), [
    ('first_frame', ['last_frame'], 'kling_frames'),
    ('first_frame', ['first_frame', 'first_frame'], 'kling_frames'),
    ('first_frame', ['reference', 'reference'], 'kling_frames'),
    ('reference', ['first_frame'], 'kling_mode'),
    ('continuation', [], 'kling_mode'),
])
def test_invalid_input_roles_never_reach_submission(images, mode, roles, code):
    _, store, _ = images
    value = request_task(images, mode, roles)
    with pytest.raises(ProjectError) as failure:
        KlingVideoGeneration(store).prepare_inputs(value['projectId'], value, config())
    assert failure.value.code == code


@pytest.mark.anyio
@pytest.mark.parametrize(('code', 'status', 'category'), [
    (1000, 401, 'authentication'), (1004, 200, 'authentication'), (1101, 429, 'quota'),
    (1102, 429, 'quota'), (1103, 403, 'permission'), (1300, 400, 'input'), (1301, 200, 'input'),
    (1302, 429, 'rate_limit'), (1303, 429, 'rate_limit'), (1304, 429, 'permission'),
    (5000, 500, 'temporary'), (5001, 503, 'temporary'), (5002, 504, 'temporary'),
])
async def test_business_errors_are_scoped_and_safe_even_with_http_200(code, status, category, caplog):
    caplog.set_level('DEBUG', logger='opendirector.integrations.http_settings')
    def handle(request):
        return httpx.Response(status, headers={'x-request-id': config()['apiKey']}, json={
            'code': code, 'request_id': config()['apiKey'], 'message': config()['apiKey']})
    adapter = KlingVideoGeneration(None, httpx.MockTransport(handle))
    async def submitted(identity):
        pytest.fail('rejected request cannot be accepted')
    with pytest.raises(GenerationError) as failure:
        await adapter.generate(config(), task(), submitted)
    assert failure.value.details.category == category
    assert failure.value.details.providerCode == str(code)
    assert failure.value.details.requestId is None
    assert config()['apiKey'] not in str(failure.value) + caplog.text
    if code in {1300, 1301}:
        assert '内容政策' in failure.value.details.message


@pytest.mark.anyio
@pytest.mark.parametrize(('header_id', 'body_id', 'expected_id'), [
    ('header-request', 'body-request', 'header-request'),
    (None, 'body-request', 'body-request'),
    ('header-request', None, 'header-request'),
    ('invalid request id', 'body-request', 'body-request'),
    (config()['apiKey'], config()['apiKey'], None),
])
async def test_failed_task_preserves_safe_query_request_id(header_id, body_id, expected_id, caplog):
    def handle(request):
        assert request.method == 'GET' and request.url.params['task_ids'] == 'remote-1'
        return httpx.Response(200, headers={'x-request-id': header_id} if header_id else {}, json={
            'code': 0, 'request_id': body_id, 'data': [{'id': 'remote-1', 'status': 'failed'}]})
    async def submitted(identity):
        pytest.fail('recovering the original task must not submit again')
    adapter = KlingVideoGeneration(None, httpx.MockTransport(handle), retry_delays=())
    with pytest.raises(GenerationError) as failure:
        await adapter.generate(config(), task(externalTaskId='remote-1'), submitted)
    details = failure.value.details
    assert details.requestId == expected_id
    assert details.providerCode is None
    assert details.providerStatus == 'failed' and details.stage == 'poll'
    assert details.category == 'provider'
    logged = [json.loads(record.message.removeprefix('model.error ')) for record in caplog.records
              if record.message.startswith('model.error ')]
    assert logged[-1]['request_id'] == expected_id
    assert config()['apiKey'] not in caplog.text


@pytest.mark.anyio
@pytest.mark.parametrize('resume', [False, True])
async def test_remote_identity_poll_retry_and_download_never_repeat_submission(resume):
    requests, accepted, ready = [], [], []
    queries = 0
    def handle(request):
        nonlocal queries
        requests.append(request)
        if request.method == 'POST':
            return httpx.Response(200, json={'code': 0, 'data': {'id': 'remote-1', 'status': 'submitted'}})
        if request.headers['host'] == 'cdn.example.test':
            assert 'authorization' not in request.headers
            return httpx.Response(200, content=b'mp4-result')
        assert request.url.path == '/tasks' and request.url.params['task_ids'] == 'remote-1'
        queries += 1
        if queries == 1:
            return httpx.Response(429, json={'code': 1302})
        return httpx.Response(200, json={'code': 0, 'data': [{'id': 'remote-1', 'status': 'succeeded',
            'outputs': [{'type': 'video', 'url': 'https://cdn.example.test/result.mp4'}]}]})
    async def submitted(identity): accepted.append(identity)
    async def result_ready(suffix, url): ready.append((suffix, url))
    adapter = KlingVideoGeneration(None, httpx.MockTransport(handle), poll_interval=0, retry_delays=(0,))
    result = await adapter.generate(config(), task(externalTaskId='remote-1' if resume else None), submitted, result_ready=result_ready)
    assert result == ('mp4', b'mp4-result')
    assert len(accepted) == (0 if resume else 1)
    assert sum(request.method == 'POST' for request in requests) == (0 if resume else 1)
    assert len(ready) == 1 and queries == 2


@pytest.mark.anyio
async def test_unknown_submission_is_not_retried_or_routed_elsewhere():
    calls = []
    def handle(request):
        calls.append(request)
        raise httpx.ReadTimeout('unknown', request=request)
    async def submitted(identity): pytest.fail('unknown acceptance')
    with pytest.raises(GenerationError) as failure:
        await KlingVideoGeneration(None, httpx.MockTransport(handle)).generate(config(), task(), submitted)
    assert failure.value.details.category == 'submission_unknown'
    assert len(calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize('remote', [
    {'id': 'wrong', 'status': 'processing'}, {'id': 'remote-1', 'status': 'mystery'},
    {'id': 'remote-1', 'status': 'succeeded', 'outputs': []},
    {'id': 'remote-1', 'status': 'succeeded', 'outputs': [{'type': 'video', 'url': 'http://unsafe.test/video'}]},
])
async def test_malformed_task_or_result_never_reports_success(remote):
    adapter = KlingVideoGeneration(None, httpx.MockTransport(lambda request: httpx.Response(200, json={'code': 0, 'data': [remote]})), retry_delays=())
    async def submitted(identity): pytest.fail('resume must not submit')
    with pytest.raises(GenerationError):
        await adapter.generate(config(), task(externalTaskId='remote-1'), submitted)


@pytest.fixture(scope='module')
def video_bytes(tmp_path_factory):
    path = tmp_path_factory.mktemp('kling-media') / 'output.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=640x640:r=24',
                    '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)], check=True)
    return path.read_bytes()


@pytest.mark.anyio
@pytest.mark.parametrize('changed_intent', [False, True])
@pytest.mark.parametrize('model_id', ['kling-4.0', 'kling-4.0-flash'])
@pytest.mark.parametrize(('mode', 'roles', 'route'), [
    ('first_frame', [], 'text-to-video'), ('first_frame', ['first_frame'], 'image-to-video'),
    ('first_frame', ['first_frame', 'last_frame'], 'image-to-video'),
    ('reference', ['reference', 'reference'], 'omni-video'),
])
async def test_shared_job_acceptance_snapshots_all_modes_and_adopts_real_media(images, video_bytes, mode, roles, route, changed_intent, model_id):
    project, _, assets = images
    projects, pid, session = project
    configs = ModelConfigs(projects.local.repository)
    model = configs.save('video', config()['url'], model_id, config()['apiKey'], protocol='kling_video')
    runner = CreationGeneration(projects, configs)
    spec_id, item_id = uuid4(), uuid4()
    receipt = send(projects, pid, 'canvas.createGeneration', session=session,
        spec=dict(id=spec_id, projectId=pid, kind='video', purpose='generation', modelConfigId=model['id'], prompt='Animate',
                  parameters=dict(videoMode=mode, durationSeconds=3, resolution='720P' if model_id == 'kling-4.0-flash' else '1080P')),
        item=dict(id=item_id, projectId=pid, kind='video', binding=dict(role='generation', objectRef=dict(id=spec_id))),
        references=[dict(id=uuid4(), projectId=pid, targetSpecId=spec_id, binding='pinned', role=role, order=index,
                        source=dict(assetId=assets[index]['id'], revision=1, fingerprint=assets[index]['fingerprint'], kind='image')) for index, role in enumerate(roles)])
    assert receipt.status == 'applied', receipt
    before = projects.snapshot(pid)
    spec, item = before.generationSpecs[-1], before.canvasItems[-1]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
    accepted = runner.prepare(command, session=session, source='agent')
    if model_id == 'kling-4.0-flash' and 'last_frame' in roles:
        assert accepted.status == 'rejected'
        assert not projects.snapshot(pid).jobs
        return
    assert accepted.status == 'accepted', accepted
    job = projects.snapshot(pid).jobs[-1]
    assert job.adapterParameters['route'] == f'/{route}/{model_id}'
    assert job.adapterParameters['audio'] == 'native' and job.execution.generateAudio
    assert job.inputSnapshot.model.protocol == 'kling_video'
    assert runner.prepare(command, session=session) == accepted
    if changed_intent:
        current_spec = projects.snapshot(pid).generationSpecs[-1]
        edited = current_spec.model_copy(update={'prompt': 'User edited the scene'})
        receipt = send(projects, pid, 'generationSpec.update', session=session,
                       versions=[ver('generation_spec', current_spec)], spec=edited)
        assert receipt.status == 'applied', receipt
    calls = []
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            assert request.url.path == job.adapterParameters['route']
            assert 'Animate' in request.content.decode() and 'User edited' not in request.content.decode()
            return httpx.Response(200, json={'code': 0, 'data': {'id': 'remote-1', 'status': 'submitted'}})
        if request.headers['host'] == 'cdn.example.test':
            assert 'authorization' not in request.headers
            return httpx.Response(200, content=video_bytes)
        return httpx.Response(200, json={'code': 0, 'data': [{'id': 'remote-1', 'status': 'succeeded',
            'outputs': [{'type': 'video', 'url': 'https://cdn.example.test/video.mp4'}]}]})
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), poll_interval=0)
    try:
        await runner.execute(command, session=session)
        await asyncio.gather(*(worker.future for worker in list(runner.jobs.values())))
        current = projects.snapshot(pid)
        completed = current.jobs[-1]
        assert completed.status == 'succeeded', completed
        assert completed.adopted == (not changed_intent)
        assert current.generationSpecs[-1].prompt == ('User edited the scene' if changed_intent else 'Animate')
        assert current.results[-1].jobId == job.id
        assert current.assets[-1].metadata.width == 640
        assert sum(request.method == 'POST' for request in calls) == 1
    finally:
        await runner.close()


@pytest.mark.anyio
@pytest.mark.parametrize('failure_stage', ['submit', 'poll', 'download'])
async def test_restart_recovers_original_task_or_requires_review_without_reposting(tmp_path, video_bytes, failure_stage):
    project = new_project(tmp_path)
    projects, pid, session = project
    configs = ModelConfigs(tmp_path)
    model = configs.save('video', config()['url'], 'kling-4.0', config()['apiKey'], protocol='kling_video')
    calls, healthy = [], False
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            if failure_stage == 'submit' and not healthy:
                raise httpx.ReadTimeout('unknown submission', request=request)
            return httpx.Response(200, json={'code': 0, 'data': {'id': 'original-task', 'status': 'submitted'}})
        if request.headers['host'] == 'cdn.example.test':
            assert 'authorization' not in request.headers
            if failure_stage == 'download' and not healthy:
                raise httpx.ReadTimeout('download interrupted', request=request)
            return httpx.Response(200, content=video_bytes)
        assert request.url.params['task_ids'] == 'original-task'
        if failure_stage == 'poll' and not healthy:
            return httpx.Response(503, json={'code': 5001})
        return httpx.Response(200, json={'code': 0, 'data': [{'id': 'original-task', 'status': 'succeeded',
            'outputs': [{'type': 'video', 'url': 'https://cdn.example.test/video.mp4?signature=private-download'}]}]})
    first = CreationGeneration(projects, configs)
    provider = GenerationProviders(first.store, httpx.MockTransport(handle), poll_interval=0, retry_delays=(0,))
    first.provider = provider
    task_value, pinned, private = prepare_command(first, project, model, parameters={'durationSeconds': 3})
    first._launch(task_value, pinned, private)
    await settled(first)
    state = projects.snapshot(pid).jobs[-1]
    assert state.recovery == ('review' if failure_stage == 'submit' else 'remote')
    assert 'private-download' not in projects.snapshot(pid).model_dump_json()
    await first.close()
    healthy = True
    restarted = CreationGeneration(projects, configs, provider)
    try:
        await restarted.start()
        await restarted.recover(pid, task_value['id'])
        await settled(restarted)
        current = projects.snapshot(pid)
        if failure_stage == 'submit':
            assert current.jobs[-1].status == 'interrupted'
            assert not current.jobs[-1].resumeAllowed and not current.assets
        else:
            assert current.jobs[-1].status == 'succeeded' and current.jobs[-1].adopted
            assert len(current.results) == len(current.assets) == 1
        assert sum(request.method == 'POST' for request in calls) == 1
    finally:
        await restarted.close()


@pytest.mark.anyio
async def test_queued_execution_uses_frozen_parameters_after_capability_edits(tmp_path, video_bytes):
    project = new_project(tmp_path)
    projects, pid, session = project
    configs = ModelConfigs(tmp_path)
    model = configs.save('video', config()['url'], 'kling-4.0', config()['apiKey'], protocol='kling_video')
    runner = CreationGeneration(projects, configs)
    task_value, pinned, private = prepare_command(runner, project, model,
        parameters={'resolution': '1080P', 'durationSeconds': 3})
    configs.save('video', config()['url'], 'kling-4.0', '', model['id'], protocol='kling_video',
        video_capabilities={'outputs': [{'resolution': '720P', 'durations': [5]}],
                            'defaultResolution': '720P', 'defaultDuration': 5})
    calls = []
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            assert json.loads(request.content)['settings'] == dict(resolution='1080p', duration=3, aspect_ratio='16:9')
            return httpx.Response(200, json={'code': 0, 'data': {'id': 'frozen', 'status': 'submitted'}})
        if request.headers['host'] == 'cdn.example.test':
            return httpx.Response(200, content=video_bytes)
        return httpx.Response(200, json={'code': 0, 'data': [{'id': 'frozen', 'status': 'succeeded',
            'outputs': [{'type': 'video', 'url': 'https://cdn.example.test/result.mp4'}]}]})
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), poll_interval=0)
    try:
        await runner.start()
        await settled(runner)
        assert projects.snapshot(pid).jobs[-1].status == 'succeeded'
        assert sum(request.method == 'POST' for request in calls) == 1
    finally:
        await runner.close()


def test_response_logs_filter_echoed_keys_on_api_and_unauthenticated_cdn(caplog):
    from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS
    caplog.set_level('DEBUG', logger='opendirector.integrations.http_settings')
    async def run():
        key = config()['apiKey']
        def handle(request):
            return httpx.Response(200, headers={'x-request-id': 'echo-' + key}, content=b'video')
        adapter = KlingVideoGeneration(None, httpx.MockTransport(handle))
        assert await adapter.resume_result(config(), 'mp4', 'https://cdn.example.test/video') == ('mp4', b'video')
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=httpx.MockTransport(handle)) as client:
            await client.post(config()['url'], headers={'Authorization': 'Bearer ' + key},
                              json={'prompt': 'echo ' + key, 'contents': [{'type': 'refer_image', 'url': 'sensitive-base64-image'}]})
    asyncio.run(run())
    assert config()['apiKey'] not in caplog.text
    assert 'sensitive-base64-image' not in caplog.text
