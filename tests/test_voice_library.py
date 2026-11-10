"""Voice provider contracts, verified upload media and connection identity."""
import io
import json
import wave
from uuid import uuid4

import httpx
import pytest

from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError


def config(model='MOSS-TTS-Nano', **patch):
    return dict(id=str(uuid4()), kind='audio', url='http://voice.test/v1', modelId=model,
                protocol='openai', connectionType='self_hosted', authMode='bearer', apiKey='private-key', **patch)


class Configs:
    def __init__(self, value): self.value = value
    def resolve(self, identity, kind):
        assert identity == self.value['id'] and kind == 'audio'
        return self.value


def library(value, handler):
    from opendirector.application.voice_library import VoiceLibrary
    return VoiceLibrary(Configs(value), transport=httpx.MockTransport(handler))


def wav(seconds=2):
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
        audio.writeframes(b'\0\0' * int(16000 * seconds))
    return stream.getvalue()


def test_scoped_capabilities_change_account_and_endpoint_but_not_model():
    current = config()
    rules = input_rules(current).get('voiceLibrary')
    assert rules is not None
    assert rules['requiresReferenceAudio'] and not rules['requiresTranscript']
    assert input_rules({**current, 'modelId': 'MOSS-TTS-Drama3'})['voiceLibrary']['connectionId'] == rules['connectionId']
    for patch in ({'apiKey': 'different'}, {'url': 'http://other.test/v1'}):
        assert input_rules({**current, **patch})['voiceLibrary']['connectionId'] != rules['connectionId']
    assert 'private-key' not in json.dumps(rules)


def test_vllm_actual_string_list_and_uploaded_records():
    value = config('MOSS-TTS-Drama3')
    service = library(value, lambda request: httpx.Response(200, json={
        'voices': ['default', 'alice', '张三'], 'uploaded_voices': [
            {'name': 'Alice', 'embedding_source': 'audio', 'ref_text': 'hello'},
            {'id': '张三', 'name': '张三', 'embedding_source': 'embedding'}]}))
    result = service.list(value['id'])
    voices = {voice['voiceId']: voice for voice in result['voices']}
    assert len(voices) == 3
    assert voices['alice']['source'] == 'uploaded' and voices['alice']['compatible']
    assert voices['alice']['refText'] == 'hello' and voices['alice']['hasReferenceAudio']
    assert voices['张三']['incompatibility'] == 'voice_reference_required'
    assert not voices['default']['canDelete'] and voices['default']['previewUrl'] is None


@pytest.mark.parametrize('consent', [None, True, '   '])
def test_vllm_requires_a_consent_recording_id(consent):
    value = config()
    service = library(value, lambda request: pytest.fail('invalid consent reached the provider'))
    with pytest.raises(ProjectError) as error:
        service.create(value['id'], wav(), filename='sample.wav', name='Alice', consent=consent)
    assert error.value.code == 'voice_consent_required'


def test_moss_cursor_pagination_and_identity():
    value = config('moss-tts-1.5-flash'); value.update(url='https://api.mosi.cn/v1', connectionType='api')
    seen = []
    def handle(request):
        seen.append(str(request.url))
        assert request.headers['authorization'] == 'Bearer private-key'
        if request.url.params.get('after'):
            return httpx.Response(200, json={'data': [{'id': 'v2', 'name': 'Two'}], 'has_more': False})
        return httpx.Response(200, json={'data': [{'id': 'v1', 'name': 'One'}], 'has_more': True, 'next_cursor': 'page2'})
    result = library(value, handle).list(value['id'])
    assert [voice['voiceId'] for voice in result['voices']] == ['v1', 'v2']
    assert len(seen) == 2 and 'after=page2' in seen[1]
    assert not result['capabilities']['canDelete']


def test_pagination_loop_is_rejected():
    value = config('moss-tts-1.5-flash'); value.update(url='https://api.mosi.cn/v1', connectionType='api')
    service = library(value, lambda request: httpx.Response(200, json={'data': [{'id': 'same'}], 'has_more': True, 'next_cursor': 'repeat'}))
    with pytest.raises(ProjectError) as error: service.list(value['id'])
    assert error.value.code == 'voice_provider_protocol'


