import asyncio
import base64
from email.parser import BytesParser
from email.policy import default
import io
import json
import shutil
import subprocess
from uuid import uuid4

import httpx
from PIL import Image
import pytest

from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.model_availability import ModelAvailability
from generation_helpers import new_project, prepared as prepare_command, tasks
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.providers import GenerationProviders
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector.integrations.vllm_omni import VllmOmniGeneration, h3_frames
from opendirector.integrations.volcengine import VolcengineGeneration
from test_model_availability import document

H3 = {'protocol': 'vllm_omni', 'kind': 'video', 'url': 'http://gpu-box:8000/v1', 'modelId': 'MiniMaxAI/MiniMax-H3', 'apiKey': 'token'}


def png():
    out = io.BytesIO()
    Image.new('RGB', (16, 12)).save(out, 'PNG')
    return out.getvalue()


def data_uri(data, mime):
    return f'data:{mime};base64,' + base64.b64encode(data).decode()


def multipart(request):
    request.read()
    message = BytesParser(policy=default).parsebytes(
        b'Content-Type: ' + request.headers['content-type'].encode() + b'\r\n\r\n' + request.content)
    fields, files = {}, []
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        if part.get_filename():
            files.append((name, part.get_filename(), part.get_content_type()))
        else:
            fields[name] = part.get_content()
    return fields, files


def test_h3_profile_follows_the_served_model_on_any_host():
    rules = input_rules(H3)
    assert rules['profile'] == 'vllm-omni-h3' and rules['videoModes'] == ['first_frame', 'reference', 'continuation']
    # The continuation source is cached server-side, never uploaded: no video references.
    assert rules['maxVideos'] == 0 and 'video' in rules['allowedKinds']
    assert input_rules({**H3, 'url': 'https://example.test/omni/v1', 'modelId': 'MiniMax-H3'})['profile'] == 'vllm-omni-h3'
    assert input_rules({**H3, 'modelId': 'MiniMaxAI/MiniMax-H3-Turbo'})['profile'] == 'standard-video'
    assert input_rules({**H3, 'protocol': 'volcengine'})['profile'] == 'compatible'
    assert input_rules({**H3, 'kind': 'image'})['profile'] == 'compatible'
    providers = GenerationProviders(None)
    assert providers._profile_adapter(H3) is providers.vllm_omni
    assert providers._profile_adapter({**H3, 'protocol': 'vllm_omni'}) is providers.vllm_omni
    # Other vLLM-Omni video models keep the FastH3 profile and the protocol adapters.
    fasth3 = {**H3, 'modelId': 'FastH3-Omni', 'protocol': 'vllm_omni'}
    assert input_rules(fasth3)['profile'] == 'fasth3-omni' and providers._profile_adapter(fasth3) is None
    assert providers._profile_adapter({**H3, 'url': 'https://ark.cn-beijing.volces.com/api/plan/v3', 'modelId': 'doubao-seedance-2.0'}) is None


@pytest.mark.parametrize('seconds,frames', [(5, 124), (1, 107), (4, 107), (10, 243), (60, 345)])
def test_lengths_snap_to_the_h3_frame_grid(seconds, frames):
    assert h3_frames(seconds) == frames


def prepared(images=(), audios=(), continue_from=None, size=None):
    return {'prompt': '画面', 'images': list(images), 'audios': list(audios), 'continueFrom': continue_from, 'continueSize': size}


@pytest.mark.parametrize('mode,refs,extra,files', [
    ('first_frame', prepared(), {'task': 't2va', 'aspect_ratio': '9:16'}, []),
    ('first_frame', prepared([data_uri(png(), 'image/png')]), {'task': 'fl2va'}, [('input_reference', 'first_frame.png', 'image/png')]),
    ('reference', prepared([data_uri(png(), 'image/png')], [data_uri(b'ID3', 'audio/mpeg')]), {'task': 'ref2va'},
     [('input_references', 'image_1.png', 'image/png'), ('input_references', 'audio_1.mp3', 'audio/mpeg')]),
    ('continuation', prepared([data_uri(png(), 'image/png')], continue_from='video_gen_a', size=(1344, 768)),
     {'task': 'ref2va', 'continue_from': 'video_gen_a'}, [('input_references', 'image_1.png', 'image/png')]),
])
def test_request_form_per_mode(mode, refs, extra, files):
    task = {'videoMode': mode, 'parameters': {'duration': 5, 'ratio': '9:16'}}
    fields, uploads = VllmOmniGeneration(None).form(H3, task, refs)
    assert json.loads(fields['extra_params']) == extra
    assert fields['model'] == 'MiniMaxAI/MiniMax-H3' and fields['fps'] == '24'
    assert [(name, upload[0], upload[2]) for name, upload in uploads] == files
    assert fields['num_frames'] == '124' and 'quality' not in fields
    assert fields.get('size') == ('1344x768' if mode == 'continuation' else None)


