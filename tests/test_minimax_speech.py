"""MiniMax T2A wire contract and real MP3 persistence with mocked provider HTTP."""
import asyncio
import json
import socket
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from generation_helpers import command, prepared, settled
from opendirector.agent.tools import AgentTools
from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.voice_library import VoiceLibrary
from opendirector.domain.capabilities import SpeechRequest
from opendirector.domain.creation.generation import ResolvedReference, validate_generation
from opendirector.domain.creation.models import ModelConfigPublic
from opendirector.domain.generation import GenerationError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.domain.voices import voice_library_capabilities
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.model_adapters import MinimaxSpeech, OpenAISpeech, adapter_for
from opendirector.integrations.providers import GenerationProviders
from opendirector.integrations.reference_inputs import generation_references
from opendirector_api.main import create_app
from test_creation_canvas_service import project
from test_creation_generation_service import anyio_backend
from test_moss import mp3
from test_voice_library import Configs

URL = 'https://api.minimax.cn/v1'
RESULT = 'https://93.184.215.14/speech.mp3?signature=fixture-result-signature'
SECRET = 'minimax-test-key'
VOICE = 'Chinese (Mandarin)_Reliable_Executive'
CONFIG = dict(kind='audio', url=URL, modelId='speech-2.8-hd', apiKey=SECRET,
              protocol='openai', connectionType='api', authMode='bearer')
SUCCESS = dict(base_resp={'status_code': 0, 'status_msg': 'success'}, data={'audio': RESULT, 'status': 2})
VOICES = dict(base_resp={'status_code': 0}, system_voice=[
    {'voice_id': VOICE, 'voice_name': 'Narrator'}, {'voice_id': 'Santa_Claus ', 'voice_name': 'Santa Claus'},
])


@pytest.fixture
def context(project, tmp_path):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('audio', URL, CONFIG['modelId'], SECRET, protocol='openai')
    return project, configs, saved


def runner_for(context, handle):
    project, configs, _ = context
    runner = CreationGeneration(project[0], configs)
    transport = httpx.MockTransport(handle)
    runner.provider = GenerationProviders(runner.store, transport, retry_delays=(0, 0))
    runner.voices = VoiceLibrary(configs, transport)
    return runner


def selection(saved, voice=VOICE):
    return dict(voice=voice, voiceSelection=dict(voiceId=voice, name='Narrator', source='builtin',
        hasReferenceAudio=False, connectionId=saved['inputRules']['voiceLibrary']['connectionId']))


@pytest.mark.parametrize('model', ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd',
    'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo'])
def test_official_models_have_read_only_voice_library_and_shared_rules(model):
    config = {**CONFIG, 'modelId': model, 'url': URL + '/'}
    rules = input_rules(config)
    assert isinstance(adapter_for(config), MinimaxSpeech)
    assert rules['profile'] == 'minimax-speech'
    assert rules['voiceRequired'] and rules['referencesAllowed'] is False
    assert rules['maxPromptCharacters'] == 3000 and rules['allowedKinds'] == []
    library = rules['voiceLibrary']
    assert library['provider'] == 'minimax'
    assert not library['supportsUploadedVoices'] and not library['canDelete']
    assert not library['requiresReferenceAudio'] and not library['requiresTranscript']


@pytest.mark.parametrize('patch', [
    {'url': 'https://api.minimax.cn.evil.test/v1'}, {'url': 'https://api.minimax.io/v1'},
    {'url': 'http://api.minimax.cn/v1'}, {'url': 'https://api.minimax.cn:8443/v1'},
    {'url': 'https://api.minimax.cn/v2'},
    {'connectionType': 'self_hosted'},
])
def test_other_services_and_lookalikes_keep_the_generic_adapter(patch):
    config = {**CONFIG, **patch}
    assert isinstance(adapter_for(config), OpenAISpeech)
    assert input_rules(config)['profile'] != 'minimax-speech'


@pytest.mark.parametrize('entry', [input_rules, adapter_for])
def test_unknown_official_model_is_rejected(entry):
    with pytest.raises(ProjectError) as failure:
        entry({**CONFIG, 'modelId': 'speech-2.8-unknown'})
    assert failure.value.code == 'minimax_speech_model'


