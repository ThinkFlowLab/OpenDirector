"""Image edit recipes: reframing, cleanup, presets, and poster motion."""
import json

from PIL import Image

from opendirector.application.tool_context import Output, ToolContext, _source_image, _with, image_output
from opendirector.domain.image_presets import PRESETS, preset_instructions
from opendirector.domain.projects import ProjectError
from opendirector.media import processing as media


def _placement(pads, width, height) -> str:
    """Where the original sits in the extended frame, and which sides grow, in words."""
    left, top, right, bottom = pads
    total_width, total_height = width + left + right, height + top + bottom
    horizontal = '左侧' if not left and right else '右侧' if left and not right else ''
    vertical = '上方' if not top and bottom else '下方' if top and not bottom else ''
    where = f'{vertical}{horizontal}'.replace('上方左侧', '左上角').replace('上方右侧', '右上角') \
        .replace('下方左侧', '左下角').replace('下方右侧', '右下角') or '中央'
    sides = '、'.join(name for name, pad in (('左侧', left), ('上方', top), ('右侧', right), ('下方', bottom)) if pad)
    return (f'原画面约占新画面宽度的 {width / total_width:.0%}、高度的 {height / total_height:.0%}，位于新画面的{where}，'
            f'在{sides}新增与原场景连续的内容')

