"""Zhipu BigModel wire contracts: GLM chat reasoning levels, GLM-TTS and the voice registry.

Provider HTTP is mocked from responses recorded against the real service.
"""
import io
import json
import wave
from uuid import uuid4

import httpx
import pytest

from opendirector.application.voice_library import VoiceLibrary
from opendirector.domain.capabilities import SpeechRequest
from opendirector.domain.generation import GenerationError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.domain.zhipu_speech import ZHIPU_DEFAULT_VOICE, ZHIPU_PRESET_VOICES, is_zhipu_speech
from opendirector.integrations.chat_completions import chat_payload
from opendirector.integrations.model_adapters import OpenAISpeech, ZhipuSpeech, adapter_for
from opendirector.integrations.generation_errors import provider_failure
from test_creation_generation_service import anyio_backend  # noqa: F401


CHAT = {"modelId": "glm-5.3", "url": "https://open.bigmodel.cn/api/paas/v4"}



def test_zhipu_reasoning_effort_accepts_only_glm_levels():
    assert chat_payload(CHAT, [], "low")["reasoning_effort"] == "low"
    assert chat_payload(CHAT, [], "medium")["reasoning_effort"] == "high"
    assert chat_payload(CHAT, [], "high")["reasoning_effort"] == "max"
    assert chat_payload(CHAT, [], "xhigh")["reasoning_effort"] == "high"


def test_zhipu_auto_keeps_provider_default():
    payload = chat_payload(CHAT, [], "auto")
    assert "reasoning_effort" not in payload
    assert "thinking" not in payload


def test_zhipu_base_fields_and_other_hosts_unchanged():
    payload = chat_payload(CHAT, [{"role": "user", "content": "hi"}], "high")
    assert payload["model"] == "glm-5.3"
    assert payload["stream"] is True
    assert payload["max_tokens"] == 8192
    assert payload["messages"] == [{"role": "user", "content": "hi"}]
    other = chat_payload({"modelId": "x", "url": "https://api.example.com/v1"}, [], "medium")
    assert other["reasoning_effort"] == "medium"
    deepseek = chat_payload({"modelId": "x", "url": "https://api.deepseek.com/v1"}, [], "high")
    assert deepseek["thinking"] == {"type": "enabled"}
    assert deepseek["reasoning_effort"] == "max"


SECRET = 'zhipu-private-test-key'
BASE = 'https://open.bigmodel.cn/api/paas/v4'
CDN = 'https://bigmodel-us3-prod-voice-clone.cn-wlcb.ufileos.com/out.wav?ufileattname=a.wav'
CLONED = 'b7f05169-b935-522f-9b0a-b49336783d42'


def config(**patch):
    return {**dict(id=str(uuid4()), kind='audio', url=BASE, modelId='glm-tts', protocol='openai',
                   connectionType='api', authMode='bearer', apiKey=SECRET), **patch}


def wav(seconds=5.0, rate=24000):
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(rate)
        audio.writeframes(b'\0\0' * int(rate * seconds))
    return stream.getvalue()


class Configs:
    def __init__(self, value): self.value = value
    def resolve(self, identity, kind):
        assert identity == self.value['id'] and kind == 'audio'
        return self.value


def public(url):
    target = httpx.URL(url)
    return target, {'Host': target.netloc.decode('ascii')}, {}


def library(value, handle, resolve_public=public):
    return VoiceLibrary(Configs(value), transport=httpx.MockTransport(handle), resolve_public=resolve_public)


def listing(*private):
    return httpx.Response(200, json={'voice_list': [
        {'voice': voice, 'voice_name': name, 'voice_type': 'PRIVATE', 'download_url': CDN,
         'create_time': '2026-11-10 10:05:39'} for voice, name in private]})


