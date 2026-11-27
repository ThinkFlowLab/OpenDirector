"""A reference video longer than the vLLM-Omni budget is sent as its final window."""
import asyncio
import json
import shutil
import subprocess
from email.parser import BytesParser
from email.policy import default
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from opendirector.domain.creation.assets import AssetRef, MediaMetadata
from opendirector.domain.creation.generation import (ResolvedReference, VideoGenerationSpec, VideoParameters,
                                                     validate_generation)
from opendirector.domain.creation.models import ModelConfigPublic
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.domain.reference_windows import reference_video_windows
from opendirector.integrations.fasth3 import video_parameters
from opendirector.integrations.providers import GenerationProviders
from opendirector.integrations.reference_inputs import generation_references
from opendirector.media.processing import clip


pytestmark = pytest.mark.cpu

OMNI = {'kind': 'video', 'protocol': 'vllm_omni', 'url': 'http://localhost:18091/v1',
        'modelId': 'FastH3-Omni', 'apiKey': '', 'authMode': 'none'}


@pytest.mark.parametrize('durations, expected', [
    ([15000], [None]),
    ([78000], [(63000, 78000)]),
    ([10000, 4000], [None, None]),
    # The short clip stays whole; the two long ones share what is left equally.
    ([20000, 4000, 30000], [(14500, 20000), None, (24500, 30000)]),
    ([6000, 6000, 6000], [(1000, 6000)] * 3),
])
def test_windows_keep_the_end_and_fill_the_budget(durations, expected):
    windows = reference_video_windows(durations)
    assert windows == expected
    sent = [window[1] - window[0] if window else value for value, window in zip(durations, windows)]
    assert sum(sent) <= 15000
    if sum(durations) > 15000:
        assert sum(sent) > 15000 - len(durations)  # Only integer rounding is left unused.


def test_windows_reject_unknown_lengths():
    with pytest.raises(ValueError):
        reference_video_windows([0, 5000])


def model(adapter='fasth3', **extra):
    config = {'kind': 'video', 'url': 'http://model.test/v1', 'modelId': 'FastH3-Omni', 'connectionType': 'self_hosted',
              'protocol': 'vllm_omni', 'authMode': 'none', 'videoAdapter': adapter, **extra}
    return ModelConfigPublic(id=uuid4(), inputRules=input_rules(config), **config)


def reference(seconds):
    return ResolvedReference(referenceId=uuid4(), role='reference',
        asset=AssetRef(assetId=uuid4(), revision=1, fingerprint='sha256:' + '0' * 64, kind='video'),
        metadata=MediaMetadata(mimeType='video/mp4', size=10, width=32, height=24, durationSeconds=seconds))


def spec(target):
    return VideoGenerationSpec(id=uuid4(), projectId=uuid4(), kind='video', purpose='generation',
        modelConfigId=target.id, prompt='Continue the scene',
        parameters=VideoParameters(videoMode='reference', durationSeconds=5))


def test_submission_accepts_a_long_reference_video_only_where_it_is_windowed():
    omni = model()
    validate_generation(spec(omni), omni, (reference(78),), submitting=True)
    validate_generation(spec(omni), omni, (reference(78), reference(40)), submitting=True)
    # The length still has to be known to plan a window.
    with pytest.raises(ValueError, match='时长必须已知'):
        validate_generation(spec(omni), omni, (reference(None),), submitting=True)
    # Audio keeps its total limit on the same profile.
    audio = ResolvedReference(referenceId=uuid4(), role='reference',
        asset=AssetRef(assetId=uuid4(), revision=1, fingerprint='sha256:' + '0' * 64, kind='audio'),
        metadata=MediaMetadata(mimeType='audio/wav', size=10, durationSeconds=20))
    with pytest.raises(ValueError, match='音频参考'):
        validate_generation(spec(omni), omni, (reference(5), audio), submitting=True)


def video_asset(name, seconds, data=b'video-bytes'):
    meta = {'id': str(uuid4()), 'name': name, 'kind': 'video', 'type': 'video/mp4', 'fingerprint': 'fixture',
            'durationMs': seconds * 1000, 'hasAudio': True}
    return meta, data


def task_for(assets, prompt='延长这段视频'):
    return {'kind': 'video', 'projectId': 'owner', 'prompt': prompt, 'referenceIds': [meta['id'] for meta, _ in assets],
            'videoMode': 'reference'}


def store_for(assets):
    by_id = {meta['id']: (data, meta) for meta, data in assets}
    return SimpleNamespace(asset=lambda owner, key: by_id[key])