async def _extend(ctx: ToolContext, image: Image.Image, pads, prompt: str) -> Image.Image:
    """Outpainting: soft border, image-to-image, original pixels kept inside a feathered seam.

    Instruction editors ignore strength and recompose a padded canvas instead of
    filling it, so they are asked to pull the camera back over the original.
    """
    if not ctx.edit_keeps_layout and not ctx.native_mask:
        await ctx.progress('正在扩展画面')
        width, height = image.width + pads[0] + pads[2], image.height + pads[1] + pads[3]
        return await ctx.reframe(image, width, height, _with(prompt, (
            f'镜头拉远，扩展画面：{_placement(pads, image.width, image.height)}。保持原图中的人物、物体、服饰、场景、色调与光线完全一致，'
            '延续原有的透视与风格，画面完整自然，不要边框、白边或拼接痕迹')))
    canvas, region = media.extend_canvas(image, *pads)
    await ctx.progress('正在扩展画面')
    drawn = await ctx.edit(canvas, _with(prompt, '自然延展画面四周，与原图内容、风格、透视和光线保持一致，无边框无拼接痕迹'), 0.9,
                           mask=region)
    # The redraw shifts tone slightly; a wide ramp inside the original hides the seam.
    inset = max(8, min(image.size) // 8)
    left, top, right, bottom = pads
    keep = (left + (inset if left else 0), top + (inset if top else 0),
            left + image.width - (inset if right else 0), top + image.height - (inset if bottom else 0))
    seam = Image.new('L', canvas.size, 255)
    seam.paste(0, keep)
    return media.blend(canvas, drawn, media.feather(seam, inset / 2))

async def smart_edit(ctx: ToolContext):
    image = _source_image(ctx)
    mode = ctx.choice('editMode', ('annotation', 'selection', 'combined'), 'combined')
    if mode == 'selection' and not ctx.mask:
        raise ProjectError('请先涂抹或识别需要修改的区域。', 422)
    prompt = ctx.text('prompt')
    notes = []
    if mode != 'selection':
        try:
            document = json.loads(ctx.parameters.get('annotationDocument') or '{}')
            notes = [stroke.get('text', '').strip() for stroke in document.get('strokes', []) if stroke.get('tool') == 'text']
        except (ValueError, AttributeError):
            pass
    instruction = '；'.join(item for item in [prompt, *notes] if item)
    if not instruction:
        raise ProjectError('请描述要如何修改图片。', 422)
    await ctx.progress('正在按描述改图')
    input_image, references, reference = image, (), None
    if mode != 'selection' and ctx.annotation:
        marked = media.open_image(ctx.annotation)
        if marked.size != image.size:
            raise ProjectError('标注图片尺寸必须与原图一致。', 422)
        if ctx.native_mask:
            reference = media.rgb_png(marked)
            instruction += '。参考图是原图上的编辑标记，请根据标记理解位置与意图'
        elif ctx.edit_max_images > 1:
            references = (media.rgb_png(marked),)
            instruction += '。第二张图是第一张图上的编辑标记，请根据标记理解位置与意图'
        else:
            input_image = marked
            instruction += '。图上的笔画、箭头与文字是编辑指示'
        instruction += '，完成修改后移除这些辅助标记'
    if mode != 'annotation' and ctx.mask:
        instruction += '。这是原图上的局部修改，请严格保持原图构图、镜头、主体位置、大小和姿势，使编辑结果与原图逐像素对齐'
    region = media.mask_from(ctx.mask, image.size) if mode != 'annotation' and ctx.mask else None
    edited = await ctx.edit(input_image, instruction + '。保持未提及的内容不变', 0.78,
                            references=references, mask=region, reference=reference)
    if mode != 'annotation' and ctx.mask:
        # A selection is an exact editing boundary: pixels outside it stay original.
        edited = media.blend(image, edited, region)
    return [image_output(edited, '智能改图')]

async def outpaint(ctx: ToolContext):
    image = _source_image(ctx)
    sides = [ctx.number(key, 0, 0, 4) for key in ('left', 'top', 'right', 'bottom')]
    if not any(sides):
        raise ProjectError('请至少向一个方向扩展。', 422)
    pads = [round(sides[0] * image.width), round(sides[1] * image.height), round(sides[2] * image.width), round(sides[3] * image.height)]
    result = await _extend(ctx, image, pads, ctx.text('prompt'))
    width, height = ctx.parameters.get('outputWidth'), ctx.parameters.get('outputHeight')
    if isinstance(width, (int, float)) and isinstance(height, (int, float)) and width > 0 and height > 0:
        result = media.resize(result, int(width), int(height))
    return [image_output(result, '扩图')]

HD_EDGES = {'2K': 2048, '4K': 4096, '8K': 8192}

async def image_hd(ctx: ToolContext):
    outputs = []
    edge = HD_EDGES[ctx.choice('resolution', HD_EDGES, '4K')]
    pro = ctx.choice('kind', ('normal', 'pro'), 'normal') == 'pro'
    for index, source in enumerate(ctx.sources):
        image = media.open_image(source.data)
        if pro:
            await ctx.progress(f'正在增强细节（{index + 1}/{len(ctx.sources)}）')
            detail = ctx.number('detailStrength', 0.5, 0.01, 1)
            base = media.scale_to_long_edge(image, 1536) if max(image.size) > 1536 else image
            image = await ctx.edit(base, '高清摄影，细节丰富，纹理锐利清晰，保持构图、主体和颜色完全不变', 0.12 + 0.3 * detail)
        await ctx.progress(f'正在放大到 {edge}px')
        outputs.append(image_output(media.scale_to_long_edge(image, edge), f'超清 {ctx.parameters.get("resolution", "4K")}'))
    return outputs

async def inpainting_remove(ctx: ToolContext):
    image = _source_image(ctx)
    if not ctx.mask:
        raise ProjectError('请先涂抹需要消除的区域。', 422)
    mask = media.mask_from(ctx.mask, image.size)
    await ctx.progress('正在消除并填补')
    drawn = await ctx.edit(image if ctx.native_mask else media.soften_region(image, mask),
                           '移除涂抹区域中的物体与文字，用周围环境自然填补，画面干净完整', 0.8, mask=mask)
    return [image_output(media.blend(image, drawn, media.feather(mask, max(3, min(image.size) / 120))), '消除笔')]

def _yaw_text(yaw):
    names = ['正面', '右前方', '右侧面', '右后方', '背面', '左后方', '左侧面', '左前方']
    return names[round((yaw % 360) / 45) % 8]

async def view_control(ctx: ToolContext):
    image = _source_image(ctx)
    yaw = ctx.number('yaw', 0, -360, 360)
    pitch = ctx.number('pitch', 0, -90, 90)
    distance = ctx.parameters.get('distancePreset') or ctx.parameters.get('distance') or 'standard'
    shot = {'near': '近景特写', 'standard': '中景', 'far': '远景全身'}.get(distance, '中景')
    angle = '俯视' if pitch > 20 else '仰视' if pitch < -10 else '平视'
    await ctx.progress('正在生成新视角')
    edited = await ctx.edit(image, _with(ctx.text('prompt'), f'同一主体从{_yaw_text(yaw)}{angle}角度拍摄的{shot}，'
                                         '保持主体外观、服装、颜色和场景风格完全一致'), 0.8)
    return [image_output(edited, f'多角度 · {_yaw_text(yaw)}')]

async def lighting(ctx: ToolContext):
    image = _source_image(ctx)
    yaw = ctx.number('yaw', 0, -360, 360)
    pitch = ctx.number('pitch', 30, -90, 90)
    # The lighting editor sends brightnessPercent; the catalog field is brightness.
    brightness = ctx.number('brightnessPercent' if 'brightnessPercent' in ctx.parameters else 'brightness', 60, 0, 100)
    texture = '柔和漫射' if ctx.parameters.get('texture', 'soft') == 'soft' else '硬朗强烈'
    color = ctx.text('lightColor', '#ffffff') or '#ffffff'
    height = '顶光' if pitch > 50 else '高位' if pitch > 15 else '底光' if pitch < -15 else '平射'
    level = '明亮' if brightness > 66 else '中等亮度' if brightness > 33 else '昏暗低调'
    await ctx.progress('正在重新布光')
    edited = await ctx.edit(image, _with(ctx.text('prompt'), f'重新布光：主光来自{_yaw_text(yaw)}{height}，{texture}的光质，'
                                         f'光色 {color}，整体{level}，阴影和高光随光源变化，保持主体和构图不变'), 0.72)
    return [image_output(edited, '智能打光')]

async def panorama(ctx: ToolContext):
    image = _source_image(ctx)
    width = max(image.width, image.height * 2)
    height = width // 2
    pads = ((width - image.width) // 2, (height - image.height) // 2)
    pads = (pads[0], pads[1], width - image.width - pads[0], height - image.height - pads[1])
    result = await _extend(ctx, image, pads, _with(ctx.text('prompt'), '360度等距柱状投影全景图，左右边缘可无缝衔接'))
    edge = {'4K': 4096, '2K': 2048}.get(ctx.parameters.get('resolution'), 2048)
    return [image_output(media.resize(result, edge, edge // 2), '720 全景')]

async def image_presets(ctx: ToolContext):
    image = _source_image(ctx)
    key = ctx.choice('preset', PRESETS)
    preset = PRESETS[key]
    title = preset.title
    prompts = preset_instructions(key, ctx.parameters.get('faceEmphasis') is True)
    outputs = []
    for index, instruction in enumerate(prompts, 1):
        await ctx.progress(f'正在生成{title}（{index}/{len(prompts)}）')
        edited = await ctx.reframe(image, *preset.size, instruction + '，保持主体外观与风格一致')
        outputs.append(image_output(edited, f'{title} {index}' if len(prompts) > 1 else title))
    return outputs

async def multi_size(ctx: ToolContext):
    image = _source_image(ctx)
    width = int(ctx.number('outputWidth', image.width, 64, 8192))
    height = int(ctx.number('outputHeight', image.height, 64, 8192))
    target, current = width / height, image.width / image.height
    if abs(target - current) < 0.01:
        return [image_output(media.resize(image, width, height), f'{width}×{height}')]
    if target > current:
        extra = round(image.height * target) - image.width
        pads = (extra // 2, 0, extra - extra // 2, 0)
    else:
        extra = round(image.width / target) - image.height
        pads = (0, extra // 2, 0, extra - extra // 2)
    result = await _extend(ctx, image, pads, ctx.text('prompt'))
    return [image_output(media.resize(result, width, height), f'{width}×{height}')]

async def product_replacement(ctx: ToolContext):
    scene, product = _source_image(ctx, 0), _source_image(ctx, 1)
    if not ctx.boxes:
        raise ProjectError('请先框选商品区域。', 422)
    box = ctx.boxes[0]
    x, y, width, height = (int(round(box[key])) for key in ('x', 'y', 'width', 'height'))
    if width < 8 or height < 8 or x < 0 or y < 0 or x + width > scene.width or y + height > scene.height:
        raise ProjectError('商品区域超出原图或尺寸不正确。', 422)
    layer = media.cover_box(product, (x, y, width, height))
    placed = scene.copy()
    placed.paste(layer, (x, y), layer)
    await ctx.progress('正在融合商品与场景')
    region = Image.new('L', scene.size, 0)
    region.paste(255, (x, y, x + width, y + height))
    drawn = await ctx.edit(placed, _with(ctx.text('prompt'), '商品自然融入场景，光影、透视和色调一致，保留商品外观和文字'), 0.42,
                           mask=region)
    result = media.blend(scene, drawn, media.feather(region, max(4, min(width, height) / 12)))
    edge = {'4K': 4096, '2K': 2048}.get(ctx.parameters.get('resolution'))
    if edge and max(result.size) < edge:
        result = media.scale_to_long_edge(result, edge)
    return [image_output(result, '商品替换')]

async def dynamic_poster(ctx: ToolContext):
    image = _source_image(ctx)
    await ctx.progress('正在生成动态海报')
    prompt = await ctx.video_prompt(ctx.text('prompt'), 'The poster comes gently alive with subtle natural motion; the subject and its text stay stable.')
    data = await ctx.video_from_frame(image, prompt, 5)
    return [Output('video', data, 'mp4', '动态海报')]