@pytest.mark.parametrize('provider', ['moss', 'vllm'])
def test_create_uses_provider_fields_and_returned_id(provider):
    value = config('MOSS-TTS-Drama3')
    if provider == 'moss': value.update(modelId='moss-tts-1.5-flash', url='https://api.mosi.cn/v1', connectionType='api')
    def handle(request):
        body = request.read()
        assert b'name="audio_sample"' in body and b'RIFF' in body
        if provider == 'vllm':
            assert b'name="consent"\r\n\r\nconsent-fixture-01\r\n' in body
            assert b'name="ref_text"' in body
            return httpx.Response(200, json={'success': True, 'voice': {'name': 'Alice', 'embedding_source': 'audio', 'ref_text': 'hello'}})
        assert b'name="consent"' not in body and b'name="ref_text"' not in body
        return httpx.Response(200, json={'id': 'cloud-id', 'name': 'Alice', 'object': 'audio.voice'})
    result = library(value, handle).create(value['id'], wav(), filename='sample.wav', name='Alice', consent='consent-fixture-01', ref_text='hello')
    assert result['voiceId'] == ('alice' if provider == 'vllm' else 'cloud-id')
    assert result['source'] == 'uploaded'


@pytest.mark.parametrize('data,filename,code', [(b'not audio', 'sample.wav', 'voice_audio_invalid'), (wav(.2), 'sample.wav', 'voice_duration'), (wav(), 'sample.exe', 'voice_format')], ids=['invalid-audio', 'too-short', 'invalid-extension'])
def test_invalid_actual_audio_never_calls_provider(data, filename, code):
    value = config()
    service = library(value, lambda request: pytest.fail('invalid upload reached provider'))
    with pytest.raises(ProjectError) as error:
        service.create(value['id'], data, filename=filename, name='Alice', consent='consent-fixture-01')
    assert error.value.code == code


def test_drama_transcript_and_nano_default_cannot_bypass_validation():
    value = config('MOSS-TTS-Drama3')
    service = library(value, lambda request: pytest.fail('missing transcript reached provider'))
    with pytest.raises(ProjectError) as error: service.create(value['id'], wav(), filename='sample.wav', name='Alice', consent='consent-fixture-01')
    assert error.value.code == 'voice_transcript_required'
    value['modelId'] = 'MOSS-TTS-Nano'
    service = library(value, lambda request: httpx.Response(200, json={'voices': ['default'], 'uploaded_voices': []}))
    with pytest.raises(ProjectError) as error: service.validate_selection(value, 'default', None)
    assert error.value.code == 'voice_reference_required'


def test_delete_guards_scope_and_builtin():
    value = config()
    service = library(value, lambda request: httpx.Response(200, json={'voices': ['default'], 'uploaded_voices': []}))
    scope = input_rules(value)['voiceLibrary']['connectionId']
    for connection, code in [('other', 'voice_connection_changed'), (scope, 'voice_delete_unsupported')]:
        with pytest.raises(ProjectError) as error: service.delete(value['id'], 'default', connection)
        assert error.value.code == code


def test_explicit_connection_identity_separates_identical_services():
    value = config()
    from opendirector.domain.voices import voice_library_capabilities
    base = voice_library_capabilities(value)['connectionId']
    assert voice_library_capabilities({**value, 'id': str(uuid4())})['connectionId'] != base
    left = voice_library_capabilities({**value, 'providerId': 'shared'})['connectionId']
    right = voice_library_capabilities({**value, 'id': str(uuid4()), 'providerId': 'shared', 'modelId': 'MOSS-TTS-Drama3'})['connectionId']
    assert left == right


def test_provider_error_redacts_credentials_but_keeps_diagnosis():
    value = config()
    service = library(value, lambda request: httpx.Response(400, json={'error': {'message': 'bad ref_text private-key'}}))
    with pytest.raises(ProjectError) as error: service.list(value['id'])
    assert 'bad ref_text' in str(error.value) and 'private-key' not in str(error.value)


def test_preview_proxy_only_authenticates_same_origin():
    value = config()
    seen = []
    def handle(request):
        seen.append(request)
        if request.url.path == '/v1/audio/voices':
            return httpx.Response(200, json={'voices': ['alice'], 'uploaded_voices': [
                {'id': 'alice', 'name': 'Alice', 'preview_url': 'https://cdn.test/alice.wav?signature=private'}]})
        assert str(request.url) == 'https://cdn.test/alice.wav?signature=private'
        assert 'authorization' not in request.headers
        return httpx.Response(200, content=wav(), headers={'content-type': 'audio/wav'})
    service = library(value, handle)
    record = service.list(value['id'])['voices'][0]
    assert record['previewUrl'].startswith('/api/voices/alice/preview?')
    assert 'signature' not in record['previewUrl']
    data, mime = service.preview(value['id'], 'alice', record['connectionId'])
    assert data.startswith(b'RIFF') and mime == 'audio/wav'


