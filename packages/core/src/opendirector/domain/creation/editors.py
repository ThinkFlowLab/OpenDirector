"""Typed retained editors. AssetRef replaces transient src/data/blob URLs."""
from math import ceil, floor, isfinite
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StrictBool, StrictFloat, StrictInt, StrictStr, field_validator, model_validator

from opendirector.domain.rule_facts import (
    TIMELINE_FONT_LIMIT, TIMELINE_OVERLAY_LIMIT, TIMELINE_TEXT_MAX_LENGTH, TIMELINE_TEXT_TOTAL_LENGTH,
)

from .assets import AssetRef
from .base import Contract, Identifier, NonNegative, Number, Point, Positive, PositiveInt, ProjectEntity, unique

Color = Annotated[str, Field(pattern=r'^#[0-9a-fA-F]{6}$')]
Unit = Annotated[float, Field(strict=True, ge=0, le=1)]


class TimelineResource(Contract):
    asset: AssetRef = Field(description='Immutable asset version.')
    title: str = Field(max_length=255, description='Display title of the imported asset.')
    durationSeconds: Positive | None = Field(default=None, description='Duration in seconds.')

    @model_validator(mode='after')
    def media(self):
        if self.asset.kind not in {'image', 'video', 'audio'}:
            raise ValueError('Timeline resources must be image, video or audio')
        return self


class TimelineClip(Contract):
    id: Identifier = Field(description='Stable object ID.')
    resource: TimelineResource = Field(description='Clip source from the imported asset collection.')
    start: NonNegative | None = Field(default=None, description='Start time in seconds.')
    inPoint: NonNegative = Field(description='Source trim start in seconds.')
    outPoint: Positive = Field(description='Source trim end in seconds.')
    speed: Positive = Field(default=1, description='Playback or motion speed multiplier.')
    volume: Unit = Field(default=1, description='Linear audio gain.')
    muted: bool = Field(default=False, description='Whether audio output is muted.')

    @model_validator(mode='after')
    def source_interval(self):
        if self.outPoint <= self.inPoint:
            raise ValueError('Source out point must follow the in point')
        if self.resource.asset.kind != 'image' and self.resource.durationSeconds is not None and self.outPoint > self.resource.durationSeconds + 1e-6:
            raise ValueError('Clip exceeds known source duration')
        return self

    def duration(self):
        return (self.outPoint - self.inPoint) / self.speed


class TimelineTrack(Contract):
    id: Identifier = Field(description='Stable object ID.')
    kind: Literal['visual', 'audio'] = Field(description='Business object or media type.')
    title: str = Field(max_length=255, description='User-visible title.')
    muted: bool = Field(default=False, description='Whether audio output is muted.')
    clips: tuple[TimelineClip, ...] = Field(default=(), description='Ordered clips on this track.')

    @model_validator(mode='after')
    def placement(self):
        intervals = []
        for clip in self.clips:
            media = clip.resource.asset.kind
            if self.kind == 'visual':
                if media not in {'image', 'video'} or clip.start is not None:
                    raise ValueError('Visual placement follows clip order')
                if media == 'image' and (clip.inPoint != 0 or clip.speed != 1):
                    raise ValueError('Images use display duration, not source trim or speed')
            else:
                if media != 'audio' or clip.start is None:
                    raise ValueError('Audio clips need an explicit start and audio source')
                intervals.append((clip.start, clip.start + clip.duration()))
        intervals.sort()
        if any(current[0] < previous[1] - 1e-6 for previous, current in zip(intervals, intervals[1:])):
            raise ValueError('Clips on the same audio track cannot overlap')
        return self


def timeline_text_frame_range(start: float, end: float, fps: int) -> tuple[int, int]:
    """Half-open output frame range, independent of UI snapping."""
    if (not isfinite(start) or not isfinite(end) or start < 0 or end <= start
            or isinstance(fps, bool) or not isinstance(fps, int) or fps <= 0
            or not isfinite(start * fps) or not isfinite(end * fps)):
        raise ValueError('Invalid timeline text interval')
    first, last = ceil(start * fps - 1e-9), ceil(end * fps - 1e-9)
    if first >= last:
        raise ValueError('Timeline text must cover an output frame')
    return first, last


