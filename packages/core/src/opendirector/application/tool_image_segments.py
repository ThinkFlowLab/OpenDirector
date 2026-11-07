"""Image segmentation recipes for cutout, layer split, and editor previews."""
from PIL import Image, ImageChops, ImageFilter

from opendirector.application.tool_context import ToolContext, _source_image, image_output
from opendirector.domain.projects import ProjectError
from opendirector.media import processing as media


async def cutout(ctx: ToolContext):
    image = _source_image(ctx)
    if ctx.mask:
        await ctx.progress('正在应用选区')
        alpha = media.mask_from(ctx.mask, image.size)
    elif ctx.segment_available:
        found = await select_image_objects(ctx, image, ctx.text('prompt'), ctx.boxes)
        alpha = Image.new('L', image.size, 0)
        for mask, _, _, _ in found:
            alpha = ImageChops.lighter(alpha, mask)
    else:
        await ctx.progress('正在识别并抠出主体')
        lifted = await ctx.cutout(image, ctx.text('prompt'))
        alpha = lifted.getchannel('A')
    if alpha.getextrema()[1] < 16:
        raise ProjectError('没有识别到可抠出的主体，请换一张图或涂抹主体所在区域后重试。', 422)
    # Keep the original pixels; the model contributes only the matte.
    result = image.copy()
    result.putalpha(ImageChops.multiply(alpha, image.getchannel('A')))
    return [image_output(result, '抠图')]

SMART_LAYERS = ('人物', '动物', '交通工具', '商品', '家具', '植物', '食物', '文字')

def _overlap(box, target):
    """Intersection over union of two (x0, y0, x1, y1) boxes."""
    width = max(0.0, min(box[2], target[2]) - max(box[0], target[0]))
    height = max(0.0, min(box[3], target[3]) - max(box[1], target[1]))
    inner = width * height
    union = (box[2] - box[0]) * (box[3] - box[1]) + (target[2] - target[0]) * (target[3] - target[1]) - inner
    return inner / union if union > 0 else 0.0

def _area(mask: Image.Image) -> int:
    return mask.histogram()[255]

def _distinct(found, size, limit=16, *, with_scores=False, preserve_order=False):
    """Highest-scoring instances first; one that mostly repeats a kept layer or is a speck is dropped."""
    kept = []
    for mask, score, label in (found if preserve_order else sorted(found, key=lambda item: -item[1])):
        mask = mask.point(lambda value: 255 if value >= 128 else 0)
        area = _area(mask)
        if area < size[0] * size[1] * 0.002:
            continue
        if any(_area(ImageChops.multiply(mask, other)) > 0.6 * min(area, other_area) for other, other_area, _, _ in kept):
            continue
        kept.append((mask, area, label, score))
        if len(kept) == limit:
            break
    return [(mask, score, label) if with_scores else (mask, label) for mask, _, label, score in kept]

async def select_image_objects(ctx: ToolContext, image: Image.Image, prompt='', boxes=()):
    """Reusable SAM instances for editor previews and automatic cutout.

    Exemplar boxes can match similar objects elsewhere, so only the best overlapping
    instance is selected for each user box. No point-prompt semantics are invented.
    """
    found = []
    if boxes:
        for index, item in enumerate(boxes, 1):
            target = (item['x'], item['y'], item['x'] + item['width'], item['y'] + item['height'])
            if target[0] < 0 or target[1] < 0 or target[2] > image.width or target[3] > image.height:
                raise ProjectError('选框必须位于原图内。', 422)
            await ctx.progress(f'正在识别框选对象（{index}/{len(boxes)}）')
            instances = await ctx.segment(image, boxes=(target,))
            best = max(instances, key=lambda item: _overlap(item[2], target), default=None)
            if best is not None and _overlap(best[2], target) >= 0.3:
                found.append((best[0], best[1], f'对象 {index}'))
    else:
        for concept, label in await ctx.concepts(prompt, SMART_LAYERS):
            await ctx.progress(f'正在识别「{label}」')
            found += [(mask, score, label) for mask, score, _ in await ctx.segment(image, concept)]
    return [(mask, score, label, mask.getbbox())
            for mask, score, label in _distinct(found, image.size, with_scores=True, preserve_order=bool(boxes))]

async def layer_decompose(ctx: ToolContext):
    image = _source_image(ctx)
    mode = ctx.choice('mode', ('smart', 'boxes', 'description'), 'smart')
    if mode == 'boxes' and not ctx.boxes:
        raise ProjectError('框选拆分需要提供原图中的矩形选区。', 422)
    text = ctx.text('prompt') if mode == 'description' else ''
    if mode == 'description' and not text:
        raise ProjectError('按描述拆分需要填写拆分描述。', 422)
    found = await select_image_objects(ctx, image, text, ctx.boxes if mode == 'boxes' else ())
    layers = [(mask, label) for mask, _, label, _ in found]
    if not layers:
        raise ProjectError('没有识别到可分离的对象，请换一种描述或框选对象后重试。', 422)
    holes = Image.new('L', image.size, 0)
    for mask, _ in layers:
        holes = ImageChops.lighter(holes, mask)
    await ctx.progress('正在补全背景')
    # Without an image editor the background keeps transparent holes where the layers were.
    grown = holes.filter(ImageFilter.MaxFilter(max(3, (min(image.size) // 100) | 1)))
    try:
        drawn = await ctx.edit(media.soften_region(image, grown), '移除画面中被涂抹区域的主体，用周围背景自然补全，画面干净完整', 0.85)
        background, title = media.blend(image, drawn, media.feather(grown, max(3, min(image.size) / 150))), '背景'
    except ProjectError:
        background, title = image.convert('RGBA'), '背景（未补全）'
        background.putalpha(ImageChops.multiply(ImageChops.invert(holes), background.getchannel('A')))
    outputs = [image_output(background, title)]
    alpha = image.convert('RGBA').getchannel('A')
    for index, (mask, label) in enumerate(layers, 1):
        # Layers keep the source canvas so stacking them over the background rebuilds the image.
        layer = image.convert('RGBA')
        layer.putalpha(ImageChops.multiply(mask, alpha))
        outputs.append(image_output(layer, f'图层 {index} · {label}'))
    return outputs
