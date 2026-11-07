"""OpenAI Images (gpt-image) as an optional provider: documented requests and failures.

gpt-image always answers with base64 and rejects `response_format`, and it reads
several reference pictures from repeated `image[]` parts. These tests pin the
wire shape so a compatible vLLM-Omni service keeps its own behaviour.
"""
import asyncio
import base64
import io
import json
from uuid import uuid4

import httpx
from PIL import Image
import pytest

from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from generation_helpers import new_project, prepared, tasks
from opendirector.domain.input_rules import input_rules
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.domain.capabilities import ImageRequest
from opendirector.integrations.model_adapters import OpenAIImages, adapter_for
from opendirector.integrations.providers import GenerationProviders

GPT_IMAGE = {'kind': 'image', 'url': 'https://api.openai.com/v1', 'modelId': 'gpt-image-1', 'protocol': 'openai'}
KEY = 'sk-test-never-recorded'


def png():
    out = io.BytesIO()
    Image.new('RGB', (16, 12), 'green').save(out, 'PNG')
    return out.getvalue()


def test_gpt_image_profile_declares_the_documented_limits():
    rules = input_rules(GPT_IMAGE)
    assert rules['profile'] == 'openai-gpt-image'
    assert rules['allowedKinds'] == ['text', 'image'] and rules['maxImages'] == 16
    assert rules['imageBytes'] == 25 * 1024 * 1024 and rules['requestBytes'] == 50 * 1024 * 1024
    assert [item['size'] for item in rules['imageOutputs']] == ['1024x1024', '1536x1024', '1024x1536']
    # Naming the model alone never claims another service's contract.
    assert input_rules({**GPT_IMAGE, 'protocol': 'volcengine', 'url': 'https://ark.test'})['profile'] != 'openai-gpt-image'
    assert input_rules({**GPT_IMAGE, 'kind': 'video'})['profile'] != 'openai-gpt-image'


def test_adapter_drops_response_format_only_for_gpt_image():
    adapter = adapter_for(GPT_IMAGE)
    assert isinstance(adapter, OpenAIImages) and adapter.response_format is False
    assert adapter.reference_field == 'image[]' and adapter.max_images == 16
    assert adapter.capabilities == {'image.generate', 'image.edit', 'image.cutout'}
    assert adapter.size(1600, 900) == (1536, 1024)
    # OpenAI-compatible services keep the vLLM-Omni request shape.
    compatible = adapter_for({**GPT_IMAGE, 'modelId': 'Tongyi-MAI/Z-Image-Turbo', 'url': 'http://gpu-box:8200/v1'})
    assert compatible.response_format is True and compatible.reference_field == 'image'


@pytest.fixture
def project(tmp_path):
    store, pid, session = new_project(tmp_path, 'gpt-image 测试')
    return store, {'id': str(pid)}, session


def run_image(project, reply, references=()):
    store, value, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', GPT_IMAGE['url'], GPT_IMAGE['modelId'], KEY, protocol='openai')
    seen = []

    def handle(request):
        seen.append(request)
        return reply

    async def run():
        manager = CreationGeneration(store, configs)
        manager.provider = GenerationProviders(manager.store, httpx.MockTransport(handle), poll_interval=0)
        try:
            manager._launch(*prepared(manager, (store, value['id'], session), config,
                prompt='海边的灯塔', parameters=dict(aspectRatio='3:2'), references=references))
            await asyncio.gather(*(job.future for job in manager.jobs.values()))
            return tasks(manager, value['id'])[-1]
        finally:
            await manager.close()
    return asyncio.run(run()), seen


def generated():
    return httpx.Response(200, json={'created': 0, 'data': [{'b64_json': base64.b64encode(png()).decode()}]})


def test_text_to_image_sends_no_response_format(project):
    task, seen = run_image(project, generated())
    assert task['status'] == 'succeeded', (task['error'], task['errorDetails'])
    [request] = seen
    payload = json.loads(request.read())
    assert request.url.path == '/v1/images/generations' and request.headers['authorization'] == f'Bearer {KEY}'
    # Documented gpt-image fields only: `response_format` is not one of them.
    assert list(payload) == ['model', 'prompt', 'size', 'n']
    assert (payload['model'], payload['size'], payload['n']) == ('gpt-image-1', '1536x1024', 1)
    assert '海边的灯塔' in payload['prompt']


