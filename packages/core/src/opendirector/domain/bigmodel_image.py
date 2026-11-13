"""BigModel GLM-Image identity and documented text-to-image outputs."""
from urllib.parse import urlsplit

from .projects import ProjectError


BIGMODEL_IMAGE_OUTPUTS = (
    ('1:1', '1280x1280'), ('3:2', '1568x1056'), ('2:3', '1056x1568'),
    ('4:3', '1472x1088'), ('3:4', '1088x1472'), ('16:9', '1728x960'), ('9:16', '960x1728'),
)


def is_bigmodel_image(config):
    url = urlsplit(config.get('url', ''))
    return (config.get('kind') == 'image' and config.get('protocol') == 'openai'
            and url.scheme == 'https' and url.hostname == 'open.bigmodel.cn'
            and url.port in {None, 443} and url.path.rstrip('/') == '/api/paas/v4'
            and config.get('modelId') == 'glm-image')


def validate_bigmodel_image(prompt, width, height, *, has_images=False):
    if has_images:
        raise ProjectError('GLM-Image 仅支持文生图，请移除参考图片或图片编辑输入。', 422,
                           code='bigmodel_image_reference')
    if not prompt.strip():
        raise ProjectError('请填写 GLM-Image 提示词。', 422, code='bigmodel_image_prompt')
    integers = type(width) is int and type(height) is int
    recommended = integers and f'{width}x{height}' in {size for _, size in BIGMODEL_IMAGE_OUTPUTS}
    custom = (integers and 1024 <= width <= 2048 and 1024 <= height <= 2048
              and width % 32 == height % 32 == 0 and width * height <= 2 ** 22)
    if not (recommended or custom):
        raise ProjectError('GLM-Image 需要预设尺寸，或边长为 1024–2048 且为 32 的倍数的尺寸。', 422,
                           code='bigmodel_image_size')
