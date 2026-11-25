"""Read current business bindings and adopted execution evidence without mutations."""
from collections import deque
from collections.abc import Callable, Mapping
from uuid import UUID

from opendirector.domain.creation.base import ObjectVersion
from opendirector.domain.creation.commands import GenerationImpactQuery
from opendirector.domain.creation.generation import ResolvedReference, freeze_input_snapshot
from opendirector.domain.creation.impact import (
    GenerationImpactItem, GenerationImpactReport, ImpactDependency, ImpactReason,
    TimelineClipImpactConsumer, TimelineTextImpactConsumer,
)
from opendirector.domain.creation.impact_messages import IMPACT_ERROR_ZH
from opendirector.domain.creation.models import ModelSnapshot
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.rule_facts import GENERATION_IMPACT_EVIDENCE_LIMIT, MAX_REFERENCES
from opendirector.domain.projects import ProjectError
from opendirector.ports.gateway import gateway

MAX_IMPACT_EDGES = 20000


class CreationImpact:
    def __init__(self, projects, *, availability=None, assets=None):
        from opendirector.application.creation_assets import CreationAssets
        self.projects = projects
        self.availability = availability
        self.assets = assets if assets is not None else CreationAssets(projects)

    def query(self, query: GenerationImpactQuery) -> GenerationImpactReport:
        from opendirector.application.model_availability import ModelAvailability
        snapshot = self.projects.snapshot(query.projectId)
        configs = gateway().models(self.projects.local.repository)
        availability = self.availability or ModelAvailability(configs)
        models = {}
        # The project, catalog and capability observations have independent read
        # boundaries. Report versions identify only the project snapshot; this
        # query neither reserves model rules nor refreshes capability probes.
        needed = {spec.modelConfigId for spec in snapshot.generationSpecs}
        for public, private in configs.catalog_snapshot():
            identity = UUID(public['id'])
            if identity not in needed:
                continue
            try:
                models[identity] = ModelSnapshot(modelConfigId=identity,
                    inputRules=availability.effective_input_rules(private),
                    **{key: public[key] for key in
                       ('kind', 'modelId', 'url', 'protocol', 'connectionType', 'proxyMode', 'videoAdapter')})
            except ValueError:
                models[identity] = None
        def available(asset_id):
            try:
                self.assets.reference_available(query.projectId, asset_id, snapshot=snapshot)
                return True
            except (ProjectError, ContractError, OSError, UnicodeError):
                return False

        return analyze_generation_impact(snapshot, root_spec_ids=query.rootSpecIds, models=models,
            asset_available=available, max_nodes=query.maxNodes)


def build_generation_dependencies(
    snapshot: ProjectSnapshot,
    resolved_by_spec: Mapping[UUID, tuple[ResolvedReference, ...] | None],
) -> tuple[ImpactDependency, ...]:
    """Only current follow bindings propagate; content identity is not source identity."""
    items = {item.id: item for item in snapshot.canvasItems}
    resolved = {spec_id: None if values is None else _by_reference(values)
                for spec_id, values in resolved_by_spec.items()}
    edges = []
    for reference in snapshot.references:
        if not reference.active or reference.binding != 'follow_current':
            continue
        source = items.get(reference.source.id)
        source_spec = (source.binding.objectRef.id if source is not None
            and source.binding.role == 'generation' and source.binding.materialOverride is None else None)
        by_ref = resolved.get(reference.targetSpecId)
        values = by_ref.get(reference.id) if by_ref is not None else None
        # A missing resolution is explicit uncertainty, never "no dependencies".
        for value in values or (None,):
            if value is not None and value.transmission == 'context_only':
                continue
            edges.append(ImpactDependency(sourceSpecId=source_spec, sourceItemId=reference.source.id,
                targetSpecId=reference.targetSpecId, referenceId=reference.id,
                role=value.role if value else reference.role, assetId=value.asset.assetId if value else None,
                documentId=value.documentVersion.id if value and value.documentVersion else None,
                inputConfirmed=value is not None))
            if len(edges) > MAX_IMPACT_EDGES:
                raise ContractError('impact_scope_exceeded', IMPACT_ERROR_ZH['impact_scope_exceeded'])
    return tuple(edges)


