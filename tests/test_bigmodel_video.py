"""CogVideoX-3 wire contracts and durable jobs; all HTTP is mocked."""
import asyncio
import base64
from io import BytesIO
import json
import logging
import subprocess
from uuid import uuid4

import httpx
from PIL import Image
import pytest

from opendirector.agent.tools import AgentTools
from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.domain.bigmodel_video import COGVIDEO_SIZES, cogvideo_parameters
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.generation import GenerationError
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.bigmodel_video import BigModelVideoGeneration
from opendirector.integrations.model_capabilities import read_service_models
from opendirector.integrations.providers import GenerationProviders
from generation_helpers import command, new_project, prepared, settled
from test_creation_canvas_service import send, ver

SECRET = 'synthetic-bigmodel-video-secret'
URL = 'https://cdn.test/video.mp4?signature=private-result'
CONFIG = dict(kind='video', modelId='cogvideox-3', protocol='bigmodel_video',
              url='https://open.bigmodel.cn/api/paas/v4', apiKey=SECRET, authMode='bearer', connectionType='api')


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture(autouse=True)
def cdn(public_cdn):
    pass


def task(**changes):
    return {**dict(id=str(uuid4()), kind='video', projectId=str(uuid4()), prompt='A moving blue sphere',
                   referenceIds=[], videoMode='first_frame', parameters={}), **changes}


@pytest.fixture
def images(tmp_path):
    project = new_project(tmp_path)
    projects, pid, session = project
    assets = []
    for color, fmt in [('red', 'PNG'), ('blue', 'JPEG')]:
        output = BytesIO()
        Image.new('RGB', (640, 360), color).save(output, fmt)
        assets.append(CreationToolAssets(projects).import_file(str(pid), str(uuid4()), 'frame.' + fmt.lower(), output.getvalue(), session))
    return project, CreationGeneration(projects, ModelConfigs(tmp_path)).store, assets


@pytest.fixture(scope='module')
def video_bytes(tmp_path_factory):
    path = tmp_path_factory.mktemp('cogvideo') / 'output.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=640x360:r=30',
                    '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)], check=True)
    return path.read_bytes()


def saved(configs):
    return configs.save('video', CONFIG['url'], CONFIG['modelId'], SECRET, protocol='bigmodel_video')


def test_model_configuration_and_native_limits(tmp_path):
    configs = ModelConfigs(tmp_path)
    model = saved(configs)
    assert 'apiKey' not in model
    rules = model['inputRules']
    assert rules['profile'] == 'bigmodel-cogvideox-3'
    assert rules['maxImages'] == 2 and rules['frameRoles'] == ['first_frame', 'last_frame']
    assert rules['allowedKinds'] == ['text', 'image'] and rules['generateAudioOptions'] == [True, False]
    assert rules['outputResolutions'] == [size.upper() for size in COGVIDEO_SIZES]
    assert ModelConfigs(tmp_path).list()[0]['inputRules'] == rules
    with pytest.raises(ProjectError):
        configs.save('video', CONFIG['url'], 'cogvideox-2', SECRET, protocol='bigmodel_video')
    with pytest.raises(ProjectError):
        configs.save('video', CONFIG['url'], 'cogvideox-3', SECRET, protocol='bigmodel_video', video_capabilities={
            'outputs': [{'resolution': '8K', 'durations': [5]}], 'defaultResolution': '8K'})


@pytest.mark.parametrize('size', COGVIDEO_SIZES)
@pytest.mark.parametrize('duration', [5, 10])
def test_supported_pixel_sizes_and_durations(size, duration):
    value = cogvideo_parameters(CONFIG, dict(resolution=size.upper(), durationSeconds=duration, generateAudio=False))
    assert value['size'] == size and value['duration'] == duration and not value['generate_audio']


@pytest.mark.anyio
async def test_model_catalog_does_not_make_a_paid_probe():
    models = await read_service_models(CONFIG, httpx.MockTransport(lambda _: pytest.fail('No catalog request expected')))
    assert [m['id'] for m in models] == ['cogvideox-3']


