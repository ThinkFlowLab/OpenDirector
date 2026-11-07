"""Preserve OpenDirector's model configuration and capability vocabulary."""
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import Field, SecretStr, field_validator, model_validator

from opendirector.domain.capabilities import agent_input_modalities
from opendirector.domain.video_capabilities import VideoCapabilities as ExistingVideoCapabilities
from opendirector.domain.video_capabilities import VideoAdapter, check_video_config
from opendirector.domain.projects import ProjectError
from .base import Contract

ModelKind = Literal['agent', 'image', 'video', 'audio', 'vision']
Protocol = Literal['openai', 'volcengine', 'minimax_video_v2', 'vllm_omni', 'vllm_omni_segmentation', 'vllm_omni_music', 'vllm_omni_depth', 'vllm_omni_score', 'placeholder']
VideoMode = Literal['first_frame', 'reference', 'continuation']
Count = Annotated[int, Field(strict=True, ge=0)]

# Marker base URL for the built-in placeholder generator. It is allow-listed in
# ModelConnection.service_url and is never dialed: dispatch happens on the
# protocol before any network use.
BUILTIN_PLACEHOLDER_URL = 'builtin://placeholder'


class VideoCapabilities(ExistingVideoCapabilities):
    # Reuse the existing validation and preset semantics, with output defaults
    # explicit in the generated response schema.
    model_config = {**Contract.model_config, 'frozen': False}


class ImageOutput(Contract):
    aspectRatio: str = Field(pattern=r'^(?:auto|[1-9]\d?:[1-9]\d?)$', description='Output width-to-height ratio.')
    size: str = Field(pattern=r'^(?:2K|[1-9]\d{2,3}x[1-9]\d{2,3})$', description='Supported image dimensions or size preset.')


class InputRules(Contract):
    profile: str = Field(min_length=1, max_length=100, description='Model capability profile.')
    maxPromptCharacters: Annotated[int, Field(strict=True, ge=1)] | None = Field(
        default=None, exclude_if=lambda value: value is None, description='Maximum characters in the final prompt including text references.')
    voiceRequired: bool | None = Field(default=None, exclude_if=lambda value: value is None,
        description='Whether speech generation requires an explicit service voice ID.')
    referencesAllowed: bool | None = Field(default=None, exclude_if=lambda value: value is None,
        description='Whether references may be attached, including context-only references.')
    allowedKinds: tuple[Literal['text', 'image', 'video', 'audio'], ...] = Field(description='Accepted reference media kinds.')
    maxImages: Count = Field(description='Maximum reference image count.')
    maxVideos: Count = Field(description='Maximum reference video count.')
    maxAudios: Count = Field(description='Maximum reference audio count.')
    imageBytes: Count = Field(description='Maximum bytes per reference image.')
    videoBytes: Count = Field(description='Maximum bytes per reference video.')
    requestBytes: Count = Field(description='Maximum aggregate reference bytes per request.')
    videoModes: tuple[VideoMode, ...] = Field(description='Supported video generation modes.')
    imageOutputs: tuple[ImageOutput, ...] = Field(default=(), description='Supported image aspect ratios and sizes.')
    outputResolutions: tuple[str, ...] = Field(default=(), description='Supported output resolution values.')
    referenceImageResolutions: tuple[str, ...] | None = Field(default=None, description='Supported reference image resolution values.')
    videoCapabilities: VideoCapabilities | None = Field(default=None, description='Supported video generation capabilities.')

    aspectRatios: tuple[str, ...] | None = Field(default=None, exclude_if=lambda value: value is None,
        description='Supported explicit video output aspect ratios; unset uses existing protocol rules.')
    frameRoles: tuple[Literal['first_frame', 'last_frame'], ...] | None = Field(
        default=None, exclude_if=lambda value: value is None, description='Supported explicit image frame slots.')
    audioReferenceStandalone: bool | None = Field(default=None, exclude_if=lambda value: value is None,
        description='Whether audio-only references are supported.')

    generateAudioOptions: tuple[Annotated[bool, Field(strict=True)], ...] | None = Field(
        default=None, min_length=1, max_length=2, exclude_if=lambda value: value is None,
        description='Allowed generateAudio values; omitted in legacy execution snapshots.')

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
    kind: ModelKind = Field(description='Business object or media type.')
    url: str = Field(min_length=1, max_length=2048, description='Provider API base URL.')
    modelId: str = Field(min_length=1, max_length=200, description='Provider-native model identifier.')
    connectionType: Literal['api', 'self_hosted', 'builtin'] = Field(description='Hosted, local, or built-in model connection type.')
    protocol: Protocol = Field(description='Provider wire protocol.')
    authMode: Literal['none', 'bearer'] = Field(description='Authentication mode for the provider connection.')
    proxyMode: Literal['system', 'direct'] = Field(default='system', description='Use the system proxy or connect directly to the model service.')
    inputModalities: tuple[Literal['text', 'image'], ...] | None = Field(default=None, description='Supported model input media kinds.')
    videoAdapter: VideoAdapter = Field(default='auto', description='Provider-specific video adapter.')
    videoCapabilities: VideoCapabilities | None = Field(default=None, description='Supported video generation capabilities.')

    @field_validator('url')
    @classmethod
    def service_url(cls, value):
        value = value.strip()
        if value == BUILTIN_PLACEHOLDER_URL:
            return value
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
        allowed = {'agent': {'openai'}, 'image': {'openai', 'volcengine', 'vllm_omni_segmentation', 'placeholder'},
                   'video': {'minimax_video_v2', 'vllm_omni', 'volcengine', 'vllm_omni_segmentation', 'vllm_omni_depth'},
                   'audio': {'openai', 'volcengine', 'vllm_omni_music', 'vllm_omni_score'}, 'vision': {'vllm_omni'}}
        if self.protocol not in allowed[self.kind]:
            raise ValueError('Protocol is incompatible with model category')
        try:
            agent_input_modalities(self.kind, self.inputModalities)
            check_video_config(self.kind, self.protocol, self.videoAdapter,
                               self.videoCapabilities.model_dump(exclude_none=True) if self.videoCapabilities else None)
        except ProjectError as error:
            raise ValueError(str(error)) from None
        return self