def _by_reference(values):
    grouped = {}
    for value in values:
        grouped.setdefault(value.referenceId, []).append(value)
    return grouped


class _SnapshotIndex:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.specs = {s.id: s for s in snapshot.generationSpecs}
        self.items = {i.id: i for i in snapshot.canvasItems}
        self.assets = {a.id: a for a in snapshot.assets}
        self.results = {r.id: r for r in snapshot.results}
        self.jobs = {j.id: j for j in snapshot.jobs}
        self.documents = {d.id: d for d in snapshot.editorDocuments}
        self.references = {}
        self.active_jobs = {}
        self.active_job_count = 0
        for ref in snapshot.references:
            if ref.active:
                self.references.setdefault(ref.targetSpecId, []).append(ref)
        for job in snapshot.jobs:
            if (job.status in {'queued', 'running', 'interrupted'} or job.recovery == 'review'
                    or job.resumeAllowed or job.remoteCancellation in {'requested', 'unknown'}):
                self.active_job_count += 1
                if self.active_job_count > GENERATION_IMPACT_EVIDENCE_LIMIT:
                    raise ContractError('impact_scope_exceeded', IMPACT_ERROR_ZH['impact_scope_exceeded'])
                self.active_jobs.setdefault(job.inputSnapshot.spec.id, []).append(job.id)

    def resolution_view(self, spec):
        """Narrow the existing resolver's search space without changing any saved facts.

        The resolver reads one level only. Index once, then pass the exact source
        objects needed by each spec; avoid rescanning all assets for every edge.
        """
        specs, items, assets, results, documents = {spec.id: spec}, {}, {}, {}, {}
        refs = self.references.get(spec.id, ())
        for ref in refs:
            if ref.binding == 'pinned':
                if ref.source.assetId in self.assets:
                    assets[ref.source.assetId] = self.assets[ref.source.assetId]
                continue
            source = self.items.get(ref.source.id)
            if source is None:
                continue
            items[source.id] = source
            source_assets = []
            if source.binding.role == 'material':
                source_assets.append(source.binding.objectRef.assetId)
            elif source.binding.role == 'generation':
                upstream = self.specs.get(source.binding.objectRef.id)
                if upstream:
                    specs[upstream.id] = upstream
                    result = self.results.get(upstream.currentResultId)
                    if result:
                        results[result.id] = result
                        source_assets.append(result.asset.assetId)
                if source.binding.materialOverride:
                    source_assets.append(source.binding.materialOverride.assetId)
            elif source.kind == 'subject':
                doc = self.documents.get(source.binding.objectRef.id)
                if doc:
                    documents[doc.id] = doc
                    source_assets.extend(a.assetId for a in (doc.data.main, *doc.data.auxiliaries, doc.data.voice) if a)
            for key in source_assets:
                if key in self.assets:
                    assets[key] = self.assets[key]
        return self.snapshot.model_copy(update=dict(generationSpecs=tuple(specs.values()),
            canvasItems=tuple(items.values()), assets=tuple(assets.values()), results=tuple(results.values()),
            editorDocuments=tuple(documents.values()), references=tuple(refs)))

    def baseline(self, spec):
        result = self.results.get(spec.currentResultId)
        job = self.jobs.get(result.jobId) if result else None
        if (result is None or job is None or result.specId != spec.id
                or job.inputSnapshot.spec.id != spec.id or job.status != 'succeeded'
                or job.projectId != self.snapshot.project.id or result.projectId != job.projectId
                or job.asset != result.asset or job.inputFingerprint != result.inputFingerprint
                or job.inputSnapshot.fingerprint() != job.inputFingerprint):
            return None
        output = self.assets.get(result.asset.assetId)
        if output is None or (output.kind, output.fingerprint) != (result.asset.kind, result.asset.fingerprint):
            return None
        return job


