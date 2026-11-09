from typing import Literal
from uuid import UUID

from pydantic import model_validator, BaseModel, ConfigDict, Field, SecretStr
from opendirector.domain.creation.editors import ToolDraftBinding
from opendirector.domain.capabilities import AgentInputModality
from opendirector.domain.video_capabilities import VideoAdapter, VideoCapabilities


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Session(Model):
    projectId: UUID


class AssetSource(Model):
    """An asset in another creation project, copied on the server."""
    projectId: UUID
    assetId: UUID
    fingerprint: str | None = Field(default=None, max_length=128, description='Expected source content; a different one is refused.')


class ModelConnection(Model):
    connectionType: Literal['api', 'self_hosted'] = 'api'
    protocol: Literal['openai', 'volcengine', 'kling_video', 'minimax_video_v2', 'vllm_omni', 'vllm_omni_segmentation', 'vllm_omni_music', 'vllm_omni_depth', 'vllm_omni_score'] | None = None
    authMode: Literal['none', 'bearer'] | None = None
    proxyMode: Literal['system', 'direct'] | None = None


class ModelConfigInput(ModelConnection):
    kind: Literal["agent", "image", "video", "audio", "vision"]
    url: str = Field(max_length=2048)
    modelId: str = Field(max_length=200)
    apiKey: SecretStr = SecretStr("")
    inputModalities: list[AgentInputModality] | None = Field(default=None, min_length=1, max_length=2)
    videoAdapter: VideoAdapter | None = None
    videoCapabilities: VideoCapabilities | None = None


class ModelOptions(Model):
    inputModalities: list[AgentInputModality] | None = Field(default=None, min_length=1, max_length=2)
    videoAdapter: VideoAdapter | None = None
    videoCapabilities: VideoCapabilities | None = None


class ModelBatchInput(ModelConfigInput):
    modelId: str = ""
    modelIds: list[str] = Field(min_length=1, max_length=200)
    modelOptions: dict[str, ModelOptions] = Field(default_factory=dict, max_length=200)
    configId: UUID | None = None


class ModelDiscoveryRequest(ModelConfigInput):
    modelId: str = Field(default="", max_length=200)
    configId: UUID | None = None


class AgentModelTest(ModelConfigInput):
    kind: Literal["agent"] = "agent"
    configId: UUID | None = None


class ModelCapabilityRequest(ModelConfigInput):
    configId: UUID | None = None
    source: Literal['preset', 'service'] = 'preset'


class ModelConfigPublic(ModelConnection):
    providerId: UUID | None = Field(default=None, exclude_if=lambda value: value is None)
    videoAdapter: VideoAdapter = 'auto'
    videoCapabilities: VideoCapabilities | None = None
    inputModalities: list[AgentInputModality] | None = None
    inputRules: dict = Field(default_factory=dict)
    id: UUID
    kind: Literal["agent", "image", "video", "audio", "vision"]
    url: str
    modelId: str


class ToolBox(Model):
    x: float = Field(ge=0, allow_inf_nan=False)
    y: float = Field(ge=0, allow_inf_nan=False)
    width: float = Field(gt=0, allow_inf_nan=False)
    height: float = Field(gt=0, allow_inf_nan=False)


class ToolTaskCreate(Model):
    draft: ToolDraftBinding | None = None
    id: UUID
    tool: str = Field(min_length=1, max_length=64, pattern=r'^[a-z0-9-]+$')
    sourceAssetIds: list[UUID] = Field(min_length=1, max_length=20)
    maskAssetId: UUID | None = None
    annotationAssetId: UUID | None = None
    boxes: list[ToolBox] = Field(default_factory=list, max_length=100)
    parameters: dict[str, str | float | int | bool] = Field(default_factory=dict, max_length=64)
    # Optional explicit model per capability; otherwise the first configured provider serves it.
    modelConfigIds: dict[str, UUID] = Field(default_factory=dict, max_length=8)
    canvas: 'ToolCanvasOrigin | None' = None

    @model_validator(mode='after')
    def bounded_parameters(self):
        if any(len(key) > 64 or (isinstance(value, str) and len(value) > 100_000) for key, value in self.parameters.items()):
            raise ValueError('parameters')
        return self


class ImageSelectionCreate(Model):
    sourceAssetId: UUID
    prompt: str = Field(default='', max_length=2000)
    boxes: list[ToolBox] = Field(default_factory=list, max_length=64)
    modelConfigId: UUID | None = None


class ToolCanvasOrigin(Model):
    nodeId: UUID
    sourceNodeIds: list[UUID] = Field(min_length=1, max_length=20)
    targetNodeId: UUID | None = None
    targetKind: Literal['image', 'video', 'audio'] | None = None
    targetTitle: str | None = Field(default=None, min_length=1, max_length=255)

    @model_validator(mode='after')
    def pending_target(self):
        values = (self.targetNodeId, self.targetKind, self.targetTitle)
        if any(value is not None for value in values):
            if not all(value is not None for value in values) or self.targetNodeId in self.sourceNodeIds:
                raise ValueError('pending result identity')
        return self


class ToolPlacement(Model):
    state: Literal['placed', 'unplaced']
    policy: Literal['if_current', 'explicit'] = 'if_current'
