"""MAGI-2 capabilities, exact requests and durable shared project jobs."""
import asyncio
import hashlib
from io import BytesIO
import json
import socket
import subprocess
from uuid import uuid4

import httpx
from PIL import Image
import pytest

from opendirector.agent.tools import AgentTools
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.generation import GenerationError
from opendirector.domain.higgsfield import BASE, MODEL, parameters
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.generation_results import GenerationResults
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.higgsfield_open import HiggsfieldOpenGeneration
from opendirector.integrations.model_capabilities import read_service_models
from opendirector.integrations.providers import GenerationProviders
from generation_helpers import cancel, command as generation_command, new_project, settled
from test_creation_canvas_service import send, ver


pytestmark = pytest.mark.cpu


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture(autouse=True)
def public_cdn(monkeypatch):
    lookup = socket.getaddrinfo

    def resolve(host, port, *args, **kwargs):
        if host in {'upload.example.test', 'cdn.example.test'}:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', port))]
        return lookup(host, port, *args, **kwargs)

    monkeypatch.setattr(socket, 'getaddrinfo', resolve)


def config():
    return dict(kind='video', modelId=MODEL, protocol='higgsfield_open', url=BASE,
                apiKey='synthetic-id:synthetic-secret', authMode='bearer', connectionType='api')


def task(**changes):
    value = {**dict(kind='video', id=str(uuid4()), projectId=str(uuid4()), prompt='Animate the scene',
                   referenceIds=[], videoMode='first_frame'), **changes}
    value.setdefault('parameters', parameters(config(), {}, value['videoMode'], bool(value['referenceIds'])))
    return value


class Media:
    def __init__(self):
        self.items = {}

    def add(self, kind='image', *, mime=None, seconds=3, data=None):
        if kind == 'image' and data is None:
            stream = BytesIO()
            Image.new('RGB', (64, 64), 'red').save(stream, 'PNG')
            data = stream.getvalue()
        data = data if data is not None else b'fixture-media'
        identity = str(uuid4())
        self.items[identity] = (data, dict(id=identity, kind=kind, name=kind,
            fingerprint='sha256:' + hashlib.sha256(data).hexdigest(), durationMs=seconds * 1000,
            type=mime or {'image': 'image/png', 'video': 'video/mp4', 'audio': 'audio/wav', 'text': 'text/plain'}[kind]))
        return identity

    def asset(self, project, identity):
        return self.items[identity]


def accepted():
    return dict(request_id='remote-1', status='queued', status_url=BASE + '/returned/status/remote-1',
                cancel_url=BASE + '/returned/cancel/remote-1')


def complete():
    return dict(request_id='remote-1', status='completed', video={'url': 'https://cdn.example.test/result.mp4?signature=private'})


class Cloud:
    def __init__(self, output=b'mp4-result'):
        self.requests, self.output = [], output
        self.uploads = 0

    def __call__(self, request):
        self.requests.append(request)
        if request.headers['host'] in {'upload.example.test', 'cdn.example.test'}:
            assert 'authorization' not in request.headers
            assert 'idempotency-key' not in request.headers
            if request.method == 'PUT':
                assert request.headers['x-amz-tagging'] == 'source=fixture'
                return httpx.Response(200)
            return httpx.Response(200, content=self.output)
        assert request.headers['authorization'] == 'Key ' + config()['apiKey']
        if request.url.path == '/files/generate-upload-url':
            self.uploads += 1
            return httpx.Response(200, json=dict(upload_url=f'https://upload.example.test/{self.uploads}?signature=private',
                public_url=f'https://cdn.example.test/input-{self.uploads}', upload_headers={'x-amz-tagging': 'source=fixture'}))
        if request.method == 'POST':
            assert request.url.path.startswith('/sand/magi-2/')
            return httpx.Response(202, json=accepted())
        assert str(request.url) == accepted()['status_url']
        return httpx.Response(200, json=complete())


async def ignore_submitted(identity):
    assert identity == 'remote-1'


