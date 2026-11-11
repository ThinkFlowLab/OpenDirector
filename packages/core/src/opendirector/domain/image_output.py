"""Output choices implemented by the existing image protocol adapters.

Sizes are wire dimensions, not a promise about an arbitrary remote model.
Unknown compatible services retain the adapter's fixed-size choices.
"""
from .projects import ProjectError
from .video_output import RATIOS
from .bigmodel_image import BIGMODEL_IMAGE_OUTPUTS


def image_outputs(config, profile):
    if profile == 'bigmodel-glm-image':
        return [dict(aspectRatio=ratio, size=size) for ratio, size in BIGMODEL_IMAGE_OUTPUTS]
    if profile == 'minimax-h3-image':
        return [dict(aspectRatio=ratio, size=size) for ratio, size in [
            ('1:1', '2048x2048'), ('4:3', '2368x1760'), ('3:4', '1760x2368'),
            ('16:9', '2720x1536'), ('9:16', '1536x2720'), ('3:2', '2496x1664'),
            ('2:3', '1664x2496'), ('21:9', '3136x1344'), ('9:21', '1344x3136'),
        ]]
    if config.get('protocol') == 'volcengine':
        # This adapter only declares the existing automatic 2K request. Do not
        # promise a ratio without an explicit output contract for that service.
        return [dict(aspectRatio='auto', size='2K')]
    if profile in {'vllm-omni-image', 'vllm-omni-qwen-image'}:
        outputs = []
        for ratio in RATIOS:
            w, h = map(int, ratio.split(':'))
            width, height = (768 * w / h, 768) if w >= h else (768, 768 * h / w)
            if ratio in {'16:9', '9:16'}:
                width, height = (1344, 768) if w > h else (768, 1344)
            scale = min(1, 1536 / max(width, height))
            width, height = (max(256, round(value * scale / 16) * 16) for value in (width, height))
            outputs.append(dict(aspectRatio=ratio, size=f'{width}x{height}'))
        return outputs
    # The documented gpt-image wire sizes; every other ratio is resampled locally.
    return [dict(aspectRatio=ratio, size=size) for ratio, size in
            [('1:1', '1024x1024'), ('3:2', '1536x1024'), ('2:3', '1024x1536')]]


def resolve_image_output(config, rules, parameters):
    outputs = rules['imageOutputs']
    ratio, size = parameters.get('aspectRatio'), parameters.get('size', 'auto')
    if ratio is None and size in {'auto', '2K'}:
        ratio = '16:9' if rules['profile'] in {'vllm-omni-image', 'vllm-omni-qwen-image'} else outputs[0]['aspectRatio']
    choices = [item for item in outputs if ratio is None or item['aspectRatio'] == ratio]
    match = next((item for item in choices if size == 'auto' or item['size'] == size), None)
    if not match:
        raise ProjectError('当前图片适配器不支持所选比例或尺寸，请重新选择。', 422)
    return match['size']
