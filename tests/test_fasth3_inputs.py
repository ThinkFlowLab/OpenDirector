import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
from uuid import uuid4

import pytest

from opendirector.domain.projects import ProjectError
from opendirector.integrations.fasth3 import native_prompt, video_parameters, finalize_video_edit


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


@pytest.mark.parametrize('text,duration,seconds,frames,preserve', [
    ('替换视频人物，保持镜头不变', 15000, '15', 362, True),
    ('替换视频人物', 3000, '4', 107, True),
    ('替换视频人物，输出 5 秒', 15000, '5', 124, False),
    ('Replace the person; generate a 6-second clip', 15000, '6', 158, False),
    ('参考这个视频制作全新短片', 15000, '5', 124, None),
])
def test_video_edit_duration_is_not_silently_five_seconds(text, duration, seconds, frames, preserve):
    video = source('video', '原片.mp4', durationMs=duration, width=480, height=832)
    node = {'referenceIds': [video['id']], 'prompt': text}
    params = video_parameters(node, {video['id']: video})
    assert params['seconds'] == seconds and params['num_frames'] == frames
    assert params['size'] == '480x832'
    if preserve is None:
        assert 'videoEdit' not in params
    else:
        assert params['videoEdit']['preserveDuration'] is preserve
        assert params['videoEdit']['sourceAssetId'] == video['id']


def test_explicit_audio_edit_is_not_overwritten_and_invalid_duration_is_rejected():
    video = source('video', '原片.mp4', durationMs=15000)
    node = {'referenceIds': [video['id']], 'prompt': '替换人物并更换背景音乐'}
    assert video_parameters(node, {video['id']: video})['videoEdit']['preserveAudio'] is False
    with pytest.raises(ProjectError, match='4—15 秒'):
        video_parameters({**node, 'prompt': '替换人物，输出 20 秒'}, {video['id']: video})


@pytest.mark.parametrize('seconds, frames', [(4, 107), (7, 175), (10, 243), (15, 362)])
def test_panel_duration_overrides_default_and_conflicting_prompt(seconds, frames):
    for prompt in ('按参考图生成人物动作', '输出 5 秒的人物动作'):
        parameters = video_parameters({'referenceIds': [], 'prompt': prompt}, {}, duration_seconds=seconds)
        assert parameters['duration'] == seconds
        assert parameters['seconds'] == str(seconds)
        assert parameters['num_frames'] == frames


def test_panel_duration_overrides_source_edit_length_without_losing_audio_policy():
    video = source('video', '原片.mp4', durationMs=5000, width=480, height=832)
    node = {'referenceIds': [video['id']], 'prompt': '替换视频中的人物'}
    parameters = video_parameters(node, {video['id']: video}, duration_seconds=7)
    assert parameters['duration'] == 7 and parameters['seconds'] == '7'
    assert parameters['videoEdit']['sourceDurationMs'] == 5000
    assert parameters['videoEdit']['preserveDuration'] is False
    assert parameters['videoEdit']['preserveAudio'] is True


@pytest.mark.parametrize('seconds', [3, 16, float('nan'), float('inf')])
def test_panel_duration_outside_supported_range_is_rejected(seconds):
    with pytest.raises(ProjectError, match='4—15 秒'):
        video_parameters({'referenceIds': [], 'prompt': '人物动作'}, {}, duration_seconds=seconds)


@pytest.mark.parametrize('has_audio', [True, False])
def test_real_finalization_preserves_source_soundtrack_or_silence_and_duration(tmp_path, has_audio):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    original, generated = tmp_path/'source.mp4', tmp_path/'generated.mp4'
    def make(path, duration, frequency):
        cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24']
        if frequency:
            cmd += ['-f', 'lavfi', '-i', f'sine=frequency={frequency}:sample_rate=48000']
        cmd += ['-t', str(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(path)]
        subprocess.run(cmd, check=True, capture_output=True)
    make(original, 1, 440 if has_audio else None)
    make(generated, 2, 880)
    meta = source('video', 'source.mp4', fingerprint='fixture', hasAudio=has_audio)
    store = SimpleNamespace(asset=lambda *args: (original.read_bytes(), meta))
    task = {'kind': 'video', 'protocol': 'vllm_omni', 'projectId': 'test',
            'inputSnapshot': {'references': {meta['id']: 'fixture'}},
            'parameters': {'videoEdit': {'sourceAssetId': meta['id'], 'sourceDurationMs': 1000,
                                        'preserveAudio': True, 'preserveDuration': True}}}
    suffix, data = finalize_video_edit(store, task, 'mp4', generated.read_bytes())
    output = tmp_path/'output.mp4'
    output.write_bytes(data)
    def probe(path):
        return json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))
    info = probe(output)
    assert suffix == 'mp4' and .99 <= float(info['format']['duration']) <= 1.1
    assert any(s['codec_type'] == 'audio' for s in info['streams']) is has_audio
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], capture_output=True, check=True)
    assert not decoded.stderr.strip()
    if has_audio:
        def packets(path):
            value = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'a',
                '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', str(path)]))
            return [p['data_hash'] for p in value['packets']]
        assert packets(output) == packets(original)
        assert packets(output) != packets(generated)
    changed = {**task, 'inputSnapshot': {'references': {meta['id']: 'changed'}}}
    with pytest.raises(ProjectError, match='原视频已变化'):
        finalize_video_edit(store, changed, 'mp4', generated.read_bytes())


