import asyncio
import base64
import io
import json
import subprocess
import time
from uuid import uuid4

import httpx
import pytest
from PIL import Image

from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.projects import ProjectError
from opendirector.application.creation_tool_assets import CreationToolAssets
from generation_helpers import new_project
from opendirector.infrastructure.local_projects import LocalProjects, child
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.model_adapters import OpenAIImages, adapter_for, capabilities_of

ZIMAGE = ('image', 'http://gpu:8210/v1', 'Tongyi-MAI/Z-Image-Turbo')
H3 = ('video', 'http://gpu:8010/v1', 'MiniMaxAI/MiniMax-H3')
TTS = ('audio', 'http://gpu:8220/v1', 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice')
CHAT = ('agent', 'http://gpu:8100/v1', 'Qwen/Qwen3-30B-A3B')
SAM3 = ('vision', 'http://gpu:8230/v1', 'facebook/sam3')


def png(size=(64, 48), color='blue', mode='RGB'):
    out = io.BytesIO()
    Image.new(mode, size, color).save(out, 'PNG')
    return out.getvalue()


def mp4(seconds=1, size='64x36'):
    return subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc=size={size}:rate=24', '-t', str(seconds),
                           '-pix_fmt', 'yuv420p', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'],
                          capture_output=True, check=True).stdout


@pytest.fixture
def project(tmp_path):
    store, pid, session = new_project(tmp_path, '工具测试')
    return store, str(pid), session


def configure(store, *models):
    configs = ModelConfigs(store.local.repository)
    for kind, url, model in models:
        configs.save(kind, url, model, '', connection_type='self_hosted', protocol='vllm_omni' if kind in {'video', 'vision'} else 'openai')
    return configs


def upload(store, project_id, session, name, data):
    return CreationToolAssets(store).import_file(project_id, uuid4(), name, data, session)['id']


def images_server(calls, color='red'):
    def handle(request):
        assert request.url.path == '/v1/images/edits'
        body = request.read()
        calls.append(body)
        size = body.split(b'name="size"\r\n\r\n', 1)[1].split(b'\r\n', 1)[0].decode()
        width, height = map(int, size.split('x'))
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png((width, height), color)).decode()}]})
    return handle


def run(store, configs, transport, project_id, session, value):
    async def go():
        tools = ToolTasks(store.local, configs, CreationToolAssets(store), transport=transport, poll_interval=0, projects=store)
        try:
            task = await tools.submit(project_id, {'id': str(uuid4()), 'boxes': [], 'parameters': {}, **value}, session)
            await asyncio.gather(*tools.jobs.values(), return_exceptions=True)
            return tools.get(project_id, task['id'])
        finally:
            await tools.close()
    return asyncio.run(go())


def output_image(store, project_id, task, index=0):
    with store.local.transaction() as db:
        directory = store._find(db, project_id)[0]
    return Image.open(io.BytesIO(CreationToolAssets(store).read_bytes(project_id, task['outputs'][index]['id']))).convert('RGB')


def test_adapters_declare_capabilities_from_profiles_not_operations():
    def config(kind, url, model, protocol='openai'):
        return {'kind': kind, 'url': url, 'modelId': model, 'protocol': protocol, 'connectionType': 'self_hosted'}
    assert capabilities_of(config(*ZIMAGE)) == {'image.generate', 'image.edit'}
    assert capabilities_of(config(*H3, protocol='vllm_omni')) == {'video.generate', 'video.first_frame', 'video.edit'}
    assert capabilities_of(config(*TTS)) == {'audio.speech'}
    # Music models share /audio/speech with TTS; the protocol, not the model name, selects the role.
    assert capabilities_of(config('audio', 'http://gpu:8240/v1', 'm-a-p/YuE2-3B', 'vllm_omni_music')) == {'audio.music'}
    assert capabilities_of(config(*CHAT)) == {'text.chat'}
    assert capabilities_of(config(*SAM3, protocol='vllm_omni')) == {'image.segment', 'video.matting'}
    assert capabilities_of(config('video', 'https://ark.cn-beijing.volces.com/api/plan/v3', 'doubao-seedance-2.0', None)) == set()
    # vLLM-Omni renders free sizes on the 16-pixel latent grid; OpenAI picks its nearest fixed size.
    assert adapter_for(config(*ZIMAGE)).size(4000, 2000) == (1536, 768)
    assert OpenAIImages().size(1600, 900) == (1536, 1024)


def test_catalog_reports_availability_by_capability(project):
    store, _, _ = project
    empty = ToolTasks(store.local, ModelConfigs(store.local.repository), None, projects=store).catalog()
    tools = {item['id']: item for item in empty['tools']}
    assert not tools['outpaint']['available'] and '图生图' in tools['outpaint']['reason']
    assert tools['audio-separation']['available'] and not tools['video-edit']['available']
    # Local recipes need no model at all.
    assert tools['image-hd']['available'] and tools['video-upscale']['available']
    configured = ToolTasks(store.local, configure(store, ZIMAGE, H3, TTS, CHAT), None, projects=store).catalog()
    tools = {item['id']: item for item in configured['tools']}
    assert tools['outpaint']['available'] and tools['dynamic-poster']['available'] and tools['video-subtitle-erasure']['available']
    assert tools['outpaint']['models']['image.edit'][0]['label'] == 'Z-Image-Turbo'
    assert tools['cutout']['available']  # A confirmed/manual mask is applied locally.
    assert not configured['selectionPreview']['available']
    assert not tools['layer-decompose']['available'] and '图像分割' in tools['layer-decompose']['reason']
    assert {'image.edit', 'video.first_frame', 'audio.speech', 'text.chat'} <= set(configured['capabilities'])
    assert any(field['key'] == 'preset' and field['options'] for field in tools['image-presets']['fields'])


