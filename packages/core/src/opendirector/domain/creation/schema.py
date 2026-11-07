"""Export authoritative input/output schemas for HTTP, Agent and TypeScript."""
from pydantic import Field

from .base import Contract
from .assets import UploadInfo
from .canvas import CanvasItem, CanvasItemBase, MediaRole, NodeCapabilities, RoleAction
from .commands import Command, CommandReceipt, ProjectEvent, Query
from .editors import EditorDocument
from .generation import ExecutionParameters, GenerationSpec, InputSnapshot, Job, PromptPart, Reference, ResultVersion
from .models import ModelConfigPublic, ModelConfigWrite, ModelKind, VideoMode
from .project import ProjectSnapshot, ViewState
from .timeline_packages import TimelinePackageManifest, TimelinePackageImportRequest, TimelinePackageImportReceipt


class CreationContracts(Contract):
    project: ProjectSnapshot = Field(description='Authoritative project snapshot schema.')
    canvasItem: CanvasItem = Field(description='Canvas item schema.')
    generationSpec: GenerationSpec = Field(description='Generation configuration schema.')
    reference: Reference = Field(description='Generation reference to create or update.')
    editorDocument: EditorDocument = Field(description='Editable document schema.')
    command: Command = Field(description='Immutable command recorded in this commit.')
    receipt: CommandReceipt = Field(description='Immutable command execution receipt.')
    query: Query = Field(description='Read-only project query.')
    event: ProjectEvent = Field(description='Project change event, if emitted.')
    job: Job = Field(description='Generation execution record.')
    result: ResultVersion = Field(description='Generated result schema.')
    snapshot: InputSnapshot = Field(description='Fixed generation input schema.')
    executionParameters: ExecutionParameters = Field(description='Effective provider execution parameter schema.')
    promptPart: PromptPart = Field(description='Structured prompt token schema.')
    publicModel: ModelConfigPublic = Field(description='Public model connection schema.')
    writeModel: ModelConfigWrite = Field(description='Model configuration input schema.')
    capabilities: NodeCapabilities = Field(description='Available canvas item operations.')
    viewState: ViewState = Field(description='Client-specific canvas view state.')
    timelinePackageManifest: TimelinePackageManifest = Field(description='Native editable timeline bundle manifest.')
    timelinePackageImport: TimelinePackageImportRequest = Field(description='Recoverable native bundle import request.')
    timelinePackageReceipt: TimelinePackageImportReceipt = Field(description='Native bundle import progress and final receipt.')
    upload: UploadInfo = Field(description='Staged upload schema.')


ALIASES = {
    'CanvasItem': CanvasItem, 'GenerationSpec': GenerationSpec, 'Reference': Reference,
    'EditorDocument': EditorDocument, 'Command': Command, 'ExecutionParameters': ExecutionParameters,
    'PromptPart': PromptPart, 'MediaRole': MediaRole, 'RoleAction': RoleAction,
    'ModelKind': ModelKind, 'VideoMode': VideoMode,
}
