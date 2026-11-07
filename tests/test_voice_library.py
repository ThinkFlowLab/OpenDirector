import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.voice_library import VoiceLibrary
from opendirector_api.main import create_app


def configs_at(path):
    configs = ModelConfigs(path)
    vllm = configs.save('audio', 'http://127.0.0.1:12345/v1', 'qwen3-tts-drama-3', '',
                        connection_type='self_hosted', protocol='openai', auth_mode='none')
    moss = configs.save('audio', 'https://api.mosi.cn/v1', 'moss-tts-1.5-flash', 'secret-key',
                        connection_type='api', protocol='openai', auth_mode='bearer')
    return configs, vllm, moss


def test_voice_capabilities_are_connection_specific(tmp_path):
    configs, vllm, moss = configs_at(tmp_path)
    public = {item['modelId']: item for item in configs.list()}
    assert public['qwen3-tts-drama-3']['inputRules']['voiceLibrary'] == {
        'provider': 'vllm-omni', 'canCreate': True, 'canDelete': True,
        'requiresConsent': True, 'requiresRefText': True,
        'maxBytes': 10 * 1024 * 1024, 'maxDurationSeconds': None,
        'formats': ['wav', 'mp3', 'flac', 'ogg', 'aac', 'webm', 'mp4'],
        'pagination': 'none', 'preview': False, 'filterUnsupported': False,
    }
    assert public['moss-tts-1.5-flash']['inputRules']['voiceLibrary']['provider'] == 'moss'
    assert public['moss-tts-1.5-flash']['inputRules']['voiceLibrary']['canDelete'] is False


def test_vllm_list_normalizes_builtins_and_uploaded_without_secrets(tmp_path):
    configs, config, _ = configs_at(tmp_path)
    seen = {}

    def handle(request):
        seen['url'] = str(request.url)
        seen['auth'] = request.headers.get('authorization')
        return httpx.Response(200, json={
            'voices': ['aiden', 'clone'],
            'uploaded_voices': [{'name': 'clone', 'created_at': 1738660000,
                                 'ref_text': 'private transcript',
                                 'speaker_description': 'warm'}],
        })

    page = asyncio.run(VoiceLibrary(configs, httpx.MockTransport(handle)).list(config['id']))
    assert seen['url'] == 'http://127.0.0.1:12345/v1/audio/voices'
    assert seen['auth'] is None
    assert page['hasMore'] is False
    assert [item['source'] for item in page['voices']] == ['builtin', 'uploaded']
    assert page['voices'][1]['hasReference'] is True
    assert page['voices'][1]['description'] == 'warm'
    assert 'private transcript' not in json.dumps(page)
    assert 'secret-key' not in json.dumps(page)


def test_moss_list_paginates_and_uses_bearer_key(tmp_path):
    configs, _, config = configs_at(tmp_path)
    calls = []

    def handle(request):
        calls.append((str(request.url), request.headers.get('authorization')))
        if request.url.params.get('after') == 'next-page':
            return httpx.Response(200, json={'data': [], 'has_more': False})
        return httpx.Response(200, json={
            'data': [{'id': 'voice-1', 'name': 'Alice', 'created_at': 1710000000}],
            'has_more': True, 'next_cursor': 'next-page',
        })

    service = VoiceLibrary(configs, httpx.MockTransport(handle))
    first = asyncio.run(service.list(config['id'], limit=1))
    second = asyncio.run(service.list(config['id'], cursor=first['nextCursor']))
    assert first['voices'][0] == {
        'id': 'voice-1', 'name': 'Alice', 'provider': 'moss', 'source': 'custom',
        'createdAt': 1710000000, 'deletable': False, 'hasReference': False,
        'description': None, 'metadata': {},
    }
    assert first['nextCursor'] == 'next-page'
    assert second['hasMore'] is False
    assert calls[0][0].endswith('/v1/audio/voices?limit=1')
    assert calls[1][0].endswith('/v1/audio/voices?limit=20&after=next-page')
    assert all(value == 'Bearer secret-key' for _, value in calls)


