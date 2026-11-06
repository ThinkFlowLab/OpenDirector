"""Verified limits for the MOSS Open Platform image service."""
from urllib.parse import urlsplit

from .projects import ProjectError


MOSS_IMAGE_MODELS = frozenset({
    'moss-image-sft-1.0',
    'moss-image-base-1.0',
})

MOSS_IMAGE_PROMPT_CHARACTERS = 4000


def is_moss_image(config):
    url = urlsplit(config.get('url', ''))
    return (config.get('kind') == 'image' and config.get('protocol') == 'openai'
            and url.scheme == 'https' and url.hostname == 'api.mosi.cn' and url.port in {None, 443}
            and url.path.rstrip('/') == '/v1' and config.get('modelId') in MOSS_IMAGE_MODELS)


def validate_moss_image_prompt(prompt):
    if not prompt.strip() or len(prompt) > MOSS_IMAGE_PROMPT_CHARACTERS:
        raise ProjectError('MOSS 提示词及文本参考须为非空文本，合计最多 4000 个字符。', 422, code='moss_prompt_limit')


def validate_moss_image_size(width, height):
    if (type(width) is not int or type(height) is not int
            or not 256 <= width <= 2048 or not 256 <= height <= 2048 or width % 16 or height % 16
            or width * height > 2097152):
        raise ProjectError('MOSS 图片边长须为 256–2048、为 16 的倍数，且总像素不超过 2097152。', 422, code='moss_image_size')
