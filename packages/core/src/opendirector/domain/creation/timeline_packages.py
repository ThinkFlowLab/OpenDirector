"""Native editable timeline exchange and recoverable import contracts."""
from typing import Literal
from uuid import UUID
from pydantic import Field, model_validator
from .assets import AssetRef
from .base import Contract, Fingerprint, MediaKind, Revision
from .commands import CommandReceipt


class TimelinePackageResource(Contract):
    source: AssetRef = Field(description='Original logical reference; only a package mapping key.')
    name: str = Field(min_length=1, max_length=255, description='Original resource filename.')
    path: str = Field(pattern=r'^assets/[0-9a-f]{64}\.[a-z0-9]{1,10}$', description='Content-addressed archive member.')
    kind: MediaKind = Field(description='Verified media kind.')
    mimeType: str = Field(min_length=1, max_length=255, description='Verified MIME type.')
    size: int = Field(strict=True, ge=0, le=512 * 1024 * 1024, description='Actual resource byte count.')
    fingerprint: Fingerprint = Field(description='SHA-256 identity of resource bytes.')

    @model_validator(mode='after')
    def identity(self):
        if self.source.kind != self.kind or self.source.fingerprint != self.fingerprint:
            raise ValueError('Resource identity differs from its original reference')
        if self.path.split('/')[1].split('.')[0] != self.fingerprint[7:]:
            raise ValueError('Resource path differs from its fingerprint')
        return self


class TimelinePackageManifest(Contract):
    format: Literal['opendirector-timeline-bundle'] = Field(default='opendirector-timeline-bundle', description='Native bundle format.')
    version: Literal[1] = Field(default=1, description='Native bundle format version.')
    requiredCapabilities: tuple[Literal['timeline.text.v1'], ...] = Field(default=(), max_length=1, description='Required editable document capabilities.')
    resources: tuple[TimelinePackageResource, ...] = Field(max_length=4093, description='Distinct logical resources; paths may share identical bytes.')


class TimelinePackageImportRequest(Contract):
    operationId: UUID = Field(description='Stable identity for this entire import and all retries.')
    uploadHandle: UUID = Field(description='Project/session-owned staged ZIP upload.')
    archiveFingerprint: Fingerprint = Field(description='Fixed archive bytes for recovery and replay.')
    replaceEditorId: UUID | None = Field(default=None, description='Explicit replacement target; omitted creates a timeline.')
    expectedRevision: Revision | None = Field(default=None, description='Required original revision for replacement.')

    @model_validator(mode='after')
    def target(self):
        if (self.replaceEditorId is None) != (self.expectedRevision is None):
            raise ValueError('Replacement requires both editor ID and expected revision')
        return self


class TimelinePackageImportReceipt(Contract):
    operationId: UUID = Field(description='Import identity.')
    status: Literal['registered', 'applied', 'rejected'] = Field(description='Partial registration, complete publication, or terminal rejection.')
    editorId: UUID = Field(description='Stable destination document ID.')
    registeredAssetIds: tuple[UUID, ...] = Field(default=(), description='Resources actually committed before final publication.')
    receipt: CommandReceipt | None = Field(default=None, description='Final atomic business command receipt, when committed.')
    errorCode: str | None = Field(default=None, description='Stable failure code for retryable registration failure.')


class TimelinePackageExportFile(Contract):
    editorId: UUID = Field(description='Saved timeline ID in the active project.')
    revision: Revision = Field(description='Exact saved revision to export.')
    path: str = Field(min_length=1, max_length=4096, description='New output file under the active execution directory.')


class TimelinePackageImportFile(Contract):
    operationId: UUID = Field(description='Stable import operation identity.')
    archiveFingerprint: Fingerprint = Field(description='Expected SHA-256 of archive bytes.')
    path: str = Field(min_length=1, max_length=4096, description='Existing bundle under the active execution directory.')
    replaceEditorId: UUID | None = Field(default=None, description='Explicit replacement target.')
    expectedRevision: Revision | None = Field(default=None, description='Expected replacement revision.')