class TimelineTextBackground(Contract):
    color: Color = Field(description='Background color in #RRGGBB format.')
    opacity: Unit = Field(description='Background opacity.')
    padding: Annotated[float, Field(strict=True, ge=0, le=128)] = Field(description='Background padding in output pixels.')


class TimelineTextStroke(Contract):
    color: Color = Field(description='Stroke color in #RRGGBB format.')
    width: Annotated[float, Field(strict=True, ge=0, le=32)] = Field(description='Stroke width in output pixels.')


class TimelineTextStyle(Contract):
    fontSize: Annotated[float, Field(strict=True, ge=1, le=512)] = Field(description='Font size in output pixels.')
    color: Color = Field(description='Text color in #RRGGBB format.')
    align: Literal['left', 'center', 'right'] = Field(description='Horizontal text alignment.')
    lineHeight: Annotated[float, Field(strict=True, ge=0.8, le=3)] = Field(description='Line height as a font size multiplier.')
    background: TimelineTextBackground | None = Field(default=None, description='Optional text background.')
    stroke: TimelineTextStroke | None = Field(default=None, description='Optional text stroke.')


class TimelineFontResource(Contract):
    id: Identifier = Field(description='Stable document-local font ID.')
    title: str = Field(max_length=255, description='Display title of the font.')
    asset: AssetRef = Field(description='Immutable registered font asset version.')

    @model_validator(mode='after')
    def font_kind(self):
        if self.asset.kind != 'file':
            raise ValueError('Timeline fonts require file assets')
        return self


class TimelineTextOverlay(Contract):
    id: Identifier = Field(description='Stable document-local text ID.')
    start: NonNegative = Field(description='Absolute start time in seconds.')
    end: Positive = Field(description='Exclusive absolute end time in seconds.')
    text: str = Field(min_length=1, max_length=TIMELINE_TEXT_MAX_LENGTH, description='Plain text normalized to LF, counted in Unicode code points.')
    x: Unit = Field(description='Normalized text box left position.')
    y: Unit = Field(description='Normalized text box top position.')
    maxWidth: Annotated[float, Field(strict=True, gt=0, le=1)] = Field(description='Text box width as a fraction of output width.')
    fontId: Identifier = Field(description='Font resource ID in this document.')
    style: TimelineTextStyle = Field(description='Output-space text styling.')
    sourceAsset: AssetRef | None = Field(default=None, description='Frozen source text asset, independent of subsequent edits.')

    @field_validator('text', mode='before')
    @classmethod
    def normalize_text(cls, value):
        if not isinstance(value, str):
            return value
        value = value.replace('\r\n', '\n').replace('\r', '\n')
        if not value.strip() or any(ord(c) < 32 and c not in '\n\t' or 127 <= ord(c) <= 159 for c in value):
            raise ValueError('Timeline text must contain visible text and no non-layout controls')
        return value

    @model_validator(mode='after')
    def placement(self):
        if self.end <= self.start or self.x + self.maxWidth > 1 + 1e-9:
            raise ValueError('Invalid timeline text placement')
        if self.sourceAsset and self.sourceAsset.kind != 'text':
            raise ValueError('Timeline text sources require text assets')
        return self


