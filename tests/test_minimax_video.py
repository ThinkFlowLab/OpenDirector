"""Official H3 inputs, durable acceptance and protocol recovery."""
import asyncio
import json
from uuid import UUID, uuid4

import httpx
import pytest

from opendirector.application.creation_canvas import resolved_inputs
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.generation import GenerationError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.minimax_video import MinimaxVideoGeneration
from opendirector.integrations.providers import GenerationProviders
from test_creation_canvas_service import project, send, ver
from test_multimodal_references import media, task


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def config():
    return dict(kind='video', modelId='MiniMax-H3', protocol='minimax_video_v2',
        url='https://api.minimax.cn/v2', apiKey='private', authMode='bearer', connectionType='api')


def test_official_profile_and_shared_connection_are_distinct_from_self_hosted(tmp_path):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('video', config()['url'], 'MiniMax-H3', 'private', protocol='minimax_video_v2')
    assert saved['inputRules']['profile'] == 'minimax-h3-official'
    assert saved['inputRules']['frameRoles'] == ['first_frame', 'last_frame']
    assert saved['inputRules']['outputResolutions'] == ['768P', '2K']
    assert ModelConfigs(tmp_path).resolve(saved['id'], 'video')['protocol'] == 'minimax_video_v2'
    assert input_rules({**config(), 'protocol': 'vllm_omni'})['profile'] == 'vllm-omni-h3'
    assert isinstance(GenerationProviders(None)._profile_adapter(config()), MinimaxVideoGeneration)
    narrowed = configs.save('video', config()['url'], 'MiniMax-H3', 'private', protocol='minimax_video_v2',
        video_capabilities={'outputs': [{'resolution': '2K', 'durations': [5]}], 'defaultResolution': '2K', 'defaultDuration': 5})
    assert narrowed['inputRules']['outputResolutions'] == ['2K']
    with pytest.raises(ProjectError, match='输出规格无效'):
        configs.save('video', config()['url'], 'MiniMax-H3', 'private', protocol='minimax_video_v2', video_capabilities={})


@pytest.mark.parametrize('roles', [['first_frame'], ['last_frame'], ['first_frame', 'last_frame']])
def test_explicit_frame_slots_preserve_asset_bytes_and_allow_one_asset_in_both_slots(media, roles):
    store, owner, _, _, image, _, _ = media
    adapter = MinimaxVideoGeneration(store)
    value = task(owner, [image], videoMode='first_frame',
        referenceRoles=[dict(assetId=image['id'], role=role) for role in roles])
    prepared = adapter.prepare_inputs(owner, value, config())
    payload = adapter.payload(config(), value, prepared)
    assert [item['role'] for item in payload['content'][1:]] == roles
    assert payload['ratio'] == 'adaptive'
    assert all(item['image_url']['url'].startswith('data:image/png;base64,') for item in payload['content'][1:])


def test_reference_audio_alone_and_pre_submission_rejections(media):
    store, owner, _, _, image, audio, _ = media
    adapter = MinimaxVideoGeneration(store)
    prepared = adapter.prepare_inputs(owner, task(owner, [audio]), config())
    assert prepared['content'][1]['role'] == 'reference_audio'
    with pytest.raises(ProjectError, match='混用'):
        adapter.prepare_inputs(owner, task(owner, [image], referenceRoles=[dict(assetId=image['id'], role='last_frame')]), config())
    with pytest.raises(ProjectError, match='模式'):
        adapter.prepare_inputs(owner, task(owner, videoMode='continuation'), config())
    with pytest.raises(ProjectError, match='提示词'):
        adapter.prepare_inputs(owner, task(owner, prompt=' '), config())
    with pytest.raises(ProjectError, match='画幅'):
        adapter.payload(config(), task(owner, parameters={'ratio': 'adaptive'}), {'content': [{'type': 'text', 'text': 'test'}]})


