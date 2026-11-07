"""Canvas AI tools as recipes over model capabilities and local media steps.

A recipe names the capabilities it needs and receives a ToolContext that serves
them through whichever configured model offers them. Recipes never see a model
name, protocol or endpoint, so swapping or adding models does not touch them.
"""

import io
import json
import math
import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from PIL import Image, ImageChops, ImageFilter

from opendirector.domain.capabilities import (ChatRequest, CutoutRequest, DepthRequest, EditMask, ImageRequest, SegmentRequest, TrackRequest,
                                          Tracks, VideoEditRequest, VideoRequest)
from opendirector.domain.projects import ProjectError
from opendirector.media import processing as media
from opendirector.media.async_work import blocking


@dataclass(frozen=True)
class Source:
    kind: str
    data: bytes
    name: str


@dataclass(frozen=True)
class Output:
    kind: str
    data: bytes
    suffix: str
    title: str


class ToolContext:
    """What a recipe may use: inputs, model capabilities and progress reporting."""

    def __init__(self, *, sources, mask, boxes, parameters, image_model, video_model, progress, video_submitted=None, cutout_model=None,
                 edit_model=None, edit_seconds=(4.0, 15.0), chat_model=None, segment_model=None, track_model=None,
                 edit_keeps_layout=True, annotation=None, edit_max_images=1, segment_available=False, depth_model=None):
        self.sources: list[Source] = sources
        self.mask: bytes | None = mask
        self.annotation: bytes | None = annotation
        self.edit_max_images = edit_max_images
        self.segment_available = segment_available
        self.boxes: list[dict] = boxes
        self.parameters: dict = parameters
        self._image, self._video, self._cutout, self._edit = image_model, video_model, cutout_model, edit_model
        self._segment, self._track, self._depth = segment_model, track_model, depth_model
        # img2img models redraw in place by strength; instruction editors recompose the picture.
        self.edit_keeps_layout = edit_keeps_layout
        # Shortest and longest clip one redraw accepts; longer sources are processed piecewise.
        self.edit_seconds = edit_seconds
        # Optional: a chat model only improves prompts; tools never require it.
        self._chat = chat_model
        self._progress, self._video_submitted = progress, video_submitted

    def text(self, key, default=''):
        value = self.parameters.get(key, default)
        return value.strip() if isinstance(value, str) else default

    def number(self, key, default, low=None, high=None):
        value = self.parameters.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ProjectError(f'参数 {key} 无效。', 422)
        if (low is not None and value < low) or (high is not None and value > high):
            raise ProjectError(f'参数 {key} 超出范围。', 422)
        return value

    def choice(self, key, options, default=None):
        value = self.parameters.get(key, default)
        if value not in options:
            raise ProjectError(f'参数 {key} 不在可选范围内。', 422)
        return value

    async def progress(self, message):
        await self._progress(message)

    async def edit(self, image: Image.Image, prompt: str, strength: float, *, references=()) -> Image.Image:
        """Image-to-image at the source's aspect; the result is resampled back to the source size."""
        result = await self._image(ImageRequest(prompt=prompt, width=image.width, height=image.height,
                                                image=media.rgb_png(image), strength=strength, references=tuple(references)))
        return media.resize(media.open_image(result.data), image.width, image.height)

    async def reframe(self, image: Image.Image, width: int, height: int, prompt: str) -> Image.Image:
        """An instruction edit of image rendered on a width x height frame."""
        result = await self._image(ImageRequest(prompt=prompt, width=width, height=height, image=media.rgb_png(image)))
        return media.resize(media.open_image(result.data), width, height)

    async def cutout(self, image: Image.Image, subject: str = '') -> Image.Image:
        """The subject on transparency, at the source size."""
        result = await self._cutout(CutoutRequest(image=media.rgb_png(image), width=image.width, height=image.height, subject=subject))
        return media.resize(media.open_image(result.data), image.width, image.height)

    async def segment(self, image: Image.Image, concept: str = '', boxes=()) -> list[tuple[Image.Image, float, tuple]]:
        """Instances of an English concept or of exemplar boxes: (mask at the image size, score, box)."""
        segments = await self._segment(SegmentRequest(image=media.rgb_png(image), concept=concept, boxes=tuple(boxes)))
        return [(media.resize(media.open_image(item.mask).convert('L'), image.width, image.height), item.score, item.box)
                for item in segments]

    async def track(self, clip: bytes, concepts: tuple[str, ...]) -> Tracks:
        return await self._track(TrackRequest(video=clip, concepts=concepts))

    async def depth(self, clip: bytes) -> bytes:
        """A grayscale depth video of clip at its size and rate; near is bright."""
        return (await self._depth(DepthRequest(video=clip))).data

    async def concepts(self, text: str, default: tuple[str, ...]) -> list[tuple[str, str]]:
        """(English concept, label) pairs from a comma-separated description; segmentation models read English."""
        parts = list(dict.fromkeys(item.strip() for item in re.split(r'[,，、;；\n]+', text) if item.strip()))
        if not parts:
            return [(CONCEPTS.get(item, item), item) for item in default]
        pairs = []
        for part in parts[:16]:
            english = CONCEPTS.get(part) or (part if part.isascii() else None)
            if english is None and self._chat is not None:
                try:
                    english = (await self._chat(ChatRequest(messages=(
                        {'role': 'system', 'content': 'Name the visual object the user describes as a short English noun phrase, '
                                                      'such as "red car" or "person". Output only the phrase.'},
                        {'role': 'user', 'content': part + ' /no_think'}), max_tokens=40))).strip().strip('."\'').lower()
                except ProjectError:
                    english = None
            if not english or not english.isascii():
                raise ProjectError(f'无法识别「{part}」，请改用英文描述，或在“模型接入”中添加对话模型以自动翻译。', 422)
            pairs.append((english, part))
        return pairs

    async def english(self, text: str) -> str:
        """Video models render non-English prompt text as burnt-in subtitles; translate when a chat model is connected."""
        if not text or text.isascii() or self._chat is None:
            return text
        try:
            translated = await self._chat(ChatRequest(messages=(
                {'role': 'system', 'content': 'Translate the user text into concise English for a video generation prompt. '
                                              'Output only the translation.'},
                {'role': 'user', 'content': text + ' /no_think'}), max_tokens=400))
        except ProjectError:
            return text
        return translated.strip() or text

    async def video_prompt(self, user: str, instruction: str) -> str:
        user = await self.english(user)
        return f'{user}. {instruction}' if user else instruction

    async def redraw(self, clip: bytes, seconds: float, width: int, height: int, prompt: str, picture=None, sound=None) -> bytes:
        result = await self._edit(VideoEditRequest(prompt=f'{prompt} {CLEAN_PICTURE}', source=clip, seconds=seconds, width=width,
                                                   height=height, picture=picture, sound=sound, avoid=NO_TEXT), self._video_submitted)
        return result.data

    async def video_from_frame(self, frame: Image.Image, prompt: str, seconds: float) -> bytes:
        ratio = frame.width / frame.height
        aspect = min(('16:9', '9:16', '1:1', '4:3', '3:4'), key=lambda item: abs(eval_ratio(item) - ratio))
        frame = media.scale_to_long_edge(frame, 1280) if max(frame.size) > 1280 else frame
        result = await self._video(VideoRequest(prompt=f'{prompt} {CLEAN_PICTURE}', seconds=seconds, aspect_ratio=aspect,
                                                first_frame=media.rgb_png(frame), avoid=NO_TEXT),
                                   self._video_submitted)
        return result.data