def test_unknown_official_model_has_no_voice_library(context):
    _, configs, saved = context
    config = {**configs.resolve(saved['id'], 'audio'), 'modelId': 'speech-2.8-unknown'}
    assert voice_library_capabilities(config) is None
    library = VoiceLibrary(Configs(config), httpx.MockTransport(
        lambda _: pytest.fail('unsupported model reached the voice provider')))
    with pytest.raises(ProjectError) as failure:
        library.list(saved['id'])
    assert failure.value.code == 'voice_library_unsupported'
    with pytest.raises(ProjectError) as failure:
        library.validate_selection(config, VOICE, selection(saved)['voiceSelection'])
    assert failure.value.code == 'voice_connection_changed'


@pytest.mark.parametrize('batch', [False, True])
@pytest.mark.parametrize('locale, message', [
    ('zh-CN', '不支持该 MiniMax 语音型号，请选择预设中的型号。'),
    ('en-US', 'Unsupported MiniMax speech model. Choose a model from the preset.'),
])
def test_unknown_model_save_is_localized_and_atomic(context, batch, locale, message):
    project, configs, _ = context
    before = configs.path.read_bytes()
    payload = {**CONFIG, 'modelId': 'speech-2.8-unknown'}
    if batch:
        payload['modelIds'] = ['speech-2.8-hd', payload.pop('modelId')]
    with TestClient(create_app(project[0].local), headers={
        'X-OpenDirector-Request': '1', 'Accept-Language': locale,
    }) as client:
        response = client.post('/api/model-configs' + ('/batch' if batch else ''), json=payload)
    assert response.status_code == 422
    assert response.json()['detail'] == message
    assert configs.path.read_bytes() == before


@pytest.mark.parametrize('page_size', [None, 1])
def test_system_voices_preserve_ids_and_account_scope(context, page_size):
    project, configs, saved = context
    calls = []
    def handle(request):
        calls.append(request)
        assert request.method == 'POST' and str(request.url) == URL + '/get_voice'
        assert json.loads(request.content) == {'voice_type': 'system'}
        assert request.headers['authorization'] == 'Bearer ' + SECRET
        return httpx.Response(200, json=VOICES)
    library = VoiceLibrary(configs, httpx.MockTransport(handle))
    listed = library.list(saved['id'], page_size=page_size)
    assert listed['capabilities']['acceptsTranscript'] is False
    assert [voice['voiceId'] for voice in listed['voices']] == [VOICE, 'Santa_Claus ']
    assert listed['nextCursor'] is None
    assert all(voice['compatible'] and voice['source'] == 'builtin' and not voice['canDelete']
               and voice['previewUrl'] is None for voice in listed['voices'])
    private = configs.resolve(saved['id'], 'audio')
    library.validate_selection(private, 'Santa_Claus ', listed['voices'][1])
    with pytest.raises(ProjectError) as failure:
        library.validate_selection(private, VOICE, {**listed['voices'][0], 'connectionId': 'stale'})
    assert failure.value.code == 'voice_connection_changed'
    with pytest.raises(ProjectError) as failure:
        library.create(saved['id'], b'', filename='voice.wav', name='Test')
    assert failure.value.code == 'voice_model_unsupported'
    with pytest.raises(ProjectError) as failure:
        library.delete(saved['id'], VOICE, listed['connectionId'])
    assert failure.value.code == 'voice_delete_unsupported'
    assert len(calls) == 2
    assert SECRET not in json.dumps(saved) + json.dumps(listed)
    business = AgentTools(project[0], None, configs)
    business.voices = library
    assert asyncio.run(business.execute(project[1], uuid4(), project[2], 'voice-list', 'voice_list',
        {'modelConfigId': saved['id']}, [], None)) == listed


@pytest.mark.parametrize('body', [{}, {'base_resp': {'status_code': False}, 'system_voice': []},
    {'base_resp': {'status_code': 0}, 'system_voice': None},
    {'base_resp': {'status_code': 0}, 'system_voice': [{'voice_id': '../voice'}]},
    {'base_resp': {'status_code': 0}, 'system_voice': [VOICES['system_voice'][0]] * 2}])