def test_magi2_connection_exposes_three_modes_with_native_limits(tmp_path):
    configs = ModelConfigs(tmp_path)
    row = configs.save('video', 'https://api.higgsfield.ai', 'sand/magi-2',
                       'synthetic-id:synthetic-secret', protocol='higgsfield_open')
    assert 'apiKey' not in row
    rules = row['inputRules']
    assert rules['profile'] == 'higgsfield-magi-2'
    assert rules['videoModes'] == ['first_frame', 'reference']
    assert rules['allowedKinds'] == ['text', 'image', 'video', 'audio']
    assert (rules['maxImages'], rules['maxVideos'], rules['maxAudios']) == (10, 5, 5)
    assert rules['generateAudioOptions'] == [True, False]
    assert rules['videoCapabilities']['outputs'] == [{'resolution': '1080P', 'durations': list(range(4, 31))}]
    assert rules['videoCapabilities']['defaultDuration'] == 5
    assert rules['referenceMediaSeconds'] == 30
    assert rules['referenceMediaMinSeconds'] == 2
    assert rules['audioBytes'] == 15 * 1024 * 1024
    assert len(ModelConfigs(tmp_path).list()) == 1


@pytest.mark.anyio
async def test_catalog_does_not_claim_to_validate_credentials():
    def unexpected(request):
        pytest.fail('Higgsfield has no model-discovery endpoint in this integration')
    rows = await read_service_models(config(), httpx.MockTransport(unexpected))
    assert [row['id'] for row in rows] == [MODEL]


@pytest.mark.parametrize('intent', [
    {'durationSeconds': 3}, {'durationSeconds': 31}, {'durationSeconds': 4.5},
    {'resolution': '720P'}, {'aspectRatio': 'adaptive'}, {'generateAudio': 'false'},
])
def test_native_output_rejects_unsupported_parameters(intent):
    with pytest.raises(ProjectError):
        parameters(config(), intent, 'first_frame', False)


@pytest.mark.parametrize(('mode', 'kinds', 'roles', 'route'), [
    ('first_frame', [], [], 'text-to-video'),
    ('first_frame', ['image'], ['first_frame'], 'image-to-video'),
    ('first_frame', ['image', 'image'], ['first_frame', 'last_frame'], 'image-to-video'),
    ('reference', ['image'], ['reference'], 'reference-to-video'),
    ('reference', ['image', 'video', 'audio'], ['reference'] * 3, 'reference-to-video'),
    ('reference', ['audio'], ['reference'], 'reference-to-video'),
])
@pytest.mark.anyio
async def test_exact_routes_upload_bytes_and_audio_choice(tmp_path, mode, kinds, roles, route):
    media, cloud = Media(), Cloud()
    ids = [media.add(kind) for kind in kinds]
    value = task(videoMode=mode, referenceIds=ids, prompt='Animate' if not ids else '',
                 referenceRoles=[dict(assetId=key, role=role) for key, role in zip(ids, roles, strict=True)])
    value['parameters']['generate_audio'] = False
    cache = GenerationResults(tmp_path, value['id'])
    adapter = HiggsfieldOpenGeneration(media, httpx.MockTransport(cloud), poll_interval=0)
    result = await adapter.generate(config(), value, ignore_submitted, recovery_cache=cache)
    assert result == ('mp4', cloud.output)
    submission = next(r for r in cloud.requests if r.url.path.startswith('/sand/magi-2/'))
    assert submission.url.path == '/sand/magi-2/' + route
    assert submission.headers['Idempotency-Key'] == value['id']
    payload = json.loads(submission.content)
    assert payload['generate_audio'] is False
    assert (payload['duration'], payload['resolution'], payload['aspect_ratio']) == (5, '1080p', '16:9')
    assert ('prompt' in payload) == (not ids)
    uploads = [r for r in cloud.requests if r.method == 'PUT']
    assert [r.content for r in uploads] == [media.items[key][0] for key in ids]
    if route == 'image-to-video':
        assert payload['image_url'] == 'https://cdn.example.test/input-1'
        assert ('end_image_url' in payload) == (len(ids) == 2)
    elif ids:
        for index, kind in enumerate(kinds, 1):
            assert payload[kind + '_urls'] == [f'https://cdn.example.test/input-{index}']
    saved = cache.submission()
    assert saved['payload'] == payload and saved['remote']['status_url'] == accepted()['status_url']
    assert config()['apiKey'] not in json.dumps(saved)


@pytest.mark.parametrize(('kind', 'mime', 'seconds', 'code'), [
    ('audio', 'audio/mpeg', 3, 'higgsfield_format'),
    ('video', 'video/quicktime', 3, 'higgsfield_format'),
    ('audio', 'audio/wav', 1.99, 'higgsfield_duration'),
    ('video', 'video/mp4', 30.01, 'higgsfield_duration'),
])
def test_formats_and_clip_limits_reject_before_upload(kind, mime, seconds, code):
    media = Media()
    value = task(videoMode='reference', referenceIds=[media.add(kind, mime=mime, seconds=seconds)])
    with pytest.raises(ProjectError) as failure:
        HiggsfieldOpenGeneration(media).prepare_inputs(value['projectId'], value, config())
    assert failure.value.code == code


