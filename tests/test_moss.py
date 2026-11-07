"""MOSS wire contracts and real media through the shared creation lifecycle."""
import asyncio
import json
import subprocess
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from generation_helpers import command, prepared, settled
from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import CreationCanvas, asset_ref
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.voice_library import VoiceLibrary
from opendirector.domain.capabilities import ImageRequest, SpeechRequest
from opendirector.domain.creation.generation import ResolvedReference, validate_generation
from opendirector.domain.creation.models import ModelConfigPublic
from opendirector.domain.generation import GenerationError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.moss_image import is_moss_image, validate_moss_image_prompt, validate_moss_image_size
from opendirector.domain.moss_speech import is_moss_speech, validate_moss_speech_input
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.model_adapters import MossImages, MossSpeech, OpenAISpeech, adapter_for
from opendirector.integrations.providers import GenerationProviders
from opendirector_api.main import create_app
from test_creation_canvas_service import project, send, ver
from test_creation_generation_service import anyio_backend
from test_creation_parameters import png


SECRET = 'moss-private-test-key'
VOICE = '5c8cd24a-dfd6-4fd8-8f47-93e9aec17328'
OTHER_VOICE = 'f0827524-a19e-4e1c-859d-afc9fd17133e'
LOCATOR = 'https://cdn.moss.test/output?signature=private-result-signature'
MODELS = ('moss-image-sft-1.0', 'moss-image-base-1.0')
SPEECH_MODELS = ('moss-tts-1.5-flash', 'moss-tts-1.0-pro',
                 'moss-tts-1.5-flash-2026-06-26', 'moss-tts-1.0-pro-2026-02-07')
SPEECH_MODEL = SPEECH_MODELS[0]
MODEL_CASES = [('image', model) for model in MODELS] + [('audio', SPEECH_MODEL)]
CONFIG = dict(kind='image', url='https://api.mosi.cn/v1', modelId=MODELS[0],
              protocol='openai', connectionType='api', authMode='bearer', apiKey=SECRET)
SPEECH_CONFIG = {**CONFIG, 'kind': 'audio', 'modelId': SPEECH_MODEL}


@pytest.fixture(scope='module')
def mp3():
    return subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'sine=frequency=440:sample_rate=24000:duration=0.2', '-c:a', 'libmp3lame',
        '-f', 'mp3', 'pipe:1'], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


@pytest.fixture(params=MODEL_CASES)
def context(project, tmp_path, request):
    kind, model_id = request.param
    configs = ModelConfigs(tmp_path)
    config = configs.save(kind, CONFIG['url'], model_id, SECRET, protocol='openai')
    return project, configs, config


def runner_for(context, handle):
    project, configs, _ = context
    runner = CreationGeneration(project[0], configs)
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), retry_delays=(0, 0))
    return runner


def test_official_profile_exposes_input_rules_without_credentials(context):
    _, configs, config = context
    private = configs.resolve(config['id'], config['kind'])
    assert private['apiKey'] == SECRET
    assert SECRET not in json.dumps(config) and 'apiKey' not in config
    assert input_rules(private) == config['inputRules']
    rules = config['inputRules']
    if config['kind'] == 'image':
        assert is_moss_image({**private, 'url': private['url'] + '/'})
        assert rules['profile'] == 'moss-image'
        assert rules['allowedKinds'] == ['text'] and rules['maxImages'] == 0
        assert rules['maxPromptCharacters'] == 4000
        assert rules['imageOutputs']
        for output in rules['imageOutputs']:
            validate_moss_image_size(*map(int, output['size'].split('x')))
    else:
        assert is_moss_speech({**private, 'url': 'https://api.mosi.cn:443/v1/'})
        assert rules['profile'] == 'moss-speech'
        assert rules['voiceRequired'] is True and rules['referencesAllowed'] is False
        assert rules['allowedKinds'] == []
        assert rules['maxImages'] == rules['maxVideos'] == rules['maxAudios'] == 0
        assert rules.get('maxPromptCharacters') != 4000