# Ordinary adapter output settings and generated seeds are already captured
# execution facts, not extra input dependencies. Unrecognized extension fields
# (guides, LoRA, external windows, transcription model snapshots, etc.) require
# additional persisted evidence before this query can assert reuse.
_KNOWN_ADAPTER_FIELDS = {
    'text': {'thinking', 'max_tokens'},
    'image': {'size', 'quality', 'response_format', 'output_format', 'watermark', 'watermark_enabled',
              'num_inference_steps', 'guidance_scale', 'prompt_enhance', 'seed'},
    'video': {'seconds', 'duration', 'ratio', 'generate_audio', 'size', 'resolution', 'fps', 'num_frames',
              'num_inference_steps', 'guidance_scale', 'seed', 'watermark', 'mode', 'cfg_scale',
              'audio', 'operation', 'route', 'quality'},
    'audio': {'speaker', 'voice', 'audio_params', 'format', 'sample_rate', 'response_format',
              'delivery_method', 'stream', 'output_format', 'watermark_enabled', 'creation_type',
              'lyrics', 'duration', 'seed', 'score_mode'},
}


def _basis_complete(job):
    if job.inputSnapshot.model.inputRules is None:
        return False
    if job.adapterParameters.keys() - _KNOWN_ADAPTER_FIELDS[job.inputSnapshot.spec.kind]:
        return False
    # No arbitrary nested adapter data is accepted as known scalar settings.
    for key, value in job.adapterParameters.items():
        if key == 'audio_params':
            if not isinstance(value, dict) or value.keys() - {'format', 'sample_rate'}:
                return False
        elif isinstance(value, (dict, list)):
            return False
    return True


def _changed_fields(old, current):
    paths = []
    for field in ('prompt', 'promptContent', 'parameters'):
        if getattr(old.spec, field) != getattr(current.spec, field):
            paths.append('spec.' + field)
    if old.model != current.model:
        paths.append('model')
    # Delegate reference equality to the shared fingerprint, including its
    # deliberate exclusions for display labels and audit-only revisions.
    if old.model_copy(update={'references': current.references}).fingerprint() != old.fingerprint():
        paths.append('references')
    return tuple(paths)


def _reachable(seeds, outgoing):
    seen = set(seeds)
    queue = deque(seeds)
    while queue:
        for target in outgoing.get(queue.popleft(), ()):
            if target not in seen:
                seen.add(target)
                queue.append(target)
    return seen


def _cycle_dependents(spec_ids, outgoing):
    """Kahn elimination leaves cycles and their dependents, with no recursion."""
    incoming = dict.fromkeys(spec_ids, 0)
    for targets in outgoing.values():
        for target in targets:
            incoming[target] += 1
    queue = deque(key for key, count in incoming.items() if not count)
    while queue:
        key = queue.popleft()
        for target in outgoing.get(key, ()):
            incoming[target] -= 1
            if not incoming[target]:
                queue.append(target)
    return {key for key, count in incoming.items() if count}