def test_preserved_soundtrack_does_not_extend_an_explicit_shorter_output(tmp_path, monkeypatch):
    original = source('video', 'source.mp4', fingerprint='fixture')
    store = SimpleNamespace(asset=lambda *args: (b'original', original))
    commands = []
    monkeypatch.setattr(shutil, 'which', lambda _: 'ffmpeg')
    def run(command, **kwargs):
        commands.append(command)
        if command[0] == 'ffprobe':
            return SimpleNamespace(stdout=b'aac\n')
        Path(command[-1]).write_bytes(b'final')
    monkeypatch.setattr(subprocess, 'run', run)
    task = {'kind': 'video', 'protocol': 'vllm_omni', 'projectId': 'owner',
            'parameters': {'duration': 5, 'videoEdit': {'sourceAssetId': original['id'],
                'sourceDurationMs': 15000, 'preserveDuration': False, 'preserveAudio': True}}}
    assert finalize_video_edit(store, task, 'mp4', b'generated') == ('mp4', b'final')
    command = commands[-1]
    assert command[command.index('-t') + 1] == '5.0'


@pytest.mark.parametrize('preserve_audio', [True, False])
def test_real_shorter_output_trims_reordered_video_and_keeps_the_selected_audio(tmp_path, preserve_audio):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    original, generated = tmp_path/'source.mp4', tmp_path/'generated.mp4'
    for path, seconds, frequency in [(original, 6 if preserve_audio else 4, 440), (generated, 5, 880)]:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24',
            '-f', 'lavfi', '-i', f'sine=frequency={frequency}:sample_rate=48000', '-t', str(seconds),
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(path)], check=True, capture_output=True)
    video_info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=has_b_frames', '-of', 'json', str(generated)]))
    assert video_info['streams'][0]['has_b_frames'] > 0
    meta = source('video', 'source.mp4', fingerprint='fixture', hasAudio=True)
    store = SimpleNamespace(asset=lambda *args: (original.read_bytes(), meta))
    task = {'kind': 'video', 'protocol': 'vllm_omni', 'projectId': 'test',
            'inputSnapshot': {'references': {meta['id']: 'fixture'}},
            'parameters': {'duration': 4, 'videoEdit': {'sourceAssetId': meta['id'], 'sourceDurationMs': 4000,
                'preserveAudio': preserve_audio, 'preserveDuration': not preserve_audio}}}
    suffix, data = finalize_video_edit(store, task, 'mp4', generated.read_bytes())
    output = tmp_path/'output.mp4'
    output.write_bytes(data)
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
    assert suffix == 'mp4' and 3.95 <= float(info['format']['duration']) <= 4.1
    assert 3.95 <= float(next(stream for stream in info['streams'] if stream['codec_type'] == 'video')['duration']) <= 4.05
    def packets(path):
        value = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'a',
            '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', str(path)]))
        return [packet['data_hash'] for packet in value['packets']]
    selected = packets(original if preserve_audio else generated)
    actual = packets(output)
    assert actual and actual == selected[:len(actual)]
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], capture_output=True, check=True)
    assert not decoded.stderr.strip()