def test_outpaint_keeps_original_pixels_and_returns_requested_size(project):
    store, project_id, session = project
    configs = configure(store, ZIMAGE)
    source = upload(store, project_id, session, 'blue.png', png((64, 48), 'blue'))
    calls = []
    task = run(store, configs, httpx.MockTransport(images_server(calls)), project_id, session,
               {'tool': 'outpaint', 'sourceAssetIds': [source],
                'parameters': {'left': 0.5, 'right': 0.5, 'top': 0, 'bottom': 0, 'outputWidth': 128, 'outputHeight': 48, 'prompt': '海边'}})
    assert task['status'] == 'succeeded', task['error']
    assert b'name="strength"' in calls[0] and '海边'.encode() in calls[0]
    image = output_image(store, project_id, task)
    assert image.size == (128, 48)
    assert image.getpixel((64, 24))[2] > 200 and image.getpixel((2, 24))[0] > 200  # original centre, drawn border


def test_outpaint_asks_instruction_editors_to_pull_the_camera_back(project):
    # Qwen-Image ignores strength and recomposes a padded canvas, so it gets the original and a zoom-out instruction.
    store, project_id, session = project
    configs = configure(store, ('image', 'http://gpu:8210/v1', 'Qwen/Qwen-Image-2.1'))
    source = upload(store, project_id, session, 'blue.png', png((64, 48), 'blue'))
    calls = []
    task = run(store, configs, httpx.MockTransport(images_server(calls)), project_id, session,
               {'tool': 'outpaint', 'sourceAssetIds': [source], 'parameters': {'left': 0, 'right': 1, 'top': 0, 'bottom': 0}})
    assert task['status'] == 'succeeded', task['error']
    body = calls[0]
    assert '镜头拉远'.encode() in body and '位于新画面的左侧'.encode() in body and '在右侧新增'.encode() in body
    assert b'name="strength"' not in body
    assert Image.open(io.BytesIO(body[body.index(b'\x89PNG'):])).size == (64, 48)  # the original, not a padded canvas
    assert output_image(store, project_id, task).size == (128, 48)


def test_inpainting_only_changes_the_masked_region(project):
    store, project_id, session = project
    configs = configure(store, ZIMAGE)
    source = upload(store, project_id, session, 'blue.png', png((64, 64), 'blue'))
    mask = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    mask.paste((255, 255, 255, 255), (40, 40, 64, 64))
    out = io.BytesIO()
    mask.save(out, 'PNG')
    mask_id = upload(store, project_id, session, 'mask.png', out.getvalue())
    task = run(store, configs, httpx.MockTransport(images_server([])), project_id, session,
               {'tool': 'inpainting-remove', 'sourceAssetIds': [source], 'maskAssetId': mask_id})
    assert task['status'] == 'succeeded', task['error']
    image = output_image(store, project_id, task)
    assert image.getpixel((5, 5)) == (0, 0, 255) and image.getpixel((60, 60))[0] > 200


def test_presets_return_one_output_per_shot_and_local_hd_needs_no_model(project):
    store, project_id, session = project
    configs = configure(store, ZIMAGE)
    source = upload(store, project_id, session, 'blue.png', png())
    calls = []
    task = run(store, configs, httpx.MockTransport(images_server(calls)), project_id, session,
               {'tool': 'image-presets', 'sourceAssetIds': [source], 'parameters': {'preset': 'storyboard'}})
    assert task['status'] == 'succeeded' and len(task['outputs']) == 4 and len(calls) == 4
    task = run(store, configs, None, project_id, session,
               {'tool': 'image-hd', 'sourceAssetIds': [source], 'parameters': {'kind': 'normal', 'resolution': '2K'}})
    assert task['status'] == 'succeeded' and output_image(store, project_id, task).size == (2048, 1536)


