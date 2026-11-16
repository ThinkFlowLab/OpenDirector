"""GLM-Image protocol and both entry points through persisted candidates and recovery."""
import io
import json
from uuid import uuid4

import httpx
import pytest
from PIL import Image

from generation_helpers import command, new_project, settled
from opendirector.agent.tools import AgentTools
from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.domain.bigmodel_image import BIGMODEL_IMAGE_OUTPUTS, validate_bigmodel_image
from opendirector.domain.capabilities import ImageRequest
from opendirector.domain.generation import GenerationError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.model_adapters import BigModelImages, adapter_for
from opendirector.integrations.providers import GenerationProviders
from test_creation_canvas_service import send, ver


SECRET = 'bigmodel-private-test-key'
URL = 'https://93.184.216.34/output?signature=private-result'
CONFIG = dict(kind='image', url='https://open.bigmodel.cn/api/paas/v4', modelId='glm-image',
              protocol='openai', connectionType='api', authMode='bearer', apiKey=SECRET)


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def picture(format='PNG'):
    output = io.BytesIO()
    Image.new('RGB', (32, 24), 'blue').save(output, format=format)
    return output.getvalue()


def runner_for(project, configs, handle):
    runner = CreationGeneration(project[0], configs)
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), retry_delays=(0, 0))
    return runner


def test_profile_sizes_and_capabilities_are_official_text_to_image_only():
    rules = input_rules(CONFIG)
    assert rules['profile'] == 'bigmodel-glm-image'
    assert rules['allowedKinds'] == ['text'] and rules['maxImages'] == 0
    assert isinstance(adapter_for(CONFIG), BigModelImages)
    assert adapter_for(CONFIG).capabilities == {'image.generate'}
    assert [choice['size'] for choice in rules['imageOutputs']] == [size for _, size in BIGMODEL_IMAGE_OUTPUTS]
    for _, size in BIGMODEL_IMAGE_OUTPUTS:
        validate_bigmodel_image('A lake', *map(int, size.split('x')))


@pytest.mark.parametrize('patch', [
    {'url': 'https://open.bigmodel.cn.evil.test/api/paas/v4'}, {'url': 'http://open.bigmodel.cn/api/paas/v4'},
    {'url': 'https://open.bigmodel.cn:8443/api/paas/v4'}, {'url': 'https://other.test/v1'},
    {'modelId': 'glm-4'}, {'kind': 'agent'}, {'protocol': 'volcengine'},
])
def test_lookalikes_keep_their_existing_adapter(patch):
    assert input_rules({**CONFIG, **patch})['profile'] != 'bigmodel-glm-image'


@pytest.mark.anyio
@pytest.mark.parametrize('format', ['PNG', 'JPEG', 'WEBP'])
@pytest.mark.parametrize('watermark', [True, False])
async def test_documented_payload_checkpoint_and_public_download(format, watermark):
    calls, checkpoints = [], []
    async def ready(suffix, url):
        checkpoints.append((suffix, url))
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            assert str(request.url) == CONFIG['url'] + '/images/generations'
            assert request.headers['authorization'] == f'Bearer {SECRET}'
            assert json.loads(request.content) == dict(model='glm-image', prompt='A lake', size='1728x960',
                                                       watermark_enabled=watermark)
            return httpx.Response(200, json={'data': [{'url': URL}]})
        assert checkpoints == [('png', URL)]
        assert 'authorization' not in request.headers
        return httpx.Response(200, content=picture(format))
    result = await BigModelImages(httpx.MockTransport(handle)).image(
        CONFIG, ImageRequest('A lake', 1728, 960), result_ready=ready, watermark=watermark)
    assert result.suffix == 'png'
    with Image.open(io.BytesIO(result.data)) as image:
        image.load()
        assert image.format == 'PNG' and image.size == (32, 24)
    assert [call.method for call in calls] == ['POST', 'GET']