class TimelineData(Contract):
    fps: PositiveInt = Field(description='Frames per second.')
    width: PositiveInt = Field(description='Width in pixels.')
    height: PositiveInt = Field(description='Height in pixels.')
    tracks: tuple[TimelineTrack, ...] = Field(min_length=1, description='Ordered timeline tracks.')
    importedAssets: tuple[TimelineResource, ...] = Field(default=(), description='Source assets available to timeline clips.')

    fonts: tuple[TimelineFontResource, ...] = Field(default=(), max_length=TIMELINE_FONT_LIMIT, exclude_if=lambda v: not v, description='Document-local registered font resources; omitted when empty.')
    overlays: tuple[TimelineTextOverlay, ...] = Field(default=(), max_length=TIMELINE_OVERLAY_LIMIT, exclude_if=lambda v: not v, description='Timed text ordered from bottom to top; omitted when empty.')

    @model_validator(mode='after')
    def tracks_and_clips(self):
        unique([track.id for track in self.tracks], 'timeline track IDs')
        unique([clip.id for track in self.tracks for clip in track.clips], 'timeline clip IDs')
        if sum(track.kind == 'visual' for track in self.tracks) != 1:
            raise ValueError('A timeline requires exactly one visual track')
        unique([font.id for font in self.fonts], 'timeline font IDs')
        unique([overlay.id for overlay in self.overlays], 'timeline text IDs')
        text_ids = [font.id for font in self.fonts] + [overlay.id for overlay in self.overlays]
        occupied = {track.id for track in self.tracks} | {clip.id for track in self.tracks for clip in track.clips}
        if len(set(text_ids)) != len(text_ids) or occupied.intersection(text_ids):
            raise ValueError('Timeline text and font IDs must be distinct within the document')
        fonts = {font.id for font in self.fonts}
        for overlay in self.overlays:
            if overlay.fontId not in fonts:
                raise ValueError('Timeline text references an unknown font')
            timeline_text_frame_range(overlay.start, overlay.end, self.fps)
        if sum(len(overlay.text) for overlay in self.overlays) > TIMELINE_TEXT_TOTAL_LENGTH:
            raise ValueError('Timeline total text exceeds the code point limit')
        return self


def timeline_duration(data: TimelineData) -> float:
    ends = [overlay.end for overlay in data.overlays]
    for track in data.tracks:
        cursor = 0.0
        for clip in track.clips:
            start = cursor if track.kind == 'visual' else clip.start
            cursor = start + clip.duration()
            ends.append(cursor)
    return max(ends, default=0.0)


class SubjectLibrarySource(Contract):
    """Frozen import provenance; subsequent editing never follows the library."""
    itemId: UUID = Field(description='Canvas item ID.')
    revision: int = Field(ge=1, strict=True, description='Captured library item revision.')
    importId: UUID = Field(description='Library import ID.')


class SubjectData(Contract):
    description: str = Field(default='', max_length=20000,
        description='User-facing annotation only; not subject media or a generation reference')
    category: str = Field(default='', max_length=100, description='Subject category.')
    main: AssetRef | None = Field(default=None, description='Primary subject media.')
    auxiliaries: tuple[AssetRef, ...] = Field(default=(), max_length=3, description='Ordered auxiliary subject media.')
    voice: AssetRef | None = Field(default=None, description='Subject voice asset version.')
    librarySource: SubjectLibrarySource | None = Field(default=None, description='Immutable source library version.')

    @model_validator(mode='after')
    def source_roles(self):
        if self.main and self.main.kind not in {'image', 'video'}:
            raise ValueError('Subject main source must be image or video')
        if any(asset.kind != 'image' for asset in self.auxiliaries) or self.voice and self.voice.kind != 'audio':
            raise ValueError('Invalid subject auxiliary or voice source')
        if not self.main and (self.auxiliaries or self.voice):
            raise ValueError('Subject auxiliary sources require a main source')
        if self.main and self.main.kind == 'video' and (self.auxiliaries or self.voice):
            raise ValueError('Video subjects cannot contain auxiliary images or independent audio')
        unique([asset.assetId for asset in (self.main, *self.auxiliaries, self.voice) if asset], 'subject sources')
        return self


class StackData(Contract):
    nodeIds: tuple[UUID, ...] = Field(default=(), description='Ordered member canvas item IDs.')
    activeIndex: int = Field(default=0, strict=True, ge=0, description='Index of the active member.')

    @model_validator(mode='after')
    def selection(self):
        unique(self.nodeIds, 'stack node IDs')
        if self.activeIndex >= max(1, len(self.nodeIds)):
            raise ValueError('Stack selection is outside its items')
        return self