@pytest.mark.anyio
@pytest.mark.parametrize('resume', [False, True])
async def test_protocol_poll_resume_and_cdn_download_never_forward_key(resume):
    requests, accepted, ready = [], [], []
    async def submitted(identity):
        accepted.append(identity)
    async def result_ready(suffix, url):
        ready.append((suffix, url))
    def handle(request):
        requests.append(request)
        if request.method == 'POST':
            assert json.loads(request.content) == dict(model='MiniMax-H3', duration=5, resolution='768P', ratio='16:9', content=[dict(type='text', text='test')])
            return httpx.Response(200, json={'task_id': 'remote-1'})
        if request.url.host == 'cdn.example.test':
            assert 'authorization' not in request.headers
            return httpx.Response(200, content=b'video-bytes')
        return httpx.Response(200, json={'task': {'id': 'remote-1', 'status': 'succeeded', 'content': {'url': 'https://cdn.example.test/output.mp4'}}})
    adapter = MinimaxVideoGeneration(None, httpx.MockTransport(handle), poll_interval=0)
    value = task('project', prompt='test', externalTaskId='remote-1' if resume else None)
    assert await adapter.generate(config(), value, submitted, result_ready=result_ready) == ('mp4', b'video-bytes')
    assert accepted == ([] if resume else ['remote-1'])
    assert sum(request.method == 'POST' for request in requests) == (0 if resume else 1)
    assert ready == [('mp4', 'https://cdn.example.test/output.mp4')]
    assert all(request.headers.get('authorization') == 'Bearer private' for request in requests if request.url.host == 'api.minimax.cn')
    assert await adapter.resume_result(config(), 'mp4', ready[0][1]) == ('mp4', b'video-bytes')


@pytest.mark.anyio
async def test_submit_timeout_does_not_retry_and_terminal_status_is_retained():
    requests = []
    def timeout(request):
        requests.append(request)
        raise httpx.ReadTimeout('unknown acceptance', request=request)
    adapter = MinimaxVideoGeneration(None, httpx.MockTransport(timeout))
    async def submitted(identity):
        pytest.fail('no remote identity was received')
    with pytest.raises(GenerationError) as failure:
        await adapter.generate(config(), task('project'), submitted)
    assert failure.value.details.stage == 'submit'
    assert len(requests) == 1
    adapter.transport = httpx.MockTransport(lambda request: httpx.Response(200, json={'task': {'id': 'remote-1', 'status': 'cancelled'}}))
    with pytest.raises(GenerationError) as failure:
        await adapter.generate(config(), task('project', externalTaskId='remote-1'), submitted)
    assert failure.value.details.providerStatus == 'cancelled'
    with pytest.raises(ProjectError, match='可能继续'):
        await adapter.cancel(config(), 'remote-1')


