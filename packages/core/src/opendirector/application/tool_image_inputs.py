"""Image-tool source roles and the execution choice fixed at acceptance.

Source assets are recipe inputs: product replacement composes two sources into
one model image, while upscaling makes a separate request for each source.
The shared image-input policy owns the limits on those serialized requests.
"""
import math

from opendirector.domain.image_inputs import native_mask_applicable
from opendirector.domain.projects import ProjectError


def validate_image_sources(tool, sources):
    expected = 2 if tool == 'product-replacement' else None if tool == 'image-hd' else 1
    if expected is not None and len(sources) != expected:
        raise ProjectError(f'该工具需要 {expected} 张来源图片。', 422, code='tool_source_count')
    if any(source['kind'] != 'image' for source in sources):
        raise ProjectError('来源素材必须是图片。', 422, code='tool_source_type')


def local_image_resize(tool, parameters, source):
    """The same-aspect multi-size branch performs no model operation."""
    if tool != 'multi-size':
        return False
    width, height = source.get('width'), source.get('height')
    target_width, target_height = parameters.get('outputWidth', width), parameters.get('outputHeight', height)
    if not all(type(value) in (int, float) and math.isfinite(value) and value > 0
               for value in (width, height, target_width, target_height)):
        return False
    if not all(64 <= value <= 8192 for value in (target_width, target_height)):
        return False
    # The recipe validates numbers and converts them to integer pixel sizes.
    return abs(int(target_width) / int(target_height) - width / height) < .01


def image_execution(tool, parameters, source, *, has_mask, has_annotation, policy):
    """Only choose native masking when the entire requested geometry applies."""
    width, height = source.get('width'), source.get('height')
    result = {'mode': 'legacy', 'roles': ['image']}
    if not isinstance(width, int) or not isinstance(height, int) or min(width, height) <= 0:
        return result
    reference_count = 0
    candidate = False
    if tool == 'smart-edit':
        mode = parameters.get('editMode', 'combined')
        candidate = mode != 'annotation' and has_mask
        reference_count = int(mode != 'selection' and has_annotation)
        if reference_count:
            result['roles'] = ['image', 'annotation'] if policy['maxImages'] > 1 else ['annotation']
    elif tool == 'inpainting-remove':
        candidate = has_mask
    elif tool == 'product-replacement':
        candidate = True  # The recipe builds one image and a rectangle mask.
        edge = {'4K': 4096, '2K': 2048}.get(parameters.get('resolution'))
        if edge and max(width, height) < edge:
            candidate = False  # Do not generate a smaller image then upscale it.
    elif tool == 'outpaint':
        sides = [parameters.get(key, 0) for key in ('left', 'top', 'right', 'bottom')]
        if all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
               and 0 <= value <= 4 for value in sides) and any(sides):
            width, height = (width + round(sides[0] * width) + round(sides[2] * width),
                             height + round(sides[1] * height) + round(sides[3] * height))
            candidate = (parameters.get('outputWidth', width), parameters.get('outputHeight', height)) == (width, height)
    elif tool == 'multi-size':
        target_width, target_height = parameters.get('outputWidth', width), parameters.get('outputHeight', height)
        if all(type(value) in (int, float) and math.isfinite(value) and 64 <= value <= 8192
               for value in (target_width, target_height)):
            target_width, target_height = int(target_width), int(target_height)
            target, current = target_width / target_height, width / height
            if abs(target - current) >= .01:
                width, height = ((round(height * target), height) if target > current
                                 else (width, round(width / target)))
                candidate = (target_width, target_height) == (width, height)
    elif tool == 'panorama':
        original = (width, height)
        width = max(width, height * 2)
        height = width // 2
        edge = {'4K': 4096, '2K': 2048}.get(parameters.get('resolution'), 2048)
        candidate = (width, height) != original and (width, height) == (edge, edge // 2)
    elif tool == 'image-presets':
        from opendirector.application.tool_image_edits import PRESETS
        preset = PRESETS.get(parameters.get('preset'))
        if preset is not None:
            width, height = preset.size
    elif tool == 'image-hd' and max(width, height) > 1536:
        scale = 1536 / max(width, height)
        width, height = max(1, round(width * scale)), max(1, round(height * scale))
    result.update(width=width, height=height)
    if candidate and native_mask_applicable(policy, width, height, image_count=1, reference_count=reference_count):
        result.update(mode='native_mask', roles=['image', 'mask'] + (['reference'] if reference_count else []))
    return result


def image_request_parameters(tool, parameters, sources, plan, *, adapter, capability, policy):
    """Project each recipe request through its actual adapter, before acceptance.

    A batch upscale submits one image per source. Preset variants share one
    geometry. Product replacement submits the composed scene, not two images.
    """
    if local_image_resize(tool, parameters, sources[0]):
        return []
    strength = {'smart-edit': .78, 'inpainting-remove': .8, 'view-control': .8, 'lighting': .72,
                'product-replacement': .42, 'layer-decompose': .85}.get(tool)
    if tool == 'image-hd':
        detail = parameters.get('detailStrength', .5)
        if type(detail) in (int, float) and math.isfinite(detail):
            strength = .12 + .3 * detail
    if tool in {'outpaint', 'multi-size', 'panorama'} and (getattr(adapter, 'strength', False) or plan['mode'] == 'native_mask'):
        strength = .9
    plans = ([image_execution(tool, parameters, source, has_mask=False, has_annotation=False, policy=policy)
              for source in sources] if tool == 'image-hd' else [plan])
    result = []
    for request in plans:
        if 'width' not in request or 'height' not in request:
            continue
        result.append(adapter.image_parameters(request['width'], request['height'],
            has_images=capability != 'image.generate', native_mask=request['mode'] == 'native_mask', strength=strength,
            extra={'background': 'transparent'} if capability == 'image.cutout' else None))
    return result