# Common subjects map to SAM 3 concepts without a chat model; other words are translated.
CONCEPTS = {
    '人': 'person', '人物': 'person', '人像': 'person', '人群': 'person', '主体': 'person', '男人': 'man', '女人': 'woman',
    '小孩': 'child', '孩子': 'child', '儿童': 'child', '脸': 'face', '手': 'hand', '头发': 'hair',
    '动物': 'animal', '猫': 'cat', '猫咪': 'cat', '小猫': 'cat', '狗': 'dog', '鸟': 'bird', '马': 'horse', '鱼': 'fish',
    '车': 'car', '汽车': 'car', '车辆': 'vehicle', '交通工具': 'vehicle', '自行车': 'bicycle', '摩托车': 'motorcycle',
    '船': 'boat', '飞机': 'airplane', '树': 'tree', '花': 'flower', '植物': 'plant', '建筑': 'building', '房子': 'house',
    '天空': 'sky', '桌子': 'table', '椅子': 'chair', '沙发': 'sofa', '家具': 'furniture', '杯子': 'cup', '瓶子': 'bottle',
    '包': 'bag', '鞋': 'shoe', '衣服': 'clothing', '帽子': 'hat', '手机': 'phone', '电脑': 'computer', '食物': 'food',
    '商品': 'product', '产品': 'product', '文字': 'text', '标志': 'logo',
}