def test_single_speaker_models_share_the_official_account_library(tmp_path):
    configs = ModelConfigs(tmp_path)
    saved = configs.save_many('audio', CONFIG['url'], list(SPEECH_MODELS), SECRET, protocol='openai')
    libraries = [item['inputRules']['voiceLibrary'] for item in saved]
    assert all(library['provider'] == 'moss' for library in libraries)
    assert len({library['connectionId'] for library in libraries}) == 1

    def handle(request):
        assert request.method == 'GET' and request.url.path == '/v1/audio/voices'
        return httpx.Response(200, json={'data': [{'id': VOICE, 'name': 'Alice'}], 'has_more': False})

    registry = VoiceLibrary(configs, httpx.MockTransport(handle))
    selected = registry.list(saved[0]['id'])['voices'][0]
    for model in saved:
        registry.validate_selection(configs.resolve(model['id'], 'audio'), VOICE, selected)


@pytest.mark.parametrize('model_id', SPEECH_MODELS)
def test_self_hosted_names_stay_on_their_own_speech_adapter(model_id):
    local = {**SPEECH_CONFIG, 'url': 'http://localhost:8090/v1', 'connectionType': 'self_hosted', 'modelId': model_id}
    assert input_rules(local)['voiceLibrary']['provider'] == 'vllm_omni'
    assert isinstance(adapter_for(local), OpenAISpeech)
    assert not is_moss_speech({**local, 'url': CONFIG['url']})


@pytest.mark.parametrize('patch', [
    {'protocol': 'volcengine'}, {'modelId': 'unofficial-model'},
    {'modelId': 'OpenMOSS/moss-image-sft-1.0'}, {'modelId': 'moss-tts-1.5-flash-extra'},
    {'url': 'https://api.mosi.cn.evil.test/v1'}, {'url': 'https://other.test/v1'},
    {'url': 'https://api.mosi.cn/v2'}, {'url': 'http://api.mosi.cn/v1'},
    {'url': 'https://api.mosi.cn:8443/v1'},
])
def test_lookalikes_do_not_inherit_official_profiles(context, patch):
    _, configs, config = context
    private = configs.resolve(config['id'], config['kind'])
    assert input_rules({**private, **patch})['profile'] not in {'moss-image', 'moss-speech'}


@pytest.mark.parametrize('prompt', ['', ' \n\t', '景' * 4001])
def test_prompt_limits_reject_blank_and_count_characters(prompt):
    with pytest.raises(ProjectError):
        validate_moss_image_prompt(prompt)
    validate_moss_image_prompt('景' * 4000)


@pytest.mark.parametrize('size', [(256, 256), (2048, 1024), (1024, 2048), (1536, 1024)])
def test_valid_image_dimensions(size):
    validate_moss_image_size(*size)


@pytest.mark.parametrize('size', [(255, 256), (2064, 256), (257, 256), (2048, 2048), (0, 1024), (1024.0, 1024), (True, 1024)])
def test_invalid_image_dimensions(size):
    with pytest.raises(ProjectError):
        validate_moss_image_size(*size)


@pytest.mark.anyio
@pytest.mark.parametrize('watermark', [True, False])
@pytest.mark.parametrize('model_id', MODELS)
async def test_wire_request_and_checkpoint_precede_cross_origin_png_download(watermark, model_id):
    calls, ready = [], []
    async def result_ready(suffix, url):
        ready.append((suffix, url))
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            assert str(request.url) == 'https://api.mosi.cn/v1/images/generations'
            assert request.headers['authorization'] == f'Bearer {SECRET}'
            assert request.extensions['timeout']['read'] == 900
            assert json.loads(request.content) == dict(model=model_id, prompt='A blue lake',
                size='1536x1024', n=1, response_format='url', prompt_enhance=False,
                output_watermark={'enabled': watermark})
            return httpx.Response(200, json={'data': [{'url': LOCATOR}]})
        assert ready == [('png', LOCATOR)]
        assert str(request.url) == LOCATOR and 'authorization' not in request.headers
        return httpx.Response(200, content=png())
    result = await MossImages(httpx.MockTransport(handle)).image(
        {**CONFIG, 'modelId': model_id}, ImageRequest('A blue lake', 1536, 1024), result_ready=result_ready, watermark=watermark)
    assert result.data == png() and result.suffix == 'png'
    assert [request.method for request in calls] == ['POST', 'GET']


