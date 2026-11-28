"""Side-effect-free contextual command guards shared by future entrypoints."""
from collections.abc import Iterator
from typing import get_args
from uuid import UUID

from opendirector.domain.projects import ProjectError

from .canvas import GroupAssembly, GroupCanvasItem, MediaCanvasItem, VideoCanvasItem, role_after
from .commands import Command, ContractIssue, IssueCode
from .generation import GenerationSpec, ResolvedReference, resolve_h3_timeline_guide
from .project import ProjectSnapshot


class ContractError(ValueError):
    def __init__(self, code, message, object_id=None, *, related_object_id=None):
        super().__init__(message)
        self.issue = ContractIssue(code=code, message=message, objectId=object_id, relatedObjectId=related_object_id)

    @classmethod
    def from_error(cls, error: ValueError | ProjectError, object_id: UUID | None = None) -> 'ContractError':
        if isinstance(error, cls):
            return error
        code = error.code if isinstance(error, ProjectError) and error.code in get_args(IssueCode) else 'invalid_input'
        return cls(code, str(error), object_id)


def _workflow_assemblies(item: VideoCanvasItem, groups: dict[UUID, GroupCanvasItem]) -> Iterator[GroupAssembly]:
    parent_id = item.parentId
    while parent_id is not None:
        group = groups[parent_id]
        if group.assembly is not None and any(clip.itemId == item.id for clip in group.assembly.clips):
            yield group.assembly
        parent_id = group.parentId


def _workflow_plans(project: ProjectSnapshot, *, include_drafts: bool = False):
    items = {item.id: item for item in project.canvasItems if isinstance(item, VideoCanvasItem)}
    specs = {spec.id: spec for spec in project.generationSpecs if spec.kind == 'video'}
    plans = {}
    for group in project.canvasItems:
        if not isinstance(group, GroupCanvasItem):
            continue
        if group.draftRunPlan is not None:
            if not include_drafts:
                continue
            member_ids = group.draftRunPlan.by_item()
        elif group.assembly is not None:
            member_ids = [clip.itemId for clip in group.assembly.clips]
        else:
            continue
        members = {}
        for item_id in member_ids:
            item = items.get(item_id)
            if item is None:
                continue
            binding = item.binding
            link = binding.objectRef if binding.role == 'generation' else binding.draftSpec if binding.role == 'empty' else None
            if link is not None and link.id in specs:
                members[item.id] = specs[link.id]
        segmented = any(spec.parameters.h3Segment is not None for spec in members.values())
        plans[group.id] = (group, members, segmented)
    return plans


def workflow_guide_policy(project: ProjectSnapshot, spec_id: UUID, origin: UUID | None) -> tuple[UUID, bool] | None:
    """A saved step owns the policy even when its canvas node is moved or aliased."""
    matches = [(group, item_id) for group, members, segmented in _workflow_plans(project, include_drafts=True).values()
               if group.runPlan is not None or group.draftRunPlan is not None
               or group.assembly.requireTimelineGuides or segmented
               for item_id, spec in members.items() if spec.id == spec_id]
    if not matches:
        return None
    if len(matches) != 1:
        raise ContractError('reference_invalid', '导帧计划中的片段必须使用各自的生成配置。', spec_id)
    group, step = matches[0]
    if origin is None:
        raise ContractError('invalid_input', '分组片段提交时必须指定来源画布节点（originItemId）。', spec_id)
    if origin != step:
        raise ContractError('reference_invalid', f'必须从计划中的片段节点 {step} 提交。', step)
    plan = group.runPlan or group.draftRunPlan
    if plan is not None:
        return group.id, plan.by_item()[step].step.kind == 'continuation'
    if not group.assembly.requireTimelineGuides:
        raise ContractError('reference_invalid', 'H3 分段计划必须启用时间线导帧约束。', step)
    return group.id, group.assembly.requires_timeline_guide(step)


