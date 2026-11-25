"""Reconstructible, read-only dependency and adopted-result reuse evidence."""
from typing import Annotated, Literal, Union
from uuid import UUID

from pydantic import Field, model_validator

from opendirector.domain.rule_facts import GENERATION_IMPACT_EVIDENCE_LIMIT

from .base import Contract, Digest, Identifier, ObjectVersion, Revision, unique


class ImpactReason(Contract):
    code: Literal['inputs_changed', 'upstream_pending', 'output_unavailable', 'baseline_missing',
        'input_unresolved', 'model_unresolved', 'dependency_unresolved', 'execution_basis_incomplete',
        'dependency_cycle'] = Field(description='Stable explanation code, localized only by the display layer.')
    objectId: UUID | None = Field(default=None, description='Related business object identity, when known.')
    referenceId: UUID | None = Field(default=None, description='Related current reference identity, when known.')
    fieldPaths: tuple[Literal['spec.prompt', 'spec.promptContent', 'spec.parameters', 'model', 'references'], ...] = Field(
        default=(), description='Allowlisted changed input sections; no user content or connection details.')


class ImpactDependency(Contract):
    sourceSpecId: UUID | None = Field(default=None, description='Generation source followed by this binding, if any; retained subject assets and overrides do not follow a spec.')
    sourceItemId: UUID = Field(description='Logical source canvas identity, including hidden sources.')
    targetSpecId: UUID = Field(description='Consumer generation configuration identity.')
    referenceId: UUID = Field(description='Current follow_current reference identity; historical and pinned usages are excluded.')
    role: Literal['reference', 'first_frame', 'last_frame', 'continuation', 'control'] = Field(description='Resolved reference purpose.')
    assetId: UUID | None = Field(default=None, description='Actual resolved input asset, absent when unresolved.')
    documentId: UUID | None = Field(default=None, description='Retained subject document supplying this asset.')
    inputConfirmed: bool = Field(description='Whether the current resolver confirmed this transmitted input. False is uncertainty, not an empty dependency.')


class TimelineImpactConsumerBase(Contract):
    editorDocumentId: UUID = Field(description='Current timeline document identity.')
    revision: Revision = Field(description='Timeline document revision read by this report.')
    assetId: UUID = Field(description='Asset currently retained in this timeline usage, including historical results and unadopted candidates; the query never replaces it.')
    specIds: tuple[UUID, ...] = Field(description='Related generation specs from exact result or source identities.')
    association: Literal['asset', 'source', 'asset_and_source'] = Field(description='Basis of association with related specs: exact retained result asset, explicit generation-source connection, or both. Not adoption status or permission to replace content.')
    sourceItemId: UUID | None = Field(default=None, description='Source item from the document input connection, when relevant.')


class TimelineClipImpactConsumer(TimelineImpactConsumerBase):
    kind: Literal['clip'] = Field(default='clip', description='Retained media clip usage.')
    clipId: Identifier = Field(description='Retained timeline clip identity.')


class TimelineTextImpactConsumer(TimelineImpactConsumerBase):
    kind: Literal['text_overlay'] = Field(default='text_overlay', description='Retained text overlay source usage.')
    overlayId: Identifier = Field(description='Retained timeline text overlay identity.')
    association: Literal['asset'] = Field(description='Exact frozen source text asset, including historical results and unadopted candidates; not adoption status. Subsequent source edits do not replace overlay text.')
    sourceItemId: None = Field(default=None, description='Text overlays retain source assets without a live source connection.')


TimelineImpactConsumer = Annotated[Union[TimelineClipImpactConsumer, TimelineTextImpactConsumer], Field(discriminator='kind')]


class GenerationImpactItem(Contract):
    specId: UUID = Field(description='Generation configuration identity.')
    specRevision: Revision = Field(description='Configuration revision read by this report.')
    currentResultId: UUID | None = Field(default=None, description='Currently adopted result, never an unadopted candidate.')
    baselineJobId: UUID | None = Field(default=None, description='Successful job owning the adopted result.')
    baselineInputFingerprint: Digest | None = Field(default=None, description='Verified adopted job input fingerprint.')
    currentInputFingerprint: Digest | None = Field(default=None, description='Reconstructed inputs from the project snapshot and independently read model rules/capability observations; not an atomic project-and-model snapshot or an execution reservation.')
    inputState: Literal['equal', 'changed', 'unresolved', 'no_baseline'] = Field(description='Current effective inputs compared with the adopted job.')
    reuseState: Literal['reusable', 'stale', 'pending_upstream', 'unavailable', 'unknown', 'no_result'] = Field(description='Result reuse evidence, independent of creative approval and remote cache availability.')
    relation: Literal['root', 'downstream', 'independent'] = Field(description='Relationship to requested roots, not an invalidation decision.')
    upstreamSpecIds: tuple[UUID, ...] = Field(default=(), description='Direct current generation dependencies only; no enumeration of all paths.')
    activeJobIds: tuple[UUID, ...] = Field(default=(), max_length=GENERATION_IMPACT_EVIDENCE_LIMIT,
        description='Active, recoverable or unresolved job identities; inspect the original jobs before deciding any action.')
    reasons: tuple[ImpactReason, ...] = Field(default=(), description='Bounded direct evidence for this decision.')


class GenerationImpactReport(Contract):
    analysisVersion: Literal[1] = Field(default=1, description='Impact interpretation version.')
    projectVersion: ObjectVersion = Field(description='Version of the authoritative project snapshot only. Model configuration and capability observations are read independently; this report does not authorize later writes or reserve execution inputs.')
    eventCursor: int = Field(strict=True, ge=0, description='Event cursor from the same project snapshot as projectVersion; excludes model configuration and capability observation changes.')
    rootSpecIds: tuple[UUID, ...] = Field(min_length=1, max_length=100, description='Unique requested roots in this project.')
    items: tuple[GenerationImpactItem, ...] = Field(max_length=10000, description='All project generation configurations, including independent branches.')
    dependencies: tuple[ImpactDependency, ...] = Field(max_length=20000, description='Current effective follow bindings; scope overflow fails instead of truncating.')
    timelineConsumers: tuple[TimelineImpactConsumer, ...] = Field(max_length=GENERATION_IMPACT_EVIDENCE_LIMIT,
        description='Current clip and text overlay usages requiring review; combined with all activeJobIds, limited to 20000 entries. Never automatic replacement instructions.')

    @model_validator(mode='after')
    def identities(self):
        unique(self.rootSpecIds, 'impact roots')
        unique([item.specId for item in self.items], 'impact specs')
        if not set(self.rootSpecIds).issubset(item.specId for item in self.items):
            raise ValueError('Impact roots must belong to the reported specs')
        if self.projectVersion.objectType != 'project':
            raise ValueError('Impact report requires a project version')
        if len(self.timelineConsumers) + sum(len(item.activeJobIds) for item in self.items) > GENERATION_IMPACT_EVIDENCE_LIMIT:
            raise ValueError('Impact report exceeds the retained evidence budget')
        return self
