"""New-format aggregate validation; no filesystem reads or legacy migration."""
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from .assets import Asset, AssetRef
from .base import Contract, NonNegative, ObjectVersion, Point, ProjectEntity, Revision, unique
from .canvas import CanvasItem, EditorBinding, GenerationBinding, MaterialBinding, MediaCanvasItem
from .editors import EditorDocument, MediaEditDocument, LayerDocument, StackDocument, SubjectDocument, TimelineDocument
from .generation import FollowingReference, GenerationSpec, Job, PromptReference, Reference, ResultVersion
from ..rule_facts import TIMELINE_DURATION_EPSILON


class Project(Contract):
    id: UUID = Field(description='Stable object ID.')
    revision: Revision = Field(default=1, description='Current object revision for optimistic concurrency.')
    name: str = Field(min_length=1, max_length=100, pattern=r'\S', description='User-visible name.')


def asset_references(value):
    if isinstance(value, AssetRef):
        yield value
    elif isinstance(value, BaseModel):
        for name in type(value).model_fields:
            yield from asset_references(getattr(value, name))
    elif isinstance(value, (tuple, list)):
        for item in value:
            yield from asset_references(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from asset_references(item)


def acyclic(edges, label):
    visiting, visited = set(), set()
    def visit(key):
        if key in visiting:
            raise ValueError(f'Cyclic {label}')
        if key in visited:
            return
        visiting.add(key)
        for source in edges.get(key, ()):
            visit(source)
        visiting.remove(key)
        visited.add(key)
    for key in edges:
        visit(key)


class ProjectSnapshot(Contract):
    format: Literal['opendirector-project'] = Field(default='opendirector-project', description='Serialized format identifier.')
    formatVersion: Literal[2] = Field(default=2, description='Project format version.')
    project: Project = Field(description='Project identity and current revision.')
    assets: tuple[Asset, ...] = Field(default=(), description='Registered immutable assets.')
    generationSpecs: tuple[GenerationSpec, ...] = Field(default=(), description='Editable generation configurations.')
    references: tuple[Reference, ...] = Field(default=(), description='Ordered generation reference bindings.')
    canvasItems: tuple[CanvasItem, ...] = Field(default=(), description='Canvas display items, including hidden items.')
    editorDocuments: tuple[EditorDocument, ...] = Field(default=(), description='Persisted editable documents.')
    jobs: tuple[Job, ...] = Field(default=(), description='Immutable generation execution records.')
    results: tuple[ResultVersion, ...] = Field(default=(), description='Generated result candidates and adoption history.')
    eventCursor: int = Field(default=0, strict=True, ge=0, description='Latest committed project event cursor.')
    undoClearedThrough: int = Field(default=0, strict=True, ge=0, description='Event cursor through which undo history was cleared.')

    @model_validator(mode='after')
    def project_relations(self):
        if self.undoClearedThrough > self.eventCursor:
            raise ValueError('Undo clearing cannot point beyond the committed cursor')
        collections = (self.assets, self.generationSpecs, self.references, self.canvasItems,
                       self.editorDocuments, self.jobs, self.results)
        objects = [obj for collection in collections for obj in collection]
        unique([self.project.id, *(obj.id for obj in objects)], 'project object IDs')
        if any(obj.projectId != self.project.id for obj in objects):
            raise ValueError('Cross-project objects are forbidden')
        assets = {asset.id: asset for asset in self.assets}
        specs = {spec.id: spec for spec in self.generationSpecs}
        items = {item.id: item for item in self.canvasItems}
        documents = {doc.id: doc for doc in self.editorDocuments}
        jobs = {job.id: job for job in self.jobs}
        results = {result.id: result for result in self.results}
        for ref in asset_references(objects):
            asset = assets.get(ref.assetId)
            if asset is None or ref.revision > asset.revision or ref.fingerprint != asset.fingerprint or ref.kind != asset.kind:
                raise ValueError('Missing or inconsistent pinned asset reference')
        parents = {}
        for item in self.canvasItems:
            if item.parentId:
                if item.parentId not in items or items[item.parentId].kind != 'group':
                    raise ValueError('Parent must be a group in the same project')
                parents[item.id] = [item.parentId]
            if isinstance(item.binding, GenerationBinding):
                spec = specs.get(item.binding.objectRef.id)
                if spec is None or spec.kind != item.kind or spec.purpose != 'generation':
                    raise ValueError('Generation node points to a missing or wrong-kind spec')
                # Retained images are verified generation outputs, published
                # edits, or outputs a canvas archive carried in with their own
                # recorded source. A bare upload still cannot claim to be one.
                if item.kind == 'image' and item.binding.materialOverride:
                    output = assets[item.binding.materialOverride.assetId]
                    retained = output.provenance.source in {'generated', 'edited', 'imported'}
                    if not retained or (output.provenance.source == 'edited' and not output.provenance.sources):
                        raise ValueError('Image overrides require recorded generation or edit provenance')
            elif item.binding.role == 'empty' and item.binding.draftSpec:
                spec_id = item.binding.draftSpec.id
                spec = specs.get(spec_id)
                if spec is None or spec.kind != item.kind or spec.purpose != 'draft':
                    raise ValueError('Empty node draft points to a missing or wrong-kind spec')
                if spec.currentResultId or any(job.inputSnapshot.spec.id == spec_id for job in self.jobs) or any(ref.active and ref.targetSpecId == spec_id for ref in self.references):
                    raise ValueError('An empty node cannot own accepted tasks, references or results')
            if isinstance(item.binding, EditorBinding):
                ref = item.binding.objectRef
                if ref.id not in documents or documents[ref.id].kind != ref.kind:
                    raise ValueError('Editor node points to a missing or wrong-kind document')
            if isinstance(item, MediaCanvasItem):
                for ref in item.editors:
                    if ref.id not in documents or documents[ref.id].kind != ref.kind:
                        raise ValueError('Missing or wrong-kind attached media editor')
        acyclic(parents, 'canvas group hierarchy')
        # References read current outputs; they do not recursively execute
        # upstream specs. Self-references and cycles are valid (OpenDirector).
        reference_ids = {reference.id: reference for reference in self.references}
        target_orders = set()
        for reference in self.references:
            if reference.targetSpecId not in specs:
                raise ValueError('Reference target spec does not exist')
            if not reference.active:
                continue
            if specs[reference.targetSpecId].purpose != 'generation':
                raise ValueError('Accepted references lock a spec to generation purpose')
            key = (reference.targetSpecId, reference.order)
            if key in target_orders:
                raise ValueError('Reference order is duplicated for its target')
            target_orders.add(key)
            if isinstance(reference, FollowingReference):
                source = items.get(reference.source.id)
                if source is None or source.kind not in {'text', 'image', 'video', 'audio', 'subject'}:
                    raise ValueError('Following reference needs a stable logical media source')
                if reference.role == 'first_frame' and source.kind != 'image' or reference.role == 'continuation' and source.kind != 'video':
                    raise ValueError('Reference source kind does not match its role')
            elif ((reference.role == 'first_frame' and reference.source.kind != 'image')
                  or (reference.role == 'continuation' and reference.source.kind != 'video')):
                raise ValueError('Reference source kind does not match its role')
        for spec in self.generationSpecs:
            if spec.promptContent:
                for part in spec.promptContent:
                    if isinstance(part, PromptReference) and (part.referenceId not in reference_ids or not reference_ids[part.referenceId].active or reference_ids[part.referenceId].targetSpecId != spec.id):
                        raise ValueError('Prompt references must belong to the same generation spec')
            if spec.currentResultId and (spec.currentResultId not in results or results[spec.currentResultId].specId != spec.id):
                raise ValueError('Current result must belong to its generation spec')
        for job in self.jobs:
            spec = specs.get(job.inputSnapshot.spec.id)
            if spec is None or job.inputSnapshot.spec.revision > spec.revision:
                raise ValueError('Task snapshot references a missing or future spec version')
            if job.previousJobId and job.previousJobId not in jobs:
                raise ValueError('Previous attempt must be a job in the same project')
            for ref in job.inputSnapshot.references:
                if ref.metadata != assets[ref.asset.assetId].metadata:
                    raise ValueError('Snapshot media facts must match the pinned asset')
        acyclic({job.id: [job.previousJobId] for job in self.jobs if job.previousJobId}, 'job attempts')
        for result in self.results:
            job = jobs.get(result.jobId)
            if job is None or job.status != 'succeeded' or job.inputSnapshot.spec.id != result.specId or job.asset != result.asset or job.inputFingerprint != result.inputFingerprint:
                raise ValueError('Result version must match the completed job and output')
        for asset in self.assets:
            provenance = asset.provenance
            if provenance.source == 'generated':
                job = jobs.get(provenance.jobId)
                if job is None or job.asset is None or job.asset.assetId != asset.id or job.inputFingerprint != provenance.inputFingerprint:
                    raise ValueError('Generated asset provenance does not match its job')
            if provenance.sourceItemId and provenance.sourceItemId not in items:
                raise ValueError('Edited asset refers to a missing logical source')
            if provenance.editorDocumentId:
                doc = documents.get(provenance.editorDocumentId)
                if doc is None or provenance.editorRevision > doc.revision:
                    raise ValueError('Edited asset references a missing or future document')
        for doc in self.editorDocuments:
            if isinstance(doc, MediaEditDocument):
                if any(source_id not in items for source_id in doc.data.sourceItems):
                    raise ValueError('Tool draft refers to a missing logical source')
                selection = doc.data.selection
                if selection:
                    source = assets[selection.source.assetId]
                    if (selection.width, selection.height) != (source.metadata.width, source.metadata.height):
                        raise ValueError('Tool selection dimensions must match the actual source')
                    if selection.mask:
                        mask = assets[selection.mask.assetId]
                        if (mask.metadata.width, mask.metadata.height) != (selection.width, selection.height):
                            raise ValueError('Tool mask dimensions must match the actual source')
            if isinstance(doc, StackDocument):
                if any(item_id not in items for item_id in doc.data.nodeIds):
                    raise ValueError('Stack refers to a missing logical node')
                if any(item.kind == 'stack' and item.binding.objectRef.id == doc.id and item.id in doc.data.nodeIds for item in items.values()):
                    raise ValueError('A stack cannot contain itself')
            if isinstance(doc, SubjectDocument):
                data = doc.data
                if data.main and data.main.kind == 'video':
                    seconds = assets[data.main.assetId].metadata.durationSeconds
                    if seconds is not None and seconds > 15:
                        raise ValueError('主体视频不能超过 15 秒。')
                if data.voice:
                    seconds = assets[data.voice.assetId].metadata.durationSeconds
                    if seconds is not None and not 0 < seconds <= 15:
                        raise ValueError('主体配音必须在 15 秒以内。')
            if isinstance(doc, TimelineDocument):
                for track in doc.data.tracks:
                    for clip in track.clips:
                        asset = assets[clip.resource.asset.assetId]
                        duration = asset.metadata.durationSeconds
                        if asset.kind != 'image' and duration is not None and clip.outPoint > duration + TIMELINE_DURATION_EPSILON:
                            raise ValueError('时间线片段超过素材的实际时长。')
        return self


class Viewport(Point):
    zoom: float = Field(default=1, strict=True, ge=0.08, le=8, description='Canvas viewport zoom factor.')


class Playhead(Contract):
    editorDocumentId: UUID = Field(description='Editable document ID.')
    seconds: NonNegative = Field(default=0, description='Playhead position in seconds.')


class ViewState(Contract):
    projectId: UUID = Field(description='Owning project ID.')
    clientId: UUID = Field(description='Client identity for independent view state.')
    viewport: Viewport = Field(default_factory=Viewport, description='Canvas pan and zoom state.')
    selectedItemIds: tuple[UUID, ...] = Field(default=(), description='Currently selected canvas item IDs.')
    activeEditorId: UUID | None = Field(default=None, description='Currently active editable document ID.')
    playheads: tuple[Playhead, ...] = Field(default=(), description='Playback positions keyed by editor identity.')
    generationCounts: dict[UUID, Annotated[int, Field(strict=True, ge=1, le=8)]] = Field(default_factory=dict, description='Requested generation counts keyed by canvas item ID.')