def validate_workflow_guide_transition(before: ProjectSnapshot, after: ProjectSnapshot) -> None:
    """Protect confirmed requirements across direct edits, batches and history."""
    previous, current = _workflow_plans(before), _workflow_plans(after)
    item_ids = {item.id for item in after.canvasItems}
    spec_ids = {spec.id for spec in after.generationSpecs}
    drafts = {item.id: item.draftRunPlan for item in after.canvasItems
              if isinstance(item, GroupCanvasItem) and item.draftRunPlan is not None}
    for group_id, (group, members, segmented) in previous.items():
        strict = group.assembly.requireTimelineGuides
        if not strict and not segmented:
            continue
        updated = current.get(group_id)
        if group.runPlan is not None and drafts.get(group_id) == group.runPlan:
            continue  # The Run transition guard authorizes and checks this change.
        if updated is None and all(item_id not in item_ids and spec.id not in spec_ids for item_id, spec in members.items()):
            continue  # Undo can remove the entire unexecuted plan and its steps.
        new_group, new_members, new_segmented = updated or (None, {}, False)
        new_recipe = new_group.assembly if new_group else None
        if strict:
            if (new_recipe is None or not new_recipe.requireTimelineGuides
                    or new_recipe.guideExemptItemId != group.assembly.guideExemptItemId
                    or not {clip.itemId for clip in group.assembly.clips} <= {clip.itemId for clip in new_recipe.clips}
                    or any(item_id not in new_members or new_members[item_id].id != spec.id for item_id, spec in members.items())):
                raise ContractError('reference_invalid', '已确认的导帧计划不能取消约束、改换锚点或移除原有片段。', group_id)
        elif new_recipe is None or (not new_recipe.requireTimelineGuides and not new_segmented):
            raise ContractError('reference_invalid', 'H3 分段计划必须启用时间线导帧约束。', group_id)

    claimed = set()
    for group_id, (group, members, segmented) in current.items():
        recipe = group.assembly
        old_group, old_members, old_segmented = previous.get(group_id, (None, {}, False))
        if group.runPlan is None and not recipe.requireTimelineGuides:
            if segmented and (not old_segmented or old_group.assembly != recipe
                              or members.keys() != old_members.keys()):
                raise ContractError('reference_invalid', 'H3 分段计划必须启用时间线导帧约束。', group_id)
            continue
        if {clip.itemId for clip in recipe.clips} != members.keys():
            raise ContractError('reference_invalid', '导帧计划的每个片段都必须绑定视频生成配置。', group_id)
        for item_id, spec in members.items():
            if spec.id in claimed:
                raise ContractError('reference_invalid', '导帧计划中的片段必须使用各自的生成配置。', item_id)
            claimed.add(spec.id)


def require_workflow_timeline_guide(item: VideoCanvasItem, spec: GenerationSpec,
                                    references: tuple[ResolvedReference, ...]) -> ResolvedReference:
    try:
        guide = resolve_h3_timeline_guide(spec, references, required=True)
        if guide is not None and (guide.sourceVersion is None or guide.sourceVersion.id != item.id):
            return guide
    except ValueError:
        pass
    name = item.title.strip() or str(item.id)
    raise ContractError('reference_invalid', f'片段「{name}」必须使用有效的 H3 时间线导帧。', item.id)


def _requires_assembly_origin(project: ProjectSnapshot, spec_id: UUID) -> bool:
    groups = {item.id: item for item in project.canvasItems if isinstance(item, GroupCanvasItem)}
    for item in project.canvasItems:
        if not isinstance(item, VideoCanvasItem) or item.parentId is None:
            continue
        binding = item.binding
        if binding.role == 'generation':
            spec_ref = binding.objectRef
        elif binding.role == 'empty':
            spec_ref = binding.draftSpec
        else:
            continue
        if spec_ref is None or spec_ref.id != spec_id:
            continue
        if next(_workflow_assemblies(item, groups), None) is not None:
            return True
    return False


