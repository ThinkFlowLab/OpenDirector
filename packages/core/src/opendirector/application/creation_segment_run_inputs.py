"""Resolve exact Run results independently of canvas display selection."""

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref, resolved_inputs
from opendirector.domain.creation.base import CanvasItemVersion
from opendirector.domain.creation.generation import FollowingReference, PinnedReference
from opendirector.domain.creation.validation import ContractError


def selected_segment_asset(snapshot, group, item, job):
    """Verify the registered raw result named by an execution's selected job."""
    entry = group.runPlan.by_item().get(item.id) if item is not None and group.runPlan is not None else None
    if (entry is None or item.kind != 'video' or item.binding.role != 'generation' or job is None
            or job.status != 'succeeded' or job.asset is None or job.asset.kind != 'video'
            or job.batchId is None or job.originItemId != item.id
            or job.inputSnapshot.spec.id != item.binding.objectRef.id):
        raise ContractError('reference_invalid', '所选结果不是此 Run 片段已完成的原始视频。', getattr(item, 'id', group.id))
    guide = job.inputSnapshot.workflowGuide
    if guide is None or guide.groupId != group.id or guide.required != (entry.step.kind == 'continuation'):
        raise ContractError('reference_invalid', '所选结果与此 Run 的导帧计划不一致。', item.id)
    asset = CreationAssets._reference(snapshot, job.asset)
    if (asset_ref(asset) != job.asset or asset.provenance.source != 'generated' or asset.provenance.jobId != job.id
            or asset.provenance.inputFingerprint != job.inputFingerprint
            or not any(result.jobId == job.id and result.specId == job.inputSnapshot.spec.id
                       and result.asset == job.asset and result.inputFingerprint == job.inputFingerprint
                       for result in snapshot.results)):
        raise ContractError('reference_invalid', '所选结果的素材版本或任务来源已变化。', item.id)
    return asset


def segment_inputs_with_guide(snapshot, group, item_id, spec, rules, guide_job_id):
    """Replace only the planned guide binding in an ephemeral reference view."""
    entry = group.runPlan.by_item().get(item_id)
    if entry is None or entry.step.kind != 'continuation':
        raise ContractError('reference_invalid', '所选片段没有指定导帧来源。', item_id)
    segment = spec.parameters.h3Segment
    reference = next((ref for ref in snapshot.references if segment is not None and ref.id == segment.guideReferenceId), None)
    if (not isinstance(reference, FollowingReference) or not reference.active or reference.role != 'reference'
            or reference.targetSpecId != spec.id or reference.source.id != entry.step.upstreamItemId
            or segment.sourceFrames != entry.step.sourceFrames):
        raise ContractError('reference_invalid', '所选导帧任务与已发布片段的来源不符。', item_id)
    source_item = next((item for item in snapshot.canvasItems if item.id == entry.step.upstreamItemId), None)
    donor = next((job for job in snapshot.jobs if job.id == guide_job_id), None)
    asset = selected_segment_asset(snapshot, group, source_item, donor)

    pinned = PinnedReference(id=reference.id, projectId=reference.projectId, revision=reference.revision,
        targetSpecId=reference.targetSpecId, role=reference.role, order=reference.order, binding='pinned',
        source=asset_ref(asset), sourceVersion=CanvasItemVersion(objectType='canvas_item', id=source_item.id,
                                                               revision=source_item.revision))
    view = snapshot.model_copy(update={'references': tuple(pinned if ref.id == reference.id else ref
                                                           for ref in snapshot.references)})
    return tuple(ref.model_copy(update={'sourceTitle': source_item.title}) if ref.referenceId == reference.id else ref
                 for ref in resolved_inputs(view, spec.id, rules))
