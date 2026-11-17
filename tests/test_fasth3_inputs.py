import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from opendirector.domain.projects import ProjectError
from opendirector.integrations.fasth3 import native_prompt, video_parameters


def source(kind, name, **extra):
    return {'id': str(uuid4()), 'name': name, 'kind': kind, 'type': kind + '/mp4', **extra}


def test_native_tags_bind_exact_chip_positions_and_share_ordinals_on_repeat():
    video = source('video', '原视频.mp4', hasAudio=True)
    first, second = source('image', '角色A.png'), source('image', '角色B.png')
    sound = source('audio', '参考音频.wav')
    refs = [(video, 'video'), (first, 'image'), (sound, 'audio'), (second, 'image')]
    def ref(asset):
        return {'type': 'reference', 'assetId': asset['id'], 'name': asset['name']}
    content = [{'type': 'text', 'text': '将'}, ref(video), {'type': 'text', 'text': '的人物换成'},
               ref(second), ref(first), {'type': 'text', 'text': '；音色参考'}, ref(sound), ref(second)]
    task = {'promptContent': content, 'prompt': 'not authoritative'}
    before = json.dumps(content, ensure_ascii=False)
    assert native_prompt(task, refs) == '将<Video 1>的人物换成<Picture 2><Picture 1>；音色参考<Audio 2><Picture 2>'
    assert json.dumps(content, ensure_ascii=False) == before


@pytest.mark.parametrize('text,duration,seconds,frames', [
    ('替换视频人物，保持镜头不变', 15000, '15', 362),
    ('替换视频人物', 3000, '4', 107),
    ('替换视频人物，输出 5 秒', 15000, '5', 124),
    ('Replace the person; generate a 6-second clip', 15000, '6', 158),
    ('参考这个视频制作全新短片', 15000, '5', 124),
])
def test_video_edit_duration_is_not_silently_five_seconds(text, duration, seconds, frames):
    video = source('video', '原片.mp4', durationMs=duration, width=480, height=832)
    node = {'referenceIds': [video['id']], 'prompt': text}
    params = video_parameters(node, {video['id']: video})
    assert params['seconds'] == seconds and params['num_frames'] == frames
    assert params['size'] == '480x832'
    assert 'videoEdit' not in params


def test_explicit_audio_edit_is_not_overwritten_and_invalid_duration_is_rejected():
    video = source('video', '原片.mp4', durationMs=15000)
    node = {'referenceIds': [video['id']], 'prompt': '替换人物并更换背景音乐'}
    assert 'videoEdit' not in video_parameters(node, {video['id']: video})
    with pytest.raises(ProjectError, match='4—15 秒'):
        video_parameters({**node, 'prompt': '替换人物，输出 20 秒'}, {video['id']: video})


@pytest.mark.parametrize('seconds, frames', [(4, 107), (7, 175), (10, 243), (15, 362)])
def test_panel_duration_overrides_default_and_conflicting_prompt(seconds, frames):
    for prompt in ('按参考图生成人物动作', '输出 5 秒的人物动作'):
        parameters = video_parameters({'referenceIds': [], 'prompt': prompt}, {}, duration_seconds=seconds)
        assert parameters['duration'] == seconds
        assert parameters['seconds'] == str(seconds)
        assert parameters['num_frames'] == frames


def test_panel_duration_overrides_source_edit_length_without_postprocessing():
    video = source('video', '原片.mp4', durationMs=5000, width=480, height=832)
    node = {'referenceIds': [video['id']], 'prompt': '替换视频中的人物'}
    parameters = video_parameters(node, {video['id']: video}, duration_seconds=7)
    assert parameters['duration'] == 7 and parameters['seconds'] == '7'
    assert 'videoEdit' not in parameters


@pytest.mark.parametrize('seconds', [3, 16, float('nan'), float('inf')])
def test_panel_duration_outside_supported_range_is_rejected(seconds):
    with pytest.raises(ProjectError, match='4—15 秒'):
        video_parameters({'referenceIds': [], 'prompt': '人物动作'}, {}, duration_seconds=seconds)


def test_native_prompt_and_full_duration_reach_actual_video_multipart():
    import asyncio
    from email.parser import BytesParser
    from email.policy import default
    import httpx
    from opendirector.integrations.providers import GenerationProviders
    video = source('video', 'original.mp4', fingerprint='fixture', durationMs=15000, hasAudio=True)
    picture = source('image', 'person.png', fingerprint='fixture')
    picture['type'] = 'image/png'
    assets = {video['id']: (b'video-bytes', video), picture['id']: (b'\x89PNG\r\n\x1a\nfixture', picture)}
    store = SimpleNamespace(asset=lambda owner, key: assets[key])
    content = [{'type': 'text', 'text': '替换'}, {'type': 'reference', 'assetId': video['id'], 'name': video['name']},
               {'type': 'text', 'text': '的人物为'}, {'type': 'reference', 'assetId': picture['id'], 'name': picture['name']}]
    task = {'kind': 'video', 'projectId': 'owner', 'prompt': '替换原视频人物', 'promptContent': content,
            'referenceIds': list(assets), 'videoMode': 'reference'}
    task['parameters'] = video_parameters(task, {key: pair[1] for key, pair in assets.items()})
    config = {'kind': 'video', 'protocol': 'vllm_omni', 'url': 'http://localhost:18091/v1',
              'modelId': 'FastH3-Omni', 'apiKey': '', 'authMode': 'none'}
    def handle(request):
        if request.method == 'POST':
            message = BytesParser(policy=default).parsebytes(('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + request.content)
            fields = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True)
                      for part in message.iter_parts() if part.get_filename() is None}
            assert fields['prompt'].decode() == '替换<Video 1>的人物为<Picture 1>'
            assert fields['num_frames'] == b'362'
            assert fields['fps'] == b'24' and 'seconds' not in fields
            assert 'duration' not in json.loads(fields['extra_params'])
            assert request.content.count(b'name="input_references"') == 2
            assert b'video-bytes' in request.content
            return httpx.Response(200, json={'id': 'verified-wire'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=b'generated')
        return httpx.Response(200, json={'status': 'completed'})
    async def submitted(value):
        assert value == 'verified-wire'
    provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
    assert asyncio.run(provider.generate(config, task, submitted)) == ('mp4', b'generated')