def _timeline_consumers(index, related):
    by_asset = {}
    for result in index.results.values():
        if result.specId in related:
            by_asset.setdefault(result.asset.assetId, set()).add(result.specId)
    consumers = []

    def append(consumer):
        if len(consumers) + index.active_job_count >= GENERATION_IMPACT_EVIDENCE_LIMIT:
            raise ContractError('impact_scope_exceeded', IMPACT_ERROR_ZH['impact_scope_exceeded'])
        consumers.append(consumer)

    for document in index.snapshot.editorDocuments:
        if document.kind != 'timeline':
            continue
        connections = {c.slotId: c for c in document.inputConnections}
        for track in document.data.tracks:
            for clip in track.clips:
                asset_specs = by_asset.get(clip.resource.asset.assetId, set())
                connection = connections.get(clip.id)
                source = index.items.get(connection.sourceId) if connection else None
                source_spec = source.binding.objectRef.id if source and source.binding.role == 'generation' else None
                source_specs = {source_spec} if source_spec in related else set()
                if not asset_specs and not source_specs:
                    continue
                append(TimelineClipImpactConsumer(editorDocumentId=document.id, revision=document.revision,
                    clipId=clip.id, assetId=clip.resource.asset.assetId, specIds=tuple(sorted(asset_specs | source_specs)),
                    association='asset_and_source' if asset_specs and source_specs else 'asset' if asset_specs else 'source',
                    sourceItemId=source.id if source is not None else None))
        for overlay in document.data.overlays:
            if overlay.sourceAsset is None:
                continue
            asset_specs = by_asset.get(overlay.sourceAsset.assetId, set())
            if asset_specs:
                append(TimelineTextImpactConsumer(editorDocumentId=document.id, revision=document.revision,
                    overlayId=overlay.id, assetId=overlay.sourceAsset.assetId, specIds=tuple(sorted(asset_specs)), association='asset'))
    return tuple(consumers)