class ToolField(Contract):
    name: str = Field(min_length=1, max_length=200, description='User-visible name.')
    values: tuple[str, ...] = Field(description='Ordered tool field values.')


class PaletteProvenance(Contract):
    paletteId: Identifier = Field(description='Palette ID.')
    version: PositiveInt = Field(description='Version of the referenced record.')


class PaletteData(Contract):
    name: str | None = Field(default=None, max_length=255, description='User-visible name.')
    sourceImage: AssetRef | None = Field(default=None, description='Source image used to extract palette colors.')

    @model_validator(mode='after')
    def image(self):
        if self.sourceImage and self.sourceImage.kind != 'image':
            raise ValueError('Palette source must be an image')
        return self


class ToolData(Contract):
    kind: Literal['camera', 'style', 'palette', 'camera_motion'] = Field(description='Business object or media type.')
    fields: tuple[ToolField, ...] = Field(default=(), description='Named tool-specific parameter fields.')
    provenance: PaletteProvenance | None = Field(default=None, description='Recorded origin and execution context.')
    palette: PaletteData | None = Field(default=None, description='Reusable palette data.')


class MaskStroke(Contract):
    mode: Literal['erase', 'restore'] = Field(description='Operation mode within this contract variant.')
    size: Annotated[float, Field(strict=True, ge=1, le=4096)] = Field(description='Mask brush diameter in pixels.')
    points: tuple[Point, ...] = Field(min_length=1, max_length=200000, description='Ordered mask stroke coordinates.')


class LayerContentBase(Contract):
    width: Annotated[int, Field(strict=True, ge=1, le=8192)] = Field(description='Width in pixels.')
    height: Annotated[int, Field(strict=True, ge=1, le=8192)] = Field(description='Height in pixels.')

    @model_validator(mode='after')
    def pixel_limit(self):
        if self.width * self.height > 16777216:
            raise ValueError('Layer content exceeds the existing pixel limit')
        return self


class ImageLayerContent(LayerContentBase):
    kind: Literal['image'] = Field(description='Business object or media type.')
    asset: AssetRef = Field(description='Immutable asset version.')

    @model_validator(mode='after')
    def image(self):
        if self.asset.kind != 'image':
            raise ValueError('Image layers require image assets')
        return self


class TextLayerContent(LayerContentBase):
    kind: Literal['text'] = Field(description='Business object or media type.')
    text: str = Field(max_length=10000, description='UTF-8 text content or search query.')
    color: Color = Field(description='Serialized display color.')
    fontSize: Annotated[float, Field(strict=True, ge=4, le=1000)] = Field(description='Text size in pixels.')


class RectangleLayerContent(LayerContentBase):
    kind: Literal['rectangle'] = Field(description='Business object or media type.')
    color: Color = Field(description='Serialized display color.')


LayerContent = Annotated[ImageLayerContent | TextLayerContent | RectangleLayerContent, Field(discriminator='kind')]


class ImageLayer(Contract):
    id: Identifier = Field(description='Stable object ID.')
    name: str = Field(max_length=200, description='User-visible name.')
    visible: bool = Field(default=True, description='Whether this object is displayed.')
    locked: bool = Field(default=False, description='Whether edits to this object are blocked.')
    opacity: Unit = Field(default=1, description='Layer opacity from zero to one.')
    x: Number = Field(default=0, description='Horizontal coordinate.')
    y: Number = Field(default=0, description='Vertical coordinate.')
    width: Annotated[float, Field(strict=True, gt=0, le=8192)] = Field(description='Width in pixels.')
    height: Annotated[float, Field(strict=True, gt=0, le=8192)] = Field(description='Height in pixels.')
    rotation: Number = Field(default=0, description='Layer rotation in degrees.')
    flipX: bool = Field(default=False, description='Whether the image is mirrored horizontally.')
    flipY: bool = Field(default=False, description='Whether the image is mirrored vertically.')
    content: LayerContent = Field(description='Editable layer content.')
    mask: tuple[MaskStroke, ...] = Field(default=(), max_length=2000, description='Ordered strokes or encoded selection mask.')