@pytest.mark.anyio
@pytest.mark.parametrize('image_request', [
    ImageRequest('', 1024, 1024), ImageRequest('x' * 4001, 1024, 1024),
    ImageRequest('lake', 2048, 2048), ImageRequest('lake', 1025, 1024),
    ImageRequest('lake', 1024, 1024, image=b'image'),
    ImageRequest('lake', 1024, 1024, references=(b'image',)),
])
async def test_capability_rejects_unsupported_inputs_before_any_http_request(image_request):
    def handle(_):
        pytest.fail('invalid MOSS input must be rejected before HTTP')
    with pytest.raises(ProjectError):
        await MossImages(httpx.MockTransport(handle)).image(CONFIG, image_request)


@pytest.mark.anyio
@pytest.mark.parametrize('body', [
    {}, {'data': [{'url': LOCATOR}, {'url': LOCATOR}]},
    {'data': [{'b64_json': 'aW1hZ2U='}]},
    {'data': [{'url': 'file:///tmp/result.png'}]},
    {'data': [{'url': 'https://user:password@cdn.test/result.png'}]},
])
async def test_malformed_success_response_is_unknown_submission_without_download(body):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=body)
    with pytest.raises(GenerationError) as caught:
        await MossImages(httpx.MockTransport(handle)).image(CONFIG, ImageRequest('lake', 1024, 1024))
    assert caught.value.details.stage == 'submit'
    assert caught.value.details.category == 'submission_unknown'
    assert len(calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize(('url', 'authorization'), [
    ('https://api.mosi.cn/output.png', f'Bearer {SECRET}'),
    (LOCATOR, None), ('https://api.mosi.cn:8443/output.png', None),
])
async def test_download_authentication_is_confined_to_configured_origin(url, authorization):
    def handle(request):
        assert request.method == 'GET' and str(request.url) == url
        assert request.headers.get('authorization') == authorization
        return httpx.Response(200, content=png())
    assert await MossImages(httpx.MockTransport(handle)).download(CONFIG, url) == png()


@pytest.mark.anyio
@pytest.mark.parametrize(('adapter', 'config', 'reply'), [
    (MossImages, CONFIG, httpx.Response(302, headers={'Location': 'https://redirect.test/asset.png'})),
    (MossImages, CONFIG, httpx.Response(200, content=b'GIF89a')),
    (MossSpeech, SPEECH_CONFIG, httpx.Response(200, content=b'RIFF-WAVE')),
])
async def test_download_rejects_redirects_and_wrong_media_formats(adapter, config, reply):
    calls = []
    def handle(request):
        calls.append(request)
        return reply
    with pytest.raises(GenerationError) as caught:
        await adapter(httpx.MockTransport(handle)).download(config, LOCATOR)
    assert caught.value.details.stage == 'download'
    assert len(calls) == 1


@pytest.mark.anyio
async def test_submit_timeout_is_unknown_and_not_retried():
    calls = []
    def handle(request):
        calls.append(request)
        raise httpx.ReadTimeout('remote acceptance unknown', request=request)
    with pytest.raises(GenerationError) as caught:
        await MossImages(httpx.MockTransport(handle)).image(CONFIG, ImageRequest('lake', 1024, 1024))
    assert caught.value.details.category == 'submission_unknown'
    assert caught.value.details.stage == 'submit' and len(calls) == 1


@pytest.mark.parametrize('voice', [VOICE, 'voice_1.demo-name', 'a' * 64])
def test_voice_identifiers_accept_provider_ids_without_a_local_voice_catalog(voice):
    validate_moss_speech_input('Read this text', voice)
    validate_moss_speech_input('字' * 4001, voice)


@pytest.mark.anyio
@pytest.mark.parametrize(('text', 'voice'), [
    ('', VOICE), (' \n\t', VOICE), ('Text', None), ('Text', ''), ('Text', ' '),
    ('Text', 'a' * 65), ('Text', '音色'), ('Text', 'voice/name'), ('Text', 'voice\n'),
])
async def test_capability_rejects_invalid_speech_inputs_before_http(text, voice):
    def handle(_):
        pytest.fail('invalid speech must be rejected before HTTP')
    with pytest.raises(ProjectError):
        await MossSpeech(httpx.MockTransport(handle)).speech(SPEECH_CONFIG, SpeechRequest(text, voice))


@pytest.mark.anyio
@pytest.mark.parametrize('metadata', [{}, {'object': 'audio.speech', 'status': 'SUCCESS', 'response_format': 'mp3'}])
@pytest.mark.parametrize('model_id', SPEECH_MODELS)
async def test_wire_request_and_url_checkpoint_precede_cross_origin_mp3_download(mp3, metadata, model_id):
    calls, ready = [], []
    async def result_ready(suffix, url):
        ready.append((suffix, url))
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            assert str(request.url) == 'https://api.mosi.cn/v1/audio/speech'
            assert request.headers['authorization'] == f'Bearer {SECRET}'
            assert request.extensions['timeout']['read'] == 240
            assert json.loads(request.content) == dict(model=model_id, input='Read a blue lake',
                voice_id=VOICE, response_format='mp3', delivery_method='url', stream=False)
            return httpx.Response(200, json={'url': LOCATOR, **metadata})
        assert ready == [('mp3', LOCATOR)]
        assert str(request.url) == LOCATOR and 'authorization' not in request.headers
        return httpx.Response(200, content=mp3)
    config = {**SPEECH_CONFIG, 'modelId': model_id}
    adapter = adapter_for(config, httpx.MockTransport(handle))
    assert isinstance(adapter, MossSpeech)
    result = await adapter.speech(config, SpeechRequest('Read a blue lake', VOICE), result_ready=result_ready)
    assert result.data == mp3 and result.suffix == 'mp3'
    assert [request.method for request in calls] == ['POST', 'GET']


@pytest.mark.anyio
@pytest.mark.parametrize('body', [
    {'url': LOCATOR, 'status': 'FAILED'},
    {'error': {'code': 'voice_not_found', 'message': SECRET + LOCATOR}},
])
async def test_explicit_provider_failure_in_success_envelope_never_downloads(body):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=body)
    with pytest.raises(GenerationError) as caught:
        await MossSpeech(httpx.MockTransport(handle)).speech(SPEECH_CONFIG, SpeechRequest('Read this', VOICE))
    assert caught.value.details.stage == 'submit'
    assert caught.value.details.category in {'provider', 'input'}
    assert SECRET not in caught.value.details.model_dump_json() + str(caught.value)
    assert 'private-result-signature' not in caught.value.details.model_dump_json() + str(caught.value)
    assert len(calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize('body', [
    {}, {'data': [{'url': LOCATOR}]}, {'url': 'file:///tmp/result.mp3'},
    {'url': LOCATOR, 'object': 'image'}, {'url': LOCATOR, 'response_format': 'wav'},
    'raw_mp3',
])
async def test_speech_malformed_or_raw_success_is_unknown_without_download(mp3, body):
    calls = []
    def handle(request):
        calls.append(request)
        if body == 'raw_mp3':
            return httpx.Response(200, content=mp3, headers={'Content-Type': 'audio/mpeg'})
        return httpx.Response(200, json=body)
    with pytest.raises(GenerationError) as caught:
        await MossSpeech(httpx.MockTransport(handle)).speech(SPEECH_CONFIG, SpeechRequest('Read this', VOICE))
    assert caught.value.details.stage == 'submit'
    assert caught.value.details.category == 'submission_unknown'
    assert len(calls) == 1


@pytest.mark.anyio
async def test_speech_voice_not_found_is_readable_safe_and_never_reposted():
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(404, json={'error': {'code': 'voice_not_found', 'message': SECRET + LOCATOR}},
            headers={'X-Request-Id': 'moss-speech-request-123'})
    with pytest.raises(GenerationError) as caught:
        await MossSpeech(httpx.MockTransport(handle)).speech(SPEECH_CONFIG, SpeechRequest('Read this', VOICE))
    details = caught.value.details
    assert details.stage == 'submit' and details.category == 'input'
    assert details.httpStatus == 404 and details.requestId == 'moss-speech-request-123'
    assert details.providerCode == 'voice_not_found' and details.suggestion
    assert '音色' in details.message or 'voice' in details.message.lower()
    assert SECRET not in details.model_dump_json() + str(caught.value)
    assert 'private-result-signature' not in details.model_dump_json() + str(caught.value)
    assert len(calls) == 1


@pytest.mark.parametrize('context', MODEL_CASES[:2], indirect=True)
@pytest.mark.parametrize('reference_kind', ['image', 'expanded_text'])
@pytest.mark.parametrize('source', ['ui', 'agent'])
def test_unified_preflight_rejects_images_and_prompt_after_text_expansion(context, reference_kind, source):
    project, _, config = context
    store, pid, session = project
    data, name = (png(), 'reference.png') if reference_kind == 'image' else (('x' * 4000).encode(), 'reference.md')
    asset = CreationToolAssets(store).import_file(str(pid), str(uuid4()), name, data, session)
    runner = runner_for(context, lambda request: pytest.fail('preflight rejection must not submit'))
    request = command(project, config, prompt='Draw a lake', references=[asset['id']])
    before = store.snapshot(pid)
    receipt = runner.prepare(request, session=session, source=source)
    assert receipt.status == 'rejected', receipt
    assert receipt.issues[0].code == ('moss_prompt_limit' if reference_kind == 'expanded_text' else 'invalid_input')
    assert receipt.issues[0].objectId == request.payload.specId
    assert not receipt.changed and not receipt.jobIds
    assert store.snapshot(pid) == before
    assert runner.prepare(request, session=session, source=source) == receipt


@pytest.mark.parametrize('context', MODEL_CASES[:2], indirect=True)
@pytest.mark.parametrize('source', ['ui', 'agent'])
def test_unified_preflight_rejects_layout_json_with_text_reference(context, source):
    project, _, config = context
    store, pid, session = project
    note = CreationToolAssets(store).import_file(str(pid), str(uuid4()), 'note.md', b'Blue water', session)
    calls = []
    runner = runner_for(context, lambda request: calls.append(request))
    request = command(project, config,
        prompt='{"summary":{"caption":"A lake"},"items":[{"label":"text","text":"Blue water","bbox":[10,20,30,40]}]}',
        references=[note['id']])
    receipt = runner.prepare(request, session=session, source=source)
    assert receipt.status == 'rejected', receipt
    assert receipt.issues[0].code == 'moss_layout_reference'
    assert 'JSON' in receipt.issues[0].message and '文本参考' in receipt.issues[0].message
    assert not store.snapshot(pid).jobs
    assert not calls


@pytest.mark.parametrize('context', MODEL_CASES[:2], indirect=True)
@pytest.mark.anyio
async def test_unified_command_preserves_layout_json_without_references(context):
    project, _, config = context
    store, pid, session = project
    prompt = ' { "summary": {"caption": "A lake"}, "items": [{"label": "text", "text": "Blue water", "bbox": [10, 20, 30, 40]}] } '
    calls = []
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            return httpx.Response(200, json={'data': [{'url': LOCATOR}]})
        return httpx.Response(200, content=png())
    runner = runner_for(context, handle)
    try:
        receipt = await runner.execute(command(project, config, prompt=prompt), session=session)
        assert receipt.status == 'accepted', receipt
        await settled(runner)
        assert store.snapshot(pid).jobs[0].status == 'succeeded'
        [payload] = [json.loads(call.content) for call in calls if call.method == 'POST']
        assert payload['prompt'] == prompt
    finally:
        await runner.close()


@pytest.mark.parametrize('context', MODEL_CASES[2:], indirect=True)
@pytest.mark.parametrize('voice', [None, '音色'])
@pytest.mark.parametrize('source', ['ui', 'agent'])
def test_speech_preflight_requires_valid_voice_without_creating_job(context, voice, source):
    project, _, config = context
    store, pid, session = project
    runner = runner_for(context, lambda _: pytest.fail('preflight must not submit'))
    request = command(project, config, prompt='Read this', parameters={'voice': voice})
    before = store.snapshot(pid)
    receipt = runner.prepare(request, session=session, source=source)
    assert receipt.status == 'rejected', receipt
    assert receipt.issues[0].code == 'moss_speech_voice'
    assert receipt.issues[0].objectId == request.payload.specId
    assert not receipt.changed and not receipt.jobIds
    assert store.snapshot(pid) == before
    assert runner.prepare(request, session=session, source=source) == receipt
    projection = CreationCanvas(store).projection(pid)
    assert not projection['capabilities'][str(request.payload.originItemId)].canGenerate


def test_http_preflight_localizes_submission_replay_and_receipt_without_changing_storage(context):
    project, _, config = context
    store, pid, session = project
    runner = runner_for(context, lambda _: pytest.fail('preflight must not submit'))
    if config['kind'] == 'audio':
        request = command(project, config, prompt='Read this', parameters={'voice': '音色'})
        code = 'moss_speech_voice'
        english = 'Enter a Voice ID available to your MOSS account.'
    else:
        note = CreationToolAssets(store).import_file(str(pid), str(uuid4()), 'note.md', b'x' * 4000, session)
        request = command(project, config, prompt='Draw a lake', references=[note['id']])
        code = 'moss_prompt_limit'
        english = 'MOSS requires a nonempty prompt of at most 4,000 characters, including text references.'
    before = store.snapshot(pid)
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session, 'Accept-Language': 'en-US'}
    path = f'/api/creation/projects/{pid}'
    body = request.model_dump(mode='json')
    with TestClient(create_app(store.local, generation_provider=runner.provider), headers=headers) as client:
        response = client.post(path + '/commands', json=body)
        assert response.status_code == 200, response.text
        receipt = response.json()
        assert receipt['status'] == 'rejected'
        assert receipt['issues'][0]['code'] == code
        assert receipt['issues'][0]['message'] == english
        assert not receipt['changed'] and not receipt['jobIds']
        assert client.post(path + '/commands', json=body).json() == receipt
        assert client.get(path + f'/receipts/{request.commandId}').json() == receipt
        stored = store.receipt(pid, request.commandId).model_dump(mode='json')
        assert stored['issues'][0]['code'] == code
        assert stored['issues'][0]['message'] != english
        assert client.get(path + f'/receipts/{request.commandId}', headers={'Accept-Language': 'zh-CN'}).json() == stored
        assert client.post(path + '/commands', json=body, headers={'Accept-Language': 'zh-CN'}).json() == stored
        assert store.receipt(pid, request.commandId).model_dump(mode='json') == stored
        assert store.snapshot(pid) == before