def analyze_generation_impact(snapshot: ProjectSnapshot, *, root_spec_ids: tuple[UUID, ...],
        models: Mapping[UUID, ModelSnapshot | None], asset_available: Callable[[UUID], bool],
        max_nodes: int) -> GenerationImpactReport:
    """Compare one snapshot with locally frozen models keyed by modelConfigId.

    Reuse concerns existing assets, not deterministic re-generation, creative
    approval, provider health, or the availability of remote continuation cache.
    """
    from opendirector.application.creation_canvas import current_generation_inputs
    if (type(max_nodes) is not int or not 1 <= max_nodes <= 10000
            or len(snapshot.generationSpecs) > max_nodes
            or sum(ref.active for ref in snapshot.references) > MAX_IMPACT_EDGES):
        raise ContractError('impact_scope_exceeded', IMPACT_ERROR_ZH['impact_scope_exceeded'])
    index = _SnapshotIndex(snapshot)
    if not root_spec_ids or len(root_spec_ids) > 100 or len(set(root_spec_ids)) != len(root_spec_ids):
        raise ContractError('invalid_input', IMPACT_ERROR_ZH['invalid_input'])
    if any(key not in index.specs for key in root_spec_ids):
        raise ContractError('missing_object', IMPACT_ERROR_ZH['missing_object'])
    availability = {}

    def available(key):
        if key not in availability:
            availability[key] = key in index.assets and asset_available(key)
        return availability[key]

    items, resolved = {}, {}
    for spec in snapshot.generationSpecs:
        reasons, current = [], None
        model = models.get(spec.modelConfigId)
        resolved[spec.id] = None
        if model is None or model.inputRules is None:
            reasons.append(ImpactReason(code='model_unresolved', objectId=spec.modelConfigId))
        else:
            try:
                if len(index.references.get(spec.id, ())) > MAX_REFERENCES:
                    raise ValueError('Current references exceed the acceptance limit')
                effective, refs = current_generation_inputs(index.resolution_view(spec), spec, model.inputRules)
                if len(refs) > MAX_REFERENCES:
                    raise ValueError('Expanded references exceed the acceptance limit')
                resolved[spec.id] = refs
                missing = next((ref for ref in refs if ref.transmission != 'context_only' and not available(ref.asset.assetId)), None)
                if missing:
                    reasons.append(ImpactReason(code='input_unresolved', objectId=missing.asset.assetId, referenceId=missing.referenceId))
                else:
                    current = freeze_input_snapshot(effective, model, refs)
            except (ValueError, StopIteration, KeyError):
                reasons.append(ImpactReason(code='input_unresolved', objectId=spec.id))
        job = index.baseline(spec) if spec.currentResultId else None
        input_state, reuse = 'unresolved', 'unknown'
        if spec.currentResultId is None:
            input_state, reuse = 'no_baseline', 'no_result'
            reasons.append(ImpactReason(code='baseline_missing', objectId=spec.id))
        elif job is None:
            reasons.append(ImpactReason(code='baseline_missing', objectId=spec.currentResultId))
        else:
            if current is not None:
                input_state = 'equal' if current.fingerprint() == job.inputFingerprint else 'changed'
            if not _basis_complete(job):
                reasons.append(ImpactReason(code='execution_basis_incomplete', objectId=job.id))
            elif current is not None:
                if not available(job.asset.assetId):
                    reuse = 'unavailable'
                    reasons.append(ImpactReason(code='output_unavailable', objectId=job.asset.assetId))
                elif input_state == 'changed':
                    reuse = 'stale'
                    reasons.append(ImpactReason(code='inputs_changed', objectId=spec.id,
                        fieldPaths=_changed_fields(job.inputSnapshot, current)))
                else:
                    reuse = 'reusable'
        items[spec.id] = GenerationImpactItem(specId=spec.id, specRevision=spec.revision,
            currentResultId=spec.currentResultId, baselineJobId=job.id if job else None,
            baselineInputFingerprint=job.inputFingerprint if job else None,
            currentInputFingerprint=current.fingerprint() if current else None,
            inputState=input_state, reuseState=reuse, relation='independent',
            activeJobIds=tuple(index.active_jobs.get(spec.id, ())), reasons=tuple(reasons))
    edges = build_generation_dependencies(snapshot, resolved)
    outgoing, incoming = {}, {}
    for edge in edges:
        incoming.setdefault(edge.targetSpecId, []).append(edge)
        if edge.sourceSpecId in index.specs:
            outgoing.setdefault(edge.sourceSpecId, []).append(edge.targetSpecId)
    related = _reachable(root_spec_ids, outgoing)
    cycles = _cycle_dependents(index.specs, outgoing)
    uncertain = _reachable({key for key, item in items.items() if item.reuseState == 'unknown'} | cycles, outgoing)
    pending = _reachable({key for key, item in items.items() if item.reuseState in {'stale', 'unavailable', 'no_result'}}, outgoing)
    for key, item in items.items():
        direct = incoming.get(key, ())
        reasons = list(item.reasons)
        reuse = item.reuseState
        if key in cycles:
            reuse = 'unknown'
            reasons.append(ImpactReason(code='dependency_cycle', objectId=key))
        for edge in direct:
            if not edge.inputConfirmed or edge.sourceSpecId in uncertain:
                reasons.append(ImpactReason(code='dependency_unresolved', objectId=edge.sourceSpecId or edge.sourceItemId, referenceId=edge.referenceId))
                if reuse in {'reusable', 'pending_upstream'}:
                    reuse = 'unknown'
            elif edge.sourceSpecId in pending and reuse in {'reusable', 'pending_upstream'}:
                reuse = 'pending_upstream'
                reasons.append(ImpactReason(code='upstream_pending', objectId=edge.sourceSpecId, referenceId=edge.referenceId))
        items[key] = item.model_copy(update=dict(reuseState=reuse, reasons=tuple(reasons),
            relation='root' if key in root_spec_ids else 'downstream' if key in related else 'independent',
            upstreamSpecIds=tuple(sorted({e.sourceSpecId for e in direct if e.sourceSpecId is not None}))))
    return GenerationImpactReport(projectVersion=ObjectVersion(objectType='project', id=snapshot.project.id,
        revision=snapshot.project.revision), eventCursor=snapshot.eventCursor, rootSpecIds=root_spec_ids,
        items=tuple(items.values()), dependencies=edges, timelineConsumers=_timeline_consumers(index, related))