class ModelConfigPublic(ModelConnection):
    """Application-level, never embedded in an editable project's credential data."""
    id: UUID = Field(description='Stable object ID.')
    providerId: UUID | None = Field(default=None, exclude=True, description='Shared provider connection ID.')
    inputRules: InputRules = Field(description='Verified model input limits and output choices.')


class ModelConfigWrite(ModelConnection):
    """Only the model-settings write boundary accepts a credential."""
    apiKey: SecretStr | None = Field(default=None, max_length=8192, description='Provider credential; omitted from public model records.')

    @field_validator('apiKey')
    @classmethod
    def credential(cls, value):
        if value and any(ord(char) < 32 for char in value.get_secret_value()):
            raise ValueError('Invalid credential')
        return value


class ModelSnapshot(Contract):
    modelConfigId: UUID = Field(description='Model configuration ID from the model catalog or user model selections.')
    kind: ModelKind = Field(description='Business object or media type.')
    modelId: str = Field(min_length=1, max_length=200, description='Provider-native model identifier.')
    url: str = Field(min_length=1, max_length=2048, description='Provider API base URL.')
    protocol: Protocol = Field(description='Provider wire protocol.')
    connectionType: Literal['api', 'self_hosted', 'builtin'] = Field(description='Hosted, local, or built-in model connection type.')
    proxyMode: Literal['system', 'direct'] = Field(default='system', exclude_if=lambda value: value == 'system', description='Network routing selected when the job was accepted.')
    inputModalities: tuple[Literal['text', 'image'], ...] | None = Field(default=None, exclude_if=lambda value: value is None, description='Supported model input media kinds.')
    videoAdapter: VideoAdapter = Field(default='auto', description='Provider-specific video adapter.')
    inputRules: InputRules | None = Field(default=None, description='Verified model input limits and output choices.')

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
                        authMode='none', videoAdapter=self.videoAdapter, inputModalities=self.inputModalities)
        return self
