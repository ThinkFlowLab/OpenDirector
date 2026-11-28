"""Commit-file contracts shared by services and storage.

These values describe bytes a command will install or remove. They do not
open project directories or choose where files live.
"""
from collections.abc import Iterable
import hashlib
from typing import BinaryIO
from uuid import UUID

from pydantic import Field

from opendirector.domain.creation.base import Contract, Fingerprint
from opendirector.domain.projects import ProjectError

CHUNK_BYTES = 1024 * 1024
MAX_CREATION_TEXT_BYTES = 1024 * 1024


class AssetFileWrite(Contract):
    assetId: UUID = Field(description='Asset ID.')
    uploadHandle: UUID = Field(description='Server-issued staged upload ID.')
    fingerprint: Fingerprint = Field(description='Immutable content fingerprint.')
    size: int = Field(strict=True, ge=0, description='Content size in bytes.')


class AssetFileDelete(Contract):
    assetId: UUID = Field(description='Asset ID.')
    fingerprint: Fingerprint = Field(description='Immutable content fingerprint.')
    size: int = Field(strict=True, ge=0, description='Content size in bytes.')


def stream_identity(stream):
    digest, size = hashlib.sha256(), 0
    while chunk := stream.read(CHUNK_BYTES):
        digest.update(chunk)
        size += len(chunk)
    return 'sha256:' + digest.hexdigest(), size


def copy_verified_asset(chunks: Iterable[bytes], output: BinaryIO, *, size: int, fingerprint: str) -> None:
    """Copy original bytes with a size bound and verify them before reporting success."""
    digest = hashlib.sha256()
    written = 0
    for chunk in chunks:
        written += len(chunk)
        if written > size:
            break
        output.write(chunk)
        digest.update(chunk)
    if written != size or 'sha256:' + digest.hexdigest() != fingerprint:
        raise ProjectError('下载内容与素材指纹或大小不一致。请检查来源并使用新文件名重试。',
                           409, code='asset_download_integrity')