# Naming text in a positive prompt invites it; the negative prompt carries the exclusion.
CLEAN_PICTURE = 'Clean picture.'
NO_TEXT = 'subtitles, captions, on-screen text, letters, words, watermark, logo'


def eval_ratio(text):
    width, height = text.split(':')
    return int(width) / int(height)


def image_output(image: Image.Image, title: str) -> Output:
    data = media.png(image)
    if len(data) > 48 * 1024 * 1024:
        # Very large renders are stored as high-quality JPEG to stay under the asset limit.
        buffer = io.BytesIO()
        image.convert('RGB').save(buffer, 'JPEG', quality=94)
        return Output('image', buffer.getvalue(), 'jpg', title)
    return Output('image', data, 'png', title)


def _source_image(ctx: ToolContext, index=0) -> Image.Image:
    if len(ctx.sources) <= index or ctx.sources[index].kind != 'image':
        raise ProjectError('请提供图片素材。', 422)
    return media.open_image(ctx.sources[index].data)


def _with(prompt: str, instruction: str) -> str:
    return f'{prompt}。{instruction}' if prompt else instruction


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


# Image recipes ---------------------------------------------------------------

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


# Video recipes ---------------------------------------------------------------

def _source_video(ctx: ToolContext) -> Source:
    if not ctx.sources or ctx.sources[0].kind != 'video':
        raise ProjectError('请提供视频素材。', 422)
    return ctx.sources[0]


async def _redraw_pieces(ctx: ToolContext, source: Source, prompt: str, picture, sound, *, window=None):
    """Redraw a clip within the model's per-request length: the whole clip in even pieces, or only
    the stretch around `window` (seconds), spliced back. Output keeps the source size and rate."""
    low, high = ctx.edit_seconds
    with media.Workspace() as work:
        path = work.write('source.mp4', source.data)
        info = await blocking(media.video_info, path)
        duration = info['duration']
        if duration < low:
            raise ProjectError(f'视频至少需要 {low:g} 秒。', 422)
        if window:
            start, end = window
            if end - start > high:
                raise ProjectError(f'一次最多重绘 {high:g} 秒，请缩短区间。', 422)
            length = min(duration, max(low, min(high, end - start + 2)))
            first = min(max(0.0, (start + end - length) / 2), duration - length)
            pieces = [(first, first + length)]
        else:
            count = math.ceil(duration / high)
            pieces = [(duration * index / count, duration * (index + 1) / count) for index in range(count)]
        done = []
        for index, (first, last) in enumerate(pieces):
            await ctx.progress(f'正在重绘（{index + 1}/{len(pieces)}）' if len(pieces) > 1 else '正在重绘')
            clip = await blocking(media.conform, path, work.path / f'in-{index}.mp4', width=info['width'], height=info['height'],
                                           fps=info['fps'], start=first, end=last)
            local = (lambda mask: mask and EditMask(mask.level, mask.region, None if mask.start is None else mask.start - first,
                                                    None if mask.end is None else mask.end - first))
            drawn = await ctx.redraw(clip.read_bytes(), last - first, info['width'], info['height'], prompt, local(picture), local(sound))
            done.append(await blocking(media.conform, work.write(f'drawn-{index}.mp4', drawn), work.path / f'out-{index}.mp4',
                                                width=info['width'], height=info['height'], fps=info['fps'], end=last - first))
        await ctx.progress('正在合成结果')
        if window:
            return await blocking(media.splice, work, path, pieces[0][0], pieces[0][1], done[0])
        return await blocking(media.concat, work, done)