class LayerData(LayerContentBase):
    background: str = Field(default='transparent', pattern=r'^(transparent|#[0-9a-fA-F]{6})$', description='Composition background color.')
    layers: tuple[ImageLayer, ...] = Field(default=(), max_length=40, description='Ordered editable image layers.')

    @model_validator(mode='after')
    def limits(self):
        if self.width * self.height > 16777216:
            raise ValueError('Layer canvas exceeds the existing pixel limit')
        unique([layer.id for layer in self.layers], 'layer IDs')
        if sum(len(stroke.points) for layer in self.layers for stroke in layer.mask) > 200000:
            raise ValueError('Layer masks exceed the existing point limit')
        return self


class Vector3(Contract):
    x: Number = Field(description='X component in stage coordinates.')
    y: Number = Field(description='Y component in stage coordinates.')
    z: Number = Field(description='Z component in stage coordinates.')


class StageTransform(Contract):
    position: Vector3 = Field(description='Position in the owning canvas or stage.')
    rotation: Vector3 = Field(description='Rotation in radians around each stage axis.')
    scale: Vector3 = Field(description='Positive scale along each stage axis.')

    @model_validator(mode='after')
    def positive_scale(self):
        if min(self.scale.x, self.scale.y, self.scale.z) <= 0:
            raise ValueError('Stage scale must be positive')
        return self


class TransformFrame(Contract):
    id: Identifier = Field(description='Stable object ID.')
    time: NonNegative = Field(description='Keyframe time in seconds.')
    value: StageTransform = Field(description='Keyframed transform or camera pose.')


class StageMotion(Contract):
    preset: Literal['idle', 'walk', 'run', 'wave'] = Field(description='Selected generation or motion preset.')
    speed: Positive = Field(description='Playback or motion speed multiplier.')
    amount: Unit = Field(description='Magnitude of the procedural motion.')


class MotionClip(Contract):
    id: Identifier = Field(description='Stable object ID.')
    start: NonNegative = Field(description='Start time in seconds.')
    duration: Positive = Field(description='Interval duration in seconds.')
    motion: StageMotion = Field(description='Procedural motion settings.')


class StageObject(StageTransform):
    id: Identifier = Field(description='Stable object ID.')
    kind: Literal['person', 'box', 'sphere'] = Field(description='Business object or media type.')
    name: str = Field(max_length=255, description='User-visible name.')
    color: Color = Field(description='Serialized display color.')
    keyframes: tuple[TransformFrame, ...] = Field(default=(), description='Ordered animation keyframes.')
    motionClips: tuple[MotionClip, ...] = Field(default=(), description='Ordered procedural motion intervals.')


class StageCamera(Contract):
    position: Vector3 = Field(description='Position in the owning canvas or stage.')
    target: Vector3 = Field(description='Camera look-at position.')
    fov: Annotated[float, Field(strict=True, gt=0, lt=180)] = Field(description='Camera vertical field of view in degrees.')

    @model_validator(mode='after')
    def direction(self):
        if self.position == self.target:
            raise ValueError('Camera position and target must differ')
        return self


class CameraFrame(Contract):
    id: Identifier = Field(description='Stable object ID.')
    time: NonNegative = Field(description='Keyframe time in seconds.')
    value: StageCamera = Field(description='Keyframed transform or camera pose.')


class CameraRig(Contract):
    id: Identifier = Field(description='Stable object ID.')
    name: str = Field(max_length=255, description='User-visible name.')
    pose: StageCamera = Field(description='Camera position and look-at target.')
    keyframes: tuple[CameraFrame, ...] = Field(default=(), description='Ordered animation keyframes.')