@pytest.mark.parametrize('context', MODEL_CASES[2:], indirect=True)
@pytest.mark.parametrize('transmission', ['content', 'context_only'])
def test_speech_references_are_rejected_before_jobs_or_http(context, mp3, transmission):
    project, _, config = context
    store, pid, session = project
    name, data = ('voice.mp3', mp3) if transmission == 'content' else ('note.md', b'Reference words')
    imported = CreationToolAssets(store).import_file(str(pid), str(uuid4()), name, data, session)
    runner = runner_for(context, lambda _: pytest.fail('references must not submit'))
    if transmission == 'content':
        with pytest.raises(ProjectError):
            prepared(runner, project, config, prompt='Read this', parameters={'voice': VOICE}, references=[imported['id']])
    else:
        command(project, config, prompt='Read this', parameters={'voice': VOICE})
        snapshot = store.snapshot(pid)
        asset = next(value for value in snapshot.assets if str(value.id) == imported['id'])
        reference = ResolvedReference(referenceId=uuid4(), role='reference', asset=asset_ref(asset),
            metadata=asset.metadata, transmission='context_only')
        with pytest.raises(ValueError, match='参考'):
            validate_generation(snapshot.generationSpecs[-1], ModelConfigPublic.model_validate(config), (reference,))
    assert not store.snapshot(pid).jobs


