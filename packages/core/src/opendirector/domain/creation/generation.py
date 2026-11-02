"""Generation intent, references and fixed execution facts, independent of nodes."""
from typing import Annotated, Literal
from datetime import datetime
from uuid import UUID

from pydantic import Field, JsonValue, model_validator

from opendirector.domain.generation import GenerationFailure, ResultCheck
from .assets import AssetRef, MediaMetadata
from .base import Contract, Digest, GenerationKind, NonNegative, ObjectVersion, PositiveInt, ProjectEntity, Revision, digest, unique
from .models import ModelConfigPublic, ModelSnapshot, VideoMode


class TextParameters(Contract):
    thinking: Literal['auto', 'low', 'medium', 'high'] = 'auto'
    maxTokens: Annotated[int, Field(strict=True, ge=1, le=32768)] = 8192


class ImageParameters(Contract):
    size: str = Field(default='auto', pattern=r'^(?:auto|2K|[1-9]\d{2,3}x[1-9]\d{2,3})$')
    aspectRatio: str | None = Field(default=None, pattern=r'^[1-9]\d?:[1-9]\d?$')
    preset: Literal['none', 'product-views'] = 'none'
    responseFormat: Literal['url'] = 'url'
    outputFormat: Literal['png'] = 'png'


class VideoParameters(Contract):
    generateAudio: bool = True
    videoMode: VideoMode = 'first_frame'
    durationSeconds: Annotated[float, Field(strict=True, ge=1, le=60)] | None = None
    aspectRatio: str | None = Field(default=None, pattern=r'^[1-9]\d?:[1-9]\d?$')
    resolution: str = Field(default='auto', pattern=r'^(?:auto|[A-Z0-9][A-Z0-9_.-]{0,23})$')


# Music models count audio frames at 25 per second, between 200 and 9000 frames.
MUSIC_SECONDS = (8, 360)
DEFAULT_MUSIC_SECONDS = 30


class AudioParameters(Contract):
    creationType: Literal['audio', 'music'] = 'audio'
    mode: Literal['tts', 'unified'] = 'tts'
    voice: str | None = Field(default=None, pattern=r'^[A-Za-z0-9_.-]{1,64}$')
    # Music only: the prompt is the style description; empty lyrics ask for an instrumental piece.
    lyrics: str = Field(default='', max_length=5000)
    durationSeconds: Annotated[float, Field(strict=True, ge=MUSIC_SECONDS[0], le=MUSIC_SECONDS[1])] | None = None


class PromptText(Contract):
    type: Literal['text']
    text: str = Field(max_length=20000)


class PromptReference(Contract):
    type: Literal['reference']
    referenceId: UUID


PromptPart = Annotated[PromptText | PromptReference, Field(discriminator='type')]


class GenerationSpecBase(ProjectEntity):
    purpose: Literal['draft', 'generation'] = 'draft'
    modelConfigId: UUID | None = None  # Drafts can exist before choosing a model.
    prompt: str = Field(default='', max_length=20000)
    promptContent: tuple[PromptPart, ...] | None = None
    currentResultId: UUID | None = None


class TextGenerationSpec(GenerationSpecBase):
    kind: Literal['text']
    parameters: TextParameters = Field(default_factory=TextParameters)


class ImageGenerationSpec(GenerationSpecBase):
    kind: Literal['image']
    parameters: ImageParameters = Field(default_factory=ImageParameters)


class VideoGenerationSpec(GenerationSpecBase):
    kind: Literal['video']
    parameters: VideoParameters = Field(default_factory=VideoParameters)


class AudioGenerationSpec(GenerationSpecBase):
    kind: Literal['audio']
    parameters: AudioParameters = Field(default_factory=AudioParameters)


GenerationSpec = Annotated[TextGenerationSpec | ImageGenerationSpec | VideoGenerationSpec | AudioGenerationSpec,
                           Field(discriminator='kind')]


class FollowingSource(Contract):
    objectType: Literal['canvas_item'] = 'canvas_item'
    id: UUID


class ReferenceBase(ProjectEntity):
    targetSpecId: UUID
    role: Literal['reference', 'first_frame', 'continuation'] = 'reference'
    order: int = Field(default=0, ge=0, strict=True)
    active: bool = True  # Retained tombstone prevents revision ABA on undo.


class PinnedReference(ReferenceBase):
    binding: Literal['pinned']
    source: AssetRef
    # Historical provenance only; execution always uses the pinned asset.
    sourceVersion: ObjectVersion | None = Field(default=None, exclude_if=lambda value: value is None)
    subjectRole: Literal['main', 'auxiliary', 'voice'] | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode='after')
    def source_identity(self):
        if self.sourceVersion and self.sourceVersion.objectType != 'canvas_item':
            raise ValueError('Pinned source provenance must identify a canvas item')
        return self


