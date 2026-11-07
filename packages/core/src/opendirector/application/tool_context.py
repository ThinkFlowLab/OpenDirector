"""Inputs and model capabilities a canvas tool recipe may use.

Recipes never see a model name, protocol, or endpoint. The context serves each
capability through whichever configured model offers it.
"""
import io
import math
import re
from dataclasses import dataclass

from PIL import Image

from opendirector.domain.capabilities import (
    ChatRequest, CutoutRequest, DepthRequest, ImageRequest, SegmentRequest, TrackRequest,
    Tracks, VideoEditRequest, VideoRequest,
)
from opendirector.domain.projects import ProjectError
from opendirector.media import processing as media


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
    '动物': 'animal', '猫': 'cat', '狗': 'dog', '鸟': 'bird', '马': 'horse', '鱼': 'fish',
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