def test_selection_ignores_forged_reference_metadata_and_rechecks_deleted_voice():
    value = config('MOSS-TTS-Drama3')
    service = library(value, lambda request: httpx.Response(200, json={'voices': ['alice'], 'uploaded_voices': [
        {'id': 'alice', 'name': 'Alice', 'embedding_source': 'audio'}]}))
    scope = input_rules(value)['voiceLibrary']['connectionId']
    selection = dict(connectionId=scope, voiceId='alice', name='Alice', source='uploaded', hasReferenceAudio=True, refText='forged text')
    with pytest.raises(ProjectError) as error: service.validate_selection(value, 'alice', selection)
    assert error.value.code == 'voice_transcript_required'
    selection['voiceId'] = 'deleted'
    with pytest.raises(ProjectError) as error: service.validate_selection(value, 'deleted', selection)
    assert error.value.code == 'voice_not_found'


def test_scoped_voice_supports_uploaded_unicode_names_and_spaces():
    from opendirector.domain.creation.generation import AudioParameters
    selection = dict(connectionId='scope', voiceId='张三 narrator', name='张三', source='uploaded', hasReferenceAudio=True, refText='hello')
    assert AudioParameters(voice='张三 narrator', voiceSelection=selection).voice == '张三 narrator'


@pytest.mark.parametrize('model', ['Drama3', 'OpenMOSS/Drama3-8B'])
def test_standalone_drama3_requires_transcript(model):
    rules = input_rules(config(model))['voiceLibrary']
    assert rules['requiresReferenceAudio'] and rules['requiresTranscript']


@pytest.mark.parametrize('model,needs_audio,needs_transcript', [
    ('IndexTeam/IndexTTS-2', True, False),
    ('IndexTeam/IndexTTS-2.5', True, False),
    ('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', True, True),
    ('fishaudio/s2-pro', False, True),
    ('fishaudio/drama-3', False, True),
    ('fishaudio/drama-3-int4', False, True),
    ('bosonai/higgs-audio-v2-generation-3B-base', False, True),
    ('bosonai/higgs-audio-v3-tts-4b', False, False),
])
def test_adapter_rules_for_plain_speech_and_registered_audio(model, needs_audio, needs_transcript):
    value = config(model)
    def handle(request):
        assert request.method == 'GET'
        return httpx.Response(200, json={'voices': ['default', 'silent', 'narrator'], 'uploaded_voices': [
            {'id': 'silent', 'embedding_source': 'audio'},
            {'id': 'narrator', 'embedding_source': 'audio', 'ref_text': 'Recorded text.'},
        ]})
    service = library(value, handle)
    listed = service.list(value['id'])
    assert listed['capabilities']['requiresTranscript'] is needs_transcript
    assert listed['capabilities']['requiresReferenceAudio'] is needs_audio
    voices = {record['voiceId']: record for record in listed['voices']}
    assert voices['default']['compatible'] is (not needs_audio)
    assert voices['silent']['compatible'] is (not needs_transcript)
    assert voices['narrator']['compatible']
    service.validate_selection(value, 'narrator', voices['narrator'])
    if needs_audio:
        with pytest.raises(ProjectError) as error:
            service.validate_selection(value, 'default', None)
        assert error.value.code == 'voice_reference_required'
    else:
        service.validate_selection(value, None, None)
        service.validate_selection(value, 'default', voices['default'])
    if needs_transcript:
        with pytest.raises(ProjectError) as error:
            service.create(value['id'], wav(), name='new', filename='sample.wav', consent='consent-fixture-01')
        assert error.value.code == 'voice_transcript_required'
        with pytest.raises(ProjectError) as error:
            service.validate_selection(value, 'silent', None)
        assert error.value.code == 'voice_transcript_required'


def test_delete_uploaded_voice_uses_provider_name_and_confirmed_success():
    value = config()
    methods = []
    def handle(request):
        methods.append((request.method, str(request.url)))
        if request.method == 'GET': return httpx.Response(200, json={'voices': ['alice'], 'uploaded_voices': [{'id': 'alice', 'name': 'Alice', 'embedding_source': 'audio'}]})
        return httpx.Response(200, json={'success': True})
    service = library(value, handle)
    service.delete(value['id'], 'alice', input_rules(value)['voiceLibrary']['connectionId'])
    assert methods[-1] == ('DELETE', 'http://voice.test/v1/audio/voices/alice')


def test_upload_rejects_real_duration_and_actual_container_mismatch():
    value = config('moss-tts-1.5-flash'); value.update(url='https://api.mosi.cn/v1', connectionType='api')
    service = library(value, lambda request: pytest.fail('invalid actual file reached provider'))
    for data, filename, code in [(wav(31), 'sample.wav', 'voice_duration'), (wav(), 'sample.mp3', 'voice_format'), (b'x' * (10 * 1024 * 1024 + 1), 'sample.wav', 'voice_size')]:
        with pytest.raises(ProjectError) as error:
            service.create(value['id'], data, filename=filename, name='Alice', consent='consent-fixture-01')
        assert error.value.code == code