class StageShot(Contract):
    id: Identifier = Field(description='Stable object ID.')
    cameraId: Identifier = Field(description='Stage camera ID.')
    start: NonNegative = Field(description='Start time in seconds.')
    duration: Positive = Field(description='Interval duration in seconds.')


def check_frames(frames, duration):
    unique([frame.id for frame in frames], 'keyframe IDs')
    unique([frame.time for frame in frames], 'keyframe times')
    if any(frame.time > duration for frame in frames):
        raise ValueError('Keyframe exceeds stage duration')


def check_intervals(items, duration):
    unique([item.id for item in items], 'interval IDs')
    ordered = sorted(items, key=lambda item: item.start)
    if any(item.start + item.duration > duration + 1e-8 for item in ordered):
        raise ValueError('Interval exceeds stage duration')
    if any(a.start + a.duration > b.start + 1e-8 for a, b in zip(ordered, ordered[1:])):
        raise ValueError('Stage intervals cannot overlap')


class DirectorData(Contract):
    background: Color = Field(description='Composition background color.')
    grid: bool = Field(default=True, description='Whether to display the stage grid.')
    duration: Positive = Field(description='Interval duration in seconds.')
    aspectRatio: Literal['16:9', '9:16', '1:1', '4:3', '3:4'] = Field(default='16:9', description='Output width-to-height ratio.')
    cameras: tuple[CameraRig, ...] = Field(min_length=1, description='Editable stage cameras.')
    activeCameraId: Identifier = Field(description='Active stage camera ID.')
    cameraSource: Literal['camera', 'storyboard'] = Field(default='camera', description='Camera selection strategy.')
    shots: tuple[StageShot, ...] = Field(default=(), description='Ordered camera shot intervals.')
    objects: tuple[StageObject, ...] = Field(default=(), description='Editable stage objects.')

    @model_validator(mode='after')
    def stage_relations(self):
        camera_ids = [camera.id for camera in self.cameras]
        unique(camera_ids, 'camera IDs')
        unique([obj.id for obj in self.objects], 'stage object IDs')
        if self.activeCameraId not in camera_ids or any(shot.cameraId not in camera_ids for shot in self.shots):
            raise ValueError('Stage references an unknown camera')
        check_intervals(self.shots, self.duration)
        if self.cameraSource == 'storyboard' and not self.shots:
            raise ValueError('Local camera-shot playback needs shots')
        for camera in self.cameras:
            check_frames(camera.keyframes, self.duration)
        for obj in self.objects:
            check_frames(obj.keyframes, self.duration)
            check_intervals(obj.motionClips, self.duration)
        return self


class ToolSelection(Contract):
    source: AssetRef = Field(description='Input source or recorded provenance.')
    width: PositiveInt = Field(description='Width in pixels.')
    height: PositiveInt = Field(description='Height in pixels.')
    mask: AssetRef | None = Field(default=None, description='Ordered strokes or encoded selection mask.')
    boxes: tuple['SelectionBox', ...] = Field(default=(), description='Selection rectangles in source image pixels.')

    @model_validator(mode='after')
    def mask_image(self):
        if self.mask and self.mask.kind != 'image':
            raise ValueError('Tool mask must be an image asset')
        return self


class SelectionBox(Contract):
    x: Number = Field(description='Horizontal coordinate.')
    y: Number = Field(description='Vertical coordinate.')
    width: Positive = Field(description='Width in pixels.')
    height: Positive = Field(description='Height in pixels.')


ToolId = Literal['layers', 'crop', 'smart-edit', 'outpaint', 'cutout', 'inpainting-remove', 'image-hd',
    'view-control', 'lighting', 'layer-decompose', 'panorama', 'product-replacement', 'multi-size',
    'dynamic-poster', 'ecommerce-main', 'image-presets', 'grid-split', 'composition', 'annotation',
    'video-edit', 'video-extend', 'video-partial-reshoot', 'video-upscale', 'video-frame-interpolation',
    'video-depth-capture', 'video-subtitle-erasure', 'video-matting', 'video-crop', 'video-translation',
    'extract-audio', 'audio-separation', 'video-trim', 'audio-trim', 'video-frame-capture', 'director-stage']


