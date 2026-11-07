"""Canvas AI tools as recipes over model capabilities and local media steps.

A recipe names the capabilities it needs and receives a ToolContext that serves
them through whichever configured model offers them. Recipes never see a model
name, protocol or endpoint, so swapping or adding models does not touch them.
"""
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from opendirector.application.tool_context import Output, Source, ToolContext
from opendirector.application.tool_image_edits import (
    PRESETS, dynamic_poster, image_hd, image_presets, inpainting_remove, lighting, multi_size,
    outpaint, panorama, product_replacement, smart_edit, view_control,
)
from opendirector.application.tool_image_segments import cutout, layer_decompose, select_image_objects
from opendirector.application.tool_video_recipes import (
    AUDIO_MODES, audio_separation, depth_capture, frame_interpolation, partial_reshoot,
    subtitle_erasure, video_edit, video_matting, video_upscale,
)

# Editor previews and tool tasks import this helper from the catalog module.
__all__ = ['Output', 'Source', 'TOOLS', 'ToolContext', 'select_image_objects']


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
