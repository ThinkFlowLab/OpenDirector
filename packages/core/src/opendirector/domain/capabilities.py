"""Model capabilities canvas operations depend on, independent of any model API.

Operations ask for a capability ("edit this image"), never for a protocol or a
model name. Adapters in opendirector.integrations.model_adapters declare which
capabilities a configured model offers and translate these requests to its API.
"""

from dataclasses import dataclass
from typing import Literal

from opendirector.domain.projects import ProjectError

Capability = Literal[
    'text.chat', 'image.generate', 'image.edit', 'image.cutout', 'video.generate', 'video.first_frame', 'video.edit',
    'audio.speech', 'audio.music', 'audio.score', 'image.segment', 'video.matting', 'video.motion_capture',
    # Declared so operations can name what they lack; no current adapter offers it.
    'audio.separate',
]

LABELS: dict[str, str] = {
    'text.chat': '对话',
    'image.generate': '文生图',
    'image.edit': '图生图/图片编辑',
    'image.cutout': '主体抠图',
    'video.generate': '文生视频',
    'video.first_frame': '首帧生视频',
    'audio.speech': '语音合成',
    'audio.music': '音乐生成',
    'audio.score': '音乐扒谱',
    'image.segment': '图像分割',
    'video.edit': '视频局部重绘',
    'video.matting': '视频抠像',
    'audio.separate': '音轨分离',
    'video.motion_capture': '深度动作捕捉',
}


@dataclass(frozen=True)
class ImageRequest:
    prompt: str
    width: int
    height: int
    # With an image the request is image-to-image; strength is how far it may move (0-1).
    image: bytes | None = None
    strength: float | None = None
    seed: int | None = None
    # Further condition images (style, product, character) after the main image.
    references: tuple[bytes, ...] = ()


@dataclass(frozen=True)
class CutoutRequest:
    """Isolate the main subject (or the named one) on a transparent background."""
    image: bytes
    width: int
    height: int
    subject: str = ''


@dataclass(frozen=True)
class SegmentRequest:
    """Find every instance of an English concept, or the objects inside exemplar boxes.

    Boxes are (x0, y0, x1, y1) in image pixels; at least a concept or a box is given.
    """
    image: bytes
    concept: str = ''
    boxes: tuple[tuple[float, float, float, float], ...] = ()


@dataclass(frozen=True)
class Segment:
    """One instance: a PNG mask (mode L, 255 inside) at the source size, its box and confidence."""
    mask: bytes
    box: tuple[float, float, float, float]
    score: float


@dataclass(frozen=True)
class TrackRequest:
    """Track every instance of English concepts through a clip."""
    video: bytes
    concepts: tuple[str, ...]


@dataclass(frozen=True)
class Tracks:
    """Per decoded frame, the COCO uncompressed RLE counts of each visible instance (column-major)."""
    width: int
    height: int
    fps: float
    frames: tuple[tuple[tuple[int, ...], ...], ...]


@dataclass(frozen=True)
class DepthRequest:
    """Per-frame depth of a whole clip, rendered as a grayscale video at the clip's size and rate."""
    video: bytes


@dataclass(frozen=True)
class VideoRequest:
    prompt: str
    seconds: float
    aspect_ratio: str = '16:9'
    first_frame: bytes | None = None
    seed: int | None = None
    # What the result must not show, for models that take a negative prompt.
    avoid: str = ''


@dataclass(frozen=True)
class EditMask:
    """Where and when an edit redraws: `level` inside the region and time window, the source elsewhere.

    level 1 redraws fully and fractions blend with the source. region is a grid
    of 0-1 weights over the frame (rows top to bottom); None covers the frame.
    start/end are seconds; None reaches the clip's start or end.
    """
    level: float = 1.0
    region: tuple[tuple[float, ...], ...] | None = None
    start: float | None = None
    end: float | None = None


@dataclass(frozen=True)
class VideoEditRequest:
    """Redraw masked parts of a clip; unmasked picture and sound stay the source's."""
    prompt: str
    source: bytes
    seconds: float
    width: int
    height: int
    picture: EditMask | None = None
    sound: EditMask | None = None
    avoid: str = ''


@dataclass(frozen=True)
class SpeechRequest:
    text: str
    voice: str | None = None


ScoreMode = Literal['melody', 'full']


@dataclass(frozen=True)
class MusicRequest:
    """A song or score from a style description; empty lyrics ask for an instrumental piece.

    With an ABC score the piece follows it: its melody only, or melody and chords.
    A seed, when given, selects the take; without one the service picks.
    """
    style: str
    lyrics: str = ''
    max_seconds: float = 30
    score: str = ''
    score_mode: ScoreMode = 'melody'
    seed: int | None = None


@dataclass(frozen=True)
class ScoreRequest:
    """Transcribe a recording into an ABC score, keeping chords unless asked for the melody only."""
    audio: bytes
    filename: str
    melody_only: bool = True


@dataclass(frozen=True)
class ChatRequest:
    messages: tuple[dict, ...]
    max_tokens: int = 2048


@dataclass(frozen=True)
class MediaResult:
    data: bytes
    suffix: str


AgentInputModality = Literal['text', 'image']


def agent_input_modalities(kind, value):
    """Declared agent inputs are separate from media-generation reference rules."""
    if value is None:
        return ['text'] if kind == 'agent' else None
    if (kind != 'agent' or not isinstance(value, (list, tuple)) or 'text' not in value
            or len(value) != len(set(value)) or any(item not in {'text', 'image'} for item in value)):
        raise ProjectError('对话模型输入模态必须包含文本，可选图片，且不能重复。')
    return ['text', *(['image'] if 'image' in value else [])]
