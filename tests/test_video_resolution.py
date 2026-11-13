import asyncio
from email.parser import BytesParser
from email.policy import default
from uuid import uuid4

import httpx
import pytest

from opendirector.application.creation_generation import CreationGeneration
from generation_helpers import new_project, prepared
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.domain.video_output import apply_video_resolution, h3_output_size
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.providers import GenerationProviders
from opendirector.integrations.vllm_omni import VllmOmniGeneration


@pytest.mark.parametrize('resolution, ratio, expected', [
    ('480P', '16:9', '832x480'), ('480P', '9:16', '480x832'),
    ('768P', '16:9', '1344x768'), ('768P', '9:16', '768x1344'),
    ('768P', '1:1', '768x768'), ('768P', '4:3', '1024x768'),
    ('480P', '3:4', '480x640'), ('768P', '21:9', '1792x768'),
])
def test_native_h3_resolutions_use_valid_buckets_and_32_pixel_alignment(resolution, ratio, expected):
    assert h3_output_size(resolution, ratio) == expected
    assert all(int(edge) % 32 == 0 for edge in expected.split('x'))


def prepare(tmp_path, *, resolution=None, model='FastH3-Omni-3090', references=(), duration_seconds=None):
    project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    config = configs.save('video', 'http://model.test/v1', model, '', connection_type='self_hosted')
    runner = CreationGeneration(project[0], configs)
    parameters = dict(videoMode='reference', aspectRatio='16:9', resolution='auto' if resolution in (None, '自动') else resolution)
    if duration_seconds is not None: parameters['durationSeconds'] = duration_seconds
    task, _, private = prepared(runner, project, config, parameters=parameters, references=references, prompt='山间日出')
    return runner.store, task, private


@pytest.mark.parametrize('seconds', [4, 7, 10, 15])
def test_panel_duration_survives_api_receipt_and_actual_video_request(tmp_path, seconds):
    store, task, config = prepare(tmp_path, resolution='480P', duration_seconds=seconds)
    assert task['parameters']['duration'] == seconds
    assert task['parameters']['seconds'] == str(seconds)
    posts = []
    def handle(request):
        if request.method == 'POST':
            import json
            content = BytesParser(policy=default).parsebytes(
                ('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + request.content)
            fields = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True).decode()
                      for part in content.iter_parts() if part.get_filename() is None}
            assert fields['seconds'] == str(seconds)
            assert json.loads(fields['extra_params'])['duration'] == seconds
            posts.append(fields)
            return httpx.Response(200, json={'id': 'original-duration-task'})
        if request.url.path.endswith('/content'): return httpx.Response(200, content=b'fixture-video')
        return httpx.Response(200, json={'id': 'original-duration-task', 'status': 'completed'})
    async def run():
        async def submitted(value): assert value == 'original-duration-task'
        provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
        assert await provider.generate(config, task, submitted) == ('mp4', b'fixture-video')
        # Recovery keeps the original duration and remote ID without reposting.
        assert await provider.generate(config, {**task, 'externalTaskId': 'original-duration-task'}, submitted) == ('mp4', b'fixture-video')
        assert len(posts) == 1
    asyncio.run(run())


@pytest.mark.parametrize('resolution', [None, '自动', 'auto'])
def test_automatic_requests_keep_fasth3_480p_default(tmp_path, resolution):
    _, task, _ = prepare(tmp_path, resolution=resolution)
    assert task['parameters']['size'] == '832x480'
    assert task['parameters']['resolution'] == '480p'


@pytest.mark.parametrize('resolution, expected', [('480P', '832x480'), ('768P', '1344x768')])
def test_selection_survives_api_task_snapshot_and_actual_fasth3_multipart(tmp_path, resolution, expected):
    store, task, config = prepare(tmp_path, resolution=resolution)
    assert task['parameters']['size'] == expected
    assert task['parameters']['resolution'] == resolution.lower()
    posts = []
    def handle(request):
        if request.method == 'POST':
            content = BytesParser(policy=default).parsebytes(
                ('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + request.content)
            fields = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True).decode()
                      for part in content.iter_parts() if part.get_filename() is None}
            assert fields['size'] == expected
            assert fields['num_inference_steps'] == '8'
            posts.append(fields)
            return httpx.Response(200, json={'id': 'existing-test'})
        if request.url.path.endswith('/content'): return httpx.Response(200, content=b'fixture-video')
        return httpx.Response(200, json={'id': 'existing-test', 'status': 'completed'})
    async def run():
        accepted = []
        async def submitted(value): accepted.append(value)
        provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
        assert await provider.generate(config, task, submitted) == ('mp4', b'fixture-video')
        assert accepted == ['existing-test']
        # Resuming must query the original job, even if a new form would be possible.
        assert await provider.generate(config, {**task, 'externalTaskId': 'existing-test'}, submitted) == ('mp4', b'fixture-video')
        assert len(posts) == 1
    asyncio.run(run())


