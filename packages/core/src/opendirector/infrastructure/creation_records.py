"""Commit documents published by project storage.

A commit record fixes the command, snapshot, receipt, and optional outbox
event. ``object_changes`` checks revisions when a service hands storage a new
snapshot. Choosing which service runs a command stays in the application layer.
"""
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from opendirector.domain.creation.base import Contract, Digest, ObjectVersion
from opendirector.domain.creation.commands import Command, CommandReceipt, ProjectEvent, command_fingerprint
from opendirector.domain.creation.index import object_index
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.projects import project_name
from opendirector.infrastructure.directories import sync_directory
from opendirector.infrastructure.local_projects import write_json
from opendirector.ports.files import AssetFileDelete, AssetFileWrite


class Manifest(Contract):
    format: Literal['opendirector-project'] = Field(default='opendirector-project', description='Serialized format identifier.')
    formatVersion: Literal[2] = Field(default=2, description='Project format version.')
    id: UUID = Field(description='Stable object ID.')
    name: str = Field(description='User-visible name.')
    head: UUID = Field(description='Current committed command ID.')


class CommitRecord(Contract):
    schemaVersion: Literal[1] = Field(default=1, description='Record schema version.')
    command: Command = Field(description='Immutable command recorded in this commit.')
    previousHead: UUID | None = Field(description='Previous commit ID, or null for project creation.')
    snapshot: ProjectSnapshot = Field(description='Authoritative project snapshot.')
    receipt: CommandReceipt = Field(description='Immutable command execution receipt.')
    event: ProjectEvent | None = Field(description='Project change event, if emitted.')

    @model_validator(mode='after')
    def consistent(self):
        if (self.command.projectId != self.snapshot.project.id
                or self.receipt.projectId != self.command.projectId
                or self.receipt.commandId != self.command.commandId
                or self.receipt.inputFingerprint != command_fingerprint(self.command)
                or self.receipt.eventCursor != self.snapshot.eventCursor):
            raise ValueError('Commit identity is inconsistent')
        applied = self.receipt.status in {'applied', 'accepted'}
        if applied != (self.event is not None):
            raise ValueError('Only applied commits have outbox events')
        if self.event is not None:
            if (self.event.projectId != self.command.projectId or self.event.commandId != self.command.commandId
                    or self.event.cursor != self.snapshot.eventCursor or self.event.jobIds != self.receipt.jobIds
                    or tuple(change.version for change in self.event.changed) != self.receipt.changed):
                raise ValueError('Outbox event differs from the committed receipt')
        return self


class CommitIntent(Contract):
    schemaVersion: Literal[1] = Field(default=1, description='Record schema version.')
    fromName: str | None = Field(description='Original project directory name.')
    toName: str = Field(description='Destination project directory name.')
    beforeFingerprint: Digest | None = Field(description='Fingerprint of the project before this commit.')
    record: CommitRecord = Field(description='Immutable commit awaiting publication.')
    files: tuple[AssetFileWrite, ...] = Field(default=(), description='Staged asset files installed before commit publication.')
    deletes: tuple[AssetFileDelete, ...] = Field(default=(), description='Asset file removals performed after publication.')

    @model_validator(mode='after')
    def consistent(self):
        project_name(self.toName)
        if self.fromName is not None:
            project_name(self.fromName)
        creating = self.fromName is None
        if creating != (self.record.previousHead is None) or creating != (self.beforeFingerprint is None):
            raise ValueError('Creation intent has no prior project')
        if creating and self.record.command.type != 'project.create':
            raise ValueError('First commit must create a project')
        ids = [write.assetId for write in self.files]
        if len(ids) != len(set(ids)):
            raise ValueError('File destinations must be unique')
        assets = {asset.id: asset for asset in self.record.snapshot.assets}
        created = {version.id for version in self.record.receipt.changed if version.objectType == 'asset'}
        for write in self.files:
            asset = assets.get(write.assetId)
            if (asset is None or asset.id not in created or asset.fingerprint != write.fingerprint
                    or asset.metadata.size != write.size):
                raise ValueError('File write must match its committed asset')
        deleted = {change.version.id for change in self.record.event.changed if change.change == 'deleted' and change.version.objectType == 'asset'} if self.record.event else set()
        if any(value.assetId not in deleted or value.assetId in assets for value in self.deletes):
            raise ValueError('Deleted files must have committed asset deletions')
        return self


def durable_json(path: Path, value):
    write_json(path, value)
    sync_directory(path.parent)


def object_changes(before, after, command):
    """The storage boundary also checks revisions on trusted service writes."""
    old = object_index(before) if before else {}
    new = object_index(after)
    expected = {(item.objectType, item.id): item.revision for item in command.expectedVersions}
    changed = []
    for key in sorted(old.keys() | new.keys(), key=lambda item: (item[0], str(item[1]))):
        previous, current = old.get(key), new.get(key)
        if previous == current:
            continue
        kind, object_id = key
        if previous is not None and expected.get(key) != previous.revision:
            raise ContractError('revision_conflict', 'Every changed object requires its current version', object_id)
        if current is not None and current.revision != (previous.revision + 1 if previous else 1):
            raise ContractError('revision_conflict', 'Object revisions must advance exactly once', object_id)
        change = 'created' if previous is None else 'deleted' if current is None else 'updated'
        if kind == 'canvas_item' and previous and current and previous.visible and not current.visible:
            change = 'hidden'
        changed.append(dict(version=ObjectVersion(objectType=kind, id=object_id,
                            revision=current.revision if current else previous.revision), change=change))
    return changed
