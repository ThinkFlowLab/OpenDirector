"""CogVideoX-3's documented sizes and fixed generation settings."""
from opendirector.domain.projects import ProjectError

COGVIDEO_MODEL = 'cogvideox-3'
COGVIDEO_SIZES = ('1280x720', '720x1280', '1024x1024', '1920x1080', '1080x1920', '2048x1080', '3840x2160')


def cogvideo_capabilities(model_id=COGVIDEO_MODEL):
    if model_id != COGVIDEO_MODEL:
        raise ProjectError('智谱视频协议仅支持 CogVideoX-3。', 422, code='bigmodel_video_model')
    return {'outputs': [{'resolution': size.upper(), 'durations': [5, 10]} for size in COGVIDEO_SIZES],
            'defaultResolution': '1920X1080', 'defaultDuration': 5, 'dimensionStep': 2}


def validate_cogvideo_outputs(capabilities):
    if any(item['resolution'].lower() not in COGVIDEO_SIZES or any(second not in (5, 10) for second in item['durations'])
           or item.get('width') is not None or item.get('height') is not None for item in capabilities['outputs']):
        raise ProjectError('请选择 CogVideoX-3 支持的像素尺寸和 5 或 10 秒时长。', 422, code='bigmodel_video_output')


def cogvideo_parameters(config, intent):
    native = cogvideo_capabilities(config['modelId'])
    caps = config.get('videoCapabilities') or native
    validate_cogvideo_outputs(caps)
    resolution = intent.get('resolution', 'auto')
    seconds = intent.get('durationSeconds')
    seconds = caps['defaultDuration'] if seconds is None else seconds
    if resolution in (None, 'auto'):
        eligible = [item['resolution'] for item in caps['outputs'] if seconds in item['durations']]
        resolution = caps['defaultResolution'] if caps['defaultResolution'] in eligible else next(iter(eligible), None)
    if (isinstance(seconds, bool) or seconds not in (5, 10) or not any(
            item['resolution'] == resolution and seconds in item['durations'] for item in caps['outputs'])
            or intent.get('aspectRatio') not in (None, 'adaptive') or intent.get('videoMode', 'first_frame') != 'first_frame'):
        raise ProjectError('请选择 CogVideoX-3 支持的像素尺寸和 5 或 10 秒时长；画幅由所选尺寸确定。',
                           422, code='bigmodel_video_output')
    return dict(size=resolution.lower(), resolution=resolution, duration=int(seconds), quality='speed', fps=30,
                generate_audio=intent.get('generateAudio', True))
