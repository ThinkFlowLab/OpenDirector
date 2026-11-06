"""Shared node inheritance and the independent media-role axis."""
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from opendirector.domain.projects import ProjectError

from .assets import AssetRef
from .base import CanvasItemVersion, Contract, Identifier, Point, Positive, ProjectEntity, unique
from .generation import FollowingSource, GenerationSpec, ResolvedReference, validate_generation
from .models import ModelConfigPublic


class FollowingReferenceSource(Contract):
    binding: Literal['follow_current'] = Field(default='follow_current', description='Follow the canvas source current asset.')
    source: FollowingSource = Field(description='Source canvas_item identity.')


class PinnedReferenceSource(Contract):
    binding: Literal['pinned'] = Field(default='pinned', description='Use the fixed asset version.')
    source: AssetRef = Field(description='Fixed current asset version.')
    sourceVersion: CanvasItemVersion = Field(description='Canvas source version retaining the connection.')


class CanvasReferenceSources(Contract):
    followCurrent: FollowingReferenceSource = Field(description='Source fields for a follow_current reference.')
    pinned: PinnedReferenceSource = Field(description='Source fields for a pinned reference retaining its canvas connection.')


CanvasKind = Literal['text', 'image', 'video', 'audio', 'file', 'group', 'timeline', 'subject', 'stack', 'tool', 'external']
MediaRole = Literal['empty', 'material', 'generation']

AUDIO_CARD_SIZE = (300, 112)
MEDIA_CARD_MIN = (160, 120)


def media_card_size(kind, media_width, media_height, base_width, base_height):
    """Keep a media card's envelope in step with the pixels it presents.

    The long edge of the existing card is retained so a portrait clip does not
    jump to a landscape placeholder when an editor publishes its result.
    """
    if kind == 'audio':
        return AUDIO_CARD_SIZE
    if kind not in {'image', 'video'} or not media_width or not media_height:
        return base_width, base_height
    long_edge = max(base_width, base_height)
    ratio = media_width / media_height
    width = long_edge if ratio >= 1 else long_edge * ratio
    height = long_edge / ratio if ratio >= 1 else long_edge
    return max(MEDIA_CARD_MIN[0], int(width + 0.5)), max(MEDIA_CARD_MIN[1], int(height + 0.5))


class GenerationSpecRef(Contract):
    objectType: Literal['generation_spec'] = Field(default='generation_spec', description='Referenced business object type.')
    id: UUID = Field(description='Referenced generation configuration ID.')


class EditorRef(Contract):
    objectType: Literal['editor_document'] = Field(default='editor_document', description='Referenced business object type.')
    id: UUID = Field(description='Referenced editable document ID.')
    kind: Literal['timeline', 'subject', 'stack', 'tool', 'director', 'layers', 'image_crop', 'media_edit'] = Field(description='Business object or media type.')


class EmptyBinding(Contract):
    """An empty canvas item with optional editable draft or manual text."""
    role: Literal['empty'] = Field(description='Business role of this binding or reference.')
    draftSpec: GenerationSpecRef | None = Field(default=None, description='Editable generation draft associated with an empty item.')
    manualText: str | None = Field(default=None, max_length=1024 * 1024, description='Manually entered text for an empty text item.')


class MaterialBinding(Contract):
    """Displays a registered project asset through objectRef."""
    role: Literal['material'] = Field(description='Business role of this binding or reference.')
    objectRef: AssetRef = Field(description='Stable reference to the bound business object.')


class GenerationBinding(Contract):
    """Displays a generation configuration and its adopted result."""
    role: Literal['generation'] = Field(description='Business role of this binding or reference.')
    objectRef: GenerationSpecRef = Field(description='Stable reference to the bound business object.')
    materialOverride: AssetRef | None = Field(default=None, description='Adopted material that overrides the current generated result.')


MediaBinding = Annotated[EmptyBinding | MaterialBinding | GenerationBinding, Field(discriminator='role')]


class EditorBinding(Contract):
    role: Literal['editor'] = Field(description='Business role of this binding or reference.')
    objectRef: EditorRef = Field(description='Stable reference to the bound business object.')