@pytest.mark.parametrize('roles', [[], ['reference'], ['last_frame', 'first_frame']])
def test_modes_send_project_bytes_with_first_then_last_order(images, roles):
    project, store, assets = images
    value = task(projectId=str(project[1]), referenceIds=[a['id'] for a in assets[:len(roles)]],
                 referenceRoles=[dict(assetId=assets[i]['id'], role=role) for i, role in enumerate(roles)])
    adapter = BigModelVideoGeneration(store)
    data = adapter.prepare_inputs(value['projectId'], value, CONFIG)
    payload = adapter.payload(CONFIG, value, data)
    assert payload['request_id'] == value['id']
    assert set(payload) <= {'model', 'prompt', 'size', 'duration', 'fps', 'quality', 'with_audio', 'watermark_enabled', 'request_id', 'image_url'}
    if not roles:
        assert 'image_url' not in payload
    else:
        actual = [payload['image_url']] if len(roles) == 1 else payload['image_url']
        ordered = [0] if len(roles) == 1 else [1, 0]
        for wire, index in zip(actual, ordered):
            assert base64.b64decode(wire.split(',', 1)[1]) == store.asset(value['projectId'], assets[index]['id'])[0]


@pytest.mark.parametrize('roles', [['last_frame'], ['first_frame', 'first_frame'], ['reference', 'reference']])
def test_ambiguous_or_missing_frame_order_is_rejected(images, roles):
    project, store, assets = images
    value = task(projectId=str(project[1]), referenceIds=[a['id'] for a in assets[:len(roles)]],
                 referenceRoles=[dict(assetId=assets[i]['id'], role=role) for i, role in enumerate(roles)])
    with pytest.raises(ProjectError):
        BigModelVideoGeneration(store).prepare_inputs(value['projectId'], value, CONFIG)


@pytest.mark.parametrize('parameters', [dict(durationSeconds=6), dict(resolution='720P'), dict(aspectRatio='16:9')])
def test_invalid_intent_never_creates_a_job(tmp_path, parameters):
    project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    runner = CreationGeneration(project[0], configs)
    request = command(project, saved(configs), parameters=parameters)
    before = project[0].snapshot(project[1])
    receipt = runner.prepare(request, session=project[2])
    assert receipt.status == 'rejected' and project[0].snapshot(project[1]) == before


def test_long_prompt_and_unsupported_real_image_rejected_before_submit(images):
    project, store, assets = images
    adapter = BigModelVideoGeneration(store)
    with pytest.raises(ProjectError):
        adapter.prepare_inputs(str(project[1]), task(prompt='x' * 513), CONFIG)
    output = BytesIO()
    Image.new('RGB', (32, 32), 'red').save(output, 'WEBP')
    asset = CreationToolAssets(project[0]).import_file(str(project[1]), str(uuid4()), 'bad.webp', output.getvalue(), project[2])
    configs = ModelConfigs(project[0].local.repository)
    runner = CreationGeneration(project[0], configs)
    request = command(project, saved(configs), references=[asset['id']])
    snapshot = project[0].snapshot(project[1])
    reference = snapshot.references[-1]
    assert send(project[0], project[1], 'reference.update', session=project[2],
        versions=[ver('reference', reference)], reference=reference.model_copy(update={'role': 'first_frame'})).status == 'applied'
    snapshot = project[0].snapshot(project[1])
    request = request.model_copy(update={'expectedVersions': tuple(type(request.expectedVersions[0]).model_validate(value)
        for value in [ver('generation_spec', snapshot.generationSpecs[-1]), ver('canvas_item', snapshot.canvasItems[-1])])})
    receipt = runner.prepare(request, session=project[2])
    assert receipt.status == 'rejected' and not project[0].snapshot(project[1]).jobs


