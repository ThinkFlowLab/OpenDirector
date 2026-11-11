"""Compile H3 references and preserve a direct source-video edit's time/audio."""
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from opendirector.domain.assets import MAX_ASSET_BYTES
from opendirector.domain.projects import ProjectError
from opendirector.domain.references import project_content

MP4_AUDIO_CODECS = {'aac', 'mp3', 'opus'}


def native_prompt(task, sources):
    """Render each rich reference in place using H3's per-modality ordinals."""
    # H3 places every video's embedded soundtrack before standalone audio refs.
    audio_offset = sum(kind == 'video' and bool(meta.get('hasAudio')) for meta, kind in sources)
    counts, tags = {}, {}
    for meta, kind in sources:
        counts[kind] = counts.get(kind, 0) + 1
        if kind in {'image', 'video', 'audio'}:
            label = {'image': 'Picture', 'video': 'Video', 'audio': 'Audio'}[kind]
            number = counts[kind] + (audio_offset if kind == 'audio' else 0)
            tags[meta['id']] = f'<{label} {number}>'
    content = task.get('promptContent')
    if content is None:
        prompt = task['prompt']
        # Old/plain drafts can mention filenames without positioned chips.
        for meta, kind in sources:
            tag = tags.get(meta['id'])
            if tag and tag not in prompt:
                prompt += f'\n{meta["name"]}：{tag}'
        return prompt
    parts = []
    for part in content:
        if part['type'] == 'text':
            parts.append(part['text'])
        elif part['assetId'] in tags:
            parts.append(tags[part['assetId']])
        else:
            # Text references retain their name; their body is appended by validation.
            parts.append(part['name'])
    return ''.join(parts)


def video_parameters(node, records, *, duration_seconds=None):
    visual = [records[key] for key in node['referenceIds'] if records[key]['kind'] in {'video', 'image'}]
    videos = [asset for asset in visual if asset['kind'] == 'video']
    basis = videos[0] if videos else visual[0] if visual else {}
    portrait = basis.get('height', 0) > basis.get('width', 0)
    text = project_content(node['promptContent'], speech=True)[0] if node.get('promptContent') is not None else node['prompt']
    edit = len(videos) == 1 and bool(re.search(r'替换|换人|换脸|换装|修改|编辑|去除|去掉|移除|\b(?:replace|swap|edit|remove)\b', text, re.I))
    explicit = re.search(r'(?:生成|输出|制作|时长(?:为|是)?|长度(?:为|是)?)\s*(?:一段)?\s*(\d+(?:\.\d+)?)\s*秒|\b(\d+(?:\.\d+)?)\s*(?:-\s*)?(?:second|seconds|sec)\b', text, re.I)
    # An explicit UI/API selection wins over prompt inference and source length.
    # Legacy callers without that field retain the prompt/source/default policy.
    seconds = float(duration_seconds) if duration_seconds is not None else (
        float(next(group for group in explicit.groups() if group)) if explicit else (
            max(4.0, basis['durationMs'] / 1000) if edit else 5.0))
    if not 4 <= seconds <= 15:
        raise ProjectError('当前 FastH3 支持生成 4—15 秒的视频，请调整输出时长；未提交生成。')
    requested_frames = round(seconds * 24)
    frames = requested_frames + (5 - requested_frames) % 17
    result = {'seconds': str(math.ceil(seconds)), 'duration': seconds,
              'size': '480x832' if portrait else '832x480', 'fps': 24, 'num_frames': frames,
              'num_inference_steps': 8, 'guidance_scale': 1}
    if edit:
        # Original audio is retained unless the user asks to change it. This is
        # local muxing, independent of the model's generative audio prediction.
        change_audio = re.search(r'(?:修改|替换|生成|更换|去除|去掉|移除|添加|改变|不要保留).{0,8}(?:音频|音乐|音轨|配音|声音|原音|BGM)|降噪|去噪|\b(?:change|replace|remove|add|generate)\b.{0,25}\b(?:audio|music|sound|voice)\b', text, re.I)
        result['videoEdit'] = {'sourceAssetId': basis['id'], 'sourceDurationMs': basis['durationMs'],
                               'preserveDuration': duration_seconds is None and explicit is None,
                               'preserveAudio': not bool(change_audio)}
    return result


def _mp4_audio_arguments(path):
    """Keep MP4-playable soundtrack packets and transcode the rest, such as MOV PCM."""
    process = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0',
                              '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', str(path)],
                             check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
    codec = process.stdout.decode(errors='replace').strip()
    return ['-c:a', 'copy'] if not codec or codec in MP4_AUDIO_CODECS else ['-c:a', 'aac', '-b:a', '192k']


