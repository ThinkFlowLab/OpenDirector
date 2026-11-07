import asyncio
import io
import json
from uuid import uuid4

import httpx
from PIL import Image
import pytest

from opendirector.application.creation_generation import CreationGeneration
from generation_helpers import new_project, prepared, tasks
from opendirector.domain.generation import GenerationError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.chat_completions import ChatCompletions
from opendirector.integrations.volcengine import VolcengineGeneration


SECRET = 'private-key-never-record'
SIGNED_URL = 'https://cdn.test/output?signature=secret-signature'


@pytest.fixture
def project(tmp_path):
    store, pid, session = new_project(tmp_path)
    return store, {'id': str(pid)}, session


@pytest.mark.parametrize(('status', 'code', 'category'), [
    (400, 'InputImageSensitiveContentDetected.PrivacyInformation', 'reference'),
    (400, 'InvalidParameter', 'input'),
    (401, 'AuthenticationError', 'authentication'),
    (403, 'PermissionDenied', 'permission'),
    (402, 'InsufficientBalance', 'quota'),
    (429, 'QuotaExceeded', 'quota'),
    (429, 'RateLimitExceeded', 'rate_limit'),
    (500, 'InternalError', 'temporary'),
])
def test_http_failure_is_safe_and_never_retried(project, status, code, category):
    store, project, _ = project
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(status, json={'error': {'code': code, 'message': f'{SECRET} {SIGNED_URL}'}},
            headers={'X-Request-Id': 'request-123'})
    async def run():
        provider = VolcengineGeneration(store, httpx.MockTransport(handle))
        config = {'url': 'https://ark.test', 'modelId': 'image', 'apiKey': SECRET}
        task = {'kind': 'image', 'projectId': project['id'], 'prompt': '图像', 'referenceIds': [], 'parameters': {}}
        with pytest.raises(GenerationError) as caught:
            await provider.generate(config, task, None)
        details = caught.value.details
        assert details.category == category and details.stage == 'submit'
        assert details.providerCode == code and details.requestId == 'request-123' and details.httpStatus == status
        assert caught.value.status == 502  # Preserve the current HTTP/status policy.
        assert details.message in str(caught.value) and '不会自动重新提交' in str(caught.value)
        serialized = details.model_dump_json() + str(caught.value)
        assert SECRET not in serialized and SIGNED_URL not in serialized and 'secret-signature' not in serialized
        if category == 'reference': assert '可能包含真人' in str(caught.value)
        assert len(requests) == 1
    asyncio.run(run())


@pytest.mark.parametrize('code', ['forbidden', 'permission_error'])
def test_403_reports_access_checks_without_diagnosing_account_permissions(project, code):
    store, project, _ = project
    requests = []
    raw_message = f'invalidKey: {SECRET} {SIGNED_URL}'
    def handle(request):
        requests.append(request)
        return httpx.Response(403, json={'error': {'code': code, 'message': raw_message}})
    async def run():
        provider = VolcengineGeneration(store, httpx.MockTransport(handle))
        with pytest.raises(GenerationError) as caught:
            await provider.generate({'url': 'https://ark.test', 'modelId': 'image', 'apiKey': SECRET},
                {'kind': 'image', 'projectId': project['id'], 'prompt': '图像', 'referenceIds': [], 'parameters': {}}, None)
        details = caught.value.details
        assert details.category == 'permission' and details.httpStatus == 403
        assert details.providerCode == code and details.stage == 'submit'
        assert details.message == '生成服务拒绝了访问请求。'
        assert 'API Key' in details.suggestion
        assert '权限' in details.suggestion and '安全策略' in details.suggestion
        serialized = details.model_dump_json() + str(caught.value)
        assert raw_message not in serialized and SECRET not in serialized and SIGNED_URL not in serialized
        assert '不会自动重新提交' in str(caught.value) and len(requests) == 1
    asyncio.run(run())