def _box_region(ctx: ToolContext, width, height, rows=36, columns=64):
    """Selection boxes (source pixels) as a 0/1 grid over the frame, or None without boxes."""
    if not ctx.boxes:
        return None
    grid = [[0.0] * columns for _ in range(rows)]
    for box in ctx.boxes:
        x0, y0 = box['x'] / width, box['y'] / height
        x1, y1 = (box['x'] + box['width']) / width, (box['y'] + box['height']) / height
        for row in range(rows):
            for column in range(columns):
                if x0 <= (column + 0.5) / columns <= x1 and y0 <= (row + 0.5) / rows <= y1:
                    grid[row][column] = 1.0
    return tuple(tuple(row) for row in grid)


async def _video_size(source: Source):
    with media.Workspace() as work:
        info = await blocking(media.video_info, work.write('probe.mp4', source.data))
    return info['width'], info['height']


async def partial_reshoot(ctx: ToolContext):
    source = _source_video(ctx)
    prompt = ctx.text('prompt')
    if not prompt:
        raise ProjectError('请描述重拍片段的内容。', 422)
    start = ctx.number('startMs', 0, 0) / 1000
    end = ctx.number('endMs', 0, 0) / 1000
    if end - start < 0.5:
        raise ProjectError('重拍区间至少 0.5 秒。', 422)
    # Only the chosen stretch is redrawn, picture and sound; the rest of the clip stays the source.
    window = EditMask(1.0, None, start, end)
    prompt = await ctx.video_prompt(prompt, 'Keep the people, setting, lighting and camera continuous with the surrounding footage.')
    data = await _redraw_pieces(ctx, source, prompt, window, window, window=(start, end))
    return [Output('video', data, 'mp4', '局部重拍')]


MATTE_MAX_FRAMES = 2048


def _write_mattes(tracks: Tracks, folder):
    folder.mkdir()
    for index, frame in enumerate(tracks.frames):
        matte = Image.new('L', (tracks.width, tracks.height), 0)
        for counts in frame:
            matte = ImageChops.lighter(matte, media.rle_mask(counts, tracks.width, tracks.height))
        # A one-pixel blur anti-aliases the hard mask edge.
        matte.filter(ImageFilter.GaussianBlur(0.8)).save(folder / f'{index:05d}.png', compress_level=1)