@pytest.mark.parametrize('context', MODEL_CASES[2:], indirect=True)
@pytest.mark.anyio
async def test_mp3_signature_without_decodable_media_never_creates_an_asset(context):
    project, _, config = context
    def handle(request):
        return httpx.Response(200, json={'url': LOCATOR}) if request.method == 'POST' else httpx.Response(200, content=b'ID3not-real-mp3')
    runner = runner_for(context, handle)
    try:
        receipt = await runner.execute(command(project, config, prompt='Read this', parameters={'voice': VOICE}), session=project[2])
        assert receipt.status == 'accepted'
        await settled(runner)
        snapshot = project[0].snapshot(project[1])
        assert snapshot.jobs[0].status == 'failed'
        assert not snapshot.assets and not snapshot.results
    finally:
        await runner.close()


@pytest.mark.parametrize('context', MODEL_CASES[2:], indirect=True)
@pytest.mark.anyio
async def test_voice_change_after_acceptance_preserves_frozen_old_voice_and_candidate(context, mp3):
    project, _, config = context
    store, pid, session = project
    started, finish = asyncio.Event(), asyncio.Event()
    payloads = []
    async def handle(request):
        if request.method == 'POST':
            payloads.append(json.loads(request.content))
            started.set()
            await finish.wait()
            return httpx.Response(200, json={'url': LOCATOR})
        return httpx.Response(200, content=mp3)
    runner = runner_for(context, handle)
    try:
        request = command(project, config, prompt='Read this', parameters={'voice': VOICE})
        assert (await runner.execute(request, session=session)).status == 'accepted'
        await asyncio.wait_for(started.wait(), 3)
        spec = store.snapshot(pid).generationSpecs[-1]
        assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)],
            spec=spec.model_copy(update={'parameters': spec.parameters.model_copy(update={'voice': OTHER_VOICE})})).status == 'applied'
        finish.set()
        await settled(runner)
        snapshot = store.snapshot(pid)
        [job] = snapshot.jobs
        assert job.status == 'succeeded' and not job.adopted
        assert job.inputSnapshot.spec.parameters.voice == job.execution.voice == VOICE
        assert payloads[0]['voice_id'] == VOICE
        assert snapshot.generationSpecs[-1].parameters.voice == OTHER_VOICE
        assert snapshot.generationSpecs[-1].currentResultId is None
        assert len(snapshot.assets) == len(snapshot.results) == 1
    finally:
        finish.set()
        await runner.close()