def test_profile_requires_the_official_endpoint_and_model():
    value = config()
    assert is_zhipu_speech(value)
    rules = input_rules(value)
    assert rules['profile'] == 'zhipu-speech' and rules['voiceRequired'] and rules['referencesAllowed'] is False
    assert rules['maxPromptCharacters'] == 1024
    library_rules = rules['voiceLibrary']
    assert library_rules['provider'] == 'zhipu' and library_rules['canDelete']
    assert library_rules['formats'] == ['wav', 'mp3'] and library_rules['maxBytes'] == 10 * 1024 * 1024
    assert not library_rules['requiresTranscript'] and not library_rules['requiresReferenceAudio']
    # The form shows an optional transcript from this capability, never from the provider name.
    assert library_rules['acceptsTranscript']
    # The default voice is published so the client does not hardcode one.
    assert rules['defaultVoice'] == ZHIPU_DEFAULT_VOICE
    assert SECRET not in json.dumps(rules)
    assert isinstance(adapter_for(value), ZhipuSpeech)
    for patch in ({'url': 'https://open.bigmodel.cn/api/paas/v3'}, {'url': 'http://open.bigmodel.cn/api/paas/v4'},
                  {'url': 'https://bigmodel.example/api/paas/v4'}, {'modelId': 'glm-tts-clone'},
                  {'connectionType': 'self_hosted'}, {'kind': 'image'}):
        other = config(**patch)
        assert not is_zhipu_speech(other)
        assert input_rules(other)['profile'] != 'zhipu-speech'
    # A self-hosted GLM-TTS keeps the vLLM-Omni voice registry and plain speech adapter.
    local = config(url='http://gpu.test/v1', connectionType='self_hosted')
    assert input_rules(local)['voiceLibrary']['provider'] == 'vllm_omni'
    assert isinstance(adapter_for(local), OpenAISpeech)