async def video_matting(ctx: ToolContext):
    source = _source_video(ctx)
    background = ctx.choice('background', ('black', 'green', 'transparent'), 'green')
    pairs = await ctx.concepts(ctx.text('prompt'), ('人物',))
    with media.Workspace() as work:
        raw = work.write('source', source.data)
        info = await blocking(media.video_info, raw)
        if info['duration'] * info['fps'] > MATTE_MAX_FRAMES:
            raise ProjectError(f'视频抠像单次最多处理 {MATTE_MAX_FRAMES} 帧（约 {MATTE_MAX_FRAMES / info["fps"]:.0f} 秒），请先裁剪视频。', 422)
        await ctx.progress('正在整理视频')
        # A constant-rate, even-sized clip decodes to the same frames for the tracker and ffmpeg.
        clip = await blocking(media.conform, raw, work.path / 'clip.mp4', width=info['width'] - info['width'] % 2,
                                       height=info['height'] - info['height'] % 2, fps=info['fps'])
        await ctx.progress(f"正在识别并跟踪「{'、'.join(label for _, label in pairs)}」")
        tracks = await ctx.track(clip.read_bytes(), tuple(concept for concept, _ in pairs))
        if not any(tracks.frames):
            raise ProjectError(f"视频中没有识别到「{'、'.join(label for _, label in pairs)}」，请换一种描述后重试。", 422)
        await ctx.progress('正在合成抠像视频')
        await blocking(_write_mattes, tracks, work.path / 'mattes')
        data, suffix = await blocking(media.matte, clip, str(work.path / 'mattes' / '%05d.png'), info['fps'],
                                               work.path / 'matted', background=background)
    return [Output('video', data, suffix, '视频抠像')]


DEPTH_MAX_SECONDS = 30
DEPTH_MAX_FRAMES = 2048
DEPTH_SHORT_EDGES = {'480P': 480, '720P': 720}


def _depth_size(width, height, short_edge):
    """The source size scaled down so its short side is at most short_edge, on even pixels."""
    scale = min(1.0, short_edge / min(width, height))
    return max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)


async def depth_capture(ctx: ToolContext):
    source = _source_video(ctx)
    resolution = ctx.choice('resolution', tuple(DEPTH_SHORT_EDGES), '480P')
    with media.Workspace() as work:
        raw = work.write('source', source.data)
        info = await blocking(media.video_info, raw)
        if not 0 < info['duration'] <= DEPTH_MAX_SECONDS + 0.05:
            raise ProjectError(f'深度动作捕捉需要不超过 {DEPTH_MAX_SECONDS} 秒的素材，请先裁剪视频。', 422)
        if info['duration'] * info['fps'] > DEPTH_MAX_FRAMES:
            raise ProjectError(f'深度动作捕捉单次最多处理 {DEPTH_MAX_FRAMES} 帧，请先裁剪视频或降低帧率。', 422)
        await ctx.progress('正在整理视频')
        # The depth service returns the size it receives, so the clip is sized here; every
        # source frame is kept so depth frame i lines up with source frame i.
        width, height = _depth_size(info['width'], info['height'], DEPTH_SHORT_EDGES[resolution])
        clip = await blocking(media.picture, raw, work.path / 'clip.mp4', width=width, height=height)
        await ctx.progress('正在估计每一帧的深度')
        data = await ctx.depth(clip.read_bytes())
    return [Output('video', data, 'mp4', f'深度动作捕捉 {resolution}')]


async def video_edit(ctx: ToolContext):
    source = _source_video(ctx)
    prompt = ctx.text('prompt')
    if not prompt:
        raise ProjectError('请描述要如何修改视频。', 422)
    width, height = await _video_size(source)
    region = _box_region(ctx, width, height)
    # Masked redraw regenerates a region; a whole-frame restyle would discard the source entirely.
    if region is None:
        raise ProjectError('请先框选要重绘的区域。', 422)
    prompt = await ctx.video_prompt(prompt, 'The rest of the picture, its light and motion stay as they are.')
    data = await _redraw_pieces(ctx, source, prompt, EditMask(1.0, region), None)
    return [Output('video', data, 'mp4', '视频编辑')]


SUBTITLE_BAND = tuple((1.0,) if row >= 39 else (0.0,) for row in range(50))  # Bottom 22% of the frame.