@pytest.fixture
def voice_api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from opendirector.application.voice_library import VoiceLibrary
    from opendirector.infrastructure.local_projects import LocalProjects
    from opendirector.infrastructure.model_configs import ModelConfigs
    from opendirector_api.main import create_app
    configs = ModelConfigs(tmp_path)
    public = configs.save('audio', 'http://voice.test/v1', 'Drama3', '', connection_type='self_hosted', protocol='openai', auth_mode='none')
    original = VoiceLibrary.__init__
    def handle(request):
        if request.method == 'GET': return httpx.Response(200, json={'voices': ['default'], 'uploaded_voices': []})
        return httpx.Response(200, json={'success': True, 'voice': {'id': 'alice', 'name': 'Alice', 'ref_text': 'hello'}})
    monkeypatch.setattr(VoiceLibrary, '__init__', lambda self, configs, transport=None: original(self, configs, httpx.MockTransport(handle)))
    with TestClient(create_app(LocalProjects(tmp_path)), headers={'X-OpenDirector-Request': '1'}) as client:
        yield client, public


def test_http_routes_use_shared_service_and_localize_errors(voice_api):
    client, public = voice_api
    listed = client.get('/api/voices', params={'modelConfigId': public['id']})
    assert listed.status_code == 200
    scope = listed.json()['connectionId']
    params = {'modelConfigId': public['id']}
    fields = dict(connectionId=scope, name='Alice', consent='consent-fixture-01')
    files = {'audio_sample': ('sample.wav', wav(), 'audio/wav')}
    response = client.post('/api/voices', params=params, data=fields, files=files, headers={'Accept-Language': 'en-US'})
    assert response.status_code == 422 and response.json()['code'] == 'voice_transcript_required'
    assert 'transcript' in response.json()['detail']
    fields_at_limit = {**fields, 'refText': '🎙' * 100000, 'speakerDescription': '🎙' * 4000}
    response = client.post('/api/voices', params=params, data=fields_at_limit, files=files)
    assert response.status_code == 200 and response.json()['voiceId'] == 'alice'
    response = client.post('/api/voices', params=params, data={**fields, 'refText': 'hello', 'connectionId': 'stale'}, files=files)
    assert response.status_code == 409 and response.json()['code'] == 'voice_connection_changed'
    response = client.post('/api/voices', params=params, content=wav(), headers={'Accept-Language': 'zh-CN'})
    assert response.status_code == 415 and '上传' in response.json()['detail']


@pytest.mark.parametrize('scope_field', [{}, {'connectionId': ''}])
def test_http_create_requires_the_connection_from_the_form(voice_api, scope_field, monkeypatch):
    from opendirector.application.voice_library import VoiceLibrary
    monkeypatch.setattr(VoiceLibrary, '_request', lambda *a, **kw: pytest.fail('unscoped upload reached the provider'))
    client, public = voice_api
    scope = public['inputRules']['voiceLibrary']['connectionId']
    response = client.post('/api/voices', params={'modelConfigId': public['id'], 'connectionId': scope},
                           data={'name': 'Alice', 'consent': 'fixture', 'refText': 'Hello', **scope_field},
                           files={'audio_sample': ('sample.wav', wav())})
    assert response.status_code == 409 and response.json()['code'] == 'voice_connection_changed'


@pytest.mark.parametrize('field,limit,code,english,chinese', [
    ('refText', 100000, 'voice_transcript_too_long', 'transcript', '转写文本'),
    ('speakerDescription', 4000, 'voice_description_too_long', 'description', '说话人描述'),
])
def test_http_create_localizes_oversized_voice_metadata(voice_api, field, limit, code, english, chinese):
    client, public = voice_api
    fields = dict(connectionId=public['inputRules']['voiceLibrary']['connectionId'],
                  name='Alice', consent='fixture', refText='hello')
    for language, word, character in [('en-US', english, 'a'), ('zh-CN', chinese, '🎙')]:
        response = client.post('/api/voices', params={'modelConfigId': public['id']},
                               data={**fields, field: character * (limit + 1)},
                               files={'audio_sample': ('sample.wav', wav())}, headers={'Accept-Language': language})
        assert response.status_code == 422 and response.json()['code'] == code
        detail = response.json()['detail']
        assert word in detail and str(limit) in detail.replace(',', '')


