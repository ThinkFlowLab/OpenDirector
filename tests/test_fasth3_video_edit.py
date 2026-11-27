"""Latent-mask editing for Ref2VA-only H3 services (FastH3 Omni and few-step adapters served the same way)."""
import asyncio
import json

import pytest

from opendirector.domain.capabilities import EditMask, MediaResult, VideoEditRequest
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


def recorded(monkeypatch, adapter):
    """Run the adapter without a service: every submitted request is kept, and each answers with its own draft."""
    calls, reported = [], []

    async def job(config, fields, files, submitted):
        calls.append((fields, files))
        if submitted:
            await submitted(f'job-{len(calls)}')
        return MediaResult(f'draft-{len(calls)}'.encode(), 'mp4')

    async def submitted(external_id):
        reported.append(external_id)

    monkeypatch.setattr(adapter, '_job', job)
    monkeypatch.setattr(adapter, '_conformed', lambda source, *_: source)
    monkeypatch.setattr(adapter, '_frame', lambda source, seconds: b'frame-%.3f-of-' % seconds + source)
    monkeypatch.setattr(adapter, '_last_edited_frame', lambda clip, end: b'last-frame-before-%r-of-' % end + clip)
    return calls, reported, submitted


def test_edit_request_is_ref2va_on_the_fixed_schedule_with_a_source_frame_as_reference(monkeypatch):
    adapter = FastH3VideoEdit()
    calls, _, submitted = recorded(monkeypatch, adapter)
    checked = capability_parameters(*adapter.edit_parameters(5, 768, 1344))
    asyncio.run(adapter.edit_video(CONFIG, VideoEditRequest(prompt='把背景换成月夜', source=b'video', seconds=5, width=768, height=1344,
                                                         picture=EditMask(1.0, region=((0.0, 1.0),)), avoid='凳子'), submitted=submitted))
    fields, files = calls[0]
    extra = json.loads(fields['extra_params'])
    assert extra == {'task': 'ref2va', 'audio_flow_shift': 3}
    assert (fields['num_inference_steps'], fields['guidance_scale'], fields['num_frames'], fields['size']) == ('8', '1', '124', '768x1344')
    # The checked parameters are the transmitted ones.
    sent = {key: value for key, value in fields.items() if key not in {'model', 'prompt', 'extra_params'}} | extra
    assert {key: str(value) for key, value in checked.items() if key not in {'width', 'height'}} == {key: str(value) for key, value in sent.items()}
    assert fields['prompt'] == '<Picture 1> 把背景换成月夜' and 'negative_prompt' not in fields
    assert [name for name, _ in files] == ['input_references', 'source_video', 'video_noise_mask', 'audio_noise_mask']
    assert files[0][1][1] == b'frame-0.000-of-video'
    assert json.loads(files[2][1][1]) == [[0.0, 1.0]] and json.loads(files[3][1][1]) == 0.0


def test_a_boxed_redraw_runs_again_with_its_own_last_edited_frame_as_reference(monkeypatch):
    """A Ref2VA model opens the clip on its reference picture, so the edit must already be in that picture."""
    adapter = FastH3VideoEdit()
    calls, reported, submitted = recorded(monkeypatch, adapter)
    result = asyncio.run(adapter.edit_video(CONFIG, VideoEditRequest(prompt='moon', source=b'video', seconds=5, width=768, height=1344,
                                                                    picture=EditMask(1.0, region=((1.0, 0.0),))), submitted=submitted))
    assert [files[0][1][1] for _, files in calls] == [b'frame-0.000-of-video', b'last-frame-before-None-of-draft-1']
    # Apart from the reference picture the second request is the first one again, on the same source and mask.
    assert calls[0][0] == calls[1][0] and calls[0][1][1:] == calls[1][1][1:]
    assert result.data == b'draft-2'
    # Both jobs are reported, so a cancel reaches whichever is running.
    assert reported == ['job-1', 'job-2']


def test_a_boxed_redraw_that_stops_early_takes_the_last_frame_it_covers(monkeypatch):
    adapter = FastH3VideoEdit()
    calls, _, submitted = recorded(monkeypatch, adapter)
    asyncio.run(adapter.edit_video(CONFIG, VideoEditRequest(prompt='moon', source=b'video', seconds=5, width=768, height=1344,
                                                           picture=EditMask(1.0, region=((1.0, 0.0),), start=1.0, end=3.0)), submitted=submitted))
    assert calls[1][1][0][1][1] == b'last-frame-before-3.0-of-draft-1'


@pytest.mark.parametrize('mask, moment', [
    (EditMask(1.0, None, 1.0, 3.0), 0.0),      # the clip opens on kept frames: its first frame is the look to keep
    (EditMask(1.0, None, None, 2.5), 2.5),     # the span opens the clip: the first kept frame comes after it
    (EditMask(1.0, None, 0.0, 2.5), 2.5),
    (EditMask(1.0, None), 0.0),                # nothing is kept, so there is no better frame than the first
    (None, 0.0),
], ids=['span-inside', 'span-opens-clip', 'span-from-zero', 'whole-clip', 'sound-only'])
def test_a_whole_frame_redraw_runs_once_on_a_frame_it_keeps(monkeypatch, mask, moment):
    adapter = FastH3VideoEdit()
    calls, _, submitted = recorded(monkeypatch, adapter)
    result = asyncio.run(adapter.edit_video(CONFIG, VideoEditRequest(prompt='green dress', source=b'video', seconds=5, width=768, height=1344,
                                                                    picture=mask, sound=EditMask(1.0)), submitted=submitted))
    assert len(calls) == 1 and result.data == b'draft-1'
    assert calls[0][1][0][1][1] == b'frame-%.3f-of-video' % moment


def test_the_final_picture_is_found_when_the_sound_runs_longer(tmp_path):
    import shutil
    import subprocess

    from opendirector.media import processing as media
    if not shutil.which('ffmpeg'):
        pytest.skip('FFmpeg is required to build the clip')
    clip = tmp_path / 'clip.mp4'
    # One second of red, then one frame short of a second of blue, under three seconds of sound.
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=24',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-filter_complex', '[1:v]trim=end_frame=23[b];[0:v][b]concat=n=2:v=1:a=0[v]',
                    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(clip)], check=True)
    assert media.video_info(clip)['duration'] == pytest.approx(3, abs=0.1)
    assert media.last_frame_time(clip) == pytest.approx(46 / 24)
    from io import BytesIO

    from PIL import Image
    red, green, blue = Image.open(BytesIO(FastH3VideoEdit._last_edited_frame(clip.read_bytes(), None))).convert('RGB').getpixel((32, 24))
    assert blue > 200 and red < 60
    red, green, blue = Image.open(BytesIO(FastH3VideoEdit._last_edited_frame(clip.read_bytes(), 0.5))).convert('RGB').getpixel((32, 24))
    assert red > 200 and blue < 60