class FakeOmni:
    """The async /v1/videos job API with a per-server latent cache of finished jobs."""

    def __init__(self, video):
        self.video, self.jobs, self.posts, self.cached = video, {}, [], set()

    def __call__(self, request):
        assert request.headers['authorization'] == 'Bearer token'
        path = request.url.path
        if request.method == 'POST' and path == '/v1/videos':
            fields, files = multipart(request)
            extra = json.loads(fields['extra_params'])
            self.posts.append((fields, files))
            if 'continue_from' in extra and extra['continue_from'] not in self.cached:
                return httpx.Response(400, json={'detail': f"continue_from video {extra['continue_from']!r} is unknown or has not completed."})
            job = f'video_gen_{len(self.posts)}'
            self.jobs[job] = 0
            return httpx.Response(200, json={'id': job, 'status': 'queued'})
        job = path.split('/')[3]
        if path.endswith('/content'):
            return httpx.Response(200, content=self.video)
        if request.method == 'DELETE':
            return httpx.Response(200, json={'id': job, 'deleted': True})
        self.jobs[job] += 1
        if self.jobs[job] < 2:
            return httpx.Response(200, json={'id': job, 'status': 'in_progress'})
        self.cached.add(job)
        return httpx.Response(200, json={'id': job, 'status': 'completed'})


@pytest.fixture
def project(tmp_path):
    store, pid, session = new_project(tmp_path, '接续测试')
    return store, {'id': str(pid)}, session, CreationToolAssets(store)


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='media fixtures require ffmpeg')
def test_canvas_continues_a_previous_h3_clip_by_its_job_id(project, tmp_path):
    store, value, session, canvas = project
    clip = tmp_path / 'clip.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:d=0.5', '-f', 'lavfi', '-i', 'sine=d=0.5',
                    '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(clip)], check=True)
    server = FakeOmni(clip.read_bytes())
    configs = ModelConfigs(store.local.repository)
    config = configs.save('video', H3['url'], H3['modelId'], 'token', connection_type='self_hosted', protocol='vllm_omni', auth_mode='bearer')
    declaration = document('video_generation', 'text_to_video', '/v1/videos', 'video', model=H3['modelId'])
    operation = declaration['models'][0]['operations']['video_generation']
    operation['profiles'].append({'id': 'video_to_video', 'support': 'unsupported'})
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=declaration)))
    availability = ModelAvailability(configs, probe)

    async def generate(inputs):
        parameters = dict(videoMode=inputs['videoMode'])
        task, pinned, private = prepare_command(manager, (store, value['id'], session), config,
            prompt=inputs['prompt'], parameters=parameters, references=inputs['referenceIds'])
        manager._launch(task, pinned, private)
        await asyncio.gather(*(job.future for job in manager.jobs.values()))
        return tasks(manager, value['id'])[-1]

    async def run():
        nonlocal manager
        manager = CreationGeneration(store, configs, availability=availability)
        manager.provider = GenerationProviders(manager.store, httpx.MockTransport(server), poll_interval=0)
        first = await generate({'prompt': '灯塔在黄昏亮起', 'referenceIds': [], 'videoMode': 'first_frame'})
        assert first['status'] == 'succeeded' and first['externalTaskId'] == 'video_gen_1', (first['error'], first['errorDetails'])
        assert json.loads(server.posts[0][0]['extra_params']) == {'task': 't2va', 'aspect_ratio': '16:9'}

        # A fresh deployment pause still prevents a continuation on /videos.
        operation['execution']['state'] = 'paused'
        availability.refresh([config['id']], manual=True)
        with pytest.raises(ProjectError, match='服务已暂停'):
            await generate({'prompt': '暂停期间接续', 'referenceIds': [first['assetId']], 'videoMode': 'continuation'})
        assert len(store.snapshot(value['id']).jobs) == len(server.posts) == 1
        operation['execution']['state'] = 'unpaused'
        availability.refresh([config['id']], manual=True)

        second = await generate({'prompt': '光束扫过海面', 'referenceIds': [first['assetId']], 'videoMode': 'continuation'})
        assert second['status'] == 'succeeded' and second['videoMode'] == 'continuation', (second['error'], second['errorDetails'])
        fields, files = server.posts[1]
        assert json.loads(fields['extra_params']) == {'task': 't2va', 'continue_from': 'video_gen_1'}
        assert (fields['size'], fields['num_frames']) == ('64x48', '124') and files == []
        reference = store.snapshot(value['id']).jobs[-1].inputSnapshot.references[0]
        assert reference.role == 'continuation' and reference.transmission == 'latent'
        assert str(reference.asset.assetId) == first['assetId']

        # The server lost its cache (e.g. restarted): the failure is explicit, not a silent new clip.
        server.cached.clear()
        third = await generate({'prompt': '海浪拍岸', 'referenceIds': [second['assetId']], 'videoMode': 'continuation'})
        assert third['status'] == 'failed' and '接续缓存' in third['errorDetails']['message']

        uploaded = canvas.import_file(value['id'], str(uuid4()), 'upload.mp4', clip.read_bytes(), session)
        with pytest.raises(ProjectError, match='不能接续'):
            await generate({'prompt': '接着上传的视频', 'referenceIds': [uploaded['id']], 'videoMode': 'continuation'})
        with pytest.raises(ProjectError, match='视频续写'):
            await generate({'prompt': '没有上一段', 'referenceIds': [], 'videoMode': 'continuation'})
        await manager.close()

    manager = None
    try:
        asyncio.run(run())
    finally:
        probe.close()


