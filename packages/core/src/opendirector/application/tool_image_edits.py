"""Image edit recipes: reframing, cleanup, presets, and poster motion."""
import json
from dataclasses import dataclass

from PIL import Image

from opendirector.application.tool_context import Output, ToolContext, _source_image, _with, image_output
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
    if not ctx.edit_keeps_layout:
        await ctx.progress('正在扩展画面')
        width, height = image.width + pads[0] + pads[2], image.height + pads[1] + pads[3]
        return await ctx.reframe(image, width, height, _with(prompt, (
            f'镜头拉远，扩展画面：{_placement(pads, image.width, image.height)}。保持原图中的人物、物体、服饰、场景、色调与光线完全一致，'
            '延续原有的透视与风格，画面完整自然，不要边框、白边或拼接痕迹')))
    canvas, _ = media.extend_canvas(image, *pads)
    await ctx.progress('正在扩展画面')
    drawn = await ctx.edit(canvas, _with(prompt, '自然延展画面四周，与原图内容、风格、透视和光线保持一致，无边框无拼接痕迹'), 0.9)
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
    input_image, references = image, ()
    if mode != 'selection' and ctx.annotation:
        marked = media.open_image(ctx.annotation)
        if marked.size != image.size:
            raise ProjectError('标注图片尺寸必须与原图一致。', 422)
        if ctx.edit_max_images > 1:
            references = (media.rgb_png(marked),)
            instruction += '。第二张图是第一张图上的编辑标记，请根据标记理解位置与意图'
        else:
            input_image = marked
            instruction += '。图上的笔画、箭头与文字是编辑指示'
        instruction += '，完成修改后移除这些辅助标记'
    if mode != 'annotation' and ctx.mask:
        instruction += '。这是原图上的局部修改，请严格保持原图构图、镜头、主体位置、大小和姿势，使编辑结果与原图逐像素对齐'
    edited = await ctx.edit(input_image, instruction + '。保持未提及的内容不变', 0.78, references=references)
    if mode != 'annotation' and ctx.mask:
        # A selection is an exact editing boundary: pixels outside it stay original.
        edited = media.blend(image, edited, media.mask_from(ctx.mask, image.size))
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
    drawn = await ctx.edit(media.soften_region(image, mask), '移除涂抹区域中的物体与文字，用周围环境自然填补，画面干净完整', 0.8)
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

@dataclass(frozen=True)
class ImagePreset:
    title: str
    prompts: tuple[str, ...]
    size: tuple[int, int] = (2048, 1152)

PRESETS = {
    # Written as edit instructions: editing models follow imperatives, not captions.
    'three-view': ImagePreset('人物三视图', (
        '以参考图中的人物为唯一身份依据，生成同一人物的全身三视图设定板。'
        '横版画面分为三个等宽区域，从左至右严格排列：正面全身、右侧90度全身、背面全身。'
        '三个视图保持同一身份、年龄、体型、头身比、发型、服装、配色、材质及配饰，衣服结构与细节相互对应。'
        '全部自然站立、双臂放松，同一高度与地面基线，完整呈现头顶到鞋底，不裁头、不切脚、不遮挡、不重叠。'
        '若原图仅有半身，依据可见服装合理补全下半身，补全部分在三个视角保持一致。'
        '保持参考图画风，纯净浅灰背景、均匀柔光、弱透视，无剧情场景、文字、标签、水印、分割线或额外视图。',)),
    'face-three-view': ImagePreset('面部三视图', (
        '以参考图人物的面部为唯一身份依据，生成同一人物的面部三视图参考板。'
        '3:1超宽横版画面均分为三个等宽区域，从左至右严格排列：正面、左侧90度、右侧90度。'
        '第二格（左侧90度）鼻尖朝向画面右方，第三格（右侧90度）鼻尖朝向画面左方；'
        '两张侧脸朝向相反、左右镜像对称，不要输出两张朝向相同的侧脸。'
        '每个区域只放一个居中的头肩像，三个头像之间留有自然间隔，不接触、不重叠、不粘连。'
        '每个视图只呈现完整头部至肩颈，头顶、下巴、耳朵均完整，不出现背面或全身视图。'
        '保持同一身份、年龄、脸型、骨相、五官比例、肤色、发际线、发型及识别性细节，左右侧面符合真实结构。'
        '三个头部大小一致、眼睛基线对齐、中性表情、视线随朝向自然变化，面部不被头发遮挡。'
        '保持参考图画风、纯净浅灰背景、均匀柔光，无美颜改脸、夸张透视、文字、标签、水印或额外人物。',), (3456, 1152)),
    'product-three-view': ImagePreset('产品三视图', (
        '以参考图中的产品为唯一设计依据，生成同一产品的工业设计三视图参考板。'
        '横版画面分为三个等宽区域，从左至右严格排列：正视图、右侧90度侧视图、后视图。'
        '采用近正交投影、无广角畸变，同一比例尺、同一高度与底部基线，完整展示产品外轮廓，不裁切、不重叠。'
        '三个视图保持结构、尺寸关系、材质、颜色、表面纹理、接口、按钮、接缝及标识一致，细节在视角之间符合物理对应关系。'
        '不可见部位依据已知结构作合理且一致的补全，不增加功能件或改变产品设计。'
        '产品独立展示，纯白背景、均匀棚拍光，无人物、手、包装道具、剧情场景、说明文字、尺寸标注、水印或额外视图；保留原有品牌标识。',)),
    'storyboard': ImagePreset('连续分镜图', ('把镜头拉远成远景建立镜头，完整交代周围环境，主体在画面中较小',
                           '改为中景镜头，主体占画面一半高度，动作清晰',
                           '改为近景镜头，镜头推近到主体胸口以上，突出表情',
                            '改为特写镜头，只拍主体面部或关键细节，背景虚化')),
    'multi-camera': ImagePreset('多机位', ('把机位移到主体正前方，平视拍摄',
                               '把机位向左绕到主体左前方约45度，从左侧斜角拍摄，透视随之改变',
                               '把机位向右绕到主体右前方约45度，从右侧斜角拍摄，透视随之改变',
                                '把机位升高到主体上方，高角度俯拍')),
}

async def image_presets(ctx: ToolContext):
    image = _source_image(ctx)
    preset = PRESETS[ctx.choice('preset', PRESETS)]
    title, prompts = preset.title, preset.prompts
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
    drawn = await ctx.edit(placed, _with(ctx.text('prompt'), '商品自然融入场景，光影、透视和色调一致，保留商品外观和文字'), 0.42)
    region = Image.new('L', scene.size, 0)
    region.paste(255, (x, y, x + width, y + height))
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
