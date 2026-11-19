"""Typed navigation metadata persisted with assistant conversation replies."""
from typing import Literal
from uuid import UUID

from pydantic import Field

from .base import Contract


class ChatCanvasLinkCandidate(Contract):
    nodeId: UUID | None = Field(default=None, description='Canvas item candidate identity.')
    assetId: UUID | None = Field(default=None, description='Project asset candidate identity.')
    kind: str | None = Field(default=None, description='Candidate business kind.')
    title: str | None = Field(default=None, description='Candidate display title.')
    hidden: bool | None = Field(default=None, description='Whether the candidate is hidden.')


class ChatCanvasLink(Contract):
    target: str = Field(description='Original Markdown destination.')
    status: Literal['focused', 'hidden', 'materialize', 'ambiguous', 'missing',
                    'cross-project', 'external'] = Field(description='Typed link resolution outcome.')
    nodeId: UUID | None = Field(default=None, description='Resolved canvas item identity.')
    assetId: UUID | None = Field(default=None, description='Resolved project asset identity.')
    projectId: UUID | None = Field(default=None, description='Destination project identity.')
    kind: str | None = Field(default=None, description='Resolved business kind.')
    action: Literal['reveal', 'materialize'] | None = Field(default=None, description='Required presentation action.')
    candidates: tuple[ChatCanvasLinkCandidate, ...] | None = Field(default=None, description='Candidates requiring user choice.')