def test_multipart_limits_bound_file_and_chunked_request():
    import asyncio
    from fastapi import Request
    from opendirector_api.voices import _voice_upload

    def parse(audio_size, chunk_size):
        payload = httpx.Request('POST', 'http://test/voices', files={'audio_sample': ('test.wav', b'a' * audio_size)})
        content = payload.read()
        consumed = 0
        async def receive():
            nonlocal consumed
            block = content[consumed:consumed + chunk_size]
            consumed += len(block)
            return {'type': 'http.request', 'body': block, 'more_body': consumed < len(content)}
        request = Request({'type': 'http', 'headers': [(b'content-type', payload.headers['content-type'].encode())]}, receive)
        with pytest.raises(ProjectError) as failure:
            asyncio.run(_voice_upload(request, 128))
        assert failure.value.status == 413 and failure.value.code == 'voice_size'
        return consumed

    # A file just over the provider cap still fits within the multipart overhead allowance.
    parse(129, 64)
    # Stop reading an unbounded chunked upload before the entire file is parsed.
    assert parse(600000, 8192) < 600000


def test_generation_rejects_forged_or_deleted_scope_before_job_acceptance(tmp_path):
    from generation_helpers import new_project, command
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.infrastructure.model_configs import ModelConfigs
    project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    public = configs.save('audio', 'http://voice.test/v1', 'MOSS-TTS-Nano', '', connection_type='self_hosted', protocol='openai', auth_mode='none')
    runner = CreationGeneration(project[0], configs)
    runner.voices = library(configs.resolve(public['id'], 'audio'), lambda request: httpx.Response(200, json={'voices': ['default'], 'uploaded_voices': []}))
    scope = public['inputRules']['voiceLibrary']['connectionId']
    for selected_scope, voice, code in [('stale', 'alice', 'voice_connection_changed'), (scope, 'deleted', 'voice_not_found'), (scope, 'default', 'voice_reference_required')]:
        selection = dict(connectionId=selected_scope, voiceId=voice, name='Alice', source='uploaded', hasReferenceAudio=True, refText='forged')
        request = command(project, public, parameters=dict(voice=voice, voiceSelection=selection))
        receipt = runner.prepare(request, session=project[2])
        assert receipt.status == 'rejected' and receipt.issues[0].code == code
        assert project[0].snapshot(project[1]).jobs == ()


def test_moss_create_does_not_require_vllm_consent():
    value = config('moss-tts-1.5-flash'); value.update(url='https://api.mosi.cn/v1', connectionType='api')
    service = library(value, lambda request: httpx.Response(200, json={'id': 'cloud-id', 'name': 'Alice'}))
    assert service.create(value['id'], wav(), filename='sample.wav', name='Alice')['voiceId'] == 'cloud-id'


def test_agent_voice_operations_share_service_and_confine_recording_path(tmp_path):
    import asyncio
    from opendirector.agent.tools import AgentTools
    from opendirector.infrastructure.creation_projects import CreationProjects
    from opendirector.infrastructure.local_projects import LocalProjects
    from opendirector.infrastructure.model_configs import ModelConfigs
    configs = ModelConfigs(tmp_path)
    public = configs.save('audio', 'http://voice.test/v1', 'Drama3', '', connection_type='self_hosted', protocol='openai', auth_mode='none')
    service = library(configs.resolve(public['id'], 'audio'), lambda request: httpx.Response(200, json=
        {'voices': ['default'], 'uploaded_voices': []} if request.method == 'GET' else
        {'success': True, 'voice': {'id': 'alice', 'name': 'Alice', 'ref_text': 'hello'}}))
    business = AgentTools(CreationProjects(LocalProjects(tmp_path)), None, configs)
    business.voices = service
    project_id, turn_id = uuid4(), uuid4()
    work = tmp_path / 'work'; work.mkdir()
    audio = work / 'sample.wav'; audio.write_bytes(wav())
    async def execute(name, arguments):
        return await business.execute(project_id, turn_id, 'session', name, name, arguments, [], None, execution_directory=work)
    listed = asyncio.run(execute('voice_list', {'modelConfigId': public['id']}))
    assert listed == service.list(public['id'])
    arguments = dict(modelConfigId=public['id'], connectionId=listed['connectionId'], path=str(audio), name='Alice', consent='consent-fixture-01', refText='hello')
    created = asyncio.run(execute('voice_create', arguments))
    assert created['voiceId'] == 'alice' and created['refText'] == 'hello'
    for field, limit, code in [('refText', 100000, 'voice_transcript_too_long'),
                               ('speakerDescription', 4000, 'voice_description_too_long')]:
        with pytest.raises(ProjectError) as error:
            asyncio.run(execute('voice_create', {**arguments, field: 'x' * (limit + 1)}))
        assert error.value.code == code
    outside = tmp_path / 'outside.wav'; outside.write_bytes(wav())
    with pytest.raises(ProjectError) as error: asyncio.run(execute('voice_create', {**arguments, 'path': str(outside)}))
    assert error.value.status == 403


