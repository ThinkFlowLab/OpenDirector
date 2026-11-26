"""Side-effect-free contextual command guards shared by future entrypoints."""
from typing import get_args
from uuid import UUID

from opendirector.domain.projects import ProjectError

from .canvas import GroupCanvasItem, MediaCanvasItem, role_after
from .commands import Command, ContractIssue, IssueCode
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


def validate_published_plans(command: Command, before: ProjectSnapshot, after: ProjectSnapshot) -> None:
    old_plans = {item.id: item for item in before.canvasItems if isinstance(item, GroupCanvasItem) and item.runPlan}
    publication = command.payload.groupId if command.type == 'group.publishRun' else None
    for item in after.canvasItems:
        if isinstance(item, GroupCanvasItem) and item.runPlan is not None:
            if item.id not in old_plans and item.id != publication:
                raise ContractError('role_restricted', '请使用发布命令生成已发布计划。', item.id)
    if not old_plans:
        return
    old_items = {item.id: item for item in before.canvasItems}
    new_items = {item.id: item for item in after.canvasItems}
    new_assets = {asset.id: asset for asset in after.assets}
    for group in old_plans.values():
        updated = new_items.get(group.id)
        if (not isinstance(updated, GroupCanvasItem) or not updated.visible
                or updated.parentId != group.parentId or updated.runPlan != group.runPlan or updated.assembly != group.assembly
                or updated.runPlanItemId != group.runPlanItemId or updated.runDefinitionId != group.runDefinitionId
                or updated.runPlanLocale != group.runPlanLocale or updated.runPlanNotes != group.runPlanNotes):
            raise ContractError('role_restricted', '已发布的计划定义为只读。', group.id)
        card = old_items[group.runPlanItemId]
        updated_card = new_items.get(card.id)
        if (updated_card is None or updated_card.kind != 'text' or not updated_card.visible
                or not updated_card.locked or updated_card.parentId != group.id
                or updated_card.binding != card.binding):
            raise ContractError('role_restricted', '已发布的计划卡为只读。', card.id)
        source = new_assets.get(group.runPlan.source.assetId)
        if source is None or source.revision != group.runPlan.source.revision:
            raise ContractError('role_restricted', '已发布的计划仍引用此源片。', group.runPlan.source.assetId)
