"""Shared image request limits; execution consumes the policy frozen at acceptance."""
from io import BytesIO
from math import isclose

from PIL import Image, UnidentifiedImageError

from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError


class ImageInputError(ProjectError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def image_input_policy(config):
    rules = input_rules(config)
    return {'version': 1, 'maxImages': rules['maxImages'], 'imageBytes': rules['imageBytes'],
            'requestBytes': rules['requestBytes'], 'nativeMask': None}


def native_mask_applicable(policy, width, height, image_count=1, reference_count=0):
    """Native selection never resizes the requested canvas to satisfy a model."""
    mask = policy.get('nativeMask') or {}
    required = ('widthMultiple', 'heightMultiple', 'minWidth', 'minHeight', 'minImages', 'maxImages', 'maxReferenceImages')
    if (mask.get('field') != 'mask_image' or mask.get('encoding') != 'grayscale_white_edit'
            or mask.get('sameSize') is not True or any(type(mask.get(key)) is not int for key in required)):
        return False
    if (type(width) is not int or type(height) is not int
            or mask['widthMultiple'] <= 0 or mask['heightMultiple'] <= 0):
        return False
    maximum = mask.get('maxPixels')
    for dimension, key in ((width, 'width'), (height, 'height')):
        allowed, step = mask.get(key + 'Values'), mask.get(key + 'Step')
        if allowed is not None and dimension not in allowed:
            return False
        if step is not None and (step <= 0 or not isclose(dimension / step, round(dimension / step), abs_tol=1e-8)):
            return False
    return (width >= mask['minWidth'] and height >= mask['minHeight']
            and (mask.get('maxWidth') is None or width <= mask['maxWidth'])
            and (mask.get('maxHeight') is None or height <= mask['maxHeight'])
            and width % mask['widthMultiple'] == 0 and height % mask['heightMultiple'] == 0
            and mask['minImages'] <= image_count <= mask['maxImages']
            and image_count <= policy.get('maxImages', 0)
            and mask.get('minReferenceImages', 0) <= reference_count <= mask['maxReferenceImages']
            and (not reference_count or mask.get('referenceField') == 'reference_image')
            and (maximum is None or (type(maximum) is int and width * height <= maximum)))


def validate_image_request(request, policy):
    """Validate actual wire roles, without slicing or modifying caller input."""
    images = ([request.image] if request.image is not None else []) + list(request.references)
    mask, reference = getattr(request, 'mask', None), getattr(request, 'reference', None)
    if len(images) > policy['maxImages']:
        raise ImageInputError('image_input_count', f"最多支持 {policy['maxImages']} 张图片，当前为 {len(images)} 张。")
    files = images + ([mask] if mask is not None else []) + ([reference] if reference is not None else [])
    if any(len(data) > policy['imageBytes'] for data in files):
        raise ImageInputError('image_input_bytes', '图片文件过大，请压缩后重试。')
    if sum(map(len, files)) > policy['requestBytes']:
        raise ImageInputError('image_input_bytes', '图片总大小超出限制，请减少图片或压缩后重试。')
    if reference is not None and mask is None:
        raise ImageInputError('image_input_mask', '标注参考图片需要配合选区使用。')
    if mask is None:
        return
    if not native_mask_applicable(policy, request.width, request.height, len(images), int(reference is not None)):
        raise ImageInputError('image_input_mask', '当前图片尺寸或数量不支持选区输入。')
    try:
        with Image.open(BytesIO(mask)) as selection, Image.open(BytesIO(images[0])) as source:
            if selection.mode != 'L' or selection.size != source.size or source.size != (request.width, request.height):
                raise ImageInputError('image_input_mask', '选区与图片的尺寸不一致。')
            if not selection.getbbox():
                raise ImageInputError('image_input_mask', '请先选择需要修改的区域。')
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ImageInputError('image_input_mask', '无法读取图片或选区，请重新选择。') from None