@pytest.mark.anyio
async def test_generic_openai_speech_keeps_its_existing_alloy_default(mp3):
    config = {**SPEECH_CONFIG, 'url': 'https://api.openai.com/v1', 'modelId': 'tts-1'}
    def handle(request):
        assert request.method == 'POST'
        payload = json.loads(request.content)
        assert payload['voice'] == 'alloy' and 'voice_id' not in payload
        return httpx.Response(200, content=mp3)
    result = await OpenAISpeech(httpx.MockTransport(handle)).speech(config, SpeechRequest('Read this'))
    assert result.data == mp3 and result.suffix == 'mp3'
    assert 'voiceRequired' not in input_rules(config)


@pytest.mark.anyio
async def test_command_saves_real_media_and_frozen_execution_reopens_idempotently(context, mp3):
    project, _, config = context
    store, pid, session = project
    image = config['kind'] == 'image'
    data = png() if image else mp3
    parameters = {'aspectRatio': '3:2'} if image else {'voice': VOICE}
    prompt = 'Draw a lake' if image else '字' * 4001
    references = []
    if image:
        note = CreationToolAssets(store).import_file(str(pid), str(uuid4()), 'note.md', b'Blue water and mountains', session)
        references.append(note['id'])
    calls = []
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            body = {'data': [{'url': LOCATOR}]} if image else {'url': LOCATOR}
            return httpx.Response(200, json=body)
        return httpx.Response(200, content=data)
    runner = runner_for(context, handle)
    try:
        runner.settings.update({'removeWatermark': True})
        request = command(project, config, prompt=prompt, parameters=parameters, references=references)
        receipt = await runner.execute(request, session=session)
        assert receipt.status == 'accepted', receipt
        await settled(runner)
        snapshot = store.snapshot(pid)
        [job] = snapshot.jobs
        assert job.status == 'succeeded' and job.adopted
        assert job.inputSnapshot.model.modelId == config['modelId']
        generated = next(asset for asset in snapshot.assets if asset.id == job.asset.assetId)
        assert generated.kind == config['kind']
        [payload] = [json.loads(call.content) for call in calls if call.method == 'POST']
        assert payload['model'] == config['modelId']
        if image:
            assert job.execution.size == '1536x1024'
            assert job.execution.responseFormat == 'url' and job.execution.outputFormat == 'png'
            assert job.execution.watermark is False and job.adapterParameters['watermark'] is False
            assert job.inputSnapshot.references[0].asset.assetId == UUID(note['id'])
            assert generated.metadata.mimeType == 'image/png'
            assert (generated.metadata.width, generated.metadata.height) == (32, 24)
            assert 'Draw a lake' in payload['prompt'] and 'Blue water and mountains' in payload['prompt']
            assert payload['output_watermark'] == {'enabled': False}
        else:
            assert job.inputSnapshot.spec.parameters.voice == job.execution.voice == VOICE
            assert job.execution.format == 'mp3'
            assert job.adapterParameters == dict(voice=VOICE, response_format='mp3', delivery_method='url', stream=False)
            assert generated.metadata.mimeType == 'audio/mpeg'
            assert generated.metadata.durationSeconds > 0 and generated.metadata.sampleRate == 24000
            assert payload['input'] == prompt and payload['voice_id'] == VOICE
        stream, _ = CreationAssets(store).open_media(pid, generated.id)
        with stream:
            assert stream.read() == data
        assert (await runner.execute(request, session=session)) == receipt
        assert sum(call.method == 'POST' for call in calls) == 1
        assert SECRET not in snapshot.model_dump_json()
        assert 'private-result-signature' not in snapshot.model_dump_json()
    finally:
        await runner.close()
    reopened = CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)
    assert reopened == snapshot and len(reopened.results) == 1