class FollowingReference(ReferenceBase):
    # A stable logical source item survives hiding; its current Asset/Spec
    # binding may change. It never points to a transient React Flow instance.
    binding: Literal['follow_current']
    source: FollowingSource


Reference = Annotated[PinnedReference | FollowingReference, Field(discriminator='binding')]


class ResolvedReference(Contract):
    referenceId: UUID
    role: Literal['reference', 'first_frame', 'continuation']
    asset: AssetRef
    metadata: MediaMetadata
    sourceVersion: ObjectVersion | None = None
    documentVersion: ObjectVersion | None = None
    subjectRole: Literal['main', 'auxiliary', 'voice'] | None = None
    name: str = Field(default='', max_length=255)
    sourceTitle: str = Field(default='', max_length=255)
    transmission: Literal['content', 'metadata', 'context_only', 'latent'] = 'content'


class InputSnapshot(Contract):
    """Only creative inputs; layout, selection and credentials are excluded."""
    spec: GenerationSpec
    model: ModelSnapshot
    references: tuple[ResolvedReference, ...] = ()

    @model_validator(mode='after')
    def identity(self):
        expected_kind = 'agent' if self.spec.kind == 'text' else self.spec.kind
        if self.model.kind != expected_kind or self.spec.modelConfigId != self.model.modelConfigId:
            raise ValueError('Snapshot model must match the generation configuration')
        if self.spec.purpose != 'generation':
            raise ValueError('Accepted execution requires a committed generation purpose')
        if self.spec.currentResultId is not None:
            raise ValueError('Current display selection is not a generation input')
        unique([(ref.referenceId, ref.asset.assetId) for ref in self.references], 'resolved reference assets')
        for reference_id in {ref.referenceId for ref in self.references}:
            expanded = [ref for ref in self.references if ref.referenceId == reference_id]
            if len(expanded) > 1 and (any(ref.documentVersion is None or ref.subjectRole is None for ref in expanded)
                    or len({(ref.documentVersion.id, ref.documentVersion.revision) for ref in expanded}) != 1):
                raise ValueError('Multiple assets per reference require one frozen subject document')
        if any(ref.asset.kind == 'file' for ref in self.references):
            raise ValueError('File nodes are not generation media references')
        reference_ids = {ref.referenceId for ref in self.references}
        if self.spec.promptContent and any(isinstance(part, PromptReference) and part.referenceId not in reference_ids
                                           for part in self.spec.promptContent):
            raise ValueError('Prompt points to an unresolved reference')
        return self

    def fingerprint(self):
        # Retain exact source revisions for audit, but a display-selection edit
        # can increment the spec revision without changing creative inputs.
        return digest(self, exclude={'spec': {'revision', 'currentResultId'},
            'references': {'__all__': {'name': True, 'sourceTitle': True, 'asset': {'revision'},
                'sourceVersion': {'revision'}, 'documentVersion': {'revision'}}}})


class VideoExecution(Contract):
    """Resolved adapter parameters, distinct from user intent and source layout."""
    kind: Literal['video']
    durationSeconds: Annotated[float, Field(strict=True, ge=1, le=60)] | None = None
    size: str | None = Field(default=None, pattern=r'^\d+x\d+$')
    resolution: str | None = None
    fps: PositiveInt | None = None
    numFrames: PositiveInt | None = None
    numInferenceSteps: PositiveInt | None = None
    guidanceScale: NonNegative | None = None
    seed: int | None = Field(default=None, strict=True)
    watermark: bool | None = None
    generateAudio: bool | None = None


class ImageExecution(Contract):
    kind: Literal['image']
    size: str
    responseFormat: Literal['url', 'b64_json'] | None = None
    outputFormat: Literal['png'] = 'png'
    watermark: bool | None = None


class AudioExecution(Contract):
    kind: Literal['audio']
    voice: str | None = None
    speaker: str | None = None
    format: Literal['mp3', 'wav']
    sampleRate: PositiveInt | None = None
    creationType: Literal['audio', 'music'] = 'audio'
    # A music model may end the piece earlier than this cap.
    maxDurationSeconds: Annotated[float, Field(strict=True, ge=MUSIC_SECONDS[0], le=MUSIC_SECONDS[1])] | None = None


class TextExecution(TextParameters):
    kind: Literal['text']


ExecutionParameters = Annotated[TextExecution | ImageExecution | VideoExecution | AudioExecution, Field(discriminator='kind')]