def test_submission_rejects_tools_without_a_capable_model(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    tools = ToolTasks(store.local, configure(store, TTS), CreationToolAssets(store), projects=store)
    for tool, message in (('outpaint', '没有可用的「图生图/图片编辑」模型'), ('layer-decompose', '图像分割')):
        with pytest.raises(ProjectError, match=message):
            asyncio.run(tools.submit(project_id, {'id': str(uuid4()), 'tool': tool, 'sourceAssetIds': [source], 'parameters': {}}, session))
    with pytest.raises(ProjectError, match='类型与工具不匹配'):
        asyncio.run(ToolTasks(store.local, configure(store, ZIMAGE), CreationToolAssets(store), projects=store).submit(
            project_id, {'id': str(uuid4()), 'tool': 'video-upscale', 'sourceAssetIds': [source], 'parameters': {}}, session))


def video_server(log, *, hold=False):
    clip = mp4(1)

    def handle(request):
        log.append((request.method, request.url.path))
        if request.method == 'POST':
            body = request.read()
            assert b'fl2va' in body and b'name="input_reference"' in body
            return httpx.Response(200, json={'id': 'video_1', 'status': 'queued'})
        if request.method == 'DELETE':
            return httpx.Response(200, json={'id': 'video_1', 'status': 'cancelled'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=clip, headers={'content-type': 'video/mp4'})
        return httpx.Response(200, json={'id': 'video_1', 'status': 'in_progress' if hold else 'completed'})
    return handle


def test_dynamic_poster_runs_first_frame_video_and_cancel_reaches_the_service(project):
    store, project_id, session = project
    configs = configure(store, H3)
    source = upload(store, project_id, session, 'poster.png', png((64, 36)))
    log = []
    task = run(store, configs, httpx.MockTransport(video_server(log)), project_id, session,
               {'tool': 'dynamic-poster', 'sourceAssetIds': [source], 'parameters': {'prompt': '霓虹闪烁'}})
    assert task['status'] == 'succeeded', task['error']
    assert task['outputs'][0]['kind'] == 'video' and ('GET', '/v1/videos/video_1/content') in log

    async def cancel():
        log.clear()
        tools = ToolTasks(store.local, configs, CreationToolAssets(store), transport=httpx.MockTransport(video_server(log, hold=True)), poll_interval=0.01, projects=store)
        task = await tools.submit(project_id, {'id': str(uuid4()), 'tool': 'dynamic-poster', 'sourceAssetIds': [source], 'parameters': {}}, session)
        while not any(method == 'GET' for method, _ in log):
            await asyncio.sleep(0.01)
        return await tools.cancel(project_id, task['id'], session)
    cancelled = asyncio.run(cancel())
    assert cancelled['status'] == 'cancelled' and ('DELETE', '/v1/videos/video_1') in log


def sound_mp4(seconds, *, channels=2, size='64x36'):
    return subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc=size={size}:rate=24', '-f', 'lavfi', '-i',
                           f'sine=frequency=440:sample_rate=48000', '-t', str(seconds), '-ac', str(channels), '-pix_fmt', 'yuv420p',
                           '-c:a', 'aac', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'],
                          capture_output=True, check=True).stdout


def edit_server(bodies):
    clips = {}

    def handle(request):
        if request.method == 'POST':
            body = request.read()
            bodies.append(body)
            # Like H3, return the requested frame count at 24 fps.
            clips[f'edit_{len(bodies)}'] = sound_mp4(int(mask_part(body, 'num_frames')) / 24)
            assert b'name="source_video"' in body and b'name="video_noise_mask"' in body and b'name="audio_noise_mask"' in body
            return httpx.Response(200, json={'id': f'edit_{len(bodies)}', 'status': 'queued'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=clips[request.url.path.split('/')[-2]], headers={'content-type': 'video/mp4'})
        return httpx.Response(200, json={'id': 'edit', 'status': 'completed'})
    return handle


def mask_part_raw(body, name):
    return body.split(f'name="{name}"'.encode(), 1)[1].split(b'\r\n\r\n', 1)[1].split(b'\r\n--', 1)[0]


def mask_part(body, name):
    return json.loads(body.split(f'name="{name}"'.encode(), 1)[1].split(b'\r\n\r\n', 1)[1].split(b'\r\n--', 1)[0])


def test_h3_edit_masks_follow_its_frame_and_audio_grids():
    from opendirector.domain.capabilities import EditMask
    from opendirector.integrations.model_adapters import VllmOmniVideo
    frames = VllmOmniVideo.frames(5)
    assert frames == 124 and VllmOmniVideo.canvas(1920, 1080) == (1344, 736)
    picture = VllmOmniVideo.picture_mask(EditMask(1.0, None, 2, 3), frames)
    assert len(picture) == frames and picture[47] == [[0.0]] and picture[48] == [[1.0]] and picture[72] == [[0.0]]
    sound = VllmOmniVideo.sound_mask(EditMask(1.0, None, 2, 3), frames)
    assert len(sound) == round(frames * 5 / 3) and sound[0] == 0.0 and sum(sound) > 0
    assert VllmOmniVideo.picture_mask(None, frames) == 0.0 and VllmOmniVideo.picture_mask(EditMask(0.7), frames) == 0.7


def test_partial_reshoot_redraws_only_its_window(project):
    store, project_id, session = project
    configs = configure(store, H3)
    source = upload(store, project_id, session, 'clip.mp4', sound_mp4(6))
    bodies = []
    task = run(store, configs, httpx.MockTransport(edit_server(bodies)), project_id, session,
               {'tool': 'video-partial-reshoot', 'sourceAssetIds': [source],
                'parameters': {'prompt': '换成雨夜', 'startMs': 2000, 'endMs': 3000}})
    assert task['status'] == 'succeeded', task['error']
    assert len(bodies) == 1 and abs(task['outputs'][0]['durationMs'] - 6000) < 300
    picture, sound = mask_part(bodies[0], 'video_noise_mask'), mask_part(bodies[0], 'audio_noise_mask')
    assert picture[0] == [[0.0]] and any(frame == [[1.0]] for frame in picture) and 0 < sum(sound) < len(sound)


def test_long_video_edit_runs_piecewise_and_subtitles_default_to_the_bottom_band(project):
    store, project_id, session = project
    configs = configure(store, H3)
    source = upload(store, project_id, session, 'long.mp4', sound_mp4(20))
    bodies = []
    task = run(store, configs, httpx.MockTransport(edit_server(bodies)), project_id, session,
               {'tool': 'video-edit', 'sourceAssetIds': [source], 'parameters': {'prompt': '把垃圾桶换成花坛'}})
    assert task['status'] == 'failed' and '框选' in task['error']
    task = run(store, configs, httpx.MockTransport(edit_server(bodies)), project_id, session,
               {'tool': 'video-edit', 'sourceAssetIds': [source], 'parameters': {'prompt': '把垃圾桶换成花坛'},
                'boxes': [{'x': 32, 'y': 0, 'width': 32, 'height': 36}]})
    assert task['status'] == 'succeeded', task['error']
    region = mask_part(bodies[0], 'video_noise_mask')
    assert len(bodies) == 2 and region[0][0] == 0.0 and region[0][-1] == 1.0 and mask_part(bodies[0], 'audio_noise_mask') == 0.0
    assert abs(task['outputs'][0]['durationMs'] - 20000) < 500
    bodies.clear()
    clip = upload(store, project_id, session, 'clip.mp4', sound_mp4(5))
    task = run(store, configs, httpx.MockTransport(edit_server(bodies)), project_id, session,
               {'tool': 'video-subtitle-erasure', 'sourceAssetIds': [clip], 'parameters': {'confirmed': True}})
    band = mask_part(bodies[0], 'video_noise_mask')
    assert task['status'] == 'succeeded' and band[0] == [0.0] and band[-1] == [1.0]
    assert b'name="negative_prompt"' in bodies[0] and b'continues the surrounding scene' in bodies[0]
    assert b'subtitles' not in mask_part_raw(bodies[0], 'prompt')


def test_video_prompts_are_translated_only_when_a_chat_model_is_connected():
    from opendirector.application.tool_operations import ToolContext

    async def chat(request):
        return 'The girl turns toward the sea'

    def context(chat_model):
        return ToolContext(sources=[], mask=None, boxes=[], parameters={}, image_model=None, video_model=None,
                           progress=None, chat_model=chat_model)
    assert asyncio.run(context(chat).video_prompt('女孩转身望向大海', 'Keep it.')) == 'The girl turns toward the sea. Keep it.'
    assert asyncio.run(context(None).video_prompt('女孩转身望向大海', 'Keep it.')) == '女孩转身望向大海. Keep it.'
    assert asyncio.run(context(chat).video_prompt('', 'Keep it.')) == 'Keep it.'


def test_audio_separation_is_local(project):
    store, project_id, session = project
    configs = configure(store)
    clip = upload(store, project_id, session, 'clip.mp4', sound_mp4(2))
    task = run(store, configs, None, project_id, session,
               {'tool': 'audio-separation', 'sourceAssetIds': [clip], 'parameters': {'mode': 'all'}})
    assert task['status'] == 'succeeded', task['error']
    assert [item['kind'] for item in task['outputs']] == ['audio', 'video']
    task = run(store, configs, None, project_id, session,
               {'tool': 'audio-separation', 'sourceAssetIds': [clip], 'parameters': {'mode': 'voice'}})
    assert task['status'] == 'succeeded' and task['outputs'][0]['kind'] == 'audio'
    mono = upload(store, project_id, session, 'mono.mp4', sound_mp4(2, channels=1))
    task = run(store, configs, None, project_id, session,
               {'tool': 'audio-separation', 'sourceAssetIds': [mono], 'parameters': {'mode': 'backgroundSound'}})
    assert task['status'] == 'failed' and '单声道' in task['error']
    with pytest.raises(ProjectError, match='音轨分离'):
        asyncio.run(ToolTasks(store.local, configs, CreationToolAssets(store), projects=store).submit(
            project_id, {'id': str(uuid4()), 'tool': 'audio-separation', 'sourceAssetIds': [clip], 'parameters': {'mode': 'soundEffects'}}, session))


def test_interrupted_tasks_are_reported_after_restart(project):
    store, project_id, session = project
    tools = ToolTasks(store.local, configure(store), CreationToolAssets(store), projects=store)
    with store.local.transaction() as db:
        directory = store._find(db, project_id)[0]
    task_id = str(uuid4())
    folder = child(directory, 'tool-tasks')
    folder.mkdir(exist_ok=True)
    (folder / f'{task_id}.json').write_text(json.dumps({'id': task_id, 'status': 'running', 'tool': 'outpaint'}))
    assert tools.get(project_id, task_id)['status'] == 'interrupted'


def test_qwen_image_edits_with_condition_images_on_its_grid_without_strength():
    from opendirector.domain.capabilities import ImageRequest
    from opendirector.domain.input_rules import input_rules
    config = {'kind': 'image', 'url': 'http://gpu:8210/v1', 'modelId': 'Qwen/Qwen-Image-2.1', 'protocol': 'openai', 'connectionType': 'self_hosted'}
    rules = input_rules(config)
    assert rules['profile'] == 'vllm-omni-qwen-image' and rules['maxImages'] == 4 and 'image' in rules['allowedKinds']
    adapter = adapter_for(config)
    assert adapter.capabilities == {'image.generate', 'image.edit', 'image.cutout'} and adapter.size(1366, 768) == (1376, 768)
    calls = []
    adapter.transport = httpx.MockTransport(images_server(calls))
    result = asyncio.run(adapter.image(config, ImageRequest(prompt='换成黄色雨衣', width=1000, height=600, image=png(), strength=0.7,
                                                            references=(png(color='red'),) * 5)))
    body = calls[0]
    assert result.suffix == 'png' and body.count(b'name="image"') == 4 and b'name="strength"' not in body
    assert b'name="size"\r\n\r\n992x608' in body


def test_cutout_keeps_original_pixels_with_the_model_matte(project):
    store, project_id, session = project
    configs = ModelConfigs(store.local.repository)
    configs.save('image', 'http://gpu:8210/v1', 'Qwen/Qwen-Image-2.1', '', connection_type='self_hosted', protocol='openai')
    source = upload(store, project_id, session, 'blue.png', png((64, 48), 'blue'))
    bodies = []

    def matte(request):
        bodies.append(request.read())
        layer = Image.new('RGBA', (64, 48), (0, 0, 0, 0))
        layer.paste((200, 200, 200, 255), (16, 8, 48, 40))
        out = io.BytesIO()
        layer.save(out, 'PNG')
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(out.getvalue()).decode()}]})
    task = run(store, configs, httpx.MockTransport(matte), project_id, session, {'tool': 'cutout', 'sourceAssetIds': [source]})
    assert task['status'] == 'succeeded', task['error']
    assert b'name="background"' in bodies[0] and b'RGBA' in bodies[0]
    with store.local.transaction() as db:
        directory = store._find(db, project_id)[0]
    image = Image.open(io.BytesIO(CreationToolAssets(store).read_bytes(project_id, task['outputs'][0]['id'])))
    assert image.mode == 'RGBA' and image.getpixel((32, 24)) == (0, 0, 255, 255) and image.getpixel((2, 2))[3] == 0