async def subtitle_erasure(ctx: ToolContext):
    source = _source_video(ctx)
    width, height = await _video_size(source)
    picture = EditMask(1.0, _box_region(ctx, width, height) or SUBTITLE_BAND)
    prompt = await ctx.video_prompt(ctx.text('prompt'), 'This part of the frame continues the surrounding scene naturally, '
                                                         'matching its texture, light and motion.')
    data = await _redraw_pieces(ctx, source, prompt, picture, None)
    return [Output('video', data, 'mp4', '字幕擦除')]


AUDIO_MODES = {'all': '完整音轨', 'voice': '人声（近似）', 'backgroundSound': '背景声（近似）'}


async def audio_separation(ctx: ToolContext):
    if not ctx.sources or ctx.sources[0].kind not in {'video', 'audio'}:
        raise ProjectError('请提供视频或音频素材。', 422)
    source = ctx.sources[0]
    mode = ctx.choice('mode', AUDIO_MODES, 'all')
    outputs = []
    with media.Workspace() as work:
        suffix = source.name.rsplit('.', 1)[-1].lower() if '.' in source.name else ('mp4' if source.kind == 'video' else 'mp3')
        path = work.write(f'source.{suffix}', source.data)
        if mode == 'backgroundSound' and not await blocking(media.is_stereo_with_side, path):
            raise ProjectError('单声道音频无法在本地估计背景声，需要接入具备音轨分离能力的模型。', 422)
        await ctx.progress('正在分离音轨')
        audio = await blocking(media.audio_track, path, work.path / 'track.mp3',
                                        mode={'all': 'all', 'voice': 'voice', 'backgroundSound': 'background'}[mode])
        outputs.append(Output('audio', audio, 'mp3', AUDIO_MODES[mode]))
        if mode == 'all' and source.kind == 'video':
            # Splitting a clip yields both halves: its soundtrack and the silent picture.
            outputs.append(Output('video', await blocking(media.without_audio, path, work.path / 'silent.mp4'), 'mp4', '无声视频'))
    return outputs


async def video_upscale(ctx: ToolContext):
    source = _source_video(ctx)
    edge = {'2K': 2560, '4K': 3840}[ctx.choice('resolution', ('2K', '4K'), '4K')]
    await ctx.progress('正在放大视频')
    with media.Workspace() as work:
        data = await blocking(media.upscale, work.write('source.mp4', source.data), edge, work.path / 'out.mp4')
    return [Output('video', data, 'mp4', f'超清 {ctx.parameters.get("resolution", "4K")}')]


async def frame_interpolation(ctx: ToolContext):
    source = _source_video(ctx)
    fps = int(ctx.choice('fps', (30, 60, '30', '60'), 60))
    await ctx.progress(f'正在补帧到 {fps} fps')
    with media.Workspace() as work:
        data = await blocking(media.interpolate, work.write('source.mp4', source.data), fps, work.path / 'out.mp4')
    return [Output('video', data, 'mp4', f'补帧 {fps}fps')]


# Catalog ---------------------------------------------------------------------

Recipe = Callable[[ToolContext], Awaitable[list[Output]]]


@dataclass(frozen=True)
class ToolSpec:
    id: str
    sources: tuple[str, ...]
    requires: Callable[[dict], tuple[str, ...]]
    recipe: Recipe | None
    # Options the frontend cannot know without the service (ToolField shape).
    fields: tuple[dict, ...] = field(default_factory=tuple)
    note: str = ''


def _needs(*capabilities):
    return lambda parameters: capabilities


def _select(key, label, options, default=None, required=True):
    value = {'key': key, 'label': label, 'type': 'select', 'required': required,
             'options': [{'value': option, 'label': text} for option, text in options]}
    if default is not None:
        value['default'] = default
    return value