@pytest.mark.anyio
@pytest.mark.parametrize('image_request', [
    ImageRequest('', 1280, 1280), ImageRequest('A lake', 1280, 1280, image=b'image'),
    ImageRequest('A lake', 1280, 1280, references=(b'image',)), ImageRequest('A lake', 1025, 1024),
    ImageRequest('A lake', '1280', 1280), ImageRequest('A lake', True, 1280),
])
async def test_invalid_input_never_submits(image_request):
    def handle(_):
        pytest.fail('Invalid GLM-Image input must not submit')
    with pytest.raises(ProjectError):
        await BigModelImages(httpx.MockTransport(handle)).image(CONFIG, image_request)


@pytest.mark.anyio
@pytest.mark.parametrize('response', [None, httpx.Response(200, json={}),
    httpx.Response(200, json={'data': [{'url': 'file:///tmp/result'}]}),
    httpx.Response(401, json={'error': {'code': '1002', 'message': SECRET}}),
    httpx.Response(429, json={'error': {'code': '1302', 'message': SECRET}}),
])
async def test_failed_or_unknown_submission_never_reposts(response):
    calls = []
    def handle(request):
        calls.append(request)
        if response is None:
            raise httpx.ReadTimeout('unknown acceptance', request=request)
        return response
    with pytest.raises(GenerationError) as caught:
        await BigModelImages(httpx.MockTransport(handle)).image(CONFIG, ImageRequest('A lake', 1280, 1280))
    assert len(calls) == 1 and caught.value.details.stage == 'submit'
    assert SECRET not in str(caught.value) + caught.value.details.model_dump_json()


@pytest.mark.anyio
@pytest.mark.parametrize('data', [b'not an image', b'\x89PNG\r\n\x1a\ntruncated', picture()[:50]])
async def test_invalid_download_cannot_become_media(data):
    with pytest.raises(GenerationError) as caught:
        await BigModelImages(httpx.MockTransport(lambda _: httpx.Response(200, content=data))).download(CONFIG, URL)
    assert caught.value.details.stage == 'download'


@pytest.mark.anyio
async def test_result_redirect_to_private_network_is_rejected():
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(302, headers={'Location': 'http://127.0.0.1/private'})
    with pytest.raises(GenerationError):
        await BigModelImages(httpx.MockTransport(handle)).download(CONFIG, URL)
    assert len(calls) == 1


@pytest.mark.parametrize('source', ['ui', 'agent'])
@pytest.mark.parametrize('invalid', ['image', 'blank', 'size'])
def test_preflight_rejects_unsupported_intent_without_jobs_or_http(tmp_path, source, invalid):
    project = new_project(tmp_path)
    store, pid, session = project
    configs = ModelConfigs(tmp_path)
    config = configs.save('image', CONFIG['url'], 'glm-image', SECRET, protocol='openai')
    references = []
    if invalid == 'image':
        asset = CreationToolAssets(store).import_file(str(pid), str(uuid4()), 'reference.png', picture(), session)
        references.append(asset['id'])
    request = command(project, config, prompt=' ' if invalid == 'blank' else 'A lake',
                      parameters={'size': '1024x1024'} if invalid == 'size' else {}, references=references)
    before = store.snapshot(pid)
    runner = runner_for(project, configs, lambda _: pytest.fail('Rejected intent must not submit'))
    receipt = runner.prepare(request, session=session, source=source)
    assert receipt.status == 'rejected' and not receipt.jobIds
    assert store.snapshot(pid) == before


