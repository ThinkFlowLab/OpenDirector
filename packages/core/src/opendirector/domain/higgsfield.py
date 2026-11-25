"""MAGI-2 operations and limits published by Higgsfield Open."""
from .projects import ProjectError


BASE = 'https://api.higgsfield.ai'
MODEL = 'sand/magi-2'
PROFILE = 'higgsfield-magi-2'
RATIOS = ('21:9', '16:9', '4:3', '1:1', '3:4', '9:16')
IMAGE_BYTES = 30 * 1024 * 1024 - 1
VIDEO_BYTES = 200 * 1024 * 1024
AUDIO_BYTES = 15 * 1024 * 1024
IMAGE_TYPES = frozenset({'image/jpeg', 'image/png', 'image/webp', 'image/gif'})


def validate_model(config):
    if (config['kind'] != 'video' or config['modelId'] != MODEL
            or config['url'].rstrip('/') != BASE
            or config.get('connectionType', 'api') != 'api'
            or config.get('authMode', 'bearer') != 'bearer'):
        raise ProjectError('请选择 Higgsfield Open 的 MAGI-2 模型和官方 API 地址。', 422, code='higgsfield_model')


def magi2_capabilities():
    return {'outputs': [{'resolution': '1080P', 'durations': list(range(4, 31))}],
            'defaultResolution': '1080P', 'defaultDuration': 5, 'dimensionStep': 2}


def validate_outputs(capabilities):
    if any(item['resolution'] != '1080P'
           or any(second not in range(4, 31) for second in item['durations'])
           or item.get('width') is not None or item.get('height') is not None
           for item in capabilities['outputs']):
        raise ProjectError('MAGI-2 支持 1080p 和 4–30 秒整数时长，请调整输出参数。', 422, code='higgsfield_output')


def operation(mode, has_images):
    if mode == 'reference':
        return 'reference-to-video'
    if mode == 'first_frame':
        return 'image-to-video' if has_images else 'text-to-video'
    raise ProjectError('MAGI-2 支持首尾帧和参考素材模式。', 422, code='higgsfield_mode')


def parameters(config, intent, mode, has_images):
    validate_model(config)
    capabilities = config.get('videoCapabilities') or magi2_capabilities()
    validate_outputs(capabilities)
    resolution = intent.get('resolution', 'auto')
    if resolution == 'auto':
        resolution = capabilities['outputs'][0]['resolution']
    seconds = intent.get('durationSeconds')
    if seconds is None:
        seconds = capabilities['defaultDuration']
    if (isinstance(seconds, bool) or not isinstance(seconds, (int, float))
            or not any(item['resolution'] == resolution and seconds in item['durations']
                       for item in capabilities['outputs'])):
        raise ProjectError('MAGI-2 支持 1080p 和 4–30 秒整数时长，请调整输出参数。', 422, code='higgsfield_output')
    ratio = intent.get('aspectRatio') or '16:9'
    audio = intent.get('generateAudio', True)
    if ratio not in RATIOS or not isinstance(audio, bool):
        raise ProjectError('请选择 MAGI-2 支持的画幅比例和音频选项。', 422, code='higgsfield_parameters')
    return {'operation': operation(mode, has_images), 'duration': int(seconds), 'resolution': resolution,
            'ratio': ratio, 'generate_audio': audio}