def test_explicit_ratio_wins_over_references_and_automatic_fit_prefers_video():
    config = {'kind': 'video', 'protocol': 'vllm_omni', 'modelId': 'FastH3-Omni', 'url': 'http://model.test/v1'}
    node = {'videoMode': 'reference', 'referenceIds': ['photo', 'video']}
    records = {'photo': {'kind': 'image', 'width': 512, 'height': 1024},
               'video': {'kind': 'video', 'width': 1920, 'height': 1080}}
    parameters = {}
    apply_video_resolution(parameters, node, records, config, {'resolution': '768P', 'aspectRatio': '9:16'})
    assert parameters['size'] == '768x1344'
    apply_video_resolution(parameters, node, records, config, {'resolution': '768P', 'aspectRatio': 'adaptive'})
    assert parameters['size'] == '1344x768'
    records['video'].update(width=1080, height=1920)
    apply_video_resolution(parameters, node, records, config, {'resolution': '768P', 'aspectRatio': '16:9'})
    assert parameters['size'] == '1344x768'
    apply_video_resolution(parameters, node, records, config, {'resolution': '768P'})
    assert parameters['size'] == '768x1344'
    assert records['photo']['width'] == 512  # Source/reference dimensions remain untouched.


@pytest.mark.parametrize('resolution', ['720P', '1080P', '4K'])
def test_unsupported_h3_resolutions_are_rejected_before_task_acceptance(tmp_path, resolution):
    with pytest.raises(ProjectError, match='输出分辨率'):
        prepare(tmp_path, resolution=resolution)
    assert not list(tmp_path.glob('projects/*/tasks/*.json'))


def test_native_h3_explicit_resolution_reaches_form_and_continuation_stays_automatic(tmp_path):
    _, task, config = prepare(tmp_path, resolution='768P', model='MiniMaxAI/MiniMax-H3')
    prepared = {'prompt': '山间日出', 'images': [], 'audios': [], 'continueSize': None}
    fields, _ = VllmOmniGeneration(None).form(config, task, prepared)
    assert fields['size'] == '1344x768'
    with pytest.raises(ProjectError, match='接续沿用'):
        apply_video_resolution({}, {'videoMode': 'continuation', 'referenceIds': []}, {}, config, {'resolution': '768P'})


def test_seedance_maps_resolution_and_rejects_1080p_image_reference():
    config = {'kind': 'video', 'protocol': 'volcengine', 'modelId': 'doubao-seedance-2.0',
              'url': 'https://ark.cn-beijing.volces.com/api/plan/v3'}
    assert input_rules(config)['outputResolutions'] == ['480P', '720P', '1080P', '4K']
    node = {'videoMode': 'reference', 'referenceIds': ['photo']}
    records = {'photo': {'kind': 'image', 'width': 512, 'height': 512}}
    with pytest.raises(ProjectError, match='图片参考模式'):
        apply_video_resolution({}, node, records, config, {'resolution': '1080P'})
    for resolution in ('480P', '720P', '4K'):
        parameters = {}
        apply_video_resolution(parameters, node, records, config, {'resolution': resolution})
        assert parameters == {'resolution': resolution.lower()}
    parameters = {}
    apply_video_resolution(parameters, {**node, 'referenceIds': []}, {}, config, {'resolution': '1080P'})
    assert parameters == {'resolution': '1080p'}