def test_aggregate_durations_are_separate_and_prompt_is_not_truncated():
    media = Media()
    ids = [media.add('video', seconds=30), media.add('audio', seconds=30)]
    adapter = HiggsfieldOpenGeneration(media)
    value = task(videoMode='reference', referenceIds=ids, prompt='中' * 15000)
    assert adapter.prepare_inputs(value['projectId'], value, config())['prompt'] == value['prompt']
    with pytest.raises(ProjectError, match='15,000'):
        adapter.prepare_inputs(value['projectId'], {**value, 'prompt': value['prompt'] + '字'}, config())
    value['referenceIds'] = ids + [media.add('video', seconds=2)]
    with pytest.raises(ProjectError) as failure:
        adapter.prepare_inputs(value['projectId'], value, config())
    assert failure.value.code == 'higgsfield_duration'


def test_repeated_asset_references_keep_valid_roles():
    media = Media()
    identity = media.add()
    adapter = HiggsfieldOpenGeneration(media)
    value = task(videoMode='reference', referenceIds=[identity],
        referenceRoles=[dict(assetId=identity, role='reference')] * 2)
    assert len(adapter.prepare_inputs(value['projectId'], value, config())['media']) == 1
    value.update(videoMode='first_frame', referenceRoles=[dict(assetId=identity, role='first_frame')] * 2)
    with pytest.raises(ProjectError) as failure:
        adapter.prepare_inputs(value['projectId'], value, config())
    assert failure.value.code == 'higgsfield_frames'


@pytest.mark.anyio
async def test_unknown_submission_reuses_exact_body_and_uploaded_urls_after_restart(tmp_path):
    media, cloud = Media(), Cloud()
    value = task(videoMode='reference', referenceIds=[media.add()])
    submissions = []

    def handle(request):
        if request.url.path.startswith('/sand/magi-2/'):
            submissions.append((request.headers['Idempotency-Key'], request.content))
            if len(submissions) == 1:
                raise httpx.ReadTimeout('response lost', request=request)
        return cloud(request)

    cache = GenerationResults(tmp_path, value['id'])
    adapter = HiggsfieldOpenGeneration(media, httpx.MockTransport(handle), poll_interval=0)
    with pytest.raises(GenerationError) as failure:
        await adapter.generate(config(), value, ignore_submitted, recovery_cache=cache)
    assert failure.value.details.category == 'submission_unknown'
    assert len(submissions) == 1
    # A new adapter and cache instance simulate process restart, including a changed draft.
    media.items.clear()
    value['prompt'] = 'Later draft must not change the accepted request'
    restored = HiggsfieldOpenGeneration(media, httpx.MockTransport(handle), poll_interval=0)
    await restored.generate(config(), value, ignore_submitted, recovery_cache=GenerationResults(tmp_path, value['id']))
    assert submissions[0] == submissions[1]
    assert cloud.uploads == 1


