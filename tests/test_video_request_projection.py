"""Video capability checks describe the request the selected adapter sends."""
from types import SimpleNamespace
import asyncio
import json

import pytest

from opendirector.application.model_availability import generation_request, tool_request
from test_model_availability import private, service


def reference(kind, role='reference', transmission='content'):
    return SimpleNamespace(asset=SimpleNamespace(kind=kind), role=role, transmission=transmission,
                           metadata=SimpleNamespace(width=1344, height=768))


def spec(mode):
    return SimpleNamespace(kind='video', parameters=SimpleNamespace(videoMode=mode))


def video_config(configs, saved):
    return {**private(configs, saved), 'kind': 'video', 'protocol': 'vllm_omni',
            'modelId': 'MiniMaxAI/MiniMax-H3'}


@pytest.mark.parametrize('mode,refs,roles', [
    ('first_frame', [reference('image', 'first_frame')], {'text': 1, 'image': 1, 'first_frame': 1}),
    ('reference', [reference('image'), reference('image')], {'text': 1, 'image': 2, 'reference_image': 2}),
    ('reference', [reference('video')], {'text': 1, 'video': 1, 'reference_video': 1}),
    ('continuation', [reference('video', 'continuation', 'latent'), reference('image')],
     {'text': 1, 'image': 1, 'reference_image': 1}),
])
def test_generation_preserves_media_counts_and_transmitted_purposes(service, mode, refs, roles):
    configs, saved, _, _ = service
    request = generation_request(video_config(configs, saved), spec(mode), refs)
    assert dict(request.input_counts) == roles
    assert request.inputs == set(roles)


@pytest.mark.parametrize('capability,roles', [
    ('video.first_frame', {'text': 1, 'image': 1, 'first_frame': 1}),
    ('video.edit', {'text': 1, 'video': 1, 'source_video': 1, 'video_noise_mask': 1, 'audio_noise_mask': 1}),
])
def test_tool_request_describes_all_uploaded_roles_including_default_masks(service, capability, roles):
    configs, saved, _, _ = service
    request = tool_request(video_config(configs, saved), capability, actual=True)
    assert dict(request.input_counts) == roles


@pytest.mark.parametrize('mode,has_images,has_audio', [
    ('first_frame', False, False), ('first_frame', True, False), ('reference', True, True),
    ('continuation', False, False), ('continuation', True, False), ('continuation', False, True),
])
def test_node_checked_parameters_equal_the_prepared_multipart_form(service, mode, has_images, has_audio):
    from opendirector.integrations.vllm_omni import VllmOmniGeneration
    configs, saved, _, _ = service
    config = video_config(configs, saved)
    refs = ([reference('image')] if has_images else []) + ([reference('audio')] if has_audio else [])
    if mode == 'continuation':
        refs.append(reference('video', 'continuation', 'latent'))
    parameters = {'duration': 7, 'ratio': '9:16', 'resolution': '720P', 'size': '768x1344'}
    request = generation_request(config, spec(mode), refs, parameters=parameters)
    prepared = {'prompt': 'test', 'images': ['data:image/png;base64,YQ=='] if has_images else [],
                'audios': ['data:audio/wav;base64,YQ=='] if has_audio else [],
                'continueFrom': 'accepted-job', 'continueSize': (1344, 768) if mode == 'continuation' else None}
    fields, _ = VllmOmniGeneration(None).form(config, {'videoMode': mode, 'parameters': parameters}, prepared)
    checked = dict(request.parameters)
    sent = {key: value for key, value in fields.items() if key not in {'model', 'prompt', 'extra_params'}}
    sent.update({key: value for key, value in json.loads(fields['extra_params']).items() if key != 'continue_from'})
    assert {key: str(value) for key, value in checked.items() if key not in {'width', 'height'}} == {
        key: str(value) for key, value in sent.items()}
    assert fields['size'] == f"{checked['width']}x{checked['height']}"


@pytest.mark.parametrize('editing', [False, True])
def test_tool_parameters_are_shared_with_actual_uploads(editing, monkeypatch):
    from opendirector.domain.capabilities import VideoEditRequest, VideoRequest
    from opendirector.integrations.model_adapters import VllmOmniVideo
    from opendirector.integrations.vllm_omni import capability_parameters
    adapter = VllmOmniVideo()
    calls = []
    async def capture(config, fields, files, submitted):
        calls.append((fields, files))
    monkeypatch.setattr(adapter, '_job', capture)
    monkeypatch.setattr(adapter, '_conformed', lambda source, *_: source)
    config = {'modelId': 'MiniMaxAI/MiniMax-H3'}
    if editing:
        checked = capability_parameters(*adapter.edit_parameters(7, 1920, 1080))
        asyncio.run(adapter.edit_video(config, VideoEditRequest(prompt='test', source=b'video', seconds=7,
                    width=1920, height=1080)))
    else:
        checked = capability_parameters(*adapter.video_parameters(7, first_frame=True, seed=42))
        asyncio.run(adapter.video(config, VideoRequest(prompt='test', seconds=7, first_frame=b'image', seed=42)))
    fields, files = calls[0]
    sent = {key: value for key, value in fields.items() if key not in {'model', 'prompt', 'extra_params'}}
    sent.update(json.loads(fields['extra_params']))
    assert {key: str(value) for key, value in checked.items() if key not in {'width', 'height'}} == {
        key: str(value) for key, value in sent.items()}
    if editing:
        assert [name for name, _ in files] == ['source_video', 'video_noise_mask', 'audio_noise_mask']
        assert json.loads(files[1][1][1]) == json.loads(files[2][1][1]) == 0.0
