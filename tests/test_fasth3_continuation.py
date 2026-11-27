"""Latent continuation (continue_from) on the FastH3-style Ref2VA request path."""
import asyncio
import json
from email.parser import BytesParser
from email.policy import default
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from opendirector.domain.generation import GenerationError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.integrations.fasth3 import generation_fields, video_parameters
from opendirector.integrations.providers import GenerationProviders


pytestmark = pytest.mark.cpu

CONFIG = {'kind': 'video', 'protocol': 'vllm_omni', 'url': 'http://localhost:18091/v1', 'modelId': 'Pika-H3',
          'videoAdapter': 'fasth3', 'apiKey': '', 'authMode': 'none'}


@pytest.mark.parametrize('adapter', ['fasth3', 'fasth3_dual'])
def test_every_fasth3_shaped_model_offers_continuation(adapter):
    assert 'continuation' in input_rules({**CONFIG, 'videoAdapter': adapter})['videoModes']


def test_fields_name_the_source_job_and_keep_its_canvas():
    fields, extra = generation_fields({'duration': 5, 'size': '832x480'}, continue_from='video_gen_1', continue_size=(768, 1344))
    assert extra['continue_from'] == 'video_gen_1' and extra['task'] == 'ref2va'
    # Latents cannot change size: the source canvas replaces the panel's size.
    assert fields['size'] == '768x1344' and fields['num_inference_steps'] == 8
    assert 'continue_from' not in generation_fields({'duration': 5})[1]


def fixture(source_job, **source_meta):
    video = {'id': str(uuid4()), 'name': 'part1.mp4', 'kind': 'video', 'type': 'video/mp4', 'fingerprint': 'fixture',
             'durationMs': 5167, 'width': 768, 'height': 1344, 'generationTaskId': 'task-1', **source_meta}
    picture = {'id': str(uuid4()), 'name': 'costume.png', 'kind': 'image', 'type': 'image/png', 'fingerprint': 'fixture'}
    assets = {video['id']: (b'source-video-bytes', video), picture['id']: (b'\x89PNG\r\n\x1a\nfixture', picture)}
    store = SimpleNamespace(asset=lambda owner, key: assets[key], generation_task=lambda owner, key: source_job)
    task = {'kind': 'video', 'projectId': 'owner', 'prompt': '她缓缓落地', 'referenceIds': list(assets), 'videoMode': 'continuation'}
    task['parameters'] = video_parameters(task, {key: pair[1] for key, pair in assets.items()}, duration_seconds=5)
    return store, task


def run(store, task, handle):
    async def submitted(value):
        assert value == 'video_gen_2'
    provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
    return asyncio.run(provider.generate(CONFIG, task, submitted))


SOURCE_JOB = {'kind': 'video', 'status': 'succeeded', 'externalTaskId': 'video_gen_1', 'baseURL': CONFIG['url'], 'model': CONFIG['modelId']}


def test_the_wire_carries_the_job_id_and_not_the_source_video():
    store, task = fixture(SOURCE_JOB)
    seen = {}

    def handle(request):
        if request.method == 'POST':
            prefix = 'Content-Type: ' + request.headers['content-type'] + '\r\n\r\n'
            message = BytesParser(policy=default).parsebytes(prefix.encode() + request.content)
            for part in message.iter_parts():
                seen.setdefault(part.get_param('name', header='content-disposition'), []).append(part.get_payload(decode=True))
            return httpx.Response(200, json={'id': 'video_gen_2'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=b'generated')
        return httpx.Response(200, json={'status': 'completed'})

    assert run(store, task, handle) == ('mp4', b'generated')
    extra = json.loads(seen['extra_params'][0])
    assert extra['continue_from'] == 'video_gen_1' and extra['task'] == 'ref2va'
    assert seen['size'] == [b'768x1344'] and seen['num_inference_steps'] == [b'8']
    # The picture still travels as a reference; the source clip stays server-side.
    assert len(seen['input_references']) == 1 and b'source-video-bytes' not in b''.join(seen['input_references'])


def test_an_uploaded_or_foreign_clip_cannot_be_continued():
    for job in ({**SOURCE_JOB, 'model': 'another-model'}, {**SOURCE_JOB, 'status': 'failed'}):
        store, task = fixture(job)
        with pytest.raises(ProjectError, match='不能接续'):
            run(store, task, lambda request: pytest.fail('nothing may be sent'))
    store, task = fixture(SOURCE_JOB, generationTaskId=None)
    with pytest.raises(ProjectError, match='不能接续'):
        run(store, task, lambda request: pytest.fail('nothing may be sent'))


@pytest.mark.parametrize('answer', [
    httpx.Response(400, json={'error': {'message': 'continue_from job video_gen_1 has no cached latents'}}),
    None,
])
def test_a_clip_the_service_no_longer_holds_is_explained(answer):
    store, task = fixture(SOURCE_JOB)

    def handle(request):
        if request.method == 'POST':
            return answer or httpx.Response(200, json={'id': 'video_gen_2'})
        return httpx.Response(200, json={'status': 'failed', 'error': {'message': 'continue_from: cached latents were evicted'}})

    with pytest.raises(GenerationError, match='接续缓存'):
        run(store, task, handle)