def test_reference_pictures_travel_as_repeated_image_parts(project):
    store, value, session = project
    assets = CreationToolAssets(store)
    references = [assets.import_file(value['id'], str(uuid4()), f'参考{index}.png', png(), session)['id'] for index in (1, 2)]
    task, seen = run_image(project, generated(), references)
    assert task['status'] == 'succeeded', (task['error'], task['errorDetails'])
    [request] = seen
    body = request.read()
    assert request.url.path == '/v1/images/edits'
    assert body.count(b'name="image[]"') == 2 and b'name="image"' not in body.replace(b'name="image[]"', b'')
    assert b'response_format' not in body


@pytest.mark.parametrize(('status', 'code', 'category'), [
    (400, 'moderation_blocked', 'input'),
    (401, 'invalid_api_key', 'authentication'),
    (429, 'billing_hard_limit_reached', 'quota'),
    (429, 'rate_limit_exceeded', 'rate_limit'),
    (500, 'server_error', 'temporary'),
])
def test_failures_keep_their_documented_category(project, status, code, category):
    task, seen = run_image(project, httpx.Response(status, json={'error': {'code': code, 'message': f'rejected {KEY}'}}))
    assert task['status'] == 'failed' and task['assetId'] is None and len(seen) == 1
    details = task['errorDetails']
    assert (details['category'], details['stage'], details['providerCode']) == (category, 'submit', code)
    assert KEY not in json.dumps(task)


def test_moderation_block_explains_the_content_policy(project):
    task, _ = run_image(project, httpx.Response(400, json={'error': {'code': 'moderation_blocked'}}))
    details = task['errorDetails']
    assert '内容政策' in details['message'] and '参考' in details['suggestion']


def adapter_calls(adapter):
    seen = []

    def handle(request):
        seen.append(request)
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})

    adapter.transport = httpx.MockTransport(handle)
    return adapter, seen


CONFIG = {'kind': 'image', 'url': GPT_IMAGE['url'], 'modelId': 'gpt-image-1', 'apiKey': KEY, 'protocol': 'openai'}


def test_capability_adapter_keeps_the_gpt_image_request_shape():
    adapter, seen = adapter_calls(adapter_for(GPT_IMAGE))
    result = asyncio.run(adapter.image(CONFIG, ImageRequest(prompt='灯塔', width=1536, height=1024)))
    assert result.suffix == 'png'
    [request] = seen
    assert json.loads(request.read()) == {'model': 'gpt-image-1', 'prompt': '灯塔', 'size': '1536x1024', 'n': 1}


def test_capability_adapter_sends_references_as_image_parts():
    adapter, seen = adapter_calls(adapter_for(GPT_IMAGE))
    asyncio.run(adapter.image(CONFIG, ImageRequest(prompt='灯塔', width=1024, height=1024, image=png(), references=(png(),))))
    [request] = seen
    body = request.read()
    assert request.url.path == '/v1/images/edits' and body.count(b'name="image[]"') == 2
    assert b'response_format' not in body


def test_compatible_services_keep_response_format():
    config = {**CONFIG, 'url': 'http://gpu-box:8200/v1', 'modelId': 'Tongyi-MAI/Z-Image-Turbo'}
    adapter, seen = adapter_calls(adapter_for(config))
    asyncio.run(adapter.image(config, ImageRequest(prompt='灯塔', width=1024, height=1024)))
    [request] = seen
    assert json.loads(request.read())['response_format'] == 'b64_json'

def jpeg():
    out = io.BytesIO()
    Image.new('RGB', (16, 12), (200, 40, 40)).save(out, 'JPEG')
    return out.getvalue()


def test_reference_parts_declare_the_type_detected_from_the_bytes(project):
    """gpt-image validates the declared type, so a JPEG must not travel as image/png."""
    store, value, session = project
    references = [CreationToolAssets(store).import_file(value['id'], str(uuid4()), 'photo.jpg', jpeg(), session)['id']]
    task, seen = run_image(project, generated(), references)
    assert task['status'] == 'succeeded', (task['error'], task['errorDetails'])
    body = seen[0].read()
    assert b'Content-Type: image/jpeg' in body
    assert b'filename="image_1.jpg"' in body and b'image/png' not in body