def test_voice_library_rejects_malformed_catalog(context, body):
    _, configs, saved = context
    library = VoiceLibrary(configs, httpx.MockTransport(lambda _: httpx.Response(200, json=body)))
    with pytest.raises(ProjectError) as failure:
        library.list(saved['id'])
    assert failure.value.code == 'voice_provider_protocol'


def test_voice_library_error_does_not_echo_provider_secrets(context):
    _, configs, saved = context
    body = {'base_resp': {'status_code': 1004, 'status_msg': SECRET + RESULT}}
    library = VoiceLibrary(configs, httpx.MockTransport(lambda _: httpx.Response(200, json=body)))
    with pytest.raises(ProjectError) as failure:
        library.list(saved['id'])
    assert failure.value.code == 'voice_provider_error'
    assert SECRET not in str(failure.value) and 'fixture-result-signature' not in str(failure.value)


@pytest.mark.anyio
@pytest.mark.parametrize('voice', [VOICE, 'Santa_Claus '])
async def test_exact_wire_request_checkpoint_and_credential_free_download(mp3, voice):
    calls, checkpoints = [], []
    async def ready(suffix, url):
        checkpoints.append((suffix, url))
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            assert str(request.url) == URL + '/t2a_v2'
            assert request.headers['authorization'] == 'Bearer ' + SECRET
            assert json.loads(request.content) == dict(model='speech-2.8-hd', text='🎙' * 3000,
                stream=False, voice_setting={'voice_id': voice}, audio_setting={'format': 'mp3'}, output_format='url')
            return httpx.Response(200, json=SUCCESS)
        assert checkpoints == [('mp3', RESULT)]
        assert str(request.url) == RESULT and 'authorization' not in request.headers
        return httpx.Response(200, content=mp3)
    adapter = adapter_for(CONFIG, httpx.MockTransport(handle))
    result = await adapter.speech(CONFIG, SpeechRequest('🎙' * 3000, voice), result_ready=ready)
    assert result.data == mp3 and result.suffix == 'mp3'
    assert [call.method for call in calls] == ['POST', 'GET']


@pytest.mark.anyio
@pytest.mark.parametrize('body', [{}, {'base_resp': {'status_code': False}, 'data': SUCCESS['data']},
    {'base_resp': {'status_code': 0}, 'data': None},
    {'base_resp': {'status_code': 0}, 'data': {'audio': RESULT, 'status': 1}},
    {'base_resp': {'status_code': 0}, 'data': {'audio': 'file:///tmp/voice.mp3', 'status': 2}},
    {'base_resp': {'status_code': 0}, 'data': {'audio': '494433', 'status': 2}}])
async def test_malformed_or_incomplete_submission_is_unknown_and_never_reposted(body):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=body)
    with pytest.raises(GenerationError) as failure:
        await MinimaxSpeech(httpx.MockTransport(handle)).speech(CONFIG, SpeechRequest('Read this', VOICE))
    assert failure.value.details.category == 'submission_unknown'
    assert len(calls) == 1 and calls[0].method == 'POST'


@pytest.mark.anyio
@pytest.mark.parametrize(('code', 'category'), [(1004, 'authentication'), (1008, 'quota'),
    (1002, 'rate_limit'), (2013, 'input'), (2054, 'input'), (1026, 'input'), (1001, 'temporary')])
async def test_http_200_provider_errors_are_safe_and_not_retried(code, category):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={'base_resp': {'status_code': code, 'status_msg': SECRET + RESULT},
                                        'trace_id': 'trace-fixture-1'})
    with pytest.raises(GenerationError) as failure:
        await MinimaxSpeech(httpx.MockTransport(handle)).speech(CONFIG, SpeechRequest('Read this', VOICE))
    details = failure.value.details
    assert details.category == category and details.providerCode == str(code)
    assert details.requestId == 'trace-fixture-1' and len(calls) == 1
    assert SECRET not in details.model_dump_json() and 'fixture-result-signature' not in details.model_dump_json()


