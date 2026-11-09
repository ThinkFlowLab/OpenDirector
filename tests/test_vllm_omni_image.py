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
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations import vllm_omni_image
from opendirector.integrations.providers import GenerationProviders

ZIMAGE = {'kind': 'image', 'url': 'http://gpu-box:8200/v1', 'modelId': 'Tongyi-MAI/Z-Image-Turbo', 'apiKey': 'token'}


def png():
    out = io.BytesIO()
    Image.new('RGB', (16, 12), 'blue').save(out, 'PNG')
    return out.getvalue()


def test_z_image_profile_is_text_only_and_routes_to_its_adapter():
    rules = input_rules(ZIMAGE)
    assert rules['profile'] == 'vllm-omni-image' and rules['allowedKinds'] == ['text'] and rules['maxImages'] == 0
    assert input_rules({**ZIMAGE, 'url': 'https://example.test/omni/v1', 'modelId': 'z-image-turbo'})['profile'] == 'vllm-omni-image'
    assert input_rules({**ZIMAGE, 'kind': 'video'})['profile'] == 'compatible'
    assert input_rules({**ZIMAGE, 'modelId': 'Tongyi-MAI/Z-Image'})['profile'] == 'compatible'
    providers = GenerationProviders(None)
    assert providers._profile_adapter(ZIMAGE) is providers.vllm_omni_image
    assert providers._profile_adapter({**ZIMAGE, 'protocol': 'openai', 'authMode': 'none'}) is providers.vllm_omni_image
    assert providers._profile_adapter({**ZIMAGE, 'modelId': 'other'}) is None
    with pytest.raises(ProjectError, match='只用于图片生成'):
        providers.vllm_omni_image.validate('video', ZIMAGE)


@pytest.fixture
def project(tmp_path):
    store, pid, session = new_project(tmp_path, '出图测试')
    return store, {'id': str(pid)}, session, CreationToolAssets(store)


def server(posts, reply, authorization='Bearer token'):
    def handle(request):
        assert request.headers.get('authorization') == authorization
        assert request.method == 'POST' and request.url.path == '/v1/images/generations'
        posts.append(json.loads(request.read()))
        return reply
    return handle


def run_image(project, reply, references=(), *, self_hosted=False):
    store, value, session, _ = project
    configs = ModelConfigs(store.local.repository)
    config = (configs.save('image', ZIMAGE['url'], ZIMAGE['modelId'], '', connection_type='self_hosted') if self_hosted
              else configs.save('image', ZIMAGE['url'], ZIMAGE['modelId'], 'token', protocol='openai'))
    posts = []
    async def run():
        manager = CreationGeneration(store, configs)
        manager.provider = GenerationProviders(manager.store, httpx.MockTransport(server(posts, reply, None if self_hosted else 'Bearer token')), poll_interval=0)
        try:
            manager._launch(*prepared(manager, (store, value['id'], session), config,
                prompt='樱花校门前的少女', parameters=dict(aspectRatio='16:9'), references=references))
            await asyncio.gather(*(job.future for job in manager.jobs.values()))
            return tasks(manager, value['id'])[-1]
        finally:
            await manager.close()
    return asyncio.run(run()), posts


def test_generates_a_16_9_png_with_text_references_inlined(project):
    store, value, session, _ = project
    note = CreationToolAssets(store).import_file(value['id'], str(uuid4()), '角色设定.md', '黑色长发，红色领结'.encode(), session)
    reply = httpx.Response(200, json={'created': 0, 'data': [{'b64_json': base64.b64encode(png()).decode()}]})
    task, posts = run_image(project, reply, [note['id']])
    assert task['status'] == 'succeeded', (task['error'], task['errorDetails'])
    [payload] = posts
    assert {key: payload[key] for key in ('model', 'size', 'response_format', 'output_format', 'num_inference_steps', 'guidance_scale')} == {
        'model': 'Tongyi-MAI/Z-Image-Turbo', 'size': '1344x768', 'response_format': 'b64_json', 'output_format': 'png',
        'num_inference_steps': 9, 'guidance_scale': 0.0}
    # The sampling sent is the sampling the job fixed and recorded when it was accepted.
    job = project[0].snapshot(value['id']).jobs[-1]
    assert (job.execution.numInferenceSteps, job.execution.guidanceScale) == (9, 0.0)
    assert {key: job.adapterParameters[key] for key in ('num_inference_steps', 'guidance_scale')} == {'num_inference_steps': 9, 'guidance_scale': 0.0}
    assert '樱花校门前的少女' in payload['prompt'] and '黑色长发，红色领结' in payload['prompt']
    assert 'image' not in payload and 'watermark' not in payload
    asset = project[3].record(project[3].assets.get(value['id'], task['assetId']))
    assert asset['kind'] == 'image' and (asset['width'], asset['height']) == (16, 12)