class ContainerBinding(Contract):
    role: Literal['container'] = Field(description='Business role of this binding or reference.')


class CanvasItemBase(ProjectEntity):
    kind: CanvasKind = Field(description='Business object or media type.')
    title: str = Field(default='', max_length=255, description='User-visible title.')
    position: Point = Field(default_factory=Point, description='Position in the owning canvas or stage.')
    width: Positive = Field(default=352, description='Width in pixels.')
    height: Positive = Field(default=198, description='Height in pixels.')
    zIndex: int = Field(default=0, strict=True, description='Canvas stacking order.')
    locked: bool = Field(default=False, description='Whether edits to this object are blocked.')
    visible: bool = Field(default=True, description='Whether this object is displayed.')
    parentId: UUID | None = Field(default=None, description='Parent canvas group ID, or null for the root.')
    tags: tuple[Identifier, ...] = Field(default=(), description='User-defined search tags.')

    @model_validator(mode='after')
    def presentation(self):
        if self.parentId == self.id:
            raise ValueError('Canvas item cannot be its own group parent')
        unique(self.tags, 'canvas tags')
        return self


class MediaCanvasItem(CanvasItemBase):
    binding: MediaBinding = Field(description='Business object displayed by this canvas item.')
    editors: tuple[EditorRef, ...] = Field(default=(), description='Attached editable documents.')

    @model_validator(mode='after')
    def media_role(self):
        if self.binding.role == 'generation' and self.binding.materialOverride is not None and self.binding.materialOverride.kind != self.kind:
            raise ValueError('A generation node can only retain an explicit output of the same kind')
        if self.binding.role == 'material' and self.binding.objectRef.kind != self.kind:
            raise ValueError('Material asset kind differs from canvas item kind')
        if self.binding.role == 'empty' and self.binding.manualText is not None and self.kind != 'text':
            raise ValueError('Only an empty text node can hold a manual text draft')
        if self.kind == 'file' and (self.binding.role == 'generation' or self.binding.role == 'empty' and self.binding.draftSpec):
            raise ValueError('File nodes cannot configure model generation')
        allowed_editors = {'image': {'layers', 'image_crop', 'media_edit'}, 'video': {'media_edit'}, 'audio': {'media_edit'}}.get(self.kind, set())
        if any(editor.kind not in allowed_editors for editor in self.editors):
            raise ValueError('Editor kind is incompatible with the media node')
        unique([editor.id for editor in self.editors], 'node editor references')
        unique([editor.kind for editor in self.editors], 'node editor kinds')
        return self


class TextCanvasItem(MediaCanvasItem):
    kind: Literal['text'] = Field(description='Business object or media type.')


class ImageCanvasItem(MediaCanvasItem):
    kind: Literal['image'] = Field(description='Business object or media type.')


class VideoCanvasItem(MediaCanvasItem):
    kind: Literal['video'] = Field(description='Business object or media type.')


class AudioCanvasItem(MediaCanvasItem):
    kind: Literal['audio'] = Field(description='Business object or media type.')


class FileCanvasItem(MediaCanvasItem):
    kind: Literal['file'] = Field(description='Business object or media type.')


class EditorCanvasItem(CanvasItemBase):
    binding: EditorBinding = Field(description='Business object displayed by this canvas item.')

    @model_validator(mode='after')
    def document_kind(self):
        expected = 'director' if self.kind == 'external' else self.kind
        if self.binding.objectRef.kind != expected:
            raise ValueError('Editor document kind differs from canvas item kind')
        return self


class SubjectCanvasItem(EditorCanvasItem):
    kind: Literal['subject'] = Field(description='Business object or media type.')


class TimelineCanvasItem(EditorCanvasItem):
    kind: Literal['timeline'] = Field(description='Business object or media type.')


class StackCanvasItem(EditorCanvasItem):
    kind: Literal['stack'] = Field(description='Business object or media type.')


class ToolCanvasItem(EditorCanvasItem):
    kind: Literal['tool'] = Field(description='Business object or media type.')


class DirectorCanvasItem(EditorCanvasItem):
    kind: Literal['external'] = Field(description='Business object or media type.')