@pytest.mark.anyio
async def test_poll_retry_and_download_use_saved_id_without_reposting():
    calls, ids, checkpoints = [], [], []
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            return httpx.Response(200, json={'id': 'remote-1', 'task_status': 'PROCESSING'})
        if request.headers['host'] == 'cdn.test':
            assert 'authorization' not in request.headers
            return httpx.Response(200, content=b'video')
        assert request.url.path == '/api/paas/v4/async-result/remote-1'
        if len([r for r in calls if 'async-result' in r.url.path]) == 1:
            return httpx.Response(503, json={'error': {'code': '500'}})
        return httpx.Response(200, json={'task_status': 'SUCCESS', 'video_result': [{'url': URL}]})
    async def submitted(value): ids.append(value)
    async def ready(suffix, url): checkpoints.append((suffix, url))
    result = await BigModelVideoGeneration(None, httpx.MockTransport(handle), 0, (0,)).generate(CONFIG, task(), submitted, result_ready=ready)
    assert result == ('mp4', b'video') and ids == ['remote-1'] and checkpoints == [('mp4', URL)]
    assert sum(r.method == 'POST' for r in calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize('status', ['FAIL', 'MYSTERY', 'SUCCESS'])
async def test_failed_or_malformed_task_preserves_original_identity(status):
    async def submitted(_): pytest.fail('Resume must not submit')
    adapter = BigModelVideoGeneration(None, httpx.MockTransport(lambda _: httpx.Response(200,
        json={'task_status': status, 'video_result': []})), retry_delays=())
    with pytest.raises(GenerationError) as error:
        await adapter.generate(CONFIG, task(externalTaskId='original'), submitted)
    assert error.value.details.providerStatus == ('failed' if status == 'FAIL' else None)


@pytest.mark.anyio
@pytest.mark.parametrize('failure_stage', ['submit', 'poll', 'download'])
async def test_restart_preserves_unknown_submission_or_recovers_original_task(tmp_path, video_bytes, failure_stage):
    project = new_project(tmp_path)
    projects, pid, session = project
    configs = ModelConfigs(tmp_path)
    model = saved(configs)
    calls, healthy = [], False
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            if failure_stage == 'submit' and not healthy:
                raise httpx.ReadTimeout('unknown', request=request)
            return httpx.Response(200, json={'id': 'original-task', 'task_status': 'PROCESSING'})
        if request.headers['host'] == 'cdn.test':
            assert 'authorization' not in request.headers
            if failure_stage == 'download' and not healthy:
                raise httpx.ReadTimeout('interrupted', request=request)
            return httpx.Response(200, content=video_bytes)
        assert request.url.path.endswith('/async-result/original-task')
        if failure_stage == 'poll' and not healthy:
            raise httpx.ReadTimeout('interrupted', request=request)
        return httpx.Response(200, json={'task_status': 'SUCCESS', 'video_result': [{'url': URL}]})
    first = CreationGeneration(projects, configs)
    first.provider = GenerationProviders(first.store, httpx.MockTransport(handle), 0, ())
    value, pinned, private = prepared(first, project, model)
    first._launch(value, pinned, private)
    await settled(first)
    job = projects.snapshot(pid).jobs[-1]
    assert job.recovery == ('review' if failure_stage == 'submit' else 'remote')
    assert job.externalTaskId == (None if failure_stage == 'submit' else 'original-task')
    await first.close()
    healthy = True
    reopened = CreationProjects(LocalProjects(tmp_path))
    restarted = CreationGeneration(reopened, ModelConfigs(tmp_path))
    restarted.provider = GenerationProviders(restarted.store, httpx.MockTransport(handle), 0, ())
    try:
        await restarted.start()
        await restarted.recover(pid, value['id'])
        await settled(restarted)
        current = reopened.snapshot(pid)
        assert sum(r.method == 'POST' for r in calls) == 1
        assert SECRET not in current.model_dump_json() and 'private-result' not in current.model_dump_json()
        if failure_stage == 'submit':
            assert not current.assets and not current.jobs[-1].resumeAllowed
        else:
            assert current.jobs[-1].status == 'succeeded' and current.jobs[-1].adopted
            assert len(current.results) == len(current.assets) == 1
    finally:
        await restarted.close()


@pytest.mark.anyio
@pytest.mark.parametrize('source', ['ui', 'agent'])
@pytest.mark.parametrize('roles', [[], ['first_frame'], ['last_frame', 'first_frame']])
async def test_all_modes_register_candidates_adopt_and_reopen(images, video_bytes, source, roles):
    project, _, assets = images
    projects, pid, session = project
    configs = ModelConfigs(projects.local.repository)
    model = saved(configs)
    spec_id, item_id = uuid4(), uuid4()
    receipt = send(projects, pid, 'canvas.createGeneration', session=session,
        spec=dict(id=spec_id, projectId=pid, kind='video', purpose='generation', modelConfigId=model['id'], prompt='Animate the sphere',
                  parameters=dict(resolution='1280X720', generateAudio=False)),
        item=dict(id=item_id, projectId=pid, kind='video', binding=dict(role='generation', objectRef=dict(id=spec_id))),
        references=[dict(id=uuid4(), projectId=pid, targetSpecId=spec_id, binding='pinned', role=role, order=index,
                        source=dict(assetId=assets[index]['id'], revision=1, fingerprint=assets[index]['fingerprint'], kind='image'))
                    for index, role in enumerate(roles)])
    assert receipt.status == 'applied', receipt
    runner = CreationGeneration(projects, configs)
    calls = []
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            payload = json.loads(request.content)
            assert payload['size'] == '1280x720' and payload['with_audio'] is False
            return httpx.Response(200, json={'id': 'candidate-job', 'task_status': 'PROCESSING'})
        if request.headers['host'] == 'cdn.test':
            return httpx.Response(200, content=video_bytes)
        return httpx.Response(200, json={'task_status': 'SUCCESS', 'video_result': [{'url': URL}]})
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), 0, ())
    business = AgentTools(projects, runner, configs)
    async def execute(kind, payload, versions):
        if source == 'agent':
            return await business.execute(pid, uuid4(), session, str(uuid4()), 'execute_command',
                dict(type=kind, payload=payload, expectedVersions=versions), [], None)
        request = parse_command(dict(commandId=uuid4(), projectId=pid, type=kind, expectedVersions=versions, payload=payload))
        result = await runner.execute(request, session=session) if kind == 'generation.submit' else projects.execute(request, session=session)
        return result.model_dump(mode='json')
    try:
        snapshot = projects.snapshot(pid)
        spec, item = snapshot.generationSpecs[-1], snapshot.canvasItems[-1]
        accepted = await execute('generation.submit', dict(specId=str(spec.id), expectedSpecRevision=spec.revision,
            originItemId=str(item.id), adoptionPolicy='candidate_only'), [ver('generation_spec', spec), ver('canvas_item', item)])
        assert accepted['status'] == 'accepted', accepted
        await settled(runner)
        snapshot = projects.snapshot(pid)
        job = snapshot.jobs[-1]
        assert job.status == 'succeeded' and not job.adopted and snapshot.generationSpecs[-1].currentResultId is None
        assert job.execution.size == '1280x720' and job.execution.fps == 30
        adopted = await execute('result.select', dict(specId=str(spec.id), resultId=str(snapshot.results[-1].id)),
            [ver('generation_spec', snapshot.generationSpecs[-1]), ver('canvas_item', snapshot.canvasItems[-1])])
        assert adopted['status'] == 'applied', adopted
        snapshot = projects.snapshot(pid)
        assert snapshot.generationSpecs[-1].currentResultId == snapshot.results[-1].id
        with CreationAssets(projects).open_media(pid, job.asset.assetId)[0] as stream:
            assert stream.read() == video_bytes
        assert CreationProjects(LocalProjects(projects.local.repository)).snapshot(pid) == snapshot
        assert sum(r.method == 'POST' for r in calls) == 1
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_accepted_job_keeps_output_settings_after_model_capabilities_change(tmp_path, video_bytes):
    project = new_project(tmp_path)
    projects, pid, session = project
    configs = ModelConfigs(tmp_path)
    model = saved(configs)
    runner = CreationGeneration(projects, configs)
    value, _, _ = prepared(runner, project, model,
        parameters=dict(resolution='1280X720', durationSeconds=5, generateAudio=False))
    frozen = projects.snapshot(pid).jobs[-1]
    configs.save('video', CONFIG['url'], CONFIG['modelId'], '', model['id'], protocol='bigmodel_video',
        video_capabilities=dict(outputs=[dict(resolution='1024X1024', durations=[10])],
                                defaultResolution='1024X1024', defaultDuration=10))
    calls = []
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            payload = json.loads(request.content)
            assert (payload['size'], payload['duration'], payload['with_audio'], payload['fps'], payload['quality']) == (
                '1280x720', 5, False, 30, 'speed')
            assert payload['watermark_enabled'] == frozen.execution.watermark
            return httpx.Response(200, json={'id': 'frozen-task', 'task_status': 'PROCESSING'})
        if request.headers['host'] == 'cdn.test':
            return httpx.Response(200, content=video_bytes)
        return httpx.Response(200, json={'task_status': 'SUCCESS', 'video_result': [{'url': URL}]})
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), 0, ())
    try:
        await runner.start()
        await settled(runner)
        assert projects.snapshot(pid).jobs[-1].status == 'succeeded'
        assert sum(r.method == 'POST' for r in calls) == 1
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_cdn_redirect_blocks_private_network_and_omits_credentials(caplog):
    caplog.set_level(logging.DEBUG, logger='opendirector.integrations.http_settings')
    calls = []
    def handle(request):
        calls.append(request)
        assert 'authorization' not in request.headers
        return httpx.Response(302, headers={'location': 'http://127.0.0.1/private', 'x-request-id': SECRET})
    with pytest.raises(GenerationError):
        await BigModelVideoGeneration(None, httpx.MockTransport(handle), retry_delays=()).resume_result(CONFIG, 'mp4', URL)
    assert len(calls) == 1 and SECRET not in caplog.text