@pytest.mark.anyio
async def test_submission_timeout_never_reposts():
    calls = []
    def handle(request):
        calls.append(request)
        raise httpx.ReadTimeout('unknown acceptance', request=request)
    with pytest.raises(GenerationError) as failure:
        await MinimaxSpeech(httpx.MockTransport(handle)).speech(CONFIG, SpeechRequest('Read this', VOICE))
    assert failure.value.details.category == 'submission_unknown' and len(calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize(('text', 'voice'), [('', VOICE), (' \n', VOICE), ('Read this', None),
    ('Read this', 'bad\nvoice'), ('Read this', ' '), ('x' * 3001, VOICE)],
    ids=['empty', 'blank', 'missing-voice', 'control-character', 'blank-voice', 'text-limit'])
async def test_direct_adapter_rejects_invalid_inputs_without_http(text, voice):
    adapter = MinimaxSpeech(httpx.MockTransport(lambda _: pytest.fail('invalid input reached HTTP')))
    with pytest.raises(ProjectError):
        await adapter.speech(CONFIG, SpeechRequest(text, voice))


@pytest.mark.anyio
@pytest.mark.parametrize('url', ['http://127.0.0.1/voice.mp3', 'http://169.254.169.254/latest/meta-data/',
                                 'http://[::1]/voice.mp3'])
async def test_result_download_rejects_private_addresses(url):
    adapter = MinimaxSpeech(httpx.MockTransport(lambda _: pytest.fail('private destination reached HTTP')))
    with pytest.raises(GenerationError):
        await adapter.download(CONFIG, url)


@pytest.mark.parametrize('source', ['ui', 'agent'])
@pytest.mark.parametrize(('prompt', 'voice', 'code'), [('Read this', None, 'minimax_speech_voice'),
    ('🎙' * 3001, VOICE, 'minimax_speech_text')], ids=['missing-voice', 'text-limit'])
def test_preflight_rejects_input_before_http_or_job(context, source, prompt, voice, code):
    project, _, saved = context
    runner = runner_for(context, lambda _: pytest.fail('invalid input reached HTTP'))
    request = command(project, saved, prompt=prompt, parameters=selection(saved, voice) if voice else {})
    before = project[0].snapshot(project[1])
    receipt = runner.prepare(request, session=project[2], source=source)
    assert receipt.status == 'rejected' and receipt.issues[0].code == code
    assert not receipt.jobIds and project[0].snapshot(project[1]) == before
    assert runner.prepare(request, session=project[2], source=source) == receipt


@pytest.mark.parametrize('transmission', ['content', 'context_only'])
def test_reference_boundaries_reject_even_context_only_inputs(context, transmission):
    project, _, saved = context
    store, pid, session = project
    asset = CreationToolAssets(store).import_file(str(pid), str(uuid4()), 'note.md', b'Reference words', session)
    runner = runner_for(context, lambda _: pytest.fail('references reached HTTP'))
    request = command(project, saved, parameters=selection(saved))
    snapshot = store.snapshot(pid)
    spec = next(item for item in snapshot.generationSpecs if item.id == request.payload.specId)
    reference = ResolvedReference(referenceId=uuid4(), role='reference', asset=asset_ref(snapshot.assets[0]),
        metadata=snapshot.assets[0].metadata, transmission=transmission)
    with pytest.raises(ValueError, match='参考'):
        validate_generation(spec, ModelConfigPublic.model_validate(saved), (reference,))
    with pytest.raises(ProjectError) as failure:
        generation_references(runner.store, dict(kind='audio', projectId=str(pid), prompt='Read this',
            referenceIds=[asset['id']], parameters={}), CONFIG)
    assert failure.value.code == 'minimax_speech_reference' and not store.snapshot(pid).jobs


@pytest.mark.parametrize(('prompt', 'voice', 'code', 'english', 'chinese'), [
    ('Read this', None, 'minimax_speech_voice',
     'Choose a voice available to your MiniMax account from the voice library.',
     '请从音色库选择 MiniMax 账户可用的音色。'),
    ('🎙' * 3001, VOICE, 'minimax_speech_text',
     'Enter the text to read aloud, up to 3,000 characters.',
     '请填写需要朗读的文本，且不超过 3,000 个字符。'),
], ids=['missing-voice', 'text-limit'])
def test_http_receipt_replay_switches_language_without_changing_storage(context, prompt, voice, code, english, chinese):
    project, _, saved = context
    store, pid, session = project
    request = command(project, saved, prompt=prompt, parameters=selection(saved, voice) if voice else {})
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}
    path = f'/api/creation/projects/{pid}'
    with TestClient(create_app(store.local), headers=headers) as client:
        response = client.post(path + '/commands', json=request.model_dump(mode='json'), headers={'Accept-Language': 'en-US'})
        assert response.status_code == 200
        receipt = response.json()
        assert receipt['issues'][0]['code'] == code
        assert receipt['issues'][0]['message'] == english
        assert client.get(path + f'/receipts/{request.commandId}', headers={'Accept-Language': 'en-US'}).json() == receipt
        localized = client.get(path + f'/receipts/{request.commandId}', headers={'Accept-Language': 'zh-CN'}).json()
        assert localized['issues'][0]['message'] == chinese
        assert localized == store.receipt(pid, request.commandId).model_dump(mode='json')
        assert not store.snapshot(pid).jobs


