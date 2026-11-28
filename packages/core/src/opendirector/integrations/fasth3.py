"""Compile H3 references and generation parameters."""
import math
import re

from opendirector.domain.projects import ProjectError
from opendirector.domain.references import project_content
from opendirector.domain.rule_facts import REFERENCE_MEDIA_SECONDS


def generation_fields(parameters, *, frame_indices=None, continue_from=None, continue_size=None):
    """Prepare the same FastH3 fields for capability checks and HTTP submission."""
    from opendirector.integrations.vllm_omni import FPS, video_frame_parameters
    fields = {}
    if any(key in parameters for key in ('duration', 'seconds', 'num_frames')):
        fields.update(video_frame_parameters(float(parameters.get('duration', parameters.get('seconds', 5))),
            parameters.get('fps', FPS), parameters.get('num_frames')))
    extra = {'task': 'ref2va', 'audio_flow_shift': 3}
    steps = 8
    if parameters.get('control_type'):
        # Fun ControlNet: the control video travels as control_reference with its type as a form field.
        fields['control_type'] = parameters['control_type']
        extra[parameters['control_type']] = {'control_context_scale': float(parameters.get('control_scale', 1.0))}
        if int(parameters.get('num_frames', 0)) > CONTROL_WINDOW_FRAMES:
            extra.update(long_video=True, long_video_mode='full')
    if frame_indices is not None:
        extra.update(task='fl2va', sampler='res_multistep', frame_indices=tuple(frame_indices))
        steps = parameters.get('num_inference_steps', 20)
    fields.update(size=parameters.get('size', '832x480'), num_inference_steps=steps,
                  guidance_scale=1, fps=24, seed=parameters.get('seed', 1234))
    if continue_from is not None:
        extra['continue_from'] = continue_from
    # The service samples a window over the earlier job's cached latent tail; latents cannot change size.
    # The capability check knows the size before the job has an ID to continue from, and checks what is sent.
    width, height = continue_size or (None, None)
    if width and height:
        fields['size'] = f'{width}x{height}'
    return fields, extra


CONTROL_WINDOW_FRAMES = 17 * 20 + 5  # One native FastH3 window; longer control clips run as one long_video_mode=full pass.
CONTROL_RATIOS = ('16:9', '4:3', '1:1', '3:4', '9:16')


def control_parameters(node, records, *, resolution=None):
    """FastH3 structure control follows its control video: the longest 17n+5 length it covers and the H3
    bucket nearest its aspect (768P unless 480P is chosen). The service holds the last control frame if short."""
    from opendirector.domain.rule_facts import CONTROL_VIDEO_SECONDS
    from opendirector.domain.video_output import _ratio, h3_output_size
    control = next(records[key] for key in node['referenceIds'] if records[key]['kind'] == 'video')
    seconds = min(control['durationMs'] / 1000, CONTROL_VIDEO_SECONDS[1])
    frames = 17 * max((int(seconds * 24 + 1e-6) - 5) // 17, 6) + 5
    aspect = (control.get('width') or 16) / (control.get('height') or 9)
    ratio = min(CONTROL_RATIOS, key=lambda name: abs(math.log(_ratio(name) / aspect)))
    resolution = resolution if resolution in {'480P', '768P'} else '768P'
    return {'seconds': str(math.ceil(frames / 24)), 'duration': frames / 24, 'size': h3_output_size(resolution, ratio),
            'fps': 24, 'num_frames': frames, 'num_inference_steps': 8, 'guidance_scale': 1,
            'control_type': 'depth', 'control_scale': 1.0}


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
            # An over-long source is sent as its final reference window, so an edit covers that window.
            max(4.0, min(basis['durationMs'] / 1000, REFERENCE_MEDIA_SECONDS)) if edit else 5.0))
    if not 4 <= seconds <= 15:
        raise ProjectError('当前 FastH3 支持生成 4—15 秒的视频，请调整输出时长；未提交生成。')
    requested_frames = round(seconds * 24)
    frames = requested_frames + (5 - requested_frames) % 17
    result = {'seconds': str(math.ceil(seconds)), 'duration': seconds,
              'size': '480x832' if portrait else '832x480', 'fps': 24, 'num_frames': frames,
              'num_inference_steps': 8, 'guidance_scale': 1}
    return result
