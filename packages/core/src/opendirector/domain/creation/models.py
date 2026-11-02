"""Preserve OpenDirector's model configuration and capability vocabulary."""
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import Field, SecretStr, field_validator, model_validator

from opendirector.domain.video_capabilities import VideoCapabilities as ExistingVideoCapabilities
from opendirector.domain.video_capabilities import VideoAdapter, check_video_config
from opendirector.domain.projects import ProjectError
from .base import Contract

ModelKind = Literal['agent', 'image', 'video', 'audio', 'vision']
Protocol = Literal['openai', 'volcengine', 'vllm_omni', 'vllm_omni_segmentation', 'vllm_omni_music']
VideoMode = Literal['first_frame', 'reference', 'continuation']
Count = Annotated[int, Field(strict=True, ge=0)]


class VideoCapabilities(ExistingVideoCapabilities):
    # Reuse the existing validation and preset semantics, with output defaults
    # explicit in the generated response schema.
    model_config = {**Contract.model_config, 'frozen': False}


class ImageOutput(Contract):
    aspectRatio: str = Field(pattern=r'^(?:auto|[1-9]\d?:[1-9]\d?)$')
    size: str = Field(pattern=r'^(?:2K|[1-9]\d{2,3}x[1-9]\d{2,3})$')


class InputRules(Contract):
    profile: str = Field(min_length=1, max_length=100)
    allowedKinds: tuple[Literal['text', 'image', 'video', 'audio'], ...]
    maxImages: Count
    maxVideos: Count
    maxAudios: Count
    imageBytes: Count
    videoBytes: Count
    requestBytes: Count
    videoModes: tuple[VideoMode, ...]
    imageOutputs: tuple[ImageOutput, ...] = ()
    outputResolutions: tuple[str, ...] = ()
    referenceImageResolutions: tuple[str, ...] | None = None
    videoCapabilities: VideoCapabilities | None = None

    @model_validator(mode='after')
    def consistent(self):
        from .base import unique
        for name in ('allowedKinds', 'videoModes', 'outputResolutions'):
            unique(getattr(self, name), name)
        if self.videoCapabilities:
            labels = {item.resolution for item in self.videoCapabilities.outputs}
            if set(self.outputResolutions) != labels:
                raise ValueError('Output resolutions must match declared video capabilities')
        if self.referenceImageResolutions is not None and not set(self.referenceImageResolutions) <= set(self.outputResolutions):
            raise ValueError('Reference resolutions must be supported output resolutions')
        return self


class ModelConnection(Contract):
    kind: ModelKind
    url: str = Field(min_length=1, max_length=2048)
    modelId: str = Field(min_length=1, max_length=200)
    connectionType: Literal['api', 'self_hosted']
    protocol: Protocol
    authMode: Literal['none', 'bearer']
    videoAdapter: VideoAdapter = 'auto'
    videoCapabilities: VideoCapabilities | None = None

    @field_validator('url')
    @classmethod
    def service_url(cls, value):
        value = value.strip()
        try:
            parsed = urlsplit(value)
            valid = (parsed.scheme in {'http', 'https'} and parsed.hostname and not parsed.username
                     and not parsed.password and not parsed.query and not parsed.fragment)
            parsed.port
        except ValueError:
            valid = False
        if not valid or any(char.isspace() for char in value):
            raise ValueError('Invalid service base URL')
        return value

    @field_validator('modelId')
    @classmethod
    def model_name(cls, value):
        if not value.strip() or any(ord(char) < 32 for char in value):
            raise ValueError('Invalid remote model ID')
        return value.strip()

    @model_validator(mode='after')
    def connection(self):
        allowed = {'agent': {'openai'}, 'image': {'openai', 'volcengine', 'vllm_omni_segmentation'},
                   'video': {'vllm_omni', 'volcengine', 'vllm_omni_segmentation'},
                   'audio': {'openai', 'volcengine', 'vllm_omni_music'}, 'vision': {'vllm_omni'}}
        if self.protocol not in allowed[self.kind]:
            raise ValueError('Protocol is incompatible with model category')
        try:
            check_video_config(self.kind, self.protocol, self.videoAdapter,
                               self.videoCapabilities.model_dump(exclude_none=True) if self.videoCapabilities else None)
        except ProjectError as error:
            raise ValueError(str(error)) from None
        return self


class ModelConfigPublic(ModelConnection):
    """Application-level, never embedded in an editable project's credential data."""
    id: UUID
    providerId: UUID | None = Field(default=None, exclude=True)
    inputRules: InputRules


class ModelConfigWrite(ModelConnection):
    """Only the model-settings write boundary accepts a credential."""
    apiKey: SecretStr | None = Field(default=None, max_length=8192)

    @field_validator('apiKey')
    @classmethod
    def credential(cls, value):
        if value and any(ord(char) < 32 for char in value.get_secret_value()):
            raise ValueError('Invalid credential')
        return value


class ModelSnapshot(Contract):
    modelConfigId: UUID
    kind: ModelKind
    modelId: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=2048)
    protocol: Protocol
    connectionType: Literal['api', 'self_hosted']
    videoAdapter: VideoAdapter = 'auto'
    inputRules: InputRules | None = None

    @field_validator('url')
    @classmethod
    def service_url(cls, value):
        return ModelConnection.service_url(value)

    @field_validator('modelId')
    @classmethod
    def model_name(cls, value):
        return ModelConnection.model_name(value)

    @model_validator(mode='after')
    def connection(self):
        ModelConnection(kind=self.kind, url=self.url, modelId=self.modelId,
                        connectionType=self.connectionType, protocol=self.protocol,
                        authMode='none', videoAdapter=self.videoAdapter)
        return self