TOOLS: dict[str, ToolSpec] = {item.id: item for item in [
    ToolSpec('smart-edit', ('image',), _needs('image.edit'), smart_edit),
    ToolSpec('outpaint', ('image',), _needs('image.edit'), outpaint),
    # Normal mode is local, so the catalog lists it available without an image model.
    ToolSpec('image-hd', ('image',), lambda parameters: ('image.edit',) if parameters.get('kind') == 'pro' else (), image_hd,
             (_select('resolution', '清晰度', [('2K', '2K'), ('4K', '4K'), ('8K', '8K')], '4K'),),
             note='普通模式为本地高质量插值放大；专业模式先由图片模型增强细节。'),
    ToolSpec('inpainting-remove', ('image',), _needs('image.edit'), inpainting_remove),
    ToolSpec('view-control', ('image',), _needs('image.edit'), view_control,
             (_select('distance', '距离', [('near', '近'), ('standard', '标准'), ('far', '远')], 'standard', required=False),)),
    ToolSpec('lighting', ('image',), _needs('image.edit'), lighting,
             ({'key': 'brightness', 'label': '亮度', 'type': 'number', 'min': 0, 'max': 100, 'default': 60, 'required': False},)),
    ToolSpec('panorama', ('image',), _needs('image.edit'), panorama,
             (_select('resolution', '清晰度', [('2K', '2K'), ('4K', '4K')], '2K'),)),
    ToolSpec('image-presets', ('image',), _needs('image.edit'), image_presets,
             (_select('preset', '预设', [(key, value.title) for key, value in PRESETS.items()], 'three-view'),)),
    ToolSpec('multi-size', ('image',), _needs('image.edit'), multi_size),
    ToolSpec('product-replacement', ('image',), _needs('image.edit'), product_replacement),
    ToolSpec('dynamic-poster', ('image',), _needs('video.first_frame'), dynamic_poster),
    ToolSpec('video-partial-reshoot', ('video',), _needs('video.edit'), partial_reshoot,
             note='只重绘所选时间段的画面和声音，其余部分保持原样。'),
    ToolSpec('video-edit', ('video',), _needs('video.edit'), video_edit,
             note='按描述重绘框选区域，框外画面和声音保持不变；不支持整体换风格。'),
    ToolSpec('video-subtitle-erasure', ('video',), _needs('video.edit'), subtitle_erasure,
             note='默认重绘画面底部字幕带；框选区域可指定字幕位置。声音保持不变。'),
    # Splitting off the soundtrack is local; true stems need a separation model.
    ToolSpec('audio-separation', ('video', 'audio'),
             lambda parameters: ('audio.separate',) if parameters.get('mode') in {'soundEffects', 'description'} else (),
             audio_separation, (_select('mode', '分离方式', list(AUDIO_MODES.items()), 'all'),),
             note='本地处理：完整音轨直接分离；人声/背景声为滤波近似，干净分轨需接入音轨分离模型。'),
    ToolSpec('video-upscale', ('video',), _needs(), video_upscale, note='本地 Lanczos 插值放大，不调用模型。'),
    ToolSpec('video-frame-interpolation', ('video',), _needs(), frame_interpolation,
             (_select('fps', '输出帧率', [(30, '30 fps'), (60, '60 fps')], 60),), note='本地运动补偿插帧，不调用模型。'),
    ToolSpec('cutout', ('image',), _needs(), cutout,
             note='按选区保留原图像素并输出透明背景；自动识别使用图像分割或主体抠图模型。'),
    ToolSpec('layer-decompose', ('image',), _needs('image.segment'), layer_decompose,
             note='智能拆分识别人物、动物、车辆、商品等常见对象；按描述拆分可写多个对象，用逗号分隔。'
                  '接入图片编辑模型时会补全背景。'),
    ToolSpec('video-matting', ('video',), _needs('video.matting'), video_matting,
             note='按描述跟踪对象（默认人物），多个对象用逗号分隔；透明背景输出带透明通道的 WebM。'),
    ToolSpec('video-depth-capture', ('video',), _needs('video.motion_capture'), depth_capture,
             note='逐帧估计景深，输出灰度深度视频（近处亮、远处暗），可作为视频生成的动作与结构参考；最长 30 秒。'),
]}