def test_create_and_delete_forward_required_fields(tmp_path):
    configs, config, _ = configs_at(tmp_path)
    requests = []

    def handle(request):
        requests.append(request)
        if request.method == 'POST':
            body = request.read()
            assert b'name="consent"' in body
            assert b'name="ref_text"' in body
            assert b'name="speaker_description"' in body
            return httpx.Response(201, json={'voice': {'name': 'made', 'ref_text': 'text'}})
        return httpx.Response(204)

    service = VoiceLibrary(configs, httpx.MockTransport(handle))
    created = asyncio.run(service.create(
        config['id'], filename='sample.wav', data=b'RIFF-fixture', content_type='audio/wav',
        name='made', consent='consent-1', ref_text='exact words', speaker_description='warm'))
    assert created['id'] == 'made'
    assert created['deletable'] is True
    assert created['hasReference'] is True
    asyncio.run(service.delete(config['id'], 'made'))
    assert requests[0].method == 'POST'
    assert requests[1].method == 'DELETE'
    assert str(requests[1].url) == 'http://127.0.0.1:12345/v1/audio/voices/made'


def test_moss_delete_is_rejected(tmp_path):
    configs, _, config = configs_at(tmp_path)
    with pytest.raises(ProjectError) as error:
        asyncio.run(VoiceLibrary(configs, httpx.MockTransport(lambda request: httpx.Response(204))).delete(config['id'], 'voice-1'))
    assert error.value.code == 'voice_library_delete_unsupported'


def test_api_routes_do_not_return_provider_keys(tmp_path):
    configs, config, _ = configs_at(tmp_path)

    def handle(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'voices': ['aiden'], 'uploaded_voices': []})
        return httpx.Response(201, json={'voice': {'name': 'made'}})

    app = create_app(LocalProjects(tmp_path), voice_library=VoiceLibrary(configs, httpx.MockTransport(handle)))
    with TestClient(app, headers={'X-OpenDirector-Request': '1'}) as client:
        listed = client.get(f'/api/model-configs/{config["id"]}/voices')
        assert listed.status_code == 200
        assert 'secret-key' not in listed.text
        created = client.post(f'/api/model-configs/{config["id"]}/voices',
                              files={'audio_sample': ('sample.wav', b'RIFF', 'audio/wav')},
                              data={'name': 'made', 'consent': 'consent-1', 'ref_text': 'words'})
        assert created.status_code == 200
        assert created.json()['name'] == 'made'


def test_create_validation_requires_adapter_fields_and_supported_file(tmp_path):
    configs, config, moss = configs_at(tmp_path)
    service = VoiceLibrary(configs, httpx.MockTransport(lambda request: httpx.Response(201)))
    with pytest.raises(ProjectError) as missing_consent:
        asyncio.run(service.create(config['id'], filename='sample.wav', data=b'RIFF',
                                   content_type='audio/wav', name='made', consent='', ref_text='words',
                                   speaker_description=''))
    assert missing_consent.value.code == 'voice_library_consent'
    with pytest.raises(ProjectError) as missing_transcript:
        asyncio.run(service.create(config['id'], filename='sample.wav', data=b'RIFF',
                                   content_type='audio/wav', name='made', consent='consent-1', ref_text='',
                                   speaker_description=''))
    assert missing_transcript.value.code == 'voice_library_transcript'
    with pytest.raises(ProjectError) as wrong_file:
        asyncio.run(service.create(config['id'], filename='sample.txt', data=b'x',
                                   content_type='text/plain', name='made', consent='consent-1', ref_text='words',
                                   speaker_description=''))
    assert wrong_file.value.code == 'voice_library_file_type'
    with pytest.raises(ProjectError) as wrong_size:
        asyncio.run(service.create(config['id'], filename='sample.wav', data=b'x' * (10 * 1024 * 1024 + 1),
                                   content_type='audio/wav', name='made', consent='consent-1', ref_text='words',
                                   speaker_description=''))
    assert wrong_size.value.code == 'voice_library_file_size'