@pytest.mark.anyio
@pytest.mark.parametrize('source', ['ui', 'agent'])
async def test_real_mp3_snapshot_adoption_replay_and_reopen(context, mp3, source):
    project, _, saved = context
    store, pid, session = project
    calls = []
    def handle(request):
        calls.append(request)
        if request.url.path == '/v1/get_voice': return httpx.Response(200, json=VOICES)
        if request.method == 'POST': return httpx.Response(200, json=SUCCESS)
        return httpx.Response(200, content=mp3)
    runner = runner_for(context, handle)
    try:
        request = command(project, saved, prompt='Read this', parameters=selection(saved, 'Santa_Claus '))
        receipt = await runner.execute(request, session=session, source=source)
        assert receipt.status == 'accepted'
        await settled(runner)
        snapshot = store.snapshot(pid)
        [job] = snapshot.jobs
        assert job.status == 'succeeded' and job.adopted
        assert job.inputSnapshot.spec.parameters.voice == job.execution.voice == 'Santa_Claus '
        assert job.execution.format == 'mp3'
        assert job.adapterParameters == dict(voice='Santa_Claus ', format='mp3', output_format='url', stream=False)
        [asset] = snapshot.assets
        assert asset.metadata.mimeType == 'audio/mpeg' and asset.metadata.durationSeconds > 0
        stream, _ = CreationAssets(store).open_media(pid, asset.id)
        with stream: assert stream.read() == mp3
        assert await runner.execute(request, session=session, source=source) == receipt
        assert sum(call.url.path == '/v1/t2a_v2' for call in calls) == 1
        assert SECRET not in snapshot.model_dump_json() and 'fixture-result-signature' not in snapshot.model_dump_json()
    finally:
        await runner.close()
    assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid) == snapshot


@pytest.mark.anyio
@pytest.mark.parametrize('configuration_change', ['deleted', 'changed', 'retired'])
async def test_failed_download_recovers_after_model_removal_without_resubmitting(context, mp3, monkeypatch, configuration_change):
    project, configs, saved = context
    store, pid, session = project
    calls, healthy = [], False
    def handle(request):
        calls.append(request)
        if request.url.path == '/v1/get_voice': return httpx.Response(200, json=VOICES)
        if request.method == 'POST': return httpx.Response(200, json=SUCCESS)
        assert str(request.url) == RESULT and 'authorization' not in request.headers
        if not healthy: raise httpx.ReadTimeout('download outage', request=request)
        return httpx.Response(200, content=mp3)
    first = runner_for(context, handle)
    try:
        first._launch(*prepared(first, project, saved, prompt='Read this', parameters=selection(saved)))
        await settled(first)
        [failed] = store.snapshot(pid).jobs
        assert failed.recovery == 'download' and failed.resumeAllowed
        assert not store.snapshot(pid).assets
    finally:
        await first.close()
    if configuration_change == 'deleted':
        configs.delete(saved['id'])
    elif configuration_change == 'retired':
        monkeypatch.setattr('opendirector.domain.input_rules.MINIMAX_SPEECH_MODELS', frozenset())
        monkeypatch.setattr('opendirector.domain.voices.MINIMAX_SPEECH_MODELS', frozenset())
    else:
        configs.save('audio', 'https://changed.test/v1', 'tts-1', 'different-key', saved['id'], protocol='openai')
    healthy = True
    reopened = CreationProjects(LocalProjects(store.local.repository))
    restarted = runner_for(((reopened, pid, session), configs, saved), handle)
    try:
        await restarted.start()
        await settled(restarted)
        snapshot = reopened.snapshot(pid)
        assert snapshot.jobs[0].id == failed.id and snapshot.jobs[0].status == 'succeeded'
        assert len(snapshot.assets) == len(snapshot.results) == 1
        assert sum(call.url.path == '/v1/t2a_v2' for call in calls) == 1
    finally:
        await restarted.close()