def _trim_plain_fasth3(task, suffix, data):
    """FastH3 rounds frames up to its 17n+5 grid; a 7 s request returns 175 frames (7.29 s)."""
    seconds = float(task['parameters']['duration'])
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise ProjectError('裁剪 FastH3 视频到所选时长需要 FFmpeg；生成结果可继续下载恢复，无需重新生成。', 409)
    with tempfile.TemporaryDirectory(prefix='opendirector-video-trim-') as folder:
        generated = Path(folder) / ('generated.' + suffix)
        output = Path(folder) / 'output.mp4'
        generated.write_bytes(data)
        try:
            probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
                                    '-show_entries', 'stream=duration', '-of', 'csv=p=0', str(generated)],
                                   check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
            actual = float(probe.stdout.decode(errors='replace').strip())
            # Within one frame already matches; re-encoding it would only cost quality.
            if actual <= seconds + 1 / 24:
                return suffix, data
            command = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(generated),
                       '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
                       '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-t', str(seconds), *_mp4_audio_arguments(generated),
                       '-movflags', '+faststart', str(output)]
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
        except (subprocess.SubprocessError, OSError, ValueError):
            raise ProjectError('裁剪 FastH3 视频到所选时长失败；请检查 FFmpeg，稍后继续下载原任务，无需重新生成。', 409) from None
        if output.stat().st_size > MAX_ASSET_BYTES:
            raise ProjectError('处理后的视频超过 50 MB，无法保存到项目。', 413)
        return 'mp4', output.read_bytes()


def finalize_video_edit(store, task, suffix, data):
    policy = task.get('parameters', {}).get('videoEdit')
    if task.get('protocol') != 'vllm_omni' or task['kind'] != 'video':
        return suffix, data
    if not policy:
        # Native H3 continuation resumes from the server's untrimmed clip, so only FastH3 is trimmed.
        if (task.get('referenceInputs') or {}).get('profile') == 'fasth3-omni' and task.get('parameters', {}).get('duration'):
            return _trim_plain_fasth3(task, suffix, data)
        return suffix, data
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise ProjectError('保留原片音轨和时长需要 FFmpeg；生成结果可继续下载恢复，无需重新生成。', 409)
    # An edit that changes the audio and sets its own length only trims the result,
    # so a later change to the source must not block a paid download.
    uses_source = policy.get('preserveAudio') or policy.get('preserveDuration')
    if uses_source:
        # Reuse the same fingerprint validation as submission when recovering a download.
        from opendirector.integrations.reference_inputs import references
        source, meta, _ = next(references(store, task['projectId'], [policy['sourceAssetId']]))
        expected = task.get('inputSnapshot', {}).get('references', {}).get(policy['sourceAssetId'])
        if expected and meta.get('fingerprint') != expected:
            raise ProjectError('原视频已变化，无法保留其音轨；请恢复原素材后继续下载原任务。', 409)
    with tempfile.TemporaryDirectory(prefix='opendirector-video-edit-') as folder:
        generated = Path(folder) / ('generated.' + suffix)
        output = Path(folder) / 'output.mp4'
        generated.write_bytes(data)
        # Stream-copy trimming is not frame-accurate with reordered B-frames:
        # packets after the target timestamp can extend the output duration.
        # Re-encode video for an exact boundary; audio packets stay intact when MP4 can carry them.
        # Chrome also plays High 10 and High 4:4:4, but 8-bit 4:2:0 is the widely supported H.264 baseline.
        command = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(generated)]
        if uses_source:
            original = Path(folder) / ('source' + Path(meta['name']).suffix.lower())
            original.write_bytes(source)
            command += ['-protocol_whitelist', 'file,pipe', '-i', str(original)]
        command += ['-map', '0:v:0', '-map', '1:a:0?' if policy.get('preserveAudio') else '0:a:0?',
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
                    '-map_metadata', '-1']
        # A longer source soundtrack must never extend an explicitly shorter edit.
        duration = policy['sourceDurationMs'] / 1000 if policy.get('preserveDuration') else float(task['parameters'].get('duration', task['parameters'].get('seconds', 5)))
        command += ['-t', str(duration)]
        try:
            command += _mp4_audio_arguments(original if policy.get('preserveAudio') else generated)
            command += ['-movflags', '+faststart', str(output)]
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
        except (subprocess.SubprocessError, OSError):
            raise ProjectError('保留原片音轨或时长失败；请检查 FFmpeg，稍后继续下载原任务，无需重新生成。', 409) from None
        if output.stat().st_size > MAX_ASSET_BYTES:
            raise ProjectError('处理后的视频超过 50 MB，无法保存到项目。', 413)
        return 'mp4', output.read_bytes()