class Job(ProjectEntity):
    schemaVersion: Literal[1] = 1
    createdAt: datetime | None = None
    inputSnapshot: InputSnapshot
    inputFingerprint: Digest
    execution: ExecutionParameters
    status: Literal['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] = 'queued'
    phase: Literal['queued', 'prepare', 'submit', 'poll', 'download', 'check', 'save', 'adopt', 'complete'] = 'queued'
    externalTaskId: str | None = Field(default=None, min_length=1, max_length=200)
    asset: AssetRef | None = None
    errorDetails: GenerationFailure | None = None
    recovery: Literal['submit', 'remote', 'download', 'local', 'review', 'retry', 'done'] = 'submit'
    resumeAllowed: bool = False
    cancelRequested: bool = False
    remoteCancellation: Literal['not_requested', 'requested', 'confirmed', 'unknown'] = 'not_requested'
    originItemId: UUID | None = None  # Optional display provenance, not execution ownership.
    previousJobId: UUID | None = None
    technicalCheck: ResultCheck | None = None
    adoptionPolicy: Literal['if_current', 'candidate_only'] = 'if_current'
    batchId: UUID | None = None
    showAdditionalResult: bool = False
    adoptionResultId: UUID | None = None
    adoptionMaterial: AssetRef | None = None
    adopted: bool = False
    adapterParameters: dict[str, JsonValue] = Field(default_factory=dict)

    @model_validator(mode='after')
    def execution_identity(self):
        if self.showAdditionalResult and (self.originItemId is None or self.adoptionPolicy != 'candidate_only'):
            raise ValueError('Additional result display requires an origin and candidate-only adoption')
        if self.inputSnapshot.spec.projectId != self.projectId:
            raise ValueError('Job and generation snapshot belong to different projects')
        if self.inputFingerprint != self.inputSnapshot.fingerprint():
            raise ValueError('Job input fingerprint differs from its snapshot')
        if self.execution.kind != self.inputSnapshot.spec.kind or self.asset and self.asset.kind != self.execution.kind:
            raise ValueError('Job execution/output kind differs from its inputs')
        if self.status == 'succeeded' and self.asset is None:
            raise ValueError('Successful jobs require an actual output asset')
        if self.errorDetails and self.errorDetails.category == 'submission_unknown':
            if self.recovery != 'review' or self.resumeAllowed or self.status in {'queued', 'running', 'succeeded'}:
                raise ValueError('Unknown submissions require review, never automatic resubmission')
        if self.previousJobId == self.id:
            raise ValueError('A new attempt cannot refer to itself')
        if self.recovery == 'remote' and self.externalTaskId is None:
            raise ValueError('Remote recovery requires the original task ID')
        if self.resumeAllowed and self.recovery not in {'submit', 'remote', 'download', 'local'}:
            raise ValueError('Recovery mode cannot resume execution')
        if self.remoteCancellation != 'not_requested' and not self.cancelRequested:
            raise ValueError('Remote cancellation facts require a cancellation request')
        return self


class ResultVersion(ProjectEntity):
    specId: UUID
    jobId: UUID
    asset: AssetRef
    inputFingerprint: Digest


def execution_spec(spec, references, rules):
    """Resolve effective video mode from transmitted inputs, preserving intent.

    Use the same resolution when freezing a job and comparing current inputs
    for automatic adoption. Reference layout without media is text-to-video.
    """
    if (spec.kind == 'video' and spec.parameters.videoMode == 'reference'
            and 'first_frame' in rules.videoModes
            and not any(ref.transmission != 'context_only' and ref.asset.kind != 'text' for ref in references)):
        return spec.model_copy(update={'parameters': spec.parameters.model_copy(update={'videoMode': 'first_frame'})})
    return spec


def validate_generation(spec: GenerationSpec, model: ModelConfigPublic, references: tuple[ResolvedReference, ...] = ()):
    """Pure shared validation; it never submits, uploads or changes a project."""
    if spec.modelConfigId != model.id or model.kind != ('agent' if spec.kind == 'text' else spec.kind):
        raise ValueError('Selected model does not match generation kind')
    if model.inputRules.profile == 'vllm-omni-segmentation':
        raise ValueError('视觉分割模型仅用于选区、分割和抠像，请选择生成模型。')
    if (spec.promptContent is not None and not any(isinstance(part, PromptReference) or part.text.strip() for part in spec.promptContent)) or (spec.promptContent is None and not spec.prompt.strip()):
        raise ValueError('Generation prompt is empty')
    rules = model.inputRules
    if len(references) > 64:
        raise ValueError('Too many references')
    unique([(ref.referenceId, ref.asset.assetId) for ref in references], 'resolved reference assets')
    if spec.promptContent and any(isinstance(part, PromptReference) and part.referenceId not in {ref.referenceId for ref in references} for part in spec.promptContent):
        raise ValueError('Prompt points to an unresolved reference')
    transmitted = [ref for ref in references if ref.role != 'continuation' and ref.transmission != 'context_only']
    if sum(ref.metadata.size for ref in transmitted) > rules.requestBytes:
        raise ValueError('Reference data exceeds the model request budget')
    for ref in transmitted:
        limit = rules.imageBytes if ref.asset.kind == 'image' else rules.videoBytes if ref.asset.kind == 'video' else rules.requestBytes
        if ref.metadata.size > limit:
            raise ValueError('Reference file exceeds the model byte limit')
    kinds = [ref.asset.kind for ref in references if ref.transmission != 'context_only']
    if any(kind not in rules.allowedKinds for kind in kinds):
        raise ValueError('Model does not accept this reference kind')
    for kind, limit in [('image', rules.maxImages), ('video', rules.maxVideos), ('audio', rules.maxAudios)] if spec.kind != 'text' else []:
        count = sum(ref.asset.kind == kind for ref in transmitted)
        if count > limit:
            raise ValueError(f'Too many {kind} references')
    if spec.kind == 'image':
        from opendirector.domain.image_output import resolve_image_output
        if spec.parameters.preset != 'none':
            raise ValueError('当前服务不支持产品三视图预设，请使用自由创作。')
        resolve_image_output(model.model_dump(), rules.model_dump(), spec.parameters.model_dump())
    if spec.kind == 'audio' and rules.profile == 'vllm-omni-music':
        if spec.parameters.creationType != 'music':
            raise ValueError('所选模型用于音乐生成，请切换为音乐生成。')
    elif spec.kind == 'audio' and (spec.parameters.creationType != 'audio' or spec.parameters.mode != 'tts'):
        raise ValueError('当前语音服务仅支持文本朗读。')
    if spec.kind == 'audio' and spec.promptContent is not None and not any(part.type == 'text' and part.text.strip() for part in spec.promptContent):
        raise ValueError('Speech generation requires actual text, not reference labels')
    if spec.kind != 'video':
        if any(ref.role != 'reference' for ref in references):
            raise ValueError('Frame and continuation roles require video generation')
        return
    params = spec.parameters
    if not params.generateAudio and model.protocol != 'volcengine':
        raise ValueError('当前视频适配器不支持关闭生成音频。')
    if params.videoMode == 'first_frame' and len({ref.referenceId for ref in references if ref.asset.kind == 'image' and ref.subjectRole is None}) > 2:
        raise ValueError('首尾帧模式最多连接 2 个图片节点，请先断开多余连线。')
    if params.videoMode not in rules.videoModes:
        raise ValueError('Model does not support this video mode')
    if params.videoMode == 'continuation':
        continuation = [ref for ref in references if ref.role == 'continuation']
        if len(continuation) != 1 or continuation[0].asset.kind != 'video' or kinds.count('video') != 1:
            raise ValueError('Continuation requires one prior video')
        if params.resolution != 'auto':
            raise ValueError('Continuation keeps the previous video size')
    elif any(ref.role == 'continuation' for ref in references):
        raise ValueError('Continuation references require continuation mode')
    if params.videoMode == 'first_frame' and (kinds.count('image') > 1 or any(kind in {'audio', 'video'} for kind in kinds)):
        raise ValueError('First-frame mode accepts at most one image and text')
    if params.videoMode != 'first_frame' and any(ref.role == 'first_frame' for ref in references):
        raise ValueError('First-frame references require first-frame mode')
    if kinds.count('audio') and not (kinds.count('image') or kinds.count('video')):
        raise ValueError('Audio video references require an image or video')
    for kind in ('audio', 'video'):
        seconds = [ref.metadata.durationSeconds for ref in transmitted if ref.asset.kind == kind]
        minimum = 2 if kind == 'audio' else 0
        if any(value is None or value < minimum or value <= 0 for value in seconds) or sum(seconds) > 15:
            raise ValueError(f'{kind.title()} references require a known total duration of at most 15 seconds')
    if rules.profile == 'fasth3-omni' and sum(kind in {'image', 'video', 'audio'} for kind in kinds) > 12:
        raise ValueError('FastH3 accepts at most 12 media references')
    if params.resolution != 'auto':
        choices = rules.referenceImageResolutions if params.videoMode == 'reference' and 'image' in kinds and rules.referenceImageResolutions is not None else rules.outputResolutions
        if params.resolution not in choices:
            raise ValueError('Unsupported output resolution for this reference mode')
    caps = rules.videoCapabilities
    if caps and params.durationSeconds is not None:
        choices = [output for output in caps.outputs if params.resolution == 'auto' or output.resolution == params.resolution]
        if not any(params.durationSeconds in output.durations for output in choices):
            raise ValueError('Unsupported duration/resolution combination')