@pytest.mark.anyio
@pytest.mark.parametrize('slot', ['first_frame', 'last_frame'])
@pytest.mark.parametrize('subject_role', [None, 'main'])
async def test_real_generation_acceptance_freezes_frame_roles_and_output_parameters(project, slot, subject_role, tmp_path):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    model = configs.save('video', config()['url'], 'MiniMax-H3', 'private', protocol='minimax_video_v2')
    runner = CreationGeneration(store, configs)
    # Import real bytes through the same asset service used by the UI and Agent.
    from io import BytesIO
    from PIL import Image
    image = BytesIO(); Image.new('RGB', (256, 256), 'blue').save(image, 'PNG')
    handle = uuid4()
    writer = runner.assets.uploads.begin(pid, handle, session, 'frame.png', expected_kind='image')
    writer.write(image.getvalue()); writer.finish()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=handle, name='frame.png', expectedKind='image').status == 'applied'
    asset = store.snapshot(pid).assets[-1]
    spec_id, item_id = uuid4(), uuid4()
    receipt = send(store, pid, 'canvas.createGeneration', session=session,
        spec=dict(id=spec_id, projectId=pid, kind='video', purpose='generation', modelConfigId=model['id'], prompt='Animate',
            parameters=dict(videoMode='first_frame', durationSeconds=5, resolution='2K')),
        item=dict(id=item_id, projectId=pid, kind='video', binding=dict(role='generation', objectRef=dict(id=spec_id))),
        references=[dict(id=uuid4(), projectId=pid, targetSpecId=spec_id, binding='pinned', role=slot, subjectRole=subject_role,
            source=dict(assetId=asset.id, revision=asset.revision, fingerprint=asset.fingerprint, kind='image'))])
    assert receipt.status == 'applied', receipt
    snapshot = store.snapshot(pid)
    item, spec = snapshot.canvasItems[-1], snapshot.generationSpecs[-1]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('canvas_item', item), ver('generation_spec', spec)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
    receipt = runner.prepare(command, session=session)
    if subject_role is not None:
        assert receipt.status == 'rejected', receipt
        assert receipt.issues[0].code == 'reference_invalid'
        assert not store.snapshot(pid).jobs
        return
    assert receipt.status == 'accepted', receipt
    job = store.snapshot(pid).jobs[-1]
    assert job.inputSnapshot.references[0].role == slot
    assert job.inputSnapshot.references[0].transmission == 'content'
    assert job.execution.resolution == '2K'
    assert job.adapterParameters['duration'] == 5
    assert runner.task(job)['referenceRoles'] == [dict(assetId=str(asset.id), role=slot)]
    assert runner.prepare(command, session=session) == receipt
    import subprocess
    output = tmp_path / 'output.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=256x256:r=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '5',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(output)], check=True)
    video = output.read_bytes()
    requests = []
    def handle(request):
        requests.append(request)
        if request.method == 'POST':
            payload = json.loads(request.content)
            assert payload['content'][1]['role'] == slot
            assert payload['resolution'] == '2K' and payload['ratio'] == 'adaptive'
            return httpx.Response(200, json={'task_id': 'accepted-1'})
        if request.url.host == 'cdn.example.test':
            assert 'authorization' not in request.headers
            return httpx.Response(200, content=video)
        return httpx.Response(200, json={'task': {'id': 'accepted-1', 'status': 'succeeded',
            'content': {'url': 'https://cdn.example.test/output.mp4'}}})
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), poll_interval=0)
    try:
        assert await runner.execute(command, session=session) == receipt
        await asyncio.gather(*(worker.future for worker in list(runner.jobs.values())))
        current = store.snapshot(pid)
        assert current.jobs[-1].status == 'succeeded', current.jobs[-1]
        assert current.jobs[-1].externalTaskId == 'accepted-1'
        assert len(current.results) == 1 and current.results[0].jobId == job.id
        assert current.assets[-1].metadata.hasAudio
        assert sum(request.method == 'POST' for request in requests) == 1
    finally:
        await runner.close()


@pytest.mark.parametrize(('codec', 'seconds', 'error'), [('libx264', '2', None), ('mpeg4', '2', 'H.264/H.265'), ('libx264', '1', '2—15 秒')])
def test_real_video_reference_codec_validation(media, tmp_path, codec, seconds, error):
    import shutil
    import subprocess
    store, owner, session, assets, _, _, _ = media
    if not shutil.which('ffmpeg'):
        pytest.skip('requires ffmpeg')
    path = tmp_path / 'reference.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=256x256:r=24',
        '-t', seconds, '-c:v', codec, '-pix_fmt', 'yuv420p', str(path)], check=True)
    video = assets.import_file(owner, str(uuid4()), path.name, path.read_bytes(), session)
    adapter = MinimaxVideoGeneration(store)
    if error:
        with pytest.raises(ProjectError, match=error):
            adapter.prepare_inputs(owner, task(owner, [video]), config())
        return
    prepared = adapter.prepare_inputs(owner, task(owner, [video]), config())
    assert prepared['content'][1]['role'] == 'reference_video'
    assert prepared['content'][1]['video_url']['url'].startswith('data:video/mp4;base64,')