@pytest.mark.parametrize('parameters', [
    {'size': '1344x768', 'num_inference_steps': 9, 'guidance_scale': 0.0},
    {'size': '1344x768', 'num_inference_steps': 4, 'guidance_scale': 0.0},
    {'size': '1344x768'},
])
def test_sends_the_sampling_the_job_was_accepted_with(monkeypatch, parameters):
    # Execution and recovery both rebuild the request from the job's parameters. A job accepted
    # before sampling was fixed has none and keeps the service defaults instead of today's values.
    monkeypatch.setattr(vllm_omni_image, 'generation_references', lambda store, task, config: {'prompt': '灯塔', 'images': []})
    posts = []
    reply = httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})
    generation = vllm_omni_image.VllmOmniImageGeneration(None, httpx.MockTransport(server(posts, reply)))
    asyncio.run(generation.generate({**ZIMAGE, 'protocol': 'openai'}, {'parameters': parameters}, None))
    [payload] = posts
    assert {key: payload[key] for key in ('num_inference_steps', 'guidance_scale') if key in payload} == {
        key: value for key, value in parameters.items() if key != 'size'}


@pytest.mark.parametrize('accepted', [{'num_inference_steps': 9, 'guidance_scale': 0.0}, {}])
def test_queued_job_recovery_sends_the_sampling_fixed_at_acceptance(tmp_path, monkeypatch, accepted):
    project = new_project(tmp_path)
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', ZIMAGE['url'], ZIMAGE['modelId'], 'token', protocol='openai')
    monkeypatch.setattr(vllm_omni_image, 'SAMPLING', dict(accepted))  # {}: accepted before sampling was fixed
    task, _, _ = prepared(CreationGeneration(store, configs), project, config, prompt='灯塔')
    # A later release changes the values while the job is still queued.
    monkeypatch.setattr(vllm_omni_image, 'SAMPLING', {'num_inference_steps': 4, 'guidance_scale': 1.5})
    posts = []
    reply = httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})
    async def run():
        restarted = CreationGeneration(store, configs)
        restarted.provider = GenerationProviders(restarted.store, httpx.MockTransport(server(posts, reply)), poll_interval=0)
        try:
            await restarted.recover(str(pid), task['id'])
            await asyncio.gather(*(job.future for job in list(restarted.jobs.values())))
        finally:
            await restarted.close()
    asyncio.run(run())
    [payload] = posts
    assert {key: payload[key] for key in ('num_inference_steps', 'guidance_scale') if key in payload} == accepted
    job = store.snapshot(pid).jobs[-1]
    assert job.status == 'succeeded', job.errorDetails
    assert (job.execution.numInferenceSteps, job.execution.guidanceScale) == (accepted.get('num_inference_steps'), accepted.get('guidance_scale'))


def test_reference_images_are_rejected_before_any_request(project):
    store, value, session, _ = project
    picture = CreationToolAssets(store).import_file(value['id'], str(uuid4()), '角色.png', png(), session)
    with pytest.raises(ProjectError, match='参考素材类型'):
        run_image(project, httpx.Response(500), [picture['id']])


@pytest.mark.parametrize('reply', [
    httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(b'GIF89a').decode()}]}),
    httpx.Response(200, json={'data': []}),
    httpx.Response(400, json={'error': {'message': 'size must be a multiple of 16'}}),
])
def test_bad_responses_fail_the_task(project, reply):
    task, posts = run_image(project, reply)
    assert task['status'] == 'failed' and len(posts) == 1 and task['assetId'] is None


def test_self_hosted_config_without_a_key_sends_no_authorization(project):
    reply = httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})
    task, posts = run_image(project, reply, self_hosted=True)
    assert task['status'] == 'succeeded' and len(posts) == 1, (task['error'], task['errorDetails'])