def validate_command(command: Command, project: ProjectSnapshot):
    """Validate scope, versions and role intent; C03/C06 execute and persist.

    Idempotent replay must be resolved by the command store before applying
    current-version checks. This function never changes roles or creates tasks.
    """
    if command.projectId != project.project.id:
        raise ContractError('missing_object', 'Command belongs to a different project')
    index = {('project', project.project.id): project.project}
    for kind, collection in [('asset', project.assets), ('generation_spec', project.generationSpecs),
        ('reference', project.references), ('canvas_item', project.canvasItems),
        ('editor_document', project.editorDocuments), ('job', project.jobs), ('result', project.results)]:
        index.update({(kind, obj.id): obj for obj in collection})
    expected = {(version.objectType, version.id): version.revision for version in command.expectedVersions}
    for key, version in expected.items():
        obj = index.get(key)
        if obj is None:
            raise ContractError('missing_object', 'Expected object does not exist', key[1])
        if obj.revision != version:
            raise ContractError('revision_conflict', 'Object changed; reread before modifying', key[1])
    payload = command.payload
    def get(kind, object_id):
        obj = index.get((kind, object_id))
        if obj is None:
            raise ContractError('missing_object', 'Target object does not exist', object_id)
        return obj
    if command.type in {'canvas.materialize', 'generation.submit'}:
        item_id = payload.itemId if command.type == 'canvas.materialize' else payload.originItemId
        if command.type == 'generation.submit' and item_id is None and _requires_assembly_origin(project, payload.specId):
            raise ContractError('invalid_input', '分组片段提交时必须指定来源画布节点（originItemId）。', payload.specId)
        if item_id is not None:
            item = get('canvas_item', item_id)
            if not isinstance(item, MediaCanvasItem):
                raise ContractError('role_restricted', 'Editor nodes do not accept media generation/material writes', item_id)
            if ('canvas_item', item_id) not in expected:
                raise ContractError('revision_conflict', 'Node operation requires its current version', item_id)
            try:
                if command.type == 'canvas.materialize' and item.kind == 'text' and item.binding.role == 'generation' and payload.discardGenerationDraft:
                    pass
                else:
                    role_after(item.binding.role, 'upload_material' if command.type == 'canvas.materialize' else 'accept_generation')
            except ValueError:
                raise ContractError('role_restricted', 'Operation is incompatible with the node role', item_id) from None
            if command.type == 'canvas.materialize':
                if item.kind != payload.asset.kind:
                    raise ContractError('invalid_input', 'Material kind differs from node kind', item_id)
                asset = get('asset', payload.asset.assetId)
                if payload.asset.fingerprint != asset.fingerprint or payload.asset.revision > asset.revision:
                    raise ContractError('reference_invalid', 'Material content identity differs from its asset', asset.id)
                if item.binding.role == 'empty' and item.binding.draftSpec:
                    spec = get('generation_spec', item.binding.draftSpec.id)
                    if spec.prompt or spec.modelConfigId or spec.promptContent:
                        if not payload.discardGenerationDraft or expected.get(('generation_spec', spec.id)) != spec.revision:
                            raise ContractError('revision_conflict', 'Replacing configured draft requires explicit discard and its version', spec.id)
            else:
                if item.kind == 'file':
                    raise ContractError('role_restricted', 'File nodes cannot generate', item_id)
                spec_ref = item.binding.objectRef if item.binding.role == 'generation' else item.binding.draftSpec
                if spec_ref is None or spec_ref.id != payload.specId:
                    raise ContractError('invalid_input', 'Origin node does not own this generation draft', item_id)
                if get('generation_spec', payload.specId).kind != item.kind:
                    raise ContractError('invalid_input', 'Generation kind differs from origin node', item_id)
    if command.type == 'generationSpec.update':
        current = get('generation_spec', payload.spec.id)
        if (current.kind, current.purpose, current.currentResultId) != (payload.spec.kind, payload.spec.purpose, payload.spec.currentResultId):
            raise ContractError('role_restricted', 'Configuration edits cannot change purpose, kind or result selection', current.id)
    if command.type == 'reference.add':
        spec = get('generation_spec', payload.reference.targetSpecId)
        if any(isinstance(item, MediaCanvasItem) and item.binding.role == 'empty' and item.binding.draftSpec
               and item.binding.draftSpec.id == spec.id and ('canvas_item', item.id) not in expected for item in project.canvasItems):
            raise ContractError('revision_conflict', 'Locking an empty node requires its current version', spec.id)
    if command.type in {'job.cancel', 'job.recover'}:
        get('job', payload.jobId)
    if command.type == 'result.select':
        if get('result', payload.resultId).specId != payload.specId:
            raise ContractError('invalid_input', 'Result belongs to another generation spec', payload.resultId)
    if command.type == 'reference.update':
        if get('reference', payload.reference.id).targetSpecId != payload.reference.targetSpecId:
            raise ContractError('invalid_input', 'A reference cannot be moved to another generation spec', payload.reference.id)
    if command.type == 'editor.save':
        current = get('editor_document', payload.document.id)
        if current.kind != payload.document.kind:
            raise ContractError('invalid_input', 'Editor document kind cannot change', current.id)


def segment_run_owner(snapshot: ProjectSnapshot, spec_id: UUID) -> GroupCanvasItem | None:
    for group, members, _ in _workflow_plans(snapshot).values():
        if group.runPlan is not None and any(spec.id == spec_id for spec in members.values()):
            return group
    return None