@pytest.mark.parametrize('body', [b'<html>secret-signature private-key-never-record</html>', b'[]', b'{broken', b'x' * 100000], ids=['html', 'array', 'broken-json', 'oversized'])
def test_non_json_and_oversized_errors_have_safe_fallback(project, body):
    store, project, _ = project
    def handle(request):
        return httpx.Response(503, content=body, headers={'X-Tt-Logid': 'log-123'})
    async def run():
        provider = VolcengineGeneration(store, httpx.MockTransport(handle))
        with pytest.raises(GenerationError) as caught:
            await provider.generate({'url': 'https://ark.test', 'modelId': 'image', 'apiKey': SECRET},
                {'kind': 'image', 'projectId': project['id'], 'prompt': '图像', 'referenceIds': [], 'parameters': {}}, None)
        assert caught.value.details.requestId == 'log-123'
        assert caught.value.details.providerCode is None
        assert caught.value.details.category == 'temporary'
        assert SECRET not in str(caught.value) and 'secret-signature' not in str(caught.value)
    asyncio.run(run())


@pytest.mark.parametrize('source', ['body', 'header', 'message'])
def test_identifiers_cannot_echo_credentials_or_signed_urls(project, source):
    store, project, _ = project
    def handle(request):
        value = {'error': {'code': SECRET, 'message': 'Request id: ' + SECRET}}
        headers = {'X-Request-Id': SIGNED_URL} if source == 'header' else {}
        if source == 'body': value['request_id'] = SECRET
        return httpx.Response(400, json=value, headers=headers)
    async def run():
        provider = VolcengineGeneration(store, httpx.MockTransport(handle))
        with pytest.raises(GenerationError) as caught:
            await provider.generate({'url': 'https://ark.test', 'modelId': 'image', 'apiKey': SECRET},
                {'kind': 'image', 'projectId': project['id'], 'prompt': '图像', 'referenceIds': [], 'parameters': {}}, None)
        assert caught.value.details.providerCode is None and caught.value.details.requestId is None
        assert SECRET not in caught.value.details.model_dump_json() and SIGNED_URL not in str(caught.value)
    asyncio.run(run())


@pytest.mark.parametrize('failure', ['video', 'audio'])
def test_http_200_business_errors_keep_provider_diagnostics(project, failure):
    store, project, _ = project
    calls = []
    def handle(request):
        calls.append(request)
        if failure == 'audio':
            return httpx.Response(200, text=json.dumps({'code': 45000001, 'message': SECRET + SIGNED_URL}), headers={'X-Tt-Logid': 'audio-log'})
        return httpx.Response(200, json={'status': 'failed', 'error': {'code': 'OutputVideoSensitiveContentDetected', 'message': SECRET}},
            headers={'X-Request-Id': 'video-log'})
    async def run():
        provider = VolcengineGeneration(store, httpx.MockTransport(handle))
        task = {'kind': failure, 'projectId': project['id'], 'prompt': '正文', 'referenceIds': [], 'parameters': {}, 'externalTaskId': 'existing-task'}
        config = {'url': 'https://ark.test', 'modelId': 'seed-tts-2.0' if failure == 'audio' else 'video', 'apiKey': SECRET}
        with pytest.raises(GenerationError) as caught:
            await provider.generate(config, task, None)
        details = caught.value.details
        assert details.httpStatus == 200 and details.category == 'input'
        assert details.requestId == failure + '-log'
        assert details.stage == ('poll' if failure == 'video' else 'submit')
        assert details.providerCode == ('45000001' if failure == 'audio' else 'OutputVideoSensitiveContentDetected')
        assert SECRET not in str(caught.value) and len(calls) == 1
        if failure == 'video': assert calls[0].method == 'GET'
    asyncio.run(run())


@pytest.mark.parametrize('stage', ['submit', 'poll', 'download', 'cancel'])
def test_transport_failure_reports_phase_without_leaking_request(project, stage):
    store, project, _ = project
    calls = []
    def handle(request):
        calls.append(request)
        if stage == 'download' and request.url.host == 'ark.test':
            return httpx.Response(200, json={'data': [{'url': SIGNED_URL}]})
        raise httpx.ReadTimeout(SECRET + SIGNED_URL, request=request)
    async def run():
        provider = VolcengineGeneration(store, httpx.MockTransport(handle), retry_delays=(0, 0))
        config = {'url': 'https://ark.test', 'modelId': 'image', 'apiKey': SECRET}
        task = {'kind': 'video' if stage == 'poll' else 'image', 'projectId': project['id'], 'prompt': '生成',
            'referenceIds': [], 'parameters': {}, 'externalTaskId': 'existing-task'}
        with pytest.raises(GenerationError) as caught:
            if stage == 'cancel': await provider.cancel(config, 'existing-task')
            else: await provider.generate(config, task, None)
        assert caught.value.details.stage == stage and caught.value.status == 504
        assert caught.value.details.category == ('submission_unknown' if stage == 'submit' else 'temporary')
        assert SECRET not in str(caught.value) and 'secret-signature' not in caught.value.details.model_dump_json()
        assert len(calls) == {'submit': 1, 'poll': 3, 'download': 4, 'cancel': 1}[stage]
        if stage == 'download':
            assert 'authorization' not in calls[-1].headers and 'x-api-key' not in calls[-1].headers
    asyncio.run(run())