@pytest.mark.anyio
async def test_unknown_submission_cannot_be_replayed_under_a_different_account(tmp_path):
    value, calls = task(), []
    cache = GenerationResults(tmp_path, value['id'])
    def lost(request):
        calls.append(request)
        raise httpx.ReadTimeout('response lost', request=request)
    adapter = HiggsfieldOpenGeneration(None, httpx.MockTransport(lost))
    with pytest.raises(GenerationError):
        await adapter.generate(config(), value, ignore_submitted, recovery_cache=cache)
    with pytest.raises(GenerationError) as failure:
        await adapter.generate({**config(), 'apiKey': 'different-account:secret'}, value, ignore_submitted, recovery_cache=cache)
    assert 'API Key ID' in str(failure.value)
    assert len(calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize(('status', 'category'), [(401, 'authentication'), (402, 'quota'), (429, 'rate_limit'), (422, 'input')])
async def test_submission_failure_is_safe_and_never_retried_automatically(tmp_path, status, category, caplog):
    caplog.set_level('DEBUG', logger='opendirector.integrations.http_settings')
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(status, json={'message': config()['apiKey'], 'request_id': 'synthetic-secret'})
    value = task()
    with pytest.raises(GenerationError) as failure:
        await HiggsfieldOpenGeneration(None, httpx.MockTransport(handle)).generate(
            config(), value, ignore_submitted, recovery_cache=GenerationResults(tmp_path, value['id']))
    assert failure.value.details.category == category
    assert failure.value.details.requestId is None
    assert len(calls) == 1
    assert 'synthetic-secret' not in caplog.text + str(failure.value)


@pytest.mark.anyio
async def test_download_diagnostics_redact_each_credential_component(caplog):
    caplog.set_level('DEBUG', logger='opendirector.integrations.http_settings')
    def handle(request):
        assert 'authorization' not in request.headers
        return httpx.Response(403, headers={'x-request-id': 'synthetic-secret'}, json={'request_id': 'synthetic-id'})
    adapter = HiggsfieldOpenGeneration(None, httpx.MockTransport(handle), retry_delays=())
    with pytest.raises(GenerationError) as failure:
        await adapter.resume_result(config(), 'mp4', 'https://cdn.example.test/result.mp4?signature=private')
    assert failure.value.details.requestId is None
    assert 'synthetic-secret' not in caplog.text
    assert 'synthetic-id' not in caplog.text
    assert 'signature=private' not in caplog.text


@pytest.mark.anyio
@pytest.mark.parametrize('state', ['failed', 'nsfw', 'canceled'])
async def test_terminal_statuses_preserve_remote_identity(tmp_path, state):
    value, cloud = task(), Cloud()
    def handle(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'request_id': 'remote-1', 'status': state})
        return cloud(request)
    with pytest.raises(GenerationError) as failure:
        await HiggsfieldOpenGeneration(None, httpx.MockTransport(handle)).generate(
            config(), value, ignore_submitted, recovery_cache=GenerationResults(tmp_path, value['id']))
    assert failure.value.details.providerStatus == ('cancelled' if state == 'canceled' else 'failed')
    assert failure.value.details.requestId == 'remote-1'
    if state == 'nsfw':
        assert failure.value.details.category == 'input'


