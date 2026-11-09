"""Kling 4.0 native video capabilities and creative operation selection."""
from typing import Literal

from opendirector.domain.projects import ProjectError

KlingOperation = Literal['text', 'frames', 'reference']
KLING_MODELS = {
    'kling-4.0': {'resolutions': ('720P', '1080P'), 'maxDuration': 30, 'frameRoles': ('first_frame', 'last_frame')},
    'kling-4.0-flash': {'resolutions': ('720P',), 'maxDuration': 20, 'frameRoles': ('first_frame',)},
}
KLING_RATIOS = ('21:9', '16:9', '9:16', '1:1')
KLING_PATHS = {'text': 'text-to-video', 'frames': 'image-to-video', 'reference': 'omni-video'}


def kling_capabilities(model_id):
    if model_id not in KLING_MODELS:
        raise ProjectError('当前可灵协议不支持所选型号。', 422, code='kling_model')
    model = KLING_MODELS[model_id]
    return {'outputs': [{'resolution': label, 'durations': list(range(3, model['maxDuration'] + 1))} for label in model['resolutions']],
            'defaultResolution': model['resolutions'][-1], 'defaultDuration': 5, 'dimensionStep': 2}


def kling_operation(mode, has_images) -> KlingOperation:
    if mode not in {'first_frame', 'reference'}:
        raise ProjectError('可灵当前支持首尾帧和图片参考模式。', 422, code='kling_mode')
    return ('frames' if mode == 'first_frame' else 'reference') if has_images else 'text'


def validate_kling_prompt(prompt):
    english = sum(ord(char) < 128 for char in prompt)
    other = len(prompt) - english
    if not prompt.strip() or english * 11000 + other * 26000 > 26000 * 11000:
        raise ProjectError('可灵提示词不能为空，英文最多 26000 字符，非英文最多 11000 字符；混合文本按比例合计。',
                           422, code='kling_prompt')


def kling_parameters(config, intent, has_images):
    capabilities = config.get('videoCapabilities') or kling_capabilities(config['modelId'])
    operation = kling_operation(intent.get('videoMode', 'first_frame'), has_images)
    ratio = intent.get('aspectRatio') or 'adaptive'
    if operation == 'frames' and ratio != 'adaptive':
        raise ProjectError('可灵首尾帧生成沿用图片画幅，请将比例设为自动。', 422, code='kling_aspect')
    if ratio != 'adaptive' and ratio not in KLING_RATIOS:
        raise ProjectError('可灵不支持所选画幅比例。', 422, code='kling_aspect')
    seconds = intent.get('durationSeconds') or capabilities['defaultDuration']
    resolution = intent.get('resolution')
    if resolution in {None, 'auto'}:
        eligible = [output['resolution'] for output in capabilities['outputs'] if seconds in output['durations']]
        preferred = capabilities['defaultResolution']
        resolution = preferred if preferred in eligible else '1080P' if '1080P' in eligible else next(iter(eligible), None)
    if isinstance(seconds, bool) or seconds != int(seconds) or not any(
            output['resolution'] == resolution and seconds in output['durations'] for output in capabilities['outputs']):
        raise ProjectError('可灵输出规格无效，请选择所选型号支持的分辨率和整数时长。', 422, code='kling_output')
    return {'duration': int(seconds), 'resolution': resolution, 'ratio': '16:9' if operation == 'text' and ratio == 'adaptive' else ratio,
            'generate_audio': True, 'audio': 'native', 'operation': operation, 'route': f"/{KLING_PATHS[operation]}/{config['modelId']}"}
