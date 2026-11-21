import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from opendirector.domain.creation.assets import AssetRef, MediaMetadata
from opendirector.domain.creation.generation import (ResolvedReference, VideoGenerationSpec, VideoParameters,
                                                     validate_generation)
from opendirector.domain.creation.models import ModelConfigPublic
from opendirector.domain.input_rules import input_rules
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


@pytest.mark.parametrize('slots,indices', [
    (('first_frame',), [0]),
    (('last_frame',), [-1]),
    (('last_frame', 'first_frame'), [0, -1]),
])
def test_dual_h3_frame_slots_bind_actual_multipart(slots, indices):
    import asyncio
    from email.parser import BytesParser
    from email.policy import default
    import httpx
    from opendirector.integrations.providers import GenerationProviders

    images = {role: source('image', role + '.png', fingerprint='fixture') for role in slots}
    data = {image['id']: (b'\x89PNG\r\n\x1a\n' + role.encode(), image) for role, image in images.items()}
    store = SimpleNamespace(asset=lambda owner, key: data[key])
    task = {'kind': 'video', 'projectId': 'owner', 'prompt': 'Animate the transition',
            'referenceIds': list(data), 'videoMode': 'first_frame', 'parameters': {'duration': 4},
            'referenceRoles': [{'assetId': image['id'], 'role': role} for role, image in images.items()]}
    config = {'kind': 'video', 'protocol': 'vllm_omni', 'url': 'http://localhost:18091/v1',
              'modelId': 'FastH3-Omni-INT8', 'videoAdapter': 'fasth3_dual', 'apiKey': '', 'authMode': 'none'}

    def handle(request):
        if request.method == 'POST':
            prefix = 'Content-Type: ' + request.headers['content-type'] + '\r\n\r\n'
            message = BytesParser(policy=default).parsebytes(prefix.encode() + request.content)
            fields, uploads = {}, []
            for part in message.iter_parts():
                field = part.get_param('name', header='content-disposition')
                payload = part.get_payload(decode=True)
                if part.get_filename():
                    assert field == 'input_references'
                    uploads.append((part.get_filename(), payload.split(b'\n')[-1].decode()))
                else:
                    fields[field] = payload
            # The uploaded filename states the slot, so it must agree with the
            # frame index recorded in extra_params, including a lone tail anchor.
            assert uploads == [(role + '.png', role) for role in ('first_frame', 'last_frame') if role in slots]
            assert fields['prompt'] == b'Animate the transition'
            assert fields['num_inference_steps'] == b'20'
            extra = json.loads(fields['extra_params'])
            assert (extra['task'], extra['frame_indices'], extra['sampler']) == ('fl2va', indices, 'res_multistep')
            return httpx.Response(200, json={'id': 'verified-frame-job'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=b'generated')
        return httpx.Response(200, json={'status': 'completed'})

    async def submitted(value):
        assert value == 'verified-frame-job'

    provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
    assert asyncio.run(provider.generate(config, task, submitted)) == ('mp4', b'generated')


def test_dual_h3_same_asset_fills_both_frame_slots():
    import asyncio
    from email.parser import BytesParser
    from email.policy import default
    import httpx
    from opendirector.integrations.providers import GenerationProviders

    asset_id = str(uuid4())
    image = source('image', 'anchor.png', fingerprint='fixture')
    image['id'] = asset_id
    store = SimpleNamespace(asset=lambda owner, key: (b'\x89PNG\r\n\x1a\n', image))
    task = {'kind': 'video', 'projectId': 'owner', 'prompt': 'Loop the still',
            'referenceIds': [asset_id], 'videoMode': 'first_frame', 'parameters': {'duration': 4},
            'referenceRoles': [{'assetId': asset_id, 'role': 'first_frame'},
                               {'assetId': asset_id, 'role': 'last_frame'}]}
    config = {'kind': 'video', 'protocol': 'vllm_omni', 'url': 'http://localhost:18091/v1',
              'modelId': 'FastH3-Omni-INT8', 'videoAdapter': 'fasth3_dual', 'apiKey': '', 'authMode': 'none'}

    def handle(request):
        if request.method == 'POST':
            prefix = 'Content-Type: ' + request.headers['content-type'] + '\r\n\r\n'
            message = BytesParser(policy=default).parsebytes(prefix.encode() + request.content)
            fields, uploads = {}, []
            for part in message.iter_parts():
                if part.get_filename():
                    assert part.get_param('name', header='content-disposition') == 'input_references'
                    uploads.append(part.get_filename())
                else:
                    fields[part.get_param('name', header='content-disposition')] = part.get_payload(decode=True)
            # One asset may fill both slots; both roles still reach the wire.
            assert uploads == ['first_frame.png', 'last_frame.png']
            extra = json.loads(fields['extra_params'])
            assert (extra['task'], extra['frame_indices'], extra['sampler']) == ('fl2va', [0, -1], 'res_multistep')
            return httpx.Response(200, json={'id': 'verified-same-asset-job'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=b'generated')
        return httpx.Response(200, json={'status': 'completed'})

    async def submitted(value):
        assert value == 'verified-same-asset-job'

    provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
    assert asyncio.run(provider.generate(config, task, submitted)) == ('mp4', b'generated')


def dual_model():
    config = {'kind': 'video', 'url': 'http://model.test/v1', 'modelId': 'FastH3-Omni-INT8',
              'connectionType': 'self_hosted', 'protocol': 'vllm_omni', 'authMode': 'none',
              'videoAdapter': 'fasth3_dual'}
    return ModelConfigPublic(id=uuid4(), inputRules=input_rules(config), **config)


def dual_spec(model, mode='first_frame'):
    return VideoGenerationSpec(id=uuid4(), projectId=uuid4(), kind='video', purpose='generation',
        modelConfigId=model.id, prompt='Animate the transition',
        parameters=VideoParameters(videoMode=mode, durationSeconds=4))


def frame_reference(role, kind='image', duration=None):
    return ResolvedReference(referenceId=uuid4(), role=role,
        asset=AssetRef(assetId=uuid4(), revision=1, fingerprint='sha256:' + '0' * 64, kind=kind),
        metadata=MediaMetadata(mimeType='image/png', size=10, width=32, height=24, durationSeconds=duration))


def test_dual_h3_requires_both_anchors_at_submission():
    model = dual_model()
    spec = dual_spec(model)
    anchors = (frame_reference('first_frame'), frame_reference('last_frame'))
    validate_generation(spec, model, anchors, submitting=True)
    for references in ((), (frame_reference('first_frame'),), (frame_reference('last_frame'),)):
        with pytest.raises(ValueError, match='首帧和尾帧'):
            validate_generation(spec, model, references, submitting=True)
    # Editing a draft still allows the mode before both anchors exist.
    validate_generation(spec, model, (), submitting=False)


def test_dual_h3_rejects_auxiliary_media_at_submission():
    model = dual_model()
    spec = dual_spec(model)
    references = (frame_reference('first_frame'), frame_reference('last_frame'),
                  frame_reference('reference', kind='audio'))
    with pytest.raises(ValueError, match='不接受音频或视频参考'):
        validate_generation(spec, model, references, submitting=True)
    # Reference mode keeps its existing omnimodal semantics.
    validate_generation(dual_spec(model, 'reference'), model,
                        (frame_reference('reference'), frame_reference('reference', kind='audio', duration=3)),
                        submitting=True)