def test_real_pcm_source_soundtrack_is_transcoded_for_the_mp4_output(tmp_path):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    original, generated = tmp_path/'source.mov', tmp_path/'generated.mp4'
    for path, seconds, frequency, audio in [(original, 5, 440, 'pcm_s16le'), (generated, 8, 880, 'aac')]:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24',
            '-f', 'lavfi', '-i', f'sine=frequency={frequency}:sample_rate=48000', '-t', str(seconds),
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', audio, str(path)], check=True, capture_output=True)
    meta = source('video', 'source.mov', fingerprint='fixture', durationMs=5000, hasAudio=True)
    meta['type'] = 'video/quicktime'
    store = SimpleNamespace(asset=lambda *args: (original.read_bytes(), meta))
    task = {'kind': 'video', 'protocol': 'vllm_omni', 'projectId': 'test',
            'inputSnapshot': {'references': {meta['id']: 'fixture'}},
            'parameters': {'duration': 7, 'videoEdit': {'sourceAssetId': meta['id'], 'sourceDurationMs': 5000,
                'preserveAudio': True, 'preserveDuration': False}}}
    suffix, data = finalize_video_edit(store, task, 'mp4', generated.read_bytes())
    output = tmp_path/'output.mp4'
    output.write_bytes(data)
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
    audio = next(stream for stream in info['streams'] if stream['codec_type'] == 'audio')
    assert suffix == 'mp4' and audio['codec_name'] == 'aac'
    assert 4.9 <= float(audio['duration']) <= 5.1
    assert 6.95 <= float(info['format']['duration']) <= 7.1
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], capture_output=True, check=True)
    assert not decoded.stderr.strip()


def test_explicit_seven_second_edit_is_not_trimmed_back_to_five_second_source(tmp_path):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    original, generated = tmp_path/'source.mp4', tmp_path/'generated.mp4'
    for path, seconds, frequency in [(original, 5, 440), (generated, 8, 880)]:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24',
            '-f', 'lavfi', '-i', f'sine=frequency={frequency}:sample_rate=48000', '-t', str(seconds),
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(path)], check=True, capture_output=True)
    meta = source('video', 'source.mp4', fingerprint='fixture', durationMs=5000, hasAudio=True)
    parameters = video_parameters({'referenceIds': [meta['id']], 'prompt': '替换人物'},
                                 {meta['id']: meta}, duration_seconds=7)
    store = SimpleNamespace(asset=lambda *args: (original.read_bytes(), meta))
    task = {'kind': 'video', 'protocol': 'vllm_omni', 'projectId': 'test', 'parameters': parameters,
            'inputSnapshot': {'references': {meta['id']: 'fixture'}}}
    suffix, data = finalize_video_edit(store, task, 'mp4', generated.read_bytes())
    output = tmp_path/'output.mp4'
    output.write_bytes(data)
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_format', '-of', 'json', str(output)]))
    assert suffix == 'mp4' and 6.95 <= float(info['format']['duration']) <= 7.1
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], capture_output=True, check=True)
    assert not decoded.stderr.strip()


def test_real_audio_change_with_explicit_duration_trims_without_reading_the_source(tmp_path):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    meta = source('video', 'source.mp4', durationMs=5000)
    parameters = video_parameters({'referenceIds': [meta['id']], 'prompt': '替换人物并更换背景音乐'},
                                  {meta['id']: meta}, duration_seconds=7)
    assert parameters['num_frames'] == 175
    assert not parameters['videoEdit']['preserveAudio'] and not parameters['videoEdit']['preserveDuration']
    generated = tmp_path/'generated.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-frames:v', '175', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(generated)], check=True, capture_output=True)
    # The source may have changed since submission; this edit does not use it.
    store = SimpleNamespace(asset=lambda *args: pytest.fail('source must not be read'))
    task = {'kind': 'video', 'protocol': 'vllm_omni', 'projectId': 'test', 'parameters': parameters,
            'inputSnapshot': {'references': {meta['id']: 'changed-since-submission'}}}
    suffix, data = finalize_video_edit(store, task, 'mp4', generated.read_bytes())
    output = tmp_path/'output.mp4'
    output.write_bytes(data)
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
    assert suffix == 'mp4' and 6.95 <= float(info['format']['duration']) <= 7.05
    assert any(s['codec_type'] == 'audio' for s in info['streams'])
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], capture_output=True, check=True)
    assert not decoded.stderr.strip()


@pytest.mark.parametrize('pixel_format', ['yuv420p10le', 'yuv444p'])
def test_real_output_is_always_8_bit_420(tmp_path, pixel_format):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    generated = tmp_path/'generated.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24', '-t', '5',
        '-c:v', 'libx264', '-pix_fmt', pixel_format, str(generated)], check=True, capture_output=True)
    meta = source('video', 'source.mp4')
    task = {'kind': 'video', 'protocol': 'vllm_omni', 'projectId': 'test', 'parameters': {'duration': 4, 'seconds': '4',
            'videoEdit': {'sourceAssetId': meta['id'], 'sourceDurationMs': 4000, 'preserveAudio': False, 'preserveDuration': False}}}
    _, data = finalize_video_edit(SimpleNamespace(), task, 'mp4', generated.read_bytes())
    output = tmp_path/'output.mp4'
    output.write_bytes(data)
    stream = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=pix_fmt,profile', '-of', 'json', str(output)]))['streams'][0]
    assert stream == {'pix_fmt': 'yuv420p', 'profile': 'High'}