@pytest.mark.parametrize('locator', ['http://[broken/sample.wav', 'http://cdn.test:bad/sample.wav', 'file:///private.wav'])
def test_invalid_provider_preview_locator_is_unavailable(locator):
    value = config()
    service = library(value, lambda request: httpx.Response(200, json={'voices': [], 'uploaded_voices': [
        {'id': 'alice', 'name': 'Alice', 'preview_url': locator}]}))
    assert service.list(value['id'])['voices'][0]['previewUrl'] is None


@pytest.mark.parametrize('model', ['OpenMOSS/MOSS-TTS', 'MOSS-TTS-Realtime', 'MOSS-TTS-Local-Transformer', 'MOSS-TTS-Nano'])
def test_full_moss_family_requires_registered_audio(model):
    value = config(model)
    capabilities = input_rules(value)['voiceLibrary']
    assert capabilities['requiresReferenceAudio']
    service = library(value, lambda request: httpx.Response(200, json={'voices': ['default'], 'uploaded_voices': []}))
    with pytest.raises(ProjectError) as error: service.validate_selection(value, 'default', None)
    assert error.value.code == 'voice_reference_required'


@pytest.mark.parametrize('variant', ['CustomVoice', 'VoiceDesign'])
def test_qwen_checkpoint_rejects_uploaded_base_voices_and_creation(variant):
    value = config('Qwen/Qwen3-TTS-12Hz-1.7B-' + variant)
    methods = []
    def handle(request):
        methods.append(request.method)
        return httpx.Response(200, json={'voices': ['default', 'alice'], 'uploaded_voices': [
            {'id': 'alice', 'name': 'Alice', 'embedding_source': 'audio', 'ref_text': 'hello'}]})
    service = library(value, handle)
    listed = service.list(value['id'])
    assert listed['capabilities']['supportsUploadedVoices'] is False
    voice = next(voice for voice in listed['voices'] if voice['voiceId'] == 'alice')
    assert not voice['compatible'] and voice['incompatibility'] == 'voice_model_unsupported'
    with pytest.raises(ProjectError) as error: service.create(value['id'], wav(), filename='sample.wav', name='Alice', consent='consent-fixture-01')
    assert error.value.code == 'voice_model_unsupported' and 'POST' not in methods
    with pytest.raises(ProjectError) as error: service.validate_selection(value, 'alice', None)
    assert error.value.code == 'voice_model_unsupported'


def test_qwen_customvoice_keeps_builtin_voice_compatible():
    value = config('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice')
    service = library(value, lambda request: httpx.Response(200, json={'voices': ['vivian'], 'uploaded_voices': []}))
    record = service.list(value['id'])['voices'][0]
    assert record['compatible'] and record['source'] == 'builtin'


def test_generation_voice_lookup_runs_outside_global_storage_lock(tmp_path):
    from generation_helpers import new_project, command
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.application.voice_library import VoiceLibrary
    from opendirector.infrastructure.model_configs import ModelConfigs
    project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    public = configs.save('audio', 'http://voice.test/v1', 'MOSS-TTS-Nano', '', connection_type='self_hosted', protocol='openai', auth_mode='none')
    runner = CreationGeneration(project[0], configs)
    def handle(request):
        assert not project[0].local.lock.is_locked, 'voice HTTP must not hold global catalog lock'
        return httpx.Response(200, json={'voices': ['alice'], 'uploaded_voices': [{'id': 'alice', 'name': 'Alice', 'embedding_source': 'audio'}]})
    runner.voices = VoiceLibrary(configs, transport=httpx.MockTransport(handle))
    selection = dict(connectionId=public['inputRules']['voiceLibrary']['connectionId'], voiceId='alice', name='Alice', source='uploaded', hasReferenceAudio=True, refText=None)
    request = command(project, public, parameters=dict(voice='alice', voiceSelection=selection))
    receipt = runner.prepare(request, session=project[2])
    assert receipt.status == 'accepted'
    assert len(project[0].snapshot(project[1]).jobs) == 1