def test_other_models_keep_rejecting_video_references(project):
    store, value, _, _ = project
    seedance = {'kind': 'video', 'url': 'https://ark.cn-beijing.volces.com/api/plan/v3', 'modelId': 'doubao-seedance-2.0', 'apiKey': 'k'}
    with pytest.raises(ProjectError, match='不支持接续生成'):
        VolcengineGeneration(store).prepare_inputs(value['id'], {'kind': 'video', 'prompt': 'p', 'promptContent': None,
                                                                'referenceIds': [], 'videoMode': 'continuation'}, seedance)


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='media fixtures require ffmpeg')
def test_requested_length_and_canvas_reach_the_h3_request(project, tmp_path):
    store, value, session, _ = project
    clip = tmp_path / 'clip.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=64x48:d=0.5', '-pix_fmt', 'yuv420p', str(clip)], check=True)
    server = FakeOmni(clip.read_bytes())
    configs = ModelConfigs(store.local.repository)
    config = configs.save('video', H3['url'], H3['modelId'], 'token', connection_type='self_hosted', protocol='vllm_omni', auth_mode='bearer')
    async def run():
        manager = CreationGeneration(store, configs)
        manager.provider = GenerationProviders(manager.store, httpx.MockTransport(server), poll_interval=0)
        task, pinned, private = prepare_command(manager, (store, value['id'], session), config, prompt='雨夜街头',
            parameters=dict(videoMode='first_frame', durationSeconds=10, aspectRatio='9:16'))
        manager._launch(task, pinned, private)
        await asyncio.gather(*(job.future for job in manager.jobs.values()))
        done = tasks(manager, value['id'])[-1]
        assert done['status'] == 'succeeded', done['errorDetails']
        assert (done['parameters']['duration'], done['parameters']['ratio']) == (10, '9:16')
        intent = store.snapshot(value['id']).generationSpecs[-1]
        assert intent.parameters.durationSeconds == 10 and intent.prompt == '雨夜街头'
        fields, _ = server.posts[0]
        assert fields['num_frames'] == str(h3_frames(10))
        assert fields['size'] == '480x832' and json.loads(fields['extra_params']) == {'task': 't2va'}
        await manager.close()
    asyncio.run(run())