@pytest.mark.anyio
@pytest.mark.parametrize('configuration_change', ['deleted', 'changed', 'retired'])
@pytest.mark.parametrize('destination', ['private', 'dns', 'redirect'])
async def test_recovery_keeps_public_download_checks(context, mp3, monkeypatch, configuration_change, destination):
    project, configs, saved = context
    store, pid, _ = project
    calls, recovering = [], False
    url = 'http://127.0.0.1/private' if destination == 'private' else 'https://cdn.test/speech.mp3'
    monkeypatch.setattr(socket, 'getaddrinfo', lambda host, port, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, '',
         ('127.0.0.1' if recovering and destination == 'dns' else '93.184.215.14', port)),
    ])
    def handle(request):
        calls.append(request)
        if request.url.path == '/v1/get_voice': return httpx.Response(200, json=VOICES)
        if request.method == 'POST':
            return httpx.Response(200, json={**SUCCESS, 'data': {'audio': url, 'status': 2}})
        if not recovering: raise httpx.ReadTimeout('download outage', request=request)
        if destination == 'redirect' and request.url.path != '/private':
            return httpx.Response(302, headers={'Location': 'http://127.0.0.1/private'})
        return httpx.Response(200, content=mp3)
    first = runner_for(context, handle)
    try:
        first._launch(*prepared(first, project, saved, prompt='Read this', parameters=selection(saved)))
        await settled(first)
        [job] = store.snapshot(pid).jobs
        assert job.recovery == 'download'
    finally:
        await first.close()
    if configuration_change == 'deleted':
        configs.delete(saved['id'])
    elif configuration_change == 'retired':
        monkeypatch.setattr('opendirector.domain.input_rules.MINIMAX_SPEECH_MODELS', frozenset())
        monkeypatch.setattr('opendirector.domain.voices.MINIMAX_SPEECH_MODELS', frozenset())
    else:
        configs.save('audio', 'https://changed.test/v1', 'tts-1', 'different-key', saved['id'], protocol='openai')
    recovering = True
    before = len(calls)
    restarted = runner_for(context, handle)
    try:
        await restarted.start()
        await settled(restarted)
        snapshot = store.snapshot(pid)
        assert snapshot.jobs[0].errorDetails.category == 'protocol'
        assert snapshot.jobs[0].errorDetails.stage == 'download'
        assert len(calls) - before == (1 if destination == 'redirect' else 0)
        assert all(call.url.host == '93.184.215.14' and 'authorization' not in call.headers
                   for call in calls if call.method == 'GET')
        assert not snapshot.assets and not snapshot.results
        assert sum(call.url.path == '/v1/t2a_v2' for call in calls) == 1
    finally:
        await restarted.close()


@pytest.mark.anyio
async def test_invalid_mp3_never_publishes_an_asset(context):
    project, _, saved = context
    def handle(request):
        if request.url.path == '/v1/get_voice': return httpx.Response(200, json=VOICES)
        if request.method == 'POST': return httpx.Response(200, json=SUCCESS)
        return httpx.Response(200, content=b'ID3not-decodable-mp3')
    runner = runner_for(context, handle)
    try:
        await runner.execute(command(project, saved, parameters=selection(saved)), session=project[2])
        await settled(runner)
        snapshot = project[0].snapshot(project[1])
        assert snapshot.jobs[0].status == 'failed' and not snapshot.assets and not snapshot.results
    finally:
        await runner.close()
