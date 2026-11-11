"""Versioned JSON contracts for the new project format; no storage or UI code."""
from typing import Annotated, Literal
from uuid import UUID
import hashlib
import json

from pydantic import BaseModel, ConfigDict, Field

Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
NonNegative = Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]
Positive = Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]
Revision = Annotated[int, Field(strict=True, ge=1)]
PositiveInt = Annotated[int, Field(strict=True, ge=1)]
Identifier = Annotated[str, Field(min_length=1, max_length=100, pattern=r'\S')]
Fingerprint = Annotated[str, Field(pattern=r'^sha256:[0-9a-f]{64}$')]
Digest = Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]
MediaKind = Literal['text', 'image', 'video', 'audio', 'file']
GenerationKind = Literal['text', 'image', 'video', 'audio']


class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True, allow_inf_nan=False,
                             json_schema_serialization_defaults_required=True)

    @classmethod
    def __get_pydantic_json_schema__(cls, core_schema, handler):
        schema = handler(core_schema)
        if handler.mode == 'serialization':
            schema = handler.resolve_ref_schema(schema)
            # Conditional omission is supported by our minimum Pydantic, but
            # 2.12 still marks these fields as required in serialization schemas.
            required = schema.get('required')
            if required:
                schema['required'] = [name for name in required
                    if name not in cls.model_fields or cls.model_fields[name].exclude_if is None]
        return schema

    @classmethod
    def __pydantic_init_subclass__(cls, **kwargs: object) -> None:
        super().__pydantic_init_subclass__(**kwargs)
        missing = [name for name, field in cls.model_fields.items()
                   if not field.description or not field.description.strip()]
        if missing:
            raise TypeError(f'Missing field metadata: {cls.__name__}.{", ".join(missing)}')


class ProjectEntity(Contract):
    id: UUID = Field(description='Stable identity of this project-owned object.')
    projectId: UUID = Field(description='Owning project ID.')
    revision: Revision = Field(default=1, description='Current object revision for optimistic concurrency.')


class ObjectVersion(Contract):
    objectType: Literal['project', 'asset', 'generation_spec', 'reference', 'canvas_item', 'editor_document', 'job', 'result'] = Field(description='Referenced business object type.')
    id: UUID = Field(description='Stable object ID.')
    revision: Revision = Field(description='Current object revision for optimistic concurrency.')


class CanvasItemVersion(ObjectVersion):
    objectType: Literal['canvas_item'] = Field(description='Source canvas item type.')


class Point(Contract):
    x: Number = Field(default=0, description='Horizontal coordinate.')
    y: Number = Field(default=0, description='Vertical coordinate.')


def digest(value: Contract, *, exclude=None) -> str:
    """Stable normalized JSON identity. Persistence/idempotent replay is C03."""
    encoded = json.dumps(value.model_dump(mode='json', exclude=exclude), ensure_ascii=False, sort_keys=True,
                         separators=(',', ':'), allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def unique(values, label):
    if len(values) != len(set(values)):
        raise ValueError(f'Duplicate {label}')