class ToolDraftBinding(Contract):
    editorId: UUID = Field(description='Editable document ID.')
    editorRevision: PositiveInt = Field(description='Expected editable document revision.')
    itemId: UUID = Field(description='Canvas item ID.')
    itemRevision: PositiveInt = Field(description='Expected canvas item revision.')


class MediaEditData(Contract):
    tool: ToolId = Field(description='Registered editing tool name.')
    sources: tuple[AssetRef, ...] = Field(default=(), description='Ordered source asset versions.')
    sourceItems: tuple[UUID, ...] = Field(default=(), description='Source canvas item IDs.')
    parameters: dict[Annotated[str, Field(min_length=1, max_length=100)],
                     Annotated[StrictStr, Field(max_length=100000)] | StrictBool | StrictInt | StrictFloat] = Field(default_factory=dict, max_length=100, description='Typed generation or editing parameters.')
    selection: ToolSelection | None = Field(default=None, description='Saved source selection for this edit.')

    @model_validator(mode='after')
    def source_bindings(self):
        unique(self.sourceItems, 'tool source item IDs')
        if self.sourceItems and len(self.sourceItems) != len(self.sources):
            raise ValueError('Tool source identities must match their pinned assets')
        if self.selection:
            selection = self.selection
            if not self.sources or selection.source != self.sources[0]:
                raise ValueError('Tool selection must belong to the first pinned source')
            if len(selection.boxes) > 100 or any(box.x < 0 or box.y < 0 or box.x + box.width > selection.width or box.y + box.height > selection.height for box in selection.boxes):
                raise ValueError('Tool selection boxes exceed source bounds')
        return self


class EditorInputConnection(Contract):
    """Assembly provenance binds a retained slot, never a generation spec."""
    id: UUID = Field(description='Stable object ID.')
    sourceId: UUID = Field(description='Source canvas item ID.')
    slotId: Identifier = Field(description='Destination editor input slot.')
    asset: AssetRef = Field(description='Immutable asset version.')


class EditorDocumentBase(ProjectEntity):
    schemaVersion: Literal[1] = Field(default=1, description='Record schema version.')
    inputConnections: tuple[EditorInputConnection, ...] = Field(default=(), description='Persisted connections to source assets.')

    @model_validator(mode='after')
    def assembly_connections(self):
        unique([value.id for value in self.inputConnections], 'assembly connection IDs')
        unique([value.sourceId for value in self.inputConnections], 'assembly source IDs')
        unique([value.slotId for value in self.inputConnections], 'assembly destination slots')
        if self.inputConnections and self.kind == 'subject' and self.data.main and self.data.main.kind == 'video' and (self.data.auxiliaries or self.data.voice):
            raise ValueError('Video subject assembly cannot contain auxiliary images or independent audio')
        for value in self.inputConnections:
            if self.kind == 'subject':
                source = self.data.main if value.slotId == 'main' else next(
                    (asset for asset in self.data.auxiliaries if str(asset.assetId) == value.slotId), None)
                allowed = {'image', 'video'}
            elif self.kind == 'timeline':
                clip = next((clip for track in self.data.tracks for clip in track.clips if clip.id == value.slotId), None)
                source = clip.resource.asset if clip else None
                allowed = {'image', 'video', 'audio'}
            else:
                raise ValueError('Only subject and timeline documents accept assembly connections')
            if source is None or source != value.asset or source.kind not in allowed:
                raise ValueError('Assembly connection must own an existing compatible retained slot')
        return self


class TimelineDocument(EditorDocumentBase):
    kind: Literal['timeline'] = Field(description='Business object or media type.')
    data: TimelineData = Field(description='Typed editable document contents.')


class SubjectDocument(EditorDocumentBase):
    kind: Literal['subject'] = Field(description='Business object or media type.')
    data: SubjectData = Field(description='Typed editable document contents.')


