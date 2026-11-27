"""Latent-mask editing for Ref2VA-only H3 services (FastH3 Omni and few-step adapters served the same way)."""
import asyncio
import json

import pytest

from opendirector.domain.capabilities import EditMask, VideoEditRequest
from opendirector.integrations.model_adapters import FastH3VideoEdit, VllmOmniVideo, adapter_for, capabilities_of
from opendirector.integrations.vllm_omni import capability_parameters


pytestmark = pytest.mark.cpu

CONFIG = {'kind': 'video', 'protocol': 'vllm_omni', 'url': 'http://localhost:18091/v1', 'modelId': 'Pika-H3',
          'videoAdapter': 'fasth3', 'apiKey': '', 'authMode': 'none'}


@pytest.mark.parametrize('adapter', ['fasth3', 'fasth3_dual'])
def test_fasth3_shaped_models_provide_local_redraw_only(adapter):
    config = {**CONFIG, 'videoAdapter': adapter}
    assert isinstance(adapter_for(config), FastH3VideoEdit)
    # A Ref2VA service has no text-to-video or first-frame task, so only editing is offered to tools.
    assert capabilities_of(config) == {'video.edit'}
    assert capabilities_of({**CONFIG, 'videoAdapter': 'minimax_h3'}) == VllmOmniVideo.capabilities


def test_edit_request_is_ref2va_on_the_fixed_schedule_with_the_first_frame_as_reference(monkeypatch):
    adapter = FastH3VideoEdit()
    calls = []

    async def capture(config, fields, files, submitted):
        calls.append((fields, files))

    monkeypatch.setattr(adapter, '_job', capture)
    monkeypatch.setattr(adapter, '_conformed', lambda source, *_: source)
    monkeypatch.setattr(adapter, '_first_frame', lambda source: b'first-frame-of-' + source)
    checked = capability_parameters(*adapter.edit_parameters(5, 768, 1344))
    asyncio.run(adapter.edit_video(CONFIG, VideoEditRequest(prompt='把背景换成月夜', source=b'video', seconds=5, width=768, height=1344,
                                                         picture=EditMask(1.0, region=((0.0, 1.0),)), avoid='凳子')))
    fields, files = calls[0]
    extra = json.loads(fields['extra_params'])
    assert extra == {'task': 'ref2va', 'audio_flow_shift': 3}
    assert (fields['num_inference_steps'], fields['guidance_scale'], fields['num_frames'], fields['size']) == ('8', '1', '124', '768x1344')
    # The checked parameters are the transmitted ones.
    sent = {key: value for key, value in fields.items() if key not in {'model', 'prompt', 'extra_params'}} | extra
    assert {key: str(value) for key, value in checked.items() if key not in {'width', 'height'}} == {key: str(value) for key, value in sent.items()}
    assert fields['prompt'] == '<Picture 1> 把背景换成月夜' and 'negative_prompt' not in fields
    assert [name for name, _ in files] == ['input_references', 'source_video', 'video_noise_mask', 'audio_noise_mask']
    assert files[0][1][1] == b'first-frame-of-video'
    assert json.loads(files[2][1][1]) == [[0.0, 1.0]] and json.loads(files[3][1][1]) == 0.0
