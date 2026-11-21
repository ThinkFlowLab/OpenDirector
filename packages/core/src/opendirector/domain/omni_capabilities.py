"""The optional Omni discovery document. Missing declarations remain unknown."""
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Support = Literal['supported', 'unsupported', 'unknown']
Exposure = Literal['enabled', 'disabled', 'unknown']


class Declaration(BaseModel):
    model_config = ConfigDict(extra='ignore', strict=True)


Number = Annotated[int | float, Field(allow_inf_nan=False)]


class InputConstraint(Declaration):
    support: Support = 'unknown'
    min_count: int | None = Field(default=None, ge=0)
    max_count: int | None = Field(default=None, ge=0)

    @model_validator(mode='after')
    def bounds(self):
        if self.min_count is not None and self.max_count is not None and self.min_count > self.max_count:
            raise ValueError('inverted input bounds')
        return self


class ParameterConstraint(Declaration):
    support: Support = 'unknown'
    type: Literal['string', 'integer', 'number', 'boolean'] | None = None
    enum: list[str | int | float | bool] | None = Field(default=None, max_length=1024)
    enum_normalization: Literal['lower', 'title', 'strip_lower'] | None = None
    minimum: Number | None = None
    maximum: Number | None = None
    step: Number | None = Field(default=None, gt=0)

    @model_validator(mode='after')
    def bounds(self):
        if self.enum_normalization is not None and (
                self.type != 'string' or self.enum is None or not all(isinstance(value, str) for value in self.enum)):
            raise ValueError('enum normalization requires a string enum')
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError('inverted parameter bounds')
        return self


class MaskGeometry(Declaration):
    state: Literal['known', 'unknown'] = 'unknown'
    multiple_of: int | None = Field(default=None, ge=1)


class SourceResize(Declaration):
    max_pixels: int | None = Field(default=None, ge=1)
    policy: str | None = None


class MaskConstraint(Declaration):
    support: Support = 'unknown'
    source_role: str | None = None
    max_source_count: int | None = Field(default=None, ge=1)
    white: str | None = None
    black: str | None = None
    binarize_threshold: Number | None = Field(default=None, ge=0, le=1)
    requires_same_size: bool | None = None
    geometry: MaskGeometry = Field(default_factory=MaskGeometry)
    source_resize: SourceResize | None = None


class RequestConstraints(Declaration):
    inputs: dict[str, InputConstraint] = Field(default_factory=dict, max_length=64)
    required_any_of: list[list[str]] = Field(default_factory=list, max_length=32)
    parameters: dict[str, ParameterConstraint] = Field(default_factory=dict, max_length=128)
    mask: MaskConstraint | None = None
    max_output_pixels: int | None = Field(default=None, ge=1)

    @model_validator(mode='after')
    def groups(self):
        if any(not group or len(group) > 32 or len(set(group)) != len(group) for group in self.required_any_of):
            raise ValueError('invalid alternative input group')
        return self


class Route(Declaration):
    method: str = Field(max_length=16)
    path: str = Field(max_length=2048)
    transport: str = 'http'
    exposure: Exposure = 'unknown'
    request: RequestConstraints | None = None


class Profile(Declaration):
    id: str = Field(min_length=1, max_length=100)
    support: Support = 'unknown'
    required_inputs: list[str] = Field(default_factory=list, max_length=32)
    outputs: list[str] = Field(default_factory=list, max_length=32)
    routes: list[Route] = Field(default_factory=list, max_length=32)
    reason_code: str = Field(default='declaration_incomplete', max_length=200)
    request: RequestConstraints | None = None

    @model_validator(mode='after')
    def unique_routes(self):
        check_routes(self.routes)
        return self


class Execution(Declaration):
    state: Literal['unpaused', 'paused', 'unknown'] = 'unknown'
    scope: Literal['deployment', 'worker'] | None = None
    observed_at: str | None = Field(default=None, max_length=100)


class Operation(Declaration):
    support: Support = 'unknown'
    exposure: Exposure = 'unknown'
    reason_code: str = Field(default='declaration_incomplete', max_length=200)
    profiles: list[Profile] = Field(default_factory=list, max_length=64)
    execution: Execution = Field(default_factory=Execution)

    @model_validator(mode='after')
    def unique_profiles(self):
        if len({item.id for item in self.profiles}) != len(self.profiles):
            raise ValueError('duplicate profiles')
        if self.support == 'unsupported' and any(item.support == 'supported' for item in self.profiles):
            raise ValueError('unsupported operation has a supported profile')
        return self


class Model(Declaration):
    id: str = Field(min_length=1, max_length=200)
    stage_ids: list[str] = Field(default_factory=list, max_length=256)
    operations: dict[str, Operation] = Field(default_factory=dict, max_length=64)


class OmniCapabilities(Declaration):
    object: Literal['omni.capabilities']
    schema_version: Literal[1]
    observed_at: str = Field(max_length=100)
    models: list[Model] = Field(max_length=512)
    routes: list[Route] = Field(default_factory=list, max_length=256)

    @model_validator(mode='after')
    def unique_models(self):
        if len({item.id for item in self.models}) != len(self.models):
            raise ValueError('duplicate models')
        timestamp(self.observed_at)
        check_routes(self.routes)
        return self


def check_routes(routes):
    if len({(item.transport, item.method, item.path) for item in routes}) != len(routes):
        raise ValueError('duplicate routes')


def timestamp(value):
    value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('timestamp requires a timezone')
    return value.timestamp()