class GroupCanvasItem(CanvasItemBase):
    kind: Literal['group'] = Field(description='Business object or media type.')
    binding: ContainerBinding = Field(default_factory=lambda: ContainerBinding(role='container'), description='Business object displayed by this canvas item.')


CanvasItem = Annotated[TextCanvasItem | ImageCanvasItem | VideoCanvasItem | AudioCanvasItem | FileCanvasItem |
    SubjectCanvasItem | TimelineCanvasItem | StackCanvasItem | ToolCanvasItem | DirectorCanvasItem | GroupCanvasItem,
    Field(discriminator='kind')]

RoleAction = Literal['configure_generation', 'save_manual_text', 'upload_material', 'add_reference', 'accept_generation', 'select_result']


def role_after(role: MediaRole, action: RoleAction, *, accepted=True) -> MediaRole:
    """Pure transition guard. Only a successfully committed action locks purpose.

    C06 performs version checks and atomic writes. Clients cannot set a role.
    History replay is separate: undoing the initial accepted write may restore
    the original empty binding without deleting its retained asset or task.
    """
    allowed = {
        'configure_generation': ({'empty', 'generation'}, None),
        'save_manual_text': ({'empty', 'material'}, 'material'),
        'upload_material': ({'empty', 'material'}, 'material'),
        'add_reference': ({'empty', 'generation'}, 'generation'),
        'accept_generation': ({'empty', 'generation'}, 'generation'),
        'select_result': ({'generation'}, None),
    }
    if action not in allowed or role not in allowed[action][0]:
        raise ValueError('Operation is incompatible with the node role')
    return allowed[action][1] if accepted and allowed[action][1] else role


class NodeCapabilities(Contract):
    canEdit: bool = Field(description='Whether the current content can be edited.')
    canConfigureGeneration: bool = Field(description='Whether generation settings can be configured.')
    canGenerate: bool = Field(description='Whether generation can be submitted.')
    canAcceptReferences: bool = Field(description='Whether the item accepts generation references.')
    canUseAsReference: bool = Field(description='Whether the item can supply a generation reference.')
    canPlay: bool = Field(description='Whether the current media can be played.')
    canExport: bool = Field(description='Whether the current content can be exported.')
    canReplaceMaterial: bool = Field(description='Whether the bound material can be replaced.')


def node_capabilities(item: CanvasItem, *, spec: GenerationSpec | None = None,
                      model: ModelConfigPublic | None = None, references: tuple[ResolvedReference, ...] = (),
                      assetAvailable=False) -> NodeCapabilities:
    """UI projection only; commands must still enforce roles and versions."""
    role = item.binding.role
    editable = not item.locked
    configure = editable and item.kind in {'text', 'image', 'video', 'audio'} and (role in {'empty', 'generation'} or item.kind == 'text' and role == 'material')
    spec_ref = (item.binding.objectRef if role == 'generation' else item.binding.draftSpec if role == 'empty' else None)
    matching = spec is not None and spec_ref is not None and spec_ref.id == spec.id and spec.kind == item.kind
    generate = False
    if configure and matching and model is not None:
        try:
            validate_generation(spec, model, references)
            generate = True
        except (ValueError, ProjectError):
            pass
    return NodeCapabilities(
        canEdit=editable and (role == 'editor' or role == 'material' and assetAvailable
                             or item.kind == 'text'
                             or role == 'generation' and item.kind in {'image', 'video', 'audio'} and assetAvailable),
        canConfigureGeneration=configure,
        canGenerate=generate,
        canAcceptReferences=configure and matching and model is not None
            and spec.modelConfigId == model.id and model.kind == ('agent' if item.kind == 'text' else item.kind)
            and bool(model.inputRules.allowedKinds),
        canUseAsReference=editable and assetAvailable and item.kind in {'text', 'image', 'video', 'audio'} and role in {'material', 'generation'},
        canPlay=assetAvailable and item.kind in {'video', 'audio'} or role == 'editor' and item.kind in {'timeline', 'external'},
        canExport=assetAvailable or role == 'editor',
        canReplaceMaterial=editable and role in {'empty', 'material'} and item.kind in {'text', 'image', 'video', 'audio', 'file'})