@pytest.mark.anyio
async def test_poll_recovery_download_failure_and_cancellation_use_returned_urls(tmp_path):
    value, cloud = task(), Cloud()
    cache = GenerationResults(tmp_path, value['id'])
    cache.save_submission(dict(key=value['id'], path='/sand/magi-2/text-to-video', payload={}, remote=accepted()))
    value['externalTaskId'] = 'remote-1'
    calls, polls = [], 0
    def handle(request):
        nonlocal polls
        calls.append(request)
        if request.method == 'POST':
            assert str(request.url) == accepted()['cancel_url']
            return httpx.Response(202)
        if str(request.url) == accepted()['status_url']:
            polls += 1
            if polls == 1:
                return httpx.Response(429, json={})
            if polls == 2:
                return httpx.Response(200, json={'request_id': 'remote-1', 'status': 'in_progress'})
        return cloud(request)
    adapter = HiggsfieldOpenGeneration(None, httpx.MockTransport(handle), poll_interval=0, retry_delays=(0,))
    assert await adapter.generate(config(), value, ignore_submitted, recovery_cache=cache) == ('mp4', cloud.output)
    await adapter.cancel(config(), 'remote-1', recovery_cache=cache)
    assert polls == 3
    assert sum(r.method == 'POST' for r in calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize('url', ['https://attacker.example/status', 'http://api.higgsfield.ai/status', 'https://api.higgsfield.ai@attacker.example/status'])
async def test_provider_locators_never_forward_credentials_to_other_origins(tmp_path, url):
    value, calls = task(), []
    def handle(request):
        calls.append(request)
        return httpx.Response(202, json={**accepted(), 'status_url': url})
    with pytest.raises(GenerationError):
        await HiggsfieldOpenGeneration(None, httpx.MockTransport(handle)).generate(
            config(), value, ignore_submitted, recovery_cache=GenerationResults(tmp_path, value['id']))
    assert len(calls) == 1


@pytest.fixture(scope='module')
def video_bytes(tmp_path_factory):
    path = tmp_path_factory.mktemp('magi2-media') / 'output.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24',
                    '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)], check=True)
    return path.read_bytes()


@pytest.mark.anyio
@pytest.mark.parametrize('source', ['ui', 'agent'])
@pytest.mark.parametrize(('mode', 'roles'), [('first_frame', []), ('first_frame', ['first_frame', 'last_frame']), ('reference', ['reference'])])
async def test_shared_commands_adopt_results_and_reopen_project(tmp_path, video_bytes, source, mode, roles):
    project = new_project(tmp_path)
    projects, pid, session = project
    configs = ModelConfigs(tmp_path)
    model = configs.save('video', BASE, MODEL, config()['apiKey'], protocol='higgsfield_open')
    assets = CreationToolAssets(projects)
    media = Media()
    refs = [assets.import_file(str(pid), str(uuid4()), 'frame.png', media.asset(pid, media.add())[0], session) for _ in roles]
    spec_id, item_id = uuid4(), uuid4()
    receipt = send(projects, pid, 'canvas.createGeneration', session=session,
        spec=dict(id=spec_id, projectId=pid, kind='video', purpose='generation', modelConfigId=model['id'],
                  prompt='Animate', parameters=dict(videoMode=mode, durationSeconds=4, resolution='1080P', generateAudio=False)),
        item=dict(id=item_id, projectId=pid, kind='video', binding=dict(role='generation', objectRef=dict(id=spec_id))),
        references=[dict(id=uuid4(), projectId=pid, targetSpecId=spec_id, binding='pinned', role=role, order=index,
                        source=dict(assetId=asset['id'], revision=1, fingerprint=asset['fingerprint'], kind='image'))
                    for index, (asset, role) in enumerate(zip(refs, roles, strict=True))])
    assert receipt.status == 'applied', receipt
    before = projects.snapshot(pid)
    spec, item = before.generationSpecs[-1], before.canvasItems[-1]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
    runner = CreationGeneration(projects, configs)
    cloud = Cloud(video_bytes)
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(cloud), poll_interval=0)
    try:
        if source == 'agent':
            tools = AgentTools(projects, runner, configs)
            turn, call_id = uuid4(), 'magi2-' + str(uuid4())
            arguments = command.model_dump(mode='json', exclude={'commandId', 'projectId'})
            receipt = await tools.execute(pid, turn, session, call_id, 'execute_command', arguments, [], None)
            assert receipt['status'] == 'accepted', receipt
            assert await tools.execute(pid, turn, session, call_id, 'execute_command', arguments, [], None) == receipt
        else:
            receipt = runner.prepare(command, session=session, source=source)
            assert receipt.status == 'accepted', receipt
            assert runner.prepare(command, session=session, source=source) == receipt
            await runner.execute(command, session=session)
        await settled(runner)
        current = projects.snapshot(pid)
        job = current.jobs[-1]
        assert job.status == 'succeeded', job
        if source == 'agent':
            assert job.agentRunId == turn and job.agentCallId == call_id
        assert job.adopted is True
        assert job.execution.generateAudio is False
        assert current.results[-1].jobId == job.id
        assert current.assets[-1].metadata.durationSeconds == 4
        assert not GenerationResults(runner.directory(pid), str(job.id)).submission()
        reopened = type(projects)(type(projects.local)(tmp_path)).snapshot(pid)
        assert reopened.jobs == current.jobs and reopened.results == current.results
        assert sum(r.url.path.startswith('/sand/magi-2/') for r in cloud.requests) == 1
    finally:
        await runner.close()


@pytest.mark.parametrize('source', ['ui', 'agent'])
def test_shared_rejection_has_translatable_code_and_never_creates_job(tmp_path, video_bytes, source):
    project = new_project(tmp_path)
    projects, pid, session = project
    configs = ModelConfigs(tmp_path)
    model = configs.save('video', BASE, MODEL, config()['apiKey'], protocol='higgsfield_open')
    asset = CreationToolAssets(projects).import_file(str(pid), str(uuid4()), 'clip.mp4', video_bytes, session)
    runner = CreationGeneration(projects, configs)
    command = generation_command(project, model, prompt='x' * 15001,
        parameters={'videoMode': 'reference'}, references=[asset['id']])
    receipt = runner.prepare(command, session=session, source=source)
    assert receipt.status == 'rejected'
    assert receipt.issues[0].code == 'higgsfield_prompt'
    assert not projects.snapshot(pid).jobs
    from opendirector_api.localization import localized_error_for_language
    translated = localized_error_for_language('en-US', chinese=receipt.issues[0].message, status=422, code=receipt.issues[0].code)
    assert '15,000' in translated and 'Text-to-video' in translated