@pytest.mark.parametrize('model', ['doubao-seedance-2.0-mini', 'doubao-seedance-2-0-mini', 'doubao-seedance-2-0-mini-260615'])
def test_seedance_mini_declares_the_720p_ladder_and_4_to_15_seconds(model):
    config = {'kind': 'video', 'protocol': 'volcengine', 'modelId': model,
              'url': 'https://ark.cn-beijing.volces.com/api/plan/v3'}
    rules = input_rules(config)
    assert rules['profile'] == 'seedance-2.0'
    assert rules['outputResolutions'] == ['480P', '720P']
    assert rules['videoCapabilities']['outputs'] == [
        {'resolution': '480P', 'durations': list(range(4, 16))},
        {'resolution': '720P', 'durations': list(range(4, 16))},
    ]
    with pytest.raises(ProjectError, match='不支持所选分辨率'):
        apply_video_resolution({}, {'videoMode': 'reference', 'referenceIds': []}, {}, config, {'resolution': '1080P'})
    parameters = {}
    apply_video_resolution(parameters, {'videoMode': 'reference', 'referenceIds': []}, {}, config,
                           {'resolution': '720P', 'durationSeconds': 12})
    assert parameters == {'resolution': '720p'}


def test_seedance_fast_keeps_the_base_ladder_for_future_ids():
    config = {'kind': 'video', 'protocol': 'volcengine', 'modelId': 'doubao-seedance-2.0',
              'url': 'https://ark.cn-beijing.volces.com/api/plan/v3'}
    fast = {**config, 'modelId': 'doubao-seedance-2.0-fast'}
    assert input_rules(fast)['outputResolutions'] == ['480P', '720P']
    assert input_rules(config)['outputResolutions'] == ['480P', '720P', '1080P', '4K']


def test_seedance_resolution_is_forwarded_in_the_provider_json(tmp_path):
    store = LocalProjects(tmp_path)
    config = {'kind': 'video', 'protocol': 'volcengine', 'modelId': 'doubao-seedance-2.0',
              'url': 'https://ark.cn-beijing.volces.com/api/plan/v3', 'apiKey': 'fixture-key'}
    task = {'kind': 'video', 'projectId': str(uuid4()), 'prompt': '山间日出',
            'referenceIds': [], 'videoMode': 'reference', 'parameters': {'resolution': '4k'}}
    posts = []
    def handle(request):
        if request.method == 'POST':
            import json
            posts.append(json.loads(request.content))
            return httpx.Response(200, json={'id': 'original-task'})
        if request.url.host == 'cdn.test': return httpx.Response(200, content=b'fixture-video')
        return httpx.Response(200, json={'status': 'succeeded', 'content': {'video_url': 'https://cdn.test/result'}})
    async def run():
        async def submitted(value): assert value == 'original-task'
        provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
        assert await provider.generate(config, task, submitted) == ('mp4', b'fixture-video')
    asyncio.run(run())
    assert len(posts) == 1 and posts[0]['resolution'] == '4k'


def test_seedance_sends_whole_seconds_because_ark_rejects_floats(tmp_path):
    # The editor stores durationSeconds as 4.0; Ark answers InvalidParameter for
    # that JSON number, so the adapter has to submit 4.
    store = LocalProjects(tmp_path)
    config = {'kind': 'video', 'protocol': 'volcengine', 'modelId': 'doubao-seedance-2.0-mini',
              'url': 'https://ark.cn-beijing.volces.com/api/plan/v3', 'apiKey': 'fixture-key'}
    task = {'kind': 'video', 'projectId': str(uuid4()), 'prompt': '小猫奔跑',
            'referenceIds': [], 'videoMode': 'reference',
            'parameters': {'duration': 4.0, 'ratio': '16:9', 'generate_audio': True, 'watermark': False}}
    posts = []
    def handle(request):
        if request.method == 'POST':
            import json
            posts.append(json.loads(request.content))
            return httpx.Response(200, json={'id': 'task-1'})
        if request.url.host == 'cdn.test': return httpx.Response(200, content=b'fixture-video')
        return httpx.Response(200, json={'status': 'succeeded', 'content': {'video_url': 'https://cdn.test/result'}})
    async def run():
        async def submitted(value): assert value == 'task-1'
        provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
        assert await provider.generate(config, task, submitted) == ('mp4', b'fixture-video')
    asyncio.run(run())
    assert posts[0]['duration'] == 4 and type(posts[0]['duration']) is int