@pytest.mark.anyio
async def test_official_http_errors_keep_safe_type_and_request_identity():
    adapter = MinimaxVideoGeneration(None, httpx.MockTransport(lambda request: httpx.Response(402, json={
        'type': 'error', 'error': {'type': 'insufficient_balance_error', 'message': 'private provider diagnostic'}, 'request_id': 'req-123'})))
    async def submitted(identity):
        pytest.fail('rejected submission cannot have an accepted identity')
    with pytest.raises(GenerationError) as failure:
        await adapter.generate(config(), task('project'), submitted)
    assert failure.value.details.category == 'quota'
    assert failure.value.details.providerCode == 'insufficient_balance_error'
    assert failure.value.details.requestId == 'req-123'
    assert 'private provider diagnostic' not in str(failure.value)


def test_encoded_budget_is_checked_before_acceptance(media, monkeypatch):
    import opendirector.integrations.minimax_video as module
    store, owner, _, _, image, _, _ = media
    raw = store.asset(owner, image['id'])[0]
    rules = input_rules(config()) | {'requestBytes': 4096 + len(raw)}
    monkeypatch.setattr(module, 'input_rules', lambda _: rules)
    with pytest.raises(ProjectError, match='编码后的请求过大'):
        MinimaxVideoGeneration(store).prepare_inputs(owner, task(owner, [image]), config())


@pytest.mark.parametrize('model,resolutions,minimum', [
    ('MiniMax-H3', ['768P', '2K'], 4),
    ('MiniMax-H3-Highspeed', ['480P', '768P'], 4),
    ('MiniMax-H3-Lite', ['480P', '768P'], 4),
    ('MiniMax-H3-Max', ['480P', '768P'], 5),
])
def test_official_variants_enforce_native_outputs(model, resolutions, minimum):
    configured = {**config(), 'modelId': model}
    adapter = MinimaxVideoGeneration(None)
    adapter.validate('video', configured)
    rules = input_rules(configured)
    assert rules['outputResolutions'] == resolutions
    assert rules['videoCapabilities']['outputs'][0]['durations'] == list(range(minimum, 16))
    prepared = {'content': [{'type': 'text', 'text': 'test'}]}
    for resolution in resolutions:
        result = adapter.payload(configured, {'parameters': {'resolution': resolution, 'duration': minimum}}, prepared)
        assert result['model'] == model
    invalid = '480P' if model == 'MiniMax-H3' else '2K'
    with pytest.raises(ProjectError, match='输出规格无效'):
        adapter.payload(configured, {'parameters': {'resolution': invalid}}, prepared)
    with pytest.raises(ProjectError, match='输出规格无效'):
        adapter.payload(configured, {'parameters': {'duration': minimum - 1}}, prepared)


@pytest.mark.anyio
@pytest.mark.parametrize(('code', 'message'), [(1026, '输入内容涉及敏感信息'), (1027, '生成内容涉及敏感信息')])
async def test_moderation_failures_say_the_content_was_rejected_instead_of_a_generic_provider_error(code, message):
    def handle(request):
        if request.method == 'POST':
            return httpx.Response(200, json={'task_id': 'task-1'})
        return httpx.Response(200, json={'task': {'id': 'task-1', 'status': 'failed',
            'error': {'code': code, 'message': 'private moderation detail'}}})
    accepted = []
    async def submitted(identity):
        accepted.append(identity)
    adapter = MinimaxVideoGeneration(None, httpx.MockTransport(handle), poll_interval=0)
    adapter.prepare_inputs = lambda *args: {'content': [{'type': 'text', 'text': 'test'}]}
    with pytest.raises(GenerationError) as failure:
        await adapter.generate(config(), task('project'), submitted)
    details = failure.value.details
    assert accepted == ['task-1']
    assert details.category == 'input' and details.stage == 'poll' and details.providerStatus == 'failed'
    assert details.providerCode == str(code) and message in details.message
    # Moderation is deterministic: the suggestion must not invite an unchanged retry.
    assert '相同输入重试仍会被拒绝' in details.suggestion
    assert 'private moderation detail' not in str(failure.value)