@pytest.mark.anyio
async def test_corrupt_submission_cache_stops_before_network(tmp_path):
    value = task()
    cache = GenerationResults(tmp_path, value['id'])
    cache.save_submission(dict(key=value['id'], path='/sand/magi-2/text-to-video', payload={'prompt': 'Original'}))
    path = cache.directory / 'submission.json'
    record = json.loads(path.read_text(encoding='utf-8'))
    record['submission']['payload']['prompt'] = 'Changed'
    path.write_text(json.dumps(record), encoding='utf-8')
    def unexpected(request):
        pytest.fail('a corrupt request cannot be submitted again')
    with pytest.raises(ProjectError):
        await HiggsfieldOpenGeneration(None, httpx.MockTransport(unexpected)).generate(
            config(), value, ignore_submitted, recovery_cache=cache)


@pytest.mark.anyio
@pytest.mark.parametrize('failed_stage', ['download', 'save'])
async def test_restart_recovers_original_result_without_generation(tmp_path, video_bytes, monkeypatch, failed_stage):
    project = new_project(tmp_path)
    projects, pid, session = project
    configs = ModelConfigs(tmp_path)
    model = configs.save('video', BASE, MODEL, config()['apiKey'], protocol='higgsfield_open')
    runner = CreationGeneration(projects, configs)
    cloud, downloads = Cloud(video_bytes), 0
    def handle(request):
        nonlocal downloads
        if request.url.path == '/result.mp4':
            downloads += 1
            if downloads == 1 and failed_stage == 'download':
                raise httpx.ReadTimeout('fixture download interruption', request=request)
        return cloud(request)
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), poll_interval=0, retry_delays=())
    if failed_stage == 'save':
        def unavailable(*args, **kwargs):
            raise OSError('fixture catalog save interruption')
        monkeypatch.setattr(runner, '_commit_output', unavailable)
    command = generation_command(project, model, parameters={'durationSeconds': 4, 'generateAudio': False})
    await runner.execute(command, session=session)
    await settled(runner)
    interrupted = projects.snapshot(pid).jobs[-1]
    assert interrupted.externalTaskId == 'remote-1'
    assert interrupted.recovery == ('remote' if failed_stage == 'download' else 'local')
    await runner.close()
    restored = CreationGeneration(projects, configs)
    restored.provider = GenerationProviders(restored.store, httpx.MockTransport(handle), poll_interval=0, retry_delays=())
    try:
        await restored.recover(str(pid), str(interrupted.id), explicit=True)
        await settled(restored)
        current = projects.snapshot(pid)
        assert current.jobs[-1].status == 'succeeded', current.jobs[-1]
        assert len(current.results) == 1
        assert sum(r.url.path.startswith('/sand/magi-2/') for r in cloud.requests) == 1
        assert downloads == (2 if failed_stage == 'download' else 1)
    finally:
        await restored.close()


@pytest.mark.anyio
@pytest.mark.parametrize('cancel_status', [202, 400])
async def test_cancel_distinguishes_request_from_remote_confirmation(tmp_path, cancel_status):
    project = new_project(tmp_path)
    projects, pid, session = project
    configs = ModelConfigs(tmp_path)
    model = configs.save('video', BASE, MODEL, config()['apiKey'], protocol='higgsfield_open')
    runner = CreationGeneration(projects, configs)
    polling, block = asyncio.Event(), asyncio.Event()
    cancellation = False
    async def handle(request):
        nonlocal cancellation
        if request.url.path == '/returned/cancel/remote-1':
            cancellation = True
            return httpx.Response(cancel_status, **({} if cancel_status == 202 else {'json': {'message': 'already running'}}))
        if request.method == 'POST':
            return httpx.Response(202, json=accepted())
        if cancellation:
            return httpx.Response(200, json={'request_id': 'remote-1', 'status': 'canceled'})
        polling.set()
        await block.wait()
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), poll_interval=0)
    try:
        await runner.execute(generation_command(project, model), session=session)
        await asyncio.wait_for(polling.wait(), 5)
        job = projects.snapshot(pid).jobs[-1]
        await cancel(runner, str(pid), str(job.id), session)
        await settled(runner)
        stopped = projects.snapshot(pid).jobs[-1]
        assert stopped.status == 'cancelled'
        assert stopped.remoteCancellation == ('requested' if cancel_status == 202 else 'unknown')
        if cancel_status == 202:
            await runner.recover(str(pid), str(job.id), explicit=True)
            await settled(runner)
            assert projects.snapshot(pid).jobs[-1].remoteCancellation == 'confirmed'
    finally:
        await runner.close()