@pytest.mark.anyio
async def test_speech_sends_wav_request_and_accepts_only_a_wave_body():
    calls = []
    def handle(request):
        calls.append(request)
        assert str(request.url) == BASE + '/audio/speech'
        assert request.headers['authorization'] == f'Bearer {SECRET}'
        assert json.loads(request.content) == dict(model='glm-tts', input='你好', voice='tongtong',
                                                   response_format='wav', stream=False, watermark_enabled=False)
        return httpx.Response(200, content=wav(.2), headers={'content-type': 'audio/wav; charset=UTF-8'})
    result = await ZhipuSpeech(httpx.MockTransport(handle)).speech(config(), SpeechRequest('你好', 'tongtong'), watermark=False)
    assert result.suffix == 'wav' and result.data[:4] == b'RIFF'
    assert len(calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize('reply', [
    httpx.Response(200, content=b'\x00\x00+\x00\xf5\x00', headers={'content-type': 'audio/pcm'}),
    httpx.Response(200, content=b'', headers={'content-type': 'audio/wav'}),
    httpx.Response(200, content=b'data: {"choices":[]}\n\n', headers={'content-type': 'text/event-stream'}),
])
async def test_non_wave_success_is_a_protocol_failure(reply):
    with pytest.raises(GenerationError) as caught:
        await ZhipuSpeech(httpx.MockTransport(lambda _: reply)).speech(config(), SpeechRequest('你好', 'tongtong'))
    assert caught.value.details.category == 'submission_unknown' or caught.value.details.category == 'protocol'


@pytest.mark.anyio
async def test_json_error_inside_a_success_status_is_a_provider_failure():
    reply = httpx.Response(200, json={'error': {'code': '500', 'message': "Request method 'DELETE' not supported"}})
    with pytest.raises(GenerationError) as caught:
        await ZhipuSpeech(httpx.MockTransport(lambda _: reply)).speech(config(), SpeechRequest('你好', 'tongtong'))
    assert caught.value.details.providerCode == '500'


@pytest.mark.anyio
@pytest.mark.parametrize('status,body,category', [
    (429, {'error': {'code': '1113', 'message': '余额不足或无可用资源包,请充值。'}}, 'quota'),
    (400, {'error': {'code': '1214', 'message': '音色不存在'}}, 'input'),
    (401, {'error': {'code': '1000', 'message': '身份验证失败。'}}, 'authentication'),
])
async def test_provider_errors_are_classified(status, body, category):
    with pytest.raises(GenerationError) as caught:
        await ZhipuSpeech(httpx.MockTransport(lambda _: httpx.Response(status, json=body))).speech(
            config(), SpeechRequest('你好', 'tongtong'))
    assert caught.value.details.category == category
    assert SECRET not in str(caught.value)


def test_quota_is_not_a_rate_limit_and_missing_voice_is_readable():
    quota = provider_failure({'error': {'code': '1113', 'message': '余额不足或无可用资源包,请充值。'}}, stage='submit', http_status=429)
    assert quota.details.category == 'quota'
    missing = provider_failure({'error': {'code': '1214', 'message': '音色不存在'}}, stage='submit', http_status=400)
    assert missing.details.message == '所选音色不存在或不可用。'


@pytest.mark.anyio
@pytest.mark.parametrize('text,voice,code', [
    ('', 'tongtong', 'zhipu_speech_text'), ('字' * 1025, 'tongtong', 'zhipu_speech_text'),
    ('你好', None, 'zhipu_speech_voice'), ('你好', '音色', 'zhipu_speech_voice'),
])
async def test_invalid_input_never_reaches_the_provider(text, voice, code):
    adapter = ZhipuSpeech(httpx.MockTransport(lambda _: pytest.fail('invalid input reached provider')))
    with pytest.raises(ProjectError) as error:
        await adapter.speech(config(), SpeechRequest(text, voice))
    assert error.value.code == code


def test_list_offers_documented_presets_and_private_clones_only():
    value = config()
    def handle(request):
        assert request.method == 'GET' and request.url.path == '/api/paas/v4/voice/list'
        assert request.url.params['voiceType'] == 'PRIVATE'
        return listing((CLONED, '旁白 测试/一'))
    result = library(value, handle).list(value['id'])
    voices = {voice['voiceId']: voice for voice in result['voices']}
    assert list(voices)[:len(ZHIPU_PRESET_VOICES)] == list(ZHIPU_PRESET_VOICES)
    assert all(voices[name]['source'] == 'builtin' and not voices[name]['canDelete'] for name in ZHIPU_PRESET_VOICES)
    clone = voices[CLONED]
    assert clone['name'] == '旁白 测试/一' and clone['source'] == 'uploaded' and clone['canDelete'] and clone['compatible']
    assert clone['previewUrl'].startswith('/api/voices/' + CLONED + '/preview?')
    assert result['nextCursor'] is None


@pytest.mark.parametrize('body', [{'voice_list': [{'voice': 'x', 'voice_type': 'OFFICIAL'}]}, {'voice_list': None}, {}])
def test_unexpected_listing_is_rejected(body):
    value = config()
    with pytest.raises(ProjectError) as error:
        library(value, lambda _: httpx.Response(200, json=body)).list(value['id'])
    assert error.value.code == 'voice_provider_protocol'


def test_create_uploads_clones_cleans_up_and_reads_back():
    value = config()
    calls = []
    def handle(request):
        calls.append((request.method, request.url.path))
        if request.url.path.endswith('/files') and request.method == 'POST':
            body = request.read()
            assert b'name="purpose"\r\n\r\nvoice-clone-input' in body and b'RIFF' in body
            return httpx.Response(200, json={'id': 'in-1.wav', 'object': 'file', 'purpose': 'voice-clone-input'})
        if request.url.path.endswith('/voice/clone'):
            payload = json.loads(request.content)
            assert payload['model'] == 'glm-tts-clone' and payload['voice_name'] == 'Alice'
            assert payload['file_id'] == 'in-1.wav' and payload['input'].strip() and payload['text'] == '你好'
            return httpx.Response(200, json={'voice': CLONED, 'file_id': 'out-1.wav', 'file_purpose': 'voice-clone-output'})
        if request.method == 'DELETE':
            assert request.url.path.endswith('/files/in-1.wav')
            return httpx.Response(200, json={'id': 'in-1.wav', 'deleted': True})
        return listing((CLONED, 'Alice'))
    record = library(value, handle).create(value['id'], wav(), filename='sample.wav', name='Alice', ref_text='你好')
    assert record['voiceId'] == CLONED and record['source'] == 'uploaded' and record['previewUrl']
    assert calls[:3] == [('POST', '/api/paas/v4/files'), ('POST', '/api/paas/v4/voice/clone'),
                         ('DELETE', '/api/paas/v4/files/in-1.wav')]


@pytest.mark.parametrize('message,code,status', [
    ('音色名称已存在', 'voice_name_taken', 409),
    ('API 调用参数有误，请检查文档。no audio segment found', 'voice_provider_error', 400),
])
def test_failed_clone_still_deletes_the_uploaded_sample(message, code, status):
    value = config()
    deleted = []
    def handle(request):
        if request.url.path.endswith('/files') and request.method == 'POST':
            return httpx.Response(200, json={'id': 'in-2.wav'})
        if request.method == 'DELETE':
            deleted.append(request.url.path)
            return httpx.Response(200, json={'deleted': True})
        return httpx.Response(400, json={'error': {'code': '1214' if '名称' in message else '1210', 'message': message}})
    with pytest.raises(ProjectError) as error:
        library(value, handle).create(value['id'], wav(), filename='sample.wav', name='Alice')
    assert error.value.code == code and error.value.status == status
    assert deleted == ['/api/paas/v4/files/in-2.wav']


def test_cleanup_failure_is_logged_and_never_hides_the_created_voice(caplog):
    # A sample the provider refuses to delete must not fail the clone, but it
    # must leave a trace: the file stays in the account until its owner acts.
    value = config()
    def handle(request):
        if request.url.path.endswith('/files') and request.method == 'POST':
            return httpx.Response(200, json={'id': 'in-3.wav'})
        if request.method == 'DELETE':
            return httpx.Response(500, json={'error': {'code': '1234', 'message': '内部错误'}})
        if request.url.path.endswith('/voice/clone'):
            return httpx.Response(200, json={'voice': CLONED})
        return listing((CLONED, 'Alice'))
    with caplog.at_level('WARNING', logger='opendirector.application.voice_library'):
        record = library(value, handle).create(value['id'], wav(), filename='sample.wav', name='Alice')
    assert record['voiceId'] == CLONED and record['source'] == 'uploaded'
    warnings = [r for r in caplog.records if r.levelname == 'WARNING']
    assert len(warnings) == 1, caplog.text
    assert '语音样本清理未完成' in warnings[0].getMessage()
    # The operator needs the provider's own classification to act on it.
    assert 'voice_provider_error' in warnings[0].getMessage()
    assert warnings[0].exc_info is not None, 'the cause must stay attached for diagnosis'
    assert value['apiKey'] not in caplog.text


# Name the cases explicitly: a generated id would carry the whole sample into
# PYTEST_CURRENT_TEST, and an id past MAX_ARG_STRLEN breaks every ffprobe call.
@pytest.mark.parametrize('data,filename,code', [
    (wav(1), 'sample.wav', 'voice_duration'), (wav(31), 'sample.wav', 'voice_duration'),
    (wav(), 'sample.m4a', 'voice_format'), (b'not audio', 'sample.wav', 'voice_audio_invalid'),
], ids=['too-short', 'too-long', 'wrong-container', 'not-audio'])
def test_invalid_recording_never_reaches_the_provider(data, filename, code):
    value = config()
    service = library(value, lambda _: pytest.fail('invalid upload reached provider'))
    with pytest.raises(ProjectError) as error:
        service.create(value['id'], data, filename=filename, name='Alice')
    assert error.value.code == code


def test_quota_during_registry_calls_is_reported_as_quota():
    value = config()
    reply = httpx.Response(429, json={'error': {'code': '1113', 'message': '余额不足或无可用资源包,请充值。'}})
    with pytest.raises(ProjectError) as error:
        library(value, lambda _: reply).list(value['id'])
    assert error.value.code == 'voice_provider_quota'


def test_delete_posts_the_voice_and_rejects_presets_and_unknown_voices():
    value = config()
    scope = input_rules(value)['voiceLibrary']['connectionId']
    posted = []
    def handle(request):
        if request.url.path.endswith('/voice/delete'):
            posted.append(json.loads(request.content))
            return httpx.Response(200, json={'voice': CLONED, 'update_time': '2026-11-10 10:05:57'})
        return listing((CLONED, 'Alice'))
    service = library(value, handle)
    service.delete(value['id'], CLONED, scope)
    assert posted == [{'voice': CLONED}]
    for voice, code in [('tongtong', 'voice_delete_unsupported'), ('missing', 'voice_not_found')]:
        with pytest.raises(ProjectError) as error: service.delete(value['id'], voice, scope)
        assert error.value.code == code
    with pytest.raises(ProjectError) as error: service.delete(value['id'], CLONED, 'other')
    assert error.value.code == 'voice_connection_changed'
    assert len(posted) == 1


def test_delete_error_in_success_envelope_is_not_reported_as_deleted():
    value = config()
    scope = input_rules(value)['voiceLibrary']['connectionId']
    def handle(request):
        if request.url.path.endswith('/voice/delete'):
            return httpx.Response(200, json={'error': {'code': '500', 'message': 'not supported'}})
        return listing((CLONED, 'Alice'))
    with pytest.raises(ProjectError) as error:
        library(value, handle).delete(value['id'], CLONED, scope)
    assert error.value.code == 'voice_provider_error'


def test_preview_downloads_cdn_wave_without_credentials():
    value = config()
    scope = input_rules(value)['voiceLibrary']['connectionId']
    def handle(request):
        if request.url.host == 'open.bigmodel.cn':
            return listing((CLONED, 'Alice'))
        assert 'authorization' not in request.headers
        return httpx.Response(200, content=wav(.2), headers={'content-type': 'application/octet-stream'})
    data, mime = library(value, handle).preview(value['id'], CLONED, scope)
    assert mime == 'audio/wav' and data[:4] == b'RIFF'


def test_preview_rejects_non_wave_and_private_destinations():
    value = config()
    scope = input_rules(value)['voiceLibrary']['connectionId']
    def handle(request):
        if request.url.host == 'open.bigmodel.cn':
            return listing((CLONED, 'Alice'))
        return httpx.Response(200, content=b'<html>', headers={'content-type': 'application/octet-stream'})
    with pytest.raises(ProjectError) as error:
        library(value, handle).preview(value['id'], CLONED, scope)
    assert error.value.code == 'voice_provider_error'
    def private(request):
        if request.url.host == 'open.bigmodel.cn':
            return httpx.Response(200, json={'voice_list': [{'voice': CLONED, 'voice_name': 'A', 'voice_type': 'PRIVATE',
                                                             'download_url': 'https://127.0.0.1/x.wav'}]})
        pytest.fail('private preview destination was contacted')
    from opendirector.application.voice_library import _public_https
    with pytest.raises(ProjectError) as error:
        library(value, private, resolve_public=_public_https).preview(value['id'], CLONED, scope)
    assert error.value.code == 'voice_provider_error'


def test_generation_snapshot_and_preflight(tmp_path):
    from generation_helpers import command, new_project
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.infrastructure.model_configs import ModelConfigs
    project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    saved = configs.save('audio', BASE, 'glm-tts', SECRET, protocol='openai')
    assert saved['inputRules']['profile'] == 'zhipu-speech'
    runner = CreationGeneration(project[0], configs)
    runner.voices = library(configs.resolve(saved['id'], 'audio'), lambda _: listing((CLONED, 'Alice')))
    scope = saved['inputRules']['voiceLibrary']['connectionId']
    deleted = dict(connectionId=scope, voiceId='missing', name='Gone', source='uploaded', hasReferenceAudio=True)
    for parameters, code in [({'voice': None}, 'zhipu_speech_voice'),
                             ({'voice': 'missing', 'voiceSelection': deleted}, 'voice_not_found'),
                             ({'voice': CLONED, 'voiceSelection': {**deleted, 'voiceId': CLONED, 'connectionId': 'stale'}}, 'voice_connection_changed')]:
        request = command(project, saved, prompt='Read this', parameters=parameters)
        receipt = runner.prepare(request, session=project[2])
        assert receipt.status == 'rejected' and receipt.issues[0].code == code, receipt
    assert project[0].snapshot(project[1]).jobs == ()
    selection = {**deleted, 'voiceId': CLONED, 'name': 'Alice'}
    request = command(project, saved, prompt='Read this', parameters={'voice': CLONED, 'voiceSelection': selection})
    receipt = runner.prepare(request, session=project[2])
    assert receipt.status != 'rejected', receipt
    job = project[0].snapshot(project[1]).jobs[-1]
    execution = job.execution.model_dump() if hasattr(job.execution, 'model_dump') else job.execution
    assert execution['voice'] == CLONED and execution['format'] == 'wav'
