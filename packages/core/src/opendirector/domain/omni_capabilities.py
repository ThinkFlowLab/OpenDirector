"""The optional Omni discovery document. Missing declarations remain unknown."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Support = Literal['supported', 'unsupported', 'unknown']
Exposure = Literal['enabled', 'disabled', 'unknown']


class Declaration(BaseModel):
    model_config = ConfigDict(extra='ignore', strict=True)


class Route(Declaration):
    method: str = Field(max_length=16)
    path: str = Field(max_length=2048)
    transport: str = 'http'
    exposure: Exposure = 'unknown'


class Profile(Declaration):
    id: str = Field(min_length=1, max_length=100)
    support: Support = 'unknown'
    required_inputs: list[str] = Field(default_factory=list, max_length=32)
    outputs: list[str] = Field(default_factory=list, max_length=32)
    routes: list[Route] = Field(default_factory=list, max_length=32)
    reason_code: str = Field(default='declaration_incomplete', max_length=200)

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