def box_mask(size, box):
    mask = Image.new('L', size, 0)
    mask.paste(255, box)
    out = io.BytesIO()
    mask.save(out, 'PNG')
    return base64.b64encode(out.getvalue()).decode()


def segmentation_server(log, answers, *, edits=None):
    """SAM 3 image endpoint answering per prompt (or per box when the prompt is empty), plus optional image edits."""
    def handle(request):
        body = request.read()
        if request.url.path == '/v1/images/edits' and edits is not None:
            return images_server(edits)(httpx.Request('POST', request.url, content=body, headers=request.headers))
        assert request.url.path == '/v1/images/segmentations'
        field = lambda name: body.split(f'name="{name}"\r\n\r\n'.encode(), 1)[1].split(b'\r\n', 1)[0].decode() if f'name="{name}"'.encode() in body else ''
        key = field('prompt') or field('boxes')
        log.append(key)
        return httpx.Response(200, json={'width': 64, 'height': 48, 'mask_format': 'png', 'data': [
            {'score': score, 'box': list(box), 'mask': box_mask((64, 48), box)} for score, box in answers.get(key, [])]})
    return handle


def output_rgba(store, project_id, task, index=0):
    with store.local.transaction() as db:
        directory = store._find(db, project_id)[0]
    return Image.open(io.BytesIO(CreationToolAssets(store).read_bytes(project_id, task['outputs'][index]['id']))).convert('RGBA')