def test_planning_records_the_window_without_cutting_anything():
    long, short = video_asset('long.mp4', 78), video_asset('short.mp4', 4)
    assets = [long, short]
    prepared = generation_references(store_for(assets), task_for(assets), OMNI)
    entries = {entry['assetId']: entry for entry in prepared['manifest']}
    # 15 s budget minus the whole 4 s clip leaves the last 11 s of the long one.
    assert entries[long[0]['id']]['window'] == {'startMs': 67000, 'endMs': 78000}
    assert 'window' not in entries[short[0]['id']]
    assert prepared['windows'] == {long[0]['id']: (67000, 78000)}


def test_other_profiles_still_refuse_a_long_reference_video():
    long = video_asset('long.mp4', 78)
    seedance = {'kind': 'video', 'modelId': 'doubao-seedance-2.0', 'url': 'https://ark.cn-beijing.volces.com/api/plan/v3', 'apiKey': 'private'}
    with pytest.raises(ProjectError, match='不超过 15 秒'):
        generation_references(store_for([long]), task_for([long]), seedance)


def test_an_edit_without_a_chosen_length_covers_the_window():
    meta, _ = video_asset('long.mp4', 78)
    node = {'referenceIds': [meta['id']], 'prompt': '替换视频人物'}
    parameters = video_parameters(node, {meta['id']: meta})
    assert parameters['duration'] == 15 and parameters['num_frames'] == 362


@pytest.fixture(scope='module')
def two_tone_video(tmp_path_factory):
    """Three red seconds, then three blue ones, with a soundtrack."""
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg is required to cut reference windows')
    folder = tmp_path_factory.mktemp('reference-window')
    path = folder / 'two-tone.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=24:d=3',
                    '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
                    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(path)], check=True)
    return path.read_bytes()


def probe(data, tmp_path):
    path = tmp_path / 'probe.mp4'
    path.write_bytes(data)
    value = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
                                       '-of', 'json', str(path)], check=True, capture_output=True).stdout)
    pixel = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                            '-s', '1x1', 'pipe:1'], check=True, capture_output=True).stdout
    return float(value['format']['duration']), {stream['codec_type'] for stream in value['streams']}, tuple(pixel[:3])


def test_clip_is_the_requested_range_with_its_sound(two_tone_video, tmp_path):
    duration, streams, (red, _, blue) = probe(clip(two_tone_video, 4.0, 6.0), tmp_path)
    assert duration == pytest.approx(2.0, abs=0.15)
    assert streams == {'video', 'audio'}
    # The range starts after the cut to blue, so its first frame is blue.
    assert blue > 150 and red < 100


def test_the_wire_carries_the_final_window(two_tone_video, tmp_path, monkeypatch):
    """78 s is refused today; here a clip over a lowered budget shows the tail, not the source, is uploaded."""
    import opendirector.domain.reference_windows as windows_module
    import opendirector.integrations.reference_inputs as inputs
    monkeypatch.setattr(inputs, 'reference_video_windows',
                        lambda durations: windows_module.reference_video_windows(durations, limit_ms=2000))
    meta, data = video_asset('two-tone.mp4', 6, two_tone_video)
    task = task_for([(meta, data)])
    task['parameters'] = video_parameters(task, {meta['id']: meta}, duration_seconds=5)
    uploads = []

    def handle(request):
        if request.method == 'POST':
            prefix = 'Content-Type: ' + request.headers['content-type'] + '\r\n\r\n'
            message = BytesParser(policy=default).parsebytes(prefix.encode() + request.content)
            uploads.extend((part.get_filename(), part.get_content_type(), part.get_payload(decode=True))
                           for part in message.iter_parts() if part.get_filename())
            return httpx.Response(200, json={'id': 'window-job'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=b'generated')
        return httpx.Response(200, json={'status': 'completed'})

    async def submitted(value):
        assert value == 'window-job'

    provider = GenerationProviders(store_for([(meta, data)]), httpx.MockTransport(handle), poll_interval=0)
    assert asyncio.run(provider.generate(OMNI, task, submitted)) == ('mp4', b'generated')
    (name, mime, body), = uploads
    assert (name, mime) == ('two-tone.mp4', 'video/mp4') and body != data
    duration, streams, (red, _, blue) = probe(body, tmp_path)
    assert duration == pytest.approx(2.0, abs=0.15) and streams == {'video', 'audio'}
    assert blue > 150 and red < 100