def _audio_config(tmp_path, model_id, provider_id=None):
    configs = ModelConfigs(tmp_path)
    config = configs.save('audio', 'http://127.0.0.1:12345/v1', model_id, '',
                          connection_type='self_hosted', protocol='openai', auth_mode='none')
    if provider_id:
        config['providerId'] = provider_id
    from opendirector.domain.creation.models import ModelConfigPublic
    return ModelConfigPublic.model_validate(config)


def _audio_spec(model, *, _kind='audio', **parameters):
    from uuid import uuid4
    from opendirector.domain.creation.generation import AudioGenerationSpec
    return AudioGenerationSpec(kind=_kind, id=uuid4(), projectId=uuid4(), modelConfigId=model.id, prompt='Read this.',
                               parameters={'voice': parameters.pop('voice', 'voice-one'), **parameters})


def test_validate_generation_enforces_voice_connection_provider_and_transcript(tmp_path):
    from opendirector.domain.creation.generation import validate_generation
    model = _audio_config(tmp_path, 'qwen3-tts-drama-3', provider_id='11111111-1111-4111-8111-111111111111')
    good = _audio_spec(model, voiceConnectionId='11111111-1111-4111-8111-111111111111',
                       voiceProvider='vllm-omni', voiceHasReference=True)
    validate_generation(good, model)
    with pytest.raises(ValueError, match='音色'):
        validate_generation(_audio_spec(model, voiceConnectionId='22222222-2222-4222-8222-222222222222',
                                        voiceProvider='vllm-omni', voiceHasReference=True), model)
    with pytest.raises(ValueError, match='音色'):
        validate_generation(_audio_spec(model, voiceConnectionId='11111111-1111-4111-8111-111111111111',
                                        voiceProvider='moss', voiceHasReference=True), model)
    with pytest.raises(ValueError, match='音色'):
        validate_generation(_audio_spec(model, voiceConnectionId='11111111-1111-4111-8111-111111111111',
                                        voiceProvider='vllm-omni', voiceHasReference=False), model)
    # A legacy command without voice metadata keeps validating through the
    # shared rules; connection pinning only applies to stored voice identity.
    legacy = _audio_spec(model, voiceConnectionId=None, voiceProvider=None, voiceHasReference=None)
    validate_generation(legacy, model)


def test_create_rejects_names_outside_the_selectable_voice_contract(tmp_path):
    configs, config, _ = configs_at(tmp_path)
    service = VoiceLibrary(configs, httpx.MockTransport(lambda request: httpx.Response(201)))
    for bad in ('my voice', 'x' * 65, '中文'):
        with pytest.raises(ProjectError) as rejected:
            asyncio.run(service.create(config['id'], filename='sample.wav', data=b'RIFF',
                                       content_type='audio/wav', name=bad, consent='consent-1',
                                       ref_text='words', speaker_description=''))
        assert rejected.value.code == 'voice_library_name'
    def handle(request):
        return httpx.Response(201, json={'voice': {'name': 'my_voice-1'}})
    ok_service = VoiceLibrary(configs, httpx.MockTransport(handle))
    created = asyncio.run(ok_service.create(config['id'], filename='sample.wav', data=b'RIFF',
                               content_type='audio/wav', name='my_voice-1', consent='consent-1',
                               ref_text='words', speaker_description=''))
    assert created['id'] == 'my_voice-1'


def test_moss_model_with_required_reference_audio_hides_incompatible_builtin(tmp_path):
    """Nano-style models list `default` but reject it without ref_audio (review 4502466605)."""
    configs = ModelConfigs(tmp_path)
    config = configs.save('audio', 'https://api.mosi.cn/v1', 'moss-tts-nano', 'secret-key',
                          connection_type='api', protocol='openai', auth_mode='bearer')
    capabilities = next(item for item in configs.list() if item['id'] == config['id'])['inputRules']['voiceLibrary']
    assert capabilities['provider'] == 'moss'
    assert capabilities['filterUnsupported'] is True