def validate_segment_run_transition(before: ProjectSnapshot, after: ProjectSnapshot, command, source) -> None:
    """Protect runtime-owned state even through batches, history and ordinary editors."""
    old_items = {item.id: item for item in before.canvasItems}
    new_items = {item.id: item for item in after.canvasItems}
    old_drafts = {item.id for item in old_items.values() if isinstance(item, GroupCanvasItem) and item.draftRunPlan is not None}
    new_drafts = {item.id for item in new_items.values() if isinstance(item, GroupCanvasItem) and item.draftRunPlan is not None}
    old_runs = {item.id: item for item in old_items.values()
                if isinstance(item, GroupCanvasItem) and item.runPlan is not None}
    new_runs = {item.id: item for item in new_items.values()
                if isinstance(item, GroupCanvasItem) and item.runPlan is not None}
    added_drafts = new_drafts - old_drafts
    if added_drafts and command.type != 'group.saveRunPlan':
        raise ContractError('role_restricted', '请使用分段计划保存命令创建草稿。')
    if set(new_runs) - set(old_runs):
        if command.type != 'group.publishRun' or set(new_runs) - set(old_runs) != {command.payload.groupId}:
            raise ContractError('role_restricted', '只能通过发布命令创建 Run。')
    if not old_runs:
        return
    old_specs = {spec.id: spec for spec in before.generationSpecs}
    new_specs = {spec.id: spec for spec in after.generationSpecs}
    old_docs = {doc.id: doc for doc in before.editorDocuments}
    new_docs = {doc.id: doc for doc in after.editorDocuments}
    new_assets = {asset.id: asset for asset in after.assets}
    protected = '计划已发布，无法直接修改。'

    def unavailable(item, *, visibility=True):
        while item is not None:
            if item.locked or (visibility and not item.visible):
                return True
            item = new_items.get(item.parentId)
        return False

    for group_id, old in old_runs.items():
        new = new_runs.get(group_id)
        if (new is None or new.runPlan != old.runPlan or new.assembly != old.assembly
                or new.runModelFingerprints != old.runModelFingerprints or new.runPlanItemId != old.runPlanItemId
                or new.runDefinitionId != old.runDefinitionId or new.runPlanLocale != old.runPlanLocale
                or new.runPlanNotes != old.runPlanNotes
                or new.visible != old.visible or new.parentId != old.parentId):
            raise ContractError('role_restricted', protected, group_id)
        source_asset = new_assets.get(old.runPlan.source.assetId)
        if source_asset is None or source_asset.revision != old.runPlan.source.revision:
            raise ContractError('role_restricted', protected, old.runPlan.source.assetId)
        if unavailable(new):
            raise ContractError('role_restricted', protected, group_id)
        recipe = old.assembly
        assembling = source == 'background' and command.type == 'group.assemble' and command.payload.groupId == group_id
        owned = {recipe.timelineItemId, old.runPlanItemId, *(clip.itemId for clip in recipe.clips)}
        if not assembling:
            owned.add(recipe.outputItemId)
        for item_id in owned:
            previous, updated = old_items.get(item_id), new_items.get(item_id)
            if previous is None and updated is None:
                continue
            if (previous is None or updated is None or previous.kind != updated.kind or previous.binding != updated.binding
                    or previous.visible != updated.visible or previous.parentId != updated.parentId or unavailable(updated)):
                raise ContractError('role_restricted', protected, item_id)
        document_id = old_items[recipe.timelineItemId].binding.objectRef.id
        if not assembling and old_docs.get(document_id) != new_docs.get(document_id):
            raise ContractError('role_restricted', protected, document_id)
        if any(unavailable(item, visibility=False) for item in new_items.values() if item.kind == 'timeline'
               and item.binding.objectRef.id == document_id and item.id != recipe.timelineItemId):
            raise ContractError('role_restricted', protected, document_id)
        specs = {old_items[clip.itemId].binding.objectRef.id for clip in recipe.clips}
        for spec_id in specs:
            previous, updated = old_specs[spec_id], new_specs.get(spec_id)
            exclude = {'revision', 'currentResultId'} if source == 'background' else {'revision'}
            if updated is None or previous.model_dump(exclude=exclude) != updated.model_dump(exclude=exclude):
                raise ContractError('role_restricted', protected, spec_id)
        if (tuple(ref for ref in before.references if ref.targetSpecId in specs)
                != tuple(ref for ref in after.references if ref.targetSpecId in specs)):
            raise ContractError('role_restricted', protected, group_id)
        if source != 'background' and (
            tuple(job for job in before.jobs if job.inputSnapshot.spec.id in specs)
            != tuple(job for job in after.jobs if job.inputSnapshot.spec.id in specs)
        ):
            raise ContractError('role_restricted', '已发布片段须通过 Run 执行。', group_id)