@pytest.mark.parametrize('size,dimension', [('0.6B', 1024), ('1.7B', 2048)])
def test_qwen_base_requires_reference_or_matching_registered_embedding(size, dimension):
    value = config('Qwen/Qwen3-TTS-12Hz-' + size + '-Base')
    def handle(request):
        return httpx.Response(200, json={'voices': ['default', 'audio', 'direct', 'wrong'], 'uploaded_voices': [
            {'id': 'audio', 'embedding_source': 'audio'},
            {'id': 'direct', 'embedding_source': 'direct', 'embedding_dim': dimension},
            {'id': 'wrong', 'embedding_source': 'direct', 'embedding_dim': 777}]})
    service = library(value, handle)
    listed = service.list(value['id'])
    assert listed['capabilities']['referenceEmbeddingDimension'] == dimension
    assert listed['capabilities']['requiresReferenceAudio']
    records = {record['voiceId']: record for record in listed['voices']}
    assert records['default']['incompatibility'] == 'voice_reference_required'
    assert records['audio']['compatible'] and records['direct']['compatible']
    assert records['direct']['embeddingDim'] == dimension
    assert records['wrong']['incompatibility'] == 'voice_model_unsupported'
    service.validate_selection(value, 'direct', records['direct'])


def test_unknown_embedding_metadata_does_not_claim_compatibility():
    value = config('Qwen3-TTS')
    service = library(value, lambda request: httpx.Response(200, json={'voices': [], 'uploaded_voices': [
        {'id': 'direct', 'embedding_source': 'direct'}]}))
    assert service.list(value['id'])['voices'][0]['incompatibility'] == 'voice_model_unsupported'


def test_generation_rechecks_configuration_after_voice_preflight(tmp_path):
    from generation_helpers import new_project, command
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.application.voice_library import VoiceLibrary
    from opendirector.infrastructure.model_configs import ModelConfigs
    project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    public = configs.save('audio', 'http://voice.test/v1', 'MOSS-TTS-Nano', '', connection_type='self_hosted', protocol='openai', auth_mode='none')
    runner = CreationGeneration(project[0], configs)
    def handle(request):
        assert not project[0].local.lock.is_locked
        configs.save('audio', 'http://changed.test/v1', 'MOSS-TTS-Nano', '', public['id'], connection_type='self_hosted', protocol='openai', auth_mode='none')
        return httpx.Response(200, json={'voices': ['alice'], 'uploaded_voices': [{'id': 'alice', 'name': 'Alice', 'embedding_source': 'audio'}]})
    runner.voices = VoiceLibrary(configs, transport=httpx.MockTransport(handle))
    selection = dict(connectionId=public['inputRules']['voiceLibrary']['connectionId'], voiceId='alice', name='Alice', source='uploaded', hasReferenceAudio=True, refText=None)
    request = command(project, public, parameters=dict(voice='alice', voiceSelection=selection))
    receipt = runner.prepare(request, session=project[2])
    assert receipt.status == 'rejected' and receipt.issues[0].code == 'revision_conflict'
    assert project[0].snapshot(project[1]).jobs == ()


def moss_config():
    value = config('moss-tts-1.5-flash')
    value.update(url='https://api.mosi.cn/v1', connectionType='api')
    return value


def test_paginated_http_list_reads_only_the_requested_page():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from opendirector_api.voices import voice_routes

    calls = []
    value = moss_config()
    def handle(request):
        params = dict(request.url.params)
        calls.append(params)
        if 'after' in params:
            return httpx.Response(200, json={'data': [{'id': 'two'}], 'has_more': False})
        return httpx.Response(200, json={'data': [{'id': 'one'}], 'has_more': True, 'next_cursor': 'next/2='})

    app = FastAPI()
    app.include_router(voice_routes(library(value, handle)))
    with TestClient(app) as client:
        query = {'modelConfigId': value['id'], 'pageSize': 1}
        first = client.get('/api/voices', params=query)
        assert first.status_code == 200
        data = first.json()
        assert [row['voiceId'] for row in data['voices']] == ['one']
        assert data['nextCursor'] == 'next/2=' and calls == [{'limit': '1'}]
        second = client.get('/api/voices', params={**query, 'after': data['nextCursor'], 'connectionId': data['connectionId']})
        assert second.status_code == 200
        assert [row['voiceId'] for row in second.json()['voices']] == ['two']
        assert second.json()['nextCursor'] is None and calls[-1] == {'limit': '1', 'after': 'next/2='}
        assert client.get('/api/voices', params={**query, 'pageSize': 151}).status_code == 422
        assert len(calls) == 2


def test_complete_moss_catalog_over_100_pages_has_no_voice_count_cutoff():
    value = moss_config()
    total = 15001
    def handle(request):
        offset = int(request.url.params.get('after', '0'))
        end = min(total, offset + int(request.url.params['limit']))
        return httpx.Response(200, json={'data': [{'id': str(i)} for i in range(offset, end)],
            'has_more': end < total, 'next_cursor': str(end) if end < total else None})
    result = library(value, handle).list(value['id'])
    assert result['nextCursor'] is None
    assert [voice['voiceId'] for voice in result['voices']] == list(map(str, range(total)))