class LayerDocument(EditorDocumentBase):
    kind: Literal['layers'] = Field(description='Business object or media type.')
    data: LayerData = Field(description='Typed editable document contents.')


class ImageCropOptions(Contract):
    rotation: Literal[0, 90, 180, 270] = Field(default=0, description='Crop rotation in degrees.')
    flipX: bool = Field(default=False, description='Whether the image is mirrored horizontally.')
    flipY: bool = Field(default=False, description='Whether the image is mirrored vertically.')
    aspect: Literal['free', 'original', '1:1', '4:3', '3:4', '16:9', '9:16'] = Field(default='original', description='Crop aspect ratio or free crop mode.')
    zoom: Annotated[float, Field(strict=True, ge=100, le=400)] = Field(default=100, description='Crop zoom percentage.')
    freeWidth: Annotated[float, Field(strict=True, ge=1, le=100)] = Field(default=100, description='Free crop width as a percentage.')
    freeHeight: Annotated[float, Field(strict=True, ge=1, le=100)] = Field(default=100, description='Free crop height as a percentage.')
    x: Annotated[float, Field(strict=True, ge=0, le=100)] = Field(default=50, description='Horizontal crop position percentage.')
    y: Annotated[float, Field(strict=True, ge=0, le=100)] = Field(default=50, description='Vertical crop position percentage.')
    brightness: Annotated[float, Field(strict=True, ge=0, le=200)] = Field(default=100, description='Brightness percentage.')
    contrast: Annotated[float, Field(strict=True, ge=0, le=200)] = Field(default=100, description='Contrast percentage.')
    saturation: Annotated[float, Field(strict=True, ge=0, le=200)] = Field(default=100, description='Saturation percentage.')

    def output_size(self, width, height):
        if self.rotation % 180:
            width, height = height, width
        if self.aspect == 'free':
            out_width, out_height = max(1, width * self.freeWidth / 100), max(1, height * self.freeHeight / 100)
        else:
            ratio_width, ratio_height = (width, height) if self.aspect == 'original' else [int(v) for v in self.aspect.split(':')]
            ratio = ratio_width / ratio_height
            out_width = min(width, height * ratio) / (self.zoom / 100)
            out_height = out_width / ratio
        return max(1, floor(out_width + .5)), max(1, floor(out_height + .5))


class ImageCropData(Contract):
    source: AssetRef = Field(description='Input source or recorded provenance.')
    options: ImageCropOptions = Field(description='Non-destructive image crop and color settings.')
    width: PositiveInt = Field(description='Width in pixels.')
    height: PositiveInt = Field(description='Height in pixels.')

    @model_validator(mode='after')
    def image_source(self):
        if self.source.kind != 'image':
            raise ValueError('Image crop requires an image source')
        return self


class ImageCropDocument(EditorDocumentBase):
    kind: Literal['image_crop'] = Field(description='Business object or media type.')
    data: ImageCropData = Field(description='Typed editable document contents.')


class StackDocument(EditorDocumentBase):
    kind: Literal['stack'] = Field(description='Business object or media type.')
    data: StackData = Field(description='Typed editable document contents.')


class ToolDocument(EditorDocumentBase):
    kind: Literal['tool'] = Field(description='Business object or media type.')
    data: ToolData = Field(description='Typed editable document contents.')


class DirectorDocument(EditorDocumentBase):
    kind: Literal['director'] = Field(description='Business object or media type.')
    data: DirectorData = Field(description='Typed editable document contents.')


class MediaEditDocument(EditorDocumentBase):
    kind: Literal['media_edit'] = Field(description='Business object or media type.')
    data: MediaEditData = Field(description='Typed editable document contents.')


EditorDocument = Annotated[TimelineDocument | SubjectDocument | LayerDocument | ImageCropDocument | StackDocument |
    ToolDocument | DirectorDocument | MediaEditDocument, Field(discriminator='kind')]