def test_local_processing_failure_is_distinct_from_provider_failure(project, monkeypatch):
    store, value, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', 'https://ark.test', 'image', SECRET)
    output = io.BytesIO(); Image.new('RGB', (16, 12)).save(output, 'PNG')
    class Provider:
        calls = 0
        def validate(self, kind, config): pass
        async def generate(self, config, task, submitted):
            self.calls += 1
            return 'png', output.getvalue()
    provider = Provider()
    async def run():
        generation = CreationGeneration(store, configs, provider)
        def fail(*args, **kwargs): raise OSError(SECRET + SIGNED_URL)
        monkeypatch.setattr(generation, '_commit_output', fail)
        generation._launch(*prepared(generation, (store, value['id'], session), config))
        await asyncio.gather(*(job.future for job in generation.jobs.values()))
        receipt = tasks(generation, value['id'])[0]
        assert receipt['status'] == 'failed' and receipt['errorDetails']['category'] == 'local'
        assert receipt['errorDetails']['stage'] == 'save' and provider.calls == 1
        assert SECRET not in json.dumps(receipt) and 'secret-signature' not in json.dumps(receipt)
        await generation.close()
    asyncio.run(run())


def test_chat_error_parser_is_shared_without_retrying():
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(401, json={'error': {'code': 'invalid_api_key', 'message': SECRET}}, headers={'X-Request-Id': 'chat-id'})
    async def run():
        provider = ChatCompletions(httpx.MockTransport(handle))
        with pytest.raises(GenerationError) as caught:
            async for _ in provider.stream({'url': 'https://chat.test', 'apiKey': SECRET}, {'messages': []}): pass
        assert caught.value.details.category == 'authentication'
        assert caught.value.details.requestId == 'chat-id'
        assert SECRET not in str(caught.value) and len(calls) == 1
    asyncio.run(run())


@pytest.mark.parametrize(('kind', 'body', 'external_id', 'stage'), [
    ('image', {}, None, 'submit'),
    ('video', {'id': ''}, None, 'submit'),
    ('video', [], 'existing-task', 'poll'),
    ('video', {'status': 'succeeded', 'content': {}}, 'existing-task', 'download'),
    ('audio', [], None, 'submit'),
])
def test_malformed_success_payloads_are_bounded_protocol_errors(project, kind, body, external_id, stage):
    store, project, _ = project
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=body)
    async def run():
        provider = VolcengineGeneration(store, httpx.MockTransport(handle))
        task = {'kind': kind, 'projectId': project['id'], 'prompt': '正文', 'referenceIds': [], 'parameters': {}, 'externalTaskId': external_id}
        with pytest.raises(GenerationError) as caught:
            await provider.generate({'url': 'https://ark.test', 'modelId': 'seed-tts-2.0' if kind == 'audio' else kind, 'apiKey': SECRET}, task, None)
        assert caught.value.details.stage == stage
        assert caught.value.details.category == ('submission_unknown' if stage == 'submit' else 'protocol')
        assert len(calls) == 1
    asyncio.run(run())


def test_error_stream_is_not_read_beyond_diagnostic_limit(project):
    store, project, _ = project
    class ErrorStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'x' * 65536
            raise AssertionError('Error body must not be read without a bound')
    def handle(request):
        return httpx.Response(503, stream=ErrorStream(), headers={'X-Request-Id': 'bounded-id'})
    async def run():
        provider = VolcengineGeneration(store, httpx.MockTransport(handle))
        with pytest.raises(GenerationError) as caught:
            await provider.generate({'url': 'https://ark.test', 'modelId': 'image', 'apiKey': SECRET},
                {'kind': 'image', 'projectId': project['id'], 'prompt': '图像', 'referenceIds': [], 'parameters': {}}, None)
        assert caught.value.details.requestId == 'bounded-id'
        assert caught.value.details.category == 'temporary'
    asyncio.run(run())