def generated_clip(path, frames):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-frames:v', str(frames), '-t', str(frames / 24),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(path)], check=True, capture_output=True)


def plain_task(profile='fasth3-omni', seconds=7):
    return {'kind': 'video', 'protocol': 'vllm_omni', 'projectId': 'test', 'referenceInputs': {'profile': profile},
            'parameters': {'duration': seconds, 'seconds': str(seconds)}}


def test_real_plain_fasth3_output_is_trimmed_to_the_requested_duration(tmp_path):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    generated = tmp_path/'generated.mp4'
    generated_clip(generated, 175)  # 7 s rounded up to the 17n+5 frame grid.
    store = SimpleNamespace(asset=lambda *args: pytest.fail('a plain generation has no source to read'))
    suffix, data = finalize_video_edit(store, plain_task(), 'mp4', generated.read_bytes())
    output = tmp_path/'output.mp4'
    output.write_bytes(data)
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', str(output)]))
    video = next(stream for stream in info['streams'] if stream['codec_type'] == 'video')
    assert suffix == 'mp4' and int(video['nb_read_frames']) == 168
    assert 6.95 <= float(info['format']['duration']) <= 7.05
    assert any(stream['codec_type'] == 'audio' for stream in info['streams'])
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], capture_output=True, check=True)
    assert not decoded.stderr.strip()


@pytest.mark.parametrize('profile,frames', [('fasth3-omni', 168), ('vllm-omni-h3', 175)])
def test_real_exact_or_continuable_output_is_returned_unchanged(tmp_path, profile, frames):
    # Native H3 continues from the server's untrimmed clip, so trimming it would break the seam.
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    generated = tmp_path/'generated.mp4'
    generated_clip(generated, frames)
    store = SimpleNamespace(asset=lambda *args: pytest.fail('no source read expected'))
    assert finalize_video_edit(store, plain_task(profile), 'mp4', generated.read_bytes()) == ('mp4', generated.read_bytes())


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
            assert fields['seconds'] == b'15'
            assert json.loads(fields['extra_params'])['duration'] == 15
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


def test_dual_h3_without_frame_anchors_sends_text_task():
    import asyncio
    from email.parser import BytesParser
    from email.policy import default
    import httpx
    from opendirector.integrations.providers import GenerationProviders

    task = {'kind': 'video', 'projectId': 'owner', 'prompt': 'A calm lake at dawn',
            'referenceIds': [], 'videoMode': 'first_frame', 'parameters': {'duration': 4},
            'referenceRoles': []}
    config = {'kind': 'video', 'protocol': 'vllm_omni', 'url': 'http://localhost:18091/v1',
              'modelId': 'FastH3-Omni-INT8', 'videoAdapter': 'fasth3_dual', 'apiKey': '', 'authMode': 'none'}

    def handle(request):
        if request.method == 'POST':
            prefix = 'Content-Type: ' + request.headers['content-type'] + '\r\n\r\n'
            message = BytesParser(policy=default).parsebytes(prefix.encode() + request.content)
            parts = list(message.iter_parts())
            assert [part.get_filename() for part in parts if part.get_filename()] == []
            fields = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True)
                      for part in parts if part.get_filename() is None}
            assert fields['prompt'] == b'A calm lake at dawn'
            assert fields['num_inference_steps'] == b'20'
            extra = json.loads(fields['extra_params'])
            assert (extra['task'], 'frame_indices' in extra, extra['sampler']) == ('t2va', False, 'res_multistep')
            return httpx.Response(200, json={'id': 'verified-text-job'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=b'generated')
        return httpx.Response(200, json={'status': 'completed'})

    async def submitted(value):
        assert value == 'verified-text-job'

    store = SimpleNamespace(asset=lambda *args: pytest.fail('a text-to-video request uploads no anchor'))
    provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
    assert asyncio.run(provider.generate(config, task, submitted)) == ('mp4', b'generated')


def test_tail_anchor_preserves_last_native_frame():
    task = {**plain_task('fasth3-omni'), 'videoMode': 'first_frame',
            'referenceRoles': [{'assetId': str(uuid4()), 'role': 'last_frame'}]}
    assert finalize_video_edit(None, task, 'mp4', b'native-grid-output') == ('mp4', b'native-grid-output')
