"""Commit-file contracts shared by services and storage.

These values describe bytes a command will install or remove. They do not
open project directories or choose where files live.
"""
import hashlib
from uuid import UUID

from pydantic import Field

from opendirector.domain.creation.base import Contract, Fingerprint

CHUNK_BYTES = 1024 * 1024
MAX_CREATION_ASSET_BYTES = 512 * 1024 * 1024
MAX_CREATION_TEXT_BYTES = 1024 * 1024


class AssetFileWrite(Contract):
    assetId: UUID = Field(description='Asset ID.')
    uploadHandle: UUID = Field(description='Server-issued staged upload ID.')
    fingerprint: Fingerprint = Field(description='Immutable content fingerprint.')
    size: int = Field(strict=True, ge=0, le=MAX_CREATION_ASSET_BYTES, description='Content size in bytes.')


class AssetFileDelete(Contract):
    assetId: UUID = Field(description='Asset ID.')
    fingerprint: Fingerprint = Field(description='Immutable content fingerprint.')
    size: int = Field(strict=True, ge=0, le=MAX_CREATION_ASSET_BYTES, description='Content size in bytes.')


def stream_identity(stream):
    digest, size = hashlib.sha256(), 0
    while chunk := stream.read(CHUNK_BYTES):
        digest.update(chunk)
        size += len(chunk)
    return 'sha256:' + digest.hexdigest(), size