@pytest.mark.anyio
@pytest.mark.parametrize('source', ['ui', 'agent'])
@pytest.mark.parametrize('remove_watermark', [True, False])
async def test_candidate_adoption_and_reopen_through_both_entry_points(tmp_path, source, remove_watermark):
    project = new_project(tmp_path)
    store, pid, session = project
    configs = ModelConfigs(tmp_path)
    config = configs.save('image', CONFIG['url'], 'glm-image', SECRET, protocol='openai')
    note = CreationToolAssets(store).import_file(str(pid), str(uuid4()), 'note.md', b'Blue water', session)
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={'data': [{'url': URL}]}) if request.method == 'POST' else httpx.Response(200, content=picture())
    runner = runner_for(project, configs, handle)
    try:
        runner.settings.update({'removeWatermark': remove_watermark})
        request = command(project, config, prompt='A lake', parameters={'aspectRatio': '16:9'}, references=[note['id']])
        request = request.model_copy(update={'payload': request.payload.model_copy(update={'adoptionPolicy': 'candidate_only'})})
        if source == 'agent':
            business = AgentTools(store, runner, configs)
            arguments = request.model_dump(mode='json', exclude={'commandId', 'projectId'})
            receipt = await business.execute(pid, uuid4(), session, 'generate', 'execute_command', arguments, [], None)
            assert receipt['status'] == 'accepted'
        else:
            receipt = await runner.execute(request, session=session)
            assert receipt.status == 'accepted'
            assert await runner.execute(request, session=session) == receipt
        await settled(runner)
        snapshot = store.snapshot(pid)
        [job] = snapshot.jobs
        assert job.status == 'succeeded' and not job.adopted
        assert job.execution.size == '1728x960' and job.execution.responseFormat == 'url'
        assert job.adapterParameters == dict(size='1728x960', watermark_enabled=not remove_watermark)
        assert job.execution.watermark is not remove_watermark
        assert job.inputSnapshot.model.modelId == 'glm-image'
        [payload] = [json.loads(call.content) for call in calls if call.method == 'POST']
        assert 'Blue water' in payload['prompt'] and payload['size'] == '1728x960'
        assert payload['watermark_enabled'] is not remove_watermark
        spec = snapshot.generationSpecs[-1]
        assert spec.currentResultId is None and len(snapshot.results) == 1
        result = snapshot.results[0]
        selected = send(store, pid, 'result.select', session=session,
                        versions=[ver('generation_spec', spec), *[ver('canvas_item', item) for item in snapshot.canvasItems]],
                        specId=spec.id, resultId=result.id)
        assert selected.status == 'applied', selected
        snapshot = store.snapshot(pid)
        assert snapshot.generationSpecs[-1].currentResultId == result.id
        stream, _ = CreationAssets(store).open_media(pid, job.asset.assetId)
        with stream, Image.open(stream) as image:
            image.load()
            assert image.size == (32, 24)
        assert SECRET not in snapshot.model_dump_json() and 'private-result' not in snapshot.model_dump_json()
    finally:
        await runner.close()
    assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid) == snapshot
    assert sum(call.method == 'POST' for call in calls) == 1


@pytest.mark.anyio
async def test_download_recovery_after_restart_and_model_removal_does_not_regenerate(tmp_path):
    project = new_project(tmp_path)
    store, pid, session = project
    configs = ModelConfigs(tmp_path)
    config = configs.save('image', CONFIG['url'], 'glm-image', SECRET, protocol='openai')
    healthy, calls = False, []
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            return httpx.Response(200, json={'data': [{'url': URL}]})
        if not healthy:
            raise httpx.ReadTimeout('CDN unavailable', request=request)
        return httpx.Response(200, content=picture())
    first = runner_for(project, configs, handle)
    try:
        assert (await first.execute(command(project, config), session=session)).status == 'accepted'
        await settled(first)
        [job] = store.snapshot(pid).jobs
        assert job.recovery == 'download' and job.resumeAllowed
        assert not store.snapshot(pid).results
    finally:
        await first.close()
    healthy = True
    configs.delete(config['id'])
    reopened = CreationProjects(LocalProjects(store.local.repository))
    restarted = runner_for((reopened, pid, session), configs, handle)
    try:
        await restarted.start()
        await settled(restarted)
        snapshot = reopened.snapshot(pid)
        assert snapshot.jobs[0].id == job.id and snapshot.jobs[0].status == 'succeeded'
        assert len(snapshot.results) == 1
        assert sum(call.method == 'POST' for call in calls) == 1
    finally:
        await restarted.close()