@pytest.mark.anyio
async def test_failed_download_recovers_original_url_after_model_removal_without_second_post(context, mp3):
    project, configs, config = context
    store, pid, session = project
    image = config['kind'] == 'image'
    data = png() if image else mp3
    parameters = {} if image else {'voice': VOICE}
    calls, healthy = [], False
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            body = {'data': [{'url': LOCATOR}]} if image else {'url': LOCATOR}
            return httpx.Response(200, json=body)
        assert str(request.url) == LOCATOR and 'authorization' not in request.headers
        if not healthy:
            raise httpx.ReadTimeout('temporary download outage', request=request)
        return httpx.Response(200, content=data)
    first = runner_for(context, handle)
    try:
        first._launch(*prepared(first, project, config, prompt='A blue lake', parameters=parameters))
        await settled(first)
        snapshot = store.snapshot(pid)
        [failed] = snapshot.jobs
        assert failed.recovery == 'download' and failed.resumeAllowed
        assert not snapshot.assets and not snapshot.results
        assert SECRET not in snapshot.model_dump_json()
        assert 'private-result-signature' not in snapshot.model_dump_json()
    finally:
        await first.close()
    configs.delete(config['id'])
    healthy = True
    reopened = CreationProjects(LocalProjects(store.local.repository))
    restarted = runner_for(((reopened, pid, session), configs, config), handle)
    try:
        await restarted.start()
        await settled(restarted)
        snapshot = reopened.snapshot(pid)
        assert snapshot.jobs[0].id == failed.id and snapshot.jobs[0].status == 'succeeded'
        assert len(snapshot.assets) == len(snapshot.results) == 1
        assert sum(call.method == 'POST' for call in calls) == 1
        assert all(str(call.url) == LOCATOR for call in calls if call.method == 'GET')
        stream, _ = CreationAssets(reopened).open_media(pid, snapshot.assets[0].id)
        with stream:
            assert stream.read() == data
    finally:
        await restarted.close()