def test_vision_models_default_to_the_vllm_omni_protocol(project):
    store, _, _ = project
    saved = ModelConfigs(store.local.repository).save('vision', 'http://gpu:8230/v1', 'facebook/sam3', '', connection_type='self_hosted')
    assert saved['protocol'] == 'vllm_omni' and saved['inputRules']['profile'] == 'vllm-omni-segmentation'
    with pytest.raises(ProjectError, match='不兼容'):
        ModelConfigs(store.local.repository).save('vision', 'http://gpu:8230/v1', 'facebook/sam3', '', connection_type='self_hosted', protocol='openai')


def test_layer_decompose_splits_distinct_objects_and_fills_the_background(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    log, edits = [], []
    # "person" and "animal" find the same region; it becomes one layer.
    answers = {'person': [(0.9, (0, 0, 32, 48))], 'animal': [(0.6, (0, 0, 32, 48))], 'vehicle': [(0.8, (40, 10, 60, 30))]}
    transport = httpx.MockTransport(segmentation_server(log, answers, edits=edits))
    task = run(store, configure(store, SAM3, ZIMAGE), transport, project_id, session,
               {'tool': 'layer-decompose', 'sourceAssetIds': [source], 'parameters': {'mode': 'smart'}})
    assert task['status'] == 'succeeded', task['error']
    assert [item['title'] for item in task['outputs']] == ['背景', '图层 1 · 人物', '图层 2 · 交通工具']
    assert log[:3] == ['person', 'animal', 'vehicle'] and len(edits) == 1
    background, person, vehicle = (output_rgba(store, project_id, task, index) for index in range(3))
    # The background is redrawn (red) under the layers and keeps the source elsewhere.
    assert background.getpixel((10, 20))[:3] == (255, 0, 0) and background.getpixel((46, 44))[:3] == (0, 0, 255)
    assert person.getpixel((10, 20)) == (0, 0, 255, 255) and person.getpixel((50, 20))[3] == 0
    assert vehicle.getpixel((50, 20))[3] == 255 and vehicle.getpixel((10, 20))[3] == 0


def test_layer_decompose_by_boxes_and_description_without_an_editor(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    log = []
    # An exemplar box returns every similar object; only the enclosed one is kept.
    answers = {'[[40.0, 10.0, 60.0, 30.0]]': [(0.9, (0, 0, 20, 20)), (0.8, (41, 11, 59, 29))],
               'person': [(0.9, (0, 0, 32, 48))], 'dog': []}
    transport = httpx.MockTransport(segmentation_server(log, answers))
    configs = configure(store, SAM3)
    task = run(store, configs, transport, project_id, session,
               {'tool': 'layer-decompose', 'sourceAssetIds': [source], 'parameters': {'mode': 'boxes'},
                'boxes': [{'x': 40, 'y': 10, 'width': 20, 'height': 20}]})
    assert task['status'] == 'succeeded', task['error']
    assert [item['title'] for item in task['outputs']] == ['背景（未补全）', '图层 1 · 对象 1']
    layer = output_rgba(store, project_id, task, 1)
    assert layer.getpixel((50, 20))[3] == 255 and layer.getpixel((5, 5))[3] == 0
    assert output_rgba(store, project_id, task, 0).getpixel((50, 20))[3] == 0
    # Common Chinese subjects map to concepts without a chat model; other words need one.
    task = run(store, configs, transport, project_id, session,
               {'tool': 'layer-decompose', 'sourceAssetIds': [source], 'parameters': {'mode': 'description', 'prompt': '人物，狗'}})
    assert task['status'] == 'succeeded' and log[-2:] == ['person', 'dog']
    task = run(store, configs, transport, project_id, session,
               {'tool': 'layer-decompose', 'sourceAssetIds': [source], 'parameters': {'mode': 'description', 'prompt': '吉他'}})
    assert task['status'] == 'failed' and '吉他' in task['error']


def test_selection_preview_returns_alpha_masks_without_output_assets(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    log = []
    answers = {'person': [(0.9, (0, 0, 32, 48))], 'animal': [(0.6, (0, 0, 32, 48))],
               'vehicle': [(0.8, (40, 10, 60, 30))]}
    tools = ToolTasks(store.local, configure(store, SAM3), CreationToolAssets(store),
                      transport=httpx.MockTransport(segmentation_server(log, answers)), projects=store)
    preview = asyncio.run(tools.selection_preview(project_id, {'sourceAssetId': source}, session))
    assert preview['sourceAssetId'] == source and (preview['width'], preview['height']) == (64, 48)
    assert [item['label'] for item in preview['instances']] == ['人物', '交通工具']
    assert [item['score'] for item in preview['instances']] == [0.9, 0.8]
    mask = Image.open(io.BytesIO(base64.b64decode(preview['instances'][0]['maskDataUrl'].split(',', 1)[1])))
    assert mask.mode == 'RGBA' and mask.getpixel((10, 20)) == (255, 255, 255, 255)
    assert mask.getpixel((50, 20))[3] == 0
    with store.local.transaction() as db:
        directory = store._find(db, project_id)[0]
    assert set(tools.assets._records(directory, project_id)) == {source}
    assert not child(directory, 'tool-tasks').exists() and tools.catalog()['selectionPreview']['available']


def test_selection_preview_checks_source_authority_and_box_bounds(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    log = []
    tools = ToolTasks(store.local, configure(store, SAM3), CreationToolAssets(store),
                      transport=httpx.MockTransport(segmentation_server(log, {})), projects=store)
    with pytest.raises(ProjectError):
        asyncio.run(tools.selection_preview(project_id, {'sourceAssetId': source}, str(uuid4())))
    with pytest.raises(ProjectError, match='来源图片不存在'):
        asyncio.run(tools.selection_preview(project_id, {'sourceAssetId': str(uuid4())}, session))
    with pytest.raises(ProjectError, match='选框必须位于原图内'):
        asyncio.run(tools.selection_preview(project_id, {'sourceAssetId': source,
                    'boxes': [{'x': 60, 'y': 0, 'width': 20, 'height': 10}]}, session))
    assert not log


def test_selection_preview_cancellation_closes_upstream_work(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())

    async def check():
        entered, cancelled = asyncio.Event(), asyncio.Event()

        async def provider(_):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        tools = ToolTasks(store.local, configure(store, SAM3), CreationToolAssets(store),
                          transport=httpx.MockTransport(provider), projects=store)
        preview = asyncio.create_task(tools.selection_preview(project_id, {'sourceAssetId': source, 'prompt': 'person'}, session))
        await asyncio.wait_for(entered.wait(), 2)
        preview.cancel()
        with pytest.raises(asyncio.CancelledError):
            await preview
        assert cancelled.is_set() and not tools.jobs
    asyncio.run(check())


def test_cutout_applies_exact_user_mask_without_any_model(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    mask = upload(store, project_id, session, 'mask.png', base64.b64decode(box_mask((64, 48), (10, 8, 30, 32))))
    task = run(store, configure(store), None, project_id, session,
               {'tool': 'cutout', 'sourceAssetIds': [source], 'maskAssetId': mask})
    assert task['status'] == 'succeeded' and task['requires'] == []
    result = output_rgba(store, project_id, task)
    assert result.getpixel((10, 8)) == (0, 0, 255, 255)
    assert result.getpixel((9, 8))[3] == 0 and result.getpixel((30, 20))[3] == 0


def test_cutout_uses_sam_when_no_rgba_editor_is_configured(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    log = []
    task = run(store, configure(store, SAM3), httpx.MockTransport(segmentation_server(log, {'person': [(0.9, (10, 8, 30, 32))]})),
               project_id, session, {'tool': 'cutout', 'sourceAssetIds': [source], 'parameters': {'prompt': '人物'}})
    assert task['status'] == 'succeeded' and task['requires'] == ['image.segment']
    assert log == ['person'] and output_rgba(store, project_id, task).getpixel((20, 20)) == (0, 0, 255, 255)
    assert output_rgba(store, project_id, task).getpixel((5, 5))[3] == 0


def test_smart_edit_uses_visual_annotation_and_keeps_unselected_pixels(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    annotation = upload(store, project_id, session, 'marked.png', png(color='green'))
    mask = upload(store, project_id, session, 'mask.png', base64.b64decode(box_mask((64, 48), (10, 8, 30, 32))))
    calls = []
    task = run(store, configure(store, ('image', 'http://gpu:8210/v1', 'Qwen/Qwen-Image-2.1')),
               httpx.MockTransport(images_server(calls)), project_id, session,
               {'tool': 'smart-edit', 'sourceAssetIds': [source], 'maskAssetId': mask,
                'annotationAssetId': annotation, 'parameters': {'prompt': '改成红色'}})
    assert task['status'] == 'succeeded', task['error']
    assert calls[0].count(b'name="image"') == 2 and '第二张图'.encode() in calls[0]
    result = output_rgba(store, project_id, task)
    assert result.getpixel((20, 20)) == (255, 0, 0, 255)
    assert result.getpixel((9, 8)) == (0, 0, 255, 255) and result.getpixel((30, 20)) == (0, 0, 255, 255)


def test_smart_edit_reads_editor_text_strokes_and_honours_selected_model(project):
    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    configs = configure(store, ZIMAGE)
    chosen = configs.save('image', 'http://gpu:8210/v1', 'Qwen/Qwen-Image-2.1', '', connection_type='self_hosted', protocol='openai')
    calls = []
    document = {'version': 1, 'sourceNodeId': str(uuid4()), 'width': 64, 'height': 48,
                'strokes': [{'tool': 'text', 'text': '  换成红色外套  ', 'points': [{'x': 20, 'y': 20}], 'size': 20, 'color': '#fff'}]}
    task = run(store, configs, httpx.MockTransport(images_server(calls)), project_id, session,
               {'tool': 'smart-edit', 'sourceAssetIds': [source], 'modelConfigIds': {'image.edit': chosen['id']},
                'parameters': {'annotationDocument': json.dumps(document)}})
    assert task['status'] == 'succeeded', task['error']
    assert '换成红色外套'.encode() in calls[0] and b'Qwen/Qwen-Image-2.1' in calls[0]
    assert task['modelConfigIds'] == {'image.edit': chosen['id']}


def test_selection_api_uses_owned_source_and_accepts_only_supported_prompts(project, monkeypatch):
    from fastapi.testclient import TestClient
    from opendirector.domain.capabilities import Segment
    from opendirector.integrations.model_adapters import VllmOmniSegmentation
    from opendirector_api.main import create_app

    store, project_id, session = project
    source = upload(store, project_id, session, 'blue.png', png())
    configure(store, SAM3)
    calls = []

    async def segment(self, config, request):
        calls.append(request)
        return [Segment(base64.b64decode(box_mask((64, 48), (12, 10, 30, 30))), (12, 10, 30, 30), 0.9)]

    monkeypatch.setattr(VllmOmniSegmentation, 'segment', segment)
    with TestClient(create_app(store.local), headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}) as client:
        path = f'/api/creation/projects/{project_id}/image-selections'
        response = client.post(path, json={'sourceAssetId': source, 'boxes': [{'x': 10, 'y': 8, 'width': 22, 'height': 24}]})
        assert response.status_code == 200, response.text
        assert response.json()['instances'][0]['box'] == {'x': 12, 'y': 10, 'width': 18, 'height': 20}
        assert calls[0].boxes == ((10.0, 8.0, 32.0, 32.0),)
        assert client.post(path, json={'sourceAssetId': source, 'points': [[12, 12]]}).status_code == 422
        assert client.post(path, json={'sourceAssetId': source, 'boxes': [{'x': 0, 'y': 0, 'width': -1, 'height': 4}]}).status_code == 422
        assert client.post(path, json={'sourceAssetId': source}, headers={'X-OpenDirector-Session': str(uuid4())}).status_code == 409
    assert len(calls) == 1


def tracking_server(log, *, empty=False):
    def handle(request):
        body = request.read()
        assert request.url.path == '/v1/videos/segmentations'
        log.append(body.split(b'name="prompt"\r\n\r\n', 1)[1].split(b'\r\n', 1)[0].decode())
        # Left half of a 64x36 frame, column-major and starting with a background run.
        instance = {'id': 0, 'score': 0.9, 'box': [0, 0, 32, 36], 'mask': {'size': [36, 64], 'counts': [0, 32 * 36, 32 * 36]}}
        frames = [{'frame_index': index, 'instances': [] if empty else [instance]} for index in range(24)]
        return httpx.Response(200, json={'width': 64, 'height': 36, 'num_frames': 24, 'fps': 24.0, 'objects': [], 'frames': frames})
    return handle


def probe(path, entries):
    return json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'json', str(path)],
                                     capture_output=True, check=True).stdout)['streams'][0]


def test_video_matting_keeps_the_tracked_subject_over_the_chosen_background(project, tmp_path):
    store, project_id, session = project
    source = upload(store, project_id, session, 'clip.mp4', sound_mp4(1))
    log = []
    configs = configure(store, SAM3)
    task = run(store, configs, httpx.MockTransport(tracking_server(log)), project_id, session,
               {'tool': 'video-matting', 'sourceAssetIds': [source], 'parameters': {'background': 'green'}})
    assert task['status'] == 'succeeded', task['error']
    assert log == ['person'] and task['outputs'][0]['type'] == 'video/mp4'
    with store.local.transaction() as db:
        directory = store._find(db, project_id)[0]
    path = tmp_path / ('output.' + task['outputs'][0]['type'].split('/')[-1])
    path.write_bytes(CreationToolAssets(store).read_bytes(project_id, task['outputs'][0]['id']))
    frame = Image.open(io.BytesIO(subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1'],
                                                 capture_output=True, check=True).stdout)).convert('RGB')
    red, green, blue = frame.getpixel((58, 18))
    assert green > 200 and red < 60 and blue < 60  # The untracked right half is green screen.
    task = run(store, configs, httpx.MockTransport(tracking_server(log)), project_id, session,
               {'tool': 'video-matting', 'sourceAssetIds': [source], 'parameters': {'background': 'transparent', 'prompt': '狗'}})
    assert task['status'] == 'succeeded', task['error']
    assert log[-1] == 'dog' and task['outputs'][0]['type'] == 'video/webm'
    path = tmp_path / ('output.' + task['outputs'][0]['type'].split('/')[-1])
    path.write_bytes(CreationToolAssets(store).read_bytes(project_id, task['outputs'][0]['id']))
    assert probe(path, 'stream_tags=alpha_mode').get('tags', {}).get('alpha_mode') == '1'
    task = run(store, configs, httpx.MockTransport(tracking_server(log, empty=True)), project_id, session,
               {'tool': 'video-matting', 'sourceAssetIds': [source], 'parameters': {'background': 'black'}})
    assert task['status'] == 'failed' and '没有识别到「人物」' in task['error']


def test_cancel_drains_an_inflight_write_so_the_task_never_stays_running(project):
    """A cancelled task must not be resurrected by the write it interrupted."""
    store, project_id, session = project
    configs = configure(store, H3)
    source = upload(store, project_id, session, 'poster.png', png((64, 36)))
    log = []

    async def cancel():
        tools = ToolTasks(store.local, configs, CreationToolAssets(store),
                          transport=httpx.MockTransport(video_server(log, hold=True)), poll_interval=0.01, projects=store)
        write = tools._write
        running = asyncio.Event()

        def slow_write(directory, task):
            if task.get('status') == 'running':
                running.set()
                time.sleep(0.2)  # Still on disk when the cancellation arrives.
            write(directory, task)

        tools._write = slow_write
        submitted = await tools.submit(project_id, {'id': str(uuid4()), 'tool': 'dynamic-poster',
                                                    'sourceAssetIds': [source], 'parameters': {}}, session)
        while not running.is_set():
            await asyncio.sleep(0.01)
        cancelled = await tools.cancel(project_id, submitted['id'], session)
        await asyncio.sleep(0.4)  # Any stale receipt would land in this window.
        return cancelled, tools.get(project_id, submitted['id'], session)

    cancelled, final = asyncio.run(cancel())
    assert cancelled['status'] == 'cancelled'
    assert final['status'] == 'cancelled', final['status']
    assert final['finishedAt'] == cancelled['finishedAt']


@pytest.mark.parametrize('box', [
    {'x': 32, 'y': 0, 'width': 33, 'height': 36},
    {'x': 0, 'y': 0, 'width': 64, 'height': 37},
    {'x': -1, 'y': 0, 'width': 32, 'height': 36},
])
def test_video_edit_rejects_out_of_bounds_selection_before_acceptance(project, box):
    store, project_id, session = project
    source = upload(store, project_id, session, 'clip.mp4', mp4())
    service = ToolTasks(store.local, configure(store, H3), CreationToolAssets(store), projects=store)
    before = store.snapshot(project_id)
    with pytest.raises(ProjectError, match='超出实际来源媒体'):
        asyncio.run(service.submit(project_id, dict(id=str(uuid4()), tool='video-edit',
            sourceAssetIds=[source], parameters={'prompt': 'change'}, boxes=[box]), session))
    assert service.list(project_id) == [] and not service.jobs
    assert store.snapshot(project_id) == before