@pytest.mark.parametrize('args,status', [
    ({'after': 'two'}, 409), ({'after': 'two', 'connection_id': 'different'}, 409),
    ({'after': 'two', 'connection_id': 'current', 'page_size': None}, 422),
    ({'after': ' bad', 'connection_id': 'current'}, 422),
    ({'after': '\x00', 'connection_id': 'current'}, 422), ({'page_size': True}, 422),
])
def test_invalid_continuation_never_contacts_provider(args, status):
    value = moss_config()
    args = {'page_size': 150, **args}
    if args.get('connection_id') == 'current':
        args['connection_id'] = input_rules(value)['voiceLibrary']['connectionId']
    service = library(value, lambda _: pytest.fail('invalid continuation reached provider'))
    with pytest.raises(ProjectError) as error:
        service.list(value['id'], **args)
    assert error.value.status == status


@pytest.mark.parametrize('data', [
    {'data': [{'id': 'a'}, {'id': 'b'}], 'has_more': False}, {'data': [{'id': 'a'}], 'has_more': 1},
    {'data': [], 'has_more': True, 'next_cursor': 'two'}, {'data': [{'id': 'a'}], 'has_more': True},
    {'data': [{'id': 'a'}], 'has_more': True, 'next_cursor': 'same'},
    {'data': [{'id': 'a'}], 'has_more': True, 'next_cursor': ' '},
    {'data': [{'id': 'a'}], 'has_more': False, 'next_cursor': 'unexpected'},
])
def test_bad_moss_page_is_rejected(data):
    value = moss_config()
    scope = input_rules(value)['voiceLibrary']['connectionId']
    with pytest.raises(ProjectError) as error:
        library(value, lambda _: httpx.Response(200, json=data)).list(value['id'], page_size=1, after='same', connection_id=scope)
    assert error.value.code == 'voice_provider_protocol'


def test_selected_voice_and_preview_stop_at_the_matching_page():
    value = moss_config()
    scope = input_rules(value)['voiceLibrary']['connectionId']
    calls = []
    def handle(request):
        calls.append((request.url.path, request.url.params.get('after')))
        if request.url.path == '/sample.wav':
            assert 'authorization' not in request.headers
            return httpx.Response(200, content=b'sample', headers={'content-type': 'audio/wav'})
        cursor = request.url.params.get('after')
        assert cursor in (None, 'two')
        item = {'id': 'first'} if cursor is None else {'id': 'selected', 'preview_url': 'https://cdn.test/sample.wav'}
        return httpx.Response(200, json={'data': [item], 'has_more': True, 'next_cursor': 'two' if cursor is None else 'three'})
    service = library(value, handle)
    service.validate_selection(value, 'selected', {'connectionId': scope, 'voiceId': 'selected'})
    assert calls == [('/v1/audio/voices', None), ('/v1/audio/voices', 'two')]
    calls.clear()
    assert service.preview(value['id'], 'selected', scope) == (b'sample', 'audio/wav')
    assert calls == [('/v1/audio/voices', None), ('/v1/audio/voices', 'two'), ('/sample.wav', None)]


def test_paginated_response_rechecks_account_after_request():
    value = moss_config()
    def handle(_):
        value['apiKey'] = 'different-account'
        return httpx.Response(200, json={'data': [{'id': 'old'}], 'has_more': False})
    with pytest.raises(ProjectError) as error:
        library(value, handle).list(value['id'], page_size=150)
    assert error.value.code == 'voice_connection_changed'


def test_incomplete_scan_times_out_without_returning_partial_catalog(monkeypatch):
    from opendirector.application import voice_library
    clock = iter([0, 10, 301])
    monkeypatch.setattr(voice_library, 'monotonic', lambda: next(clock))
    value = moss_config()
    def handle(request):
        cursor = request.url.params.get('after', '0')
        return httpx.Response(200, json={'data': [{'id': cursor}], 'has_more': True, 'next_cursor': str(int(cursor) + 1)})
    with pytest.raises(ProjectError) as error:
        library(value, handle).list(value['id'])
    assert error.value.code == 'voice_provider_timeout' and error.value.status == 504


def test_vllm_paging_uses_one_native_response_without_limit_or_cursor():
    value = config()
    def handle(request):
        assert not request.url.params
        return httpx.Response(200, json={'voices': ['one', 'two']})
    service = library(value, handle)
    result = service.list(value['id'], page_size=1)
    assert [voice['voiceId'] for voice in result['voices']] == ['one', 'two'] and result['nextCursor'] is None
    with pytest.raises(ProjectError) as error:
        service.list(value['id'], page_size=1, after='unknown', connection_id=result['connectionId'])
    assert error.value.status == 422
