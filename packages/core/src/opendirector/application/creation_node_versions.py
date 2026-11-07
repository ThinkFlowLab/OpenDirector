"""Apply an actual output and its recorded creative inputs in one editable commit.

The version family comes from durable node bindings and accepted job ownership,
never filenames or matching bytes. Jobs, results and input snapshots are read only.
"""
from copy import deepcopy
from uuid import UUID, uuid5

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import (
    CreationCanvas, asset_ref, current_asset, prompt_projection, resolve_reference, resolved_inputs,
)
from opendirector.domain.creation.generation import FollowingReference, validate_generation
from opendirector.domain.creation.commands import EditorWrite
from opendirector.domain.creation.models import ModelConfigPublic
from opendirector.domain.creation.index import object_index
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.ports.gateway import gateway


def available_model(projects, frozen):
    """A removed or repurposed model remains evidence, never an implicit fallback."""
    try:
        config = gateway().models(projects.local.repository).resolve(str(frozen.modelConfigId), frozen.kind)
        public = ModelConfigPublic.model_validate({k: v for k, v in config.items() if k != 'apiKey'} | {'inputRules': input_rules(config)})
        fields = ('kind', 'url', 'modelId', 'protocol', 'connectionType', 'videoAdapter')
        if any(getattr(public, field) != getattr(frozen, field) for field in fields):
            return None
        if frozen.inputRules is not None and public.inputRules != frozen.inputRules:
            return None
        return public
    except (ProjectError, ValueError):
        return None


def version_family(projects, project_id, item_id, snapshot, *, records=None):
    item_id = UUID(str(item_id))
    item = next((i for i in snapshot.canvasItems if i.id == item_id), None)
    if item is None or item.kind not in {'text', 'image', 'video', 'audio'}:
        raise ContractError('missing_object', '该媒体节点不存在。', item_id)
    if records is None:
        records = projects.history(project_id)
    family, spec_ids = {}, set()
    for record in reversed(records):
        previous = next((i for i in record.snapshot.canvasItems if i.id == item_id), None)
        if not previous:
            continue
        binding = previous.binding
        owner = binding.objectRef if binding.role == 'generation' else binding.draftSpec if binding.role == 'empty' else None
        if owner:
            spec_ids.add(owner.id)
        asset = current_asset(record.snapshot, previous)
        if asset and asset.id not in family:
            family[asset.id] = dict(commandId=record.command.commandId, binding=binding)
    jobs = {job.id: job for job in snapshot.jobs}
    for result in snapshot.results:
        job = jobs[result.jobId]
        if job.originItemId == item_id or result.specId in spec_ids:
            family.setdefault(result.asset.assetId, dict(commandId=None, binding=None))
            family[result.asset.assetId].update(result=result, job=job)
    return item, family


def current_references_differ(snapshot, frozen):
    """Compare content, not source revisions (moves/renames do not change inputs)."""
    groups = {}
    for reference in frozen.references:
        groups.setdefault(reference.referenceId, []).append(reference)
    for reference_id, historical in groups.items():
        first = historical[0]
        if first.sourceVersion is None:
            continue  # An explicit asset has no live node to follow.
        reference = FollowingReference(id=reference_id, projectId=snapshot.project.id,
            targetSpecId=frozen.spec.id, role=first.role, binding='follow_current',
            source=dict(id=first.sourceVersion.id))
        try:
            current = resolve_reference(snapshot, reference)
        except ContractError:
            return True  # Applying still performs the authoritative validation.
        def content(values):
            return [(value.asset, value.subjectRole, value.role) for value in values]
        if content(current) != content(historical):
            return True
    return False


def node_versions(projects, project_id, item_id, *, assets=None):
    records = projects.history(project_id)
    snapshot = records[0].snapshot
    item, family = version_family(projects, project_id, item_id, snapshot, records=records)
    service = assets or CreationAssets(projects)
    models = {}
    rows = []
    for asset in reversed(snapshot.assets):
        evidence = family.get(asset.id)
        if evidence is None:
            continue
        asset_id = asset.id
        available = True
        try:
            # Empty text is a valid stored version, even if it cannot be a reference.
            stream, _ = service.open_media(project_id, asset_id, snapshot=snapshot)
            stream.close()
        except (ProjectError, ContractError, OSError, ValueError):
            available = False
        job = evidence.get('job')
        if job:
            key = job.inputSnapshot.model.model_dump_json()
            if key not in models:
                models[key] = available_model(projects, job.inputSnapshot.model) is not None
        rows.append(dict(asset=asset, source='generated' if job else asset.provenance.source,
            available=available, commandId=evidence['commandId'], resultId=evidence['result'].id if job else None,
            jobId=job.id if job else None, createdAt=job.createdAt if job else None, inputSnapshot=job.inputSnapshot if job else None,
            modelAvailable=models[key] if job else None,
            currentReferencesDiffer=current_references_differ(snapshot, job.inputSnapshot) if job else False))
    current = current_asset(snapshot, item)
    return dict(item=item, versions=rows, currentAssetId=current.id if current else None,
        eventCursor=snapshot.eventCursor,
        expectedVersions=[dict(objectType=kind, id=obj.id, revision=obj.revision)
                          for (kind, _), obj in object_index(snapshot).items()])


def apply_node_version(history, before, command):
    projects, payload = history.projects, command.payload
    item, family = version_family(projects, command.projectId, payload.itemId, before)
    evidence = family.get(payload.asset.assetId)
    if evidence is None:
        raise ContractError('reference_invalid', '该素材不属于此节点的历史版本。', payload.asset.assetId)
    assets = CreationAssets(projects)
    asset = assets._reference(before, payload.asset)
    if asset.kind != item.kind:
        raise ContractError('invalid_input', '历史素材类型与节点不匹配。', item.id)
    stream, _ = assets.open_media(command.projectId, asset.id)
    stream.close()
    data = before.model_dump(mode='json')
    target = CreationCanvas._editable(data, item.id)
    current_spec_id = item.binding.objectRef.id if item.binding.role == 'generation' else item.binding.draftSpec.id if item.binding.role == 'empty' and item.binding.draftSpec else None
    if any((j.originItemId == item.id or j.inputSnapshot.spec.id == current_spec_id) and
           (j.status in {'queued', 'running'} or j.resumeAllowed or j.recovery == 'review') for j in before.jobs):
        raise ContractError('revision_conflict', '节点有未结束或待确认任务，请先处理任务。', item.id)
    job = evidence.get('job')
    if job is None:
        if item.binding.role == 'generation':
            if item.kind != 'text' and not (item.kind == 'image' and asset.provenance.source == 'edited'):
                raise ContractError('role_restricted', '生成节点不能采用手工素材版本。', item.id)
            target['binding']['materialOverride'] = asset_ref(asset).model_dump(mode='json')
        else:
            target['binding'] = dict(role='material', objectRef=asset_ref(asset).model_dump(mode='json'))
        if item.kind == 'image':
            target['editors'] = [ref for ref in target['editors'] if ref['kind'] not in {'layers', 'image_crop'}]
            provenance = asset.provenance
            if provenance.source == 'edited':
                document = next((doc for record in reversed(projects.history(command.projectId))
                    for doc in record.snapshot.editorDocuments
                    if doc.id == provenance.editorDocumentId and doc.revision == provenance.editorRevision), None)
                if document is None or document.kind not in {'layers', 'image_crop'}:
                    raise ContractError('reference_invalid', '编辑版本的文档无法恢复。', asset.id)
                current = CreationCanvas._get(data, 'editor_document', document.id)
                # Restoring a shared document must respect every owner's lock.
                CreationCanvas(projects)._mutate(data, 'editor.save', EditorWrite(document=document.model_copy(update={'revision': current['revision']})))
                target['editors'].append(dict(objectType='editor_document', id=str(document.id), kind=document.kind))
        return history._revisions(before, data)

    frozen, result = job.inputSnapshot, evidence['result']
    if current_spec_id is not None and current_spec_id != frozen.spec.id:
        raise ContractError('reference_invalid', '历史执行不属于节点的生成配置。', item.id)
    spec = CreationCanvas._get(data, 'generation_spec', frozen.spec.id)
    model = available_model(projects, frozen.model)
    spec.update(frozen.spec.model_dump(mode='json', exclude={'revision', 'currentResultId'}))
    spec.update(currentResultId=str(result.id), modelConfigId=str(frozen.spec.modelConfigId) if model else None)
    target['binding'] = dict(role='generation', objectRef=dict(objectType='generation_spec', id=spec['id']))
    if item.kind == 'image':
        target['editors'] = [ref for ref in target['editors'] if ref['kind'] not in {'layers', 'image_crop'}]
    old_refs = {str(ref.id): ref for ref in before.references}
    groups = {}
    for resolved in frozen.references:
        groups.setdefault(resolved.referenceId, []).append(resolved)
    refs, replacements = [], {}
    for reference_id, resolved in groups.items():
        first = resolved[0]
        follow = payload.referencePolicy == 'follow_current' and first.sourceVersion is not None
        values = [first] if follow else resolved
        replacements[str(reference_id)] = []
        for index, value in enumerate(values):
            key = str(reference_id if index == 0 else uuid5(command.commandId, f'{reference_id}:{index}'))
            prior = old_refs.get(key)
            if prior and prior.targetSpecId != frozen.spec.id:
                raise ContractError('reference_invalid', '参考身份已用于另一配置。', prior.id)
            ref = dict(id=key, projectId=str(command.projectId), revision=prior.revision if prior else 1,
                active=True, targetSpecId=spec['id'], order=len(refs), role=value.role,
                binding='follow_current' if follow else 'pinned',
                source=dict(objectType='canvas_item', id=str(first.sourceVersion.id)) if follow else value.asset.model_dump(mode='json'))
            if not follow:
                ref['subjectRole'] = value.subjectRole
                ref['sourceVersion'] = value.sourceVersion.model_dump(mode='json') if value.sourceVersion else None
            refs.append(ref)
            replacements[str(reference_id)].append(key)
    restored = {r['id'] for r in refs}
    data['references'] = [{**r, 'active': False} if r['targetSpecId'] == spec['id'] else r
                          for r in data['references'] if r['id'] not in restored] + refs
    if spec['promptContent'] is not None:
        spec['promptContent'] = [deepcopy(part) if part['type'] == 'text' else dict(type='reference', referenceId=key)
            for part in spec['promptContent']
            for key in ([None] if part['type'] == 'text' else replacements[part['referenceId']])]
        spec['prompt'] = prompt_projection(data, spec)
    after = history._revisions(before, data)
    configured = next(s for s in after.generationSpecs if s.id == frozen.spec.id)
    resolved = resolved_inputs(after, configured.id, model.inputRules if model else frozen.model.inputRules)
    for value in resolved:
        assets._reference(after, value.asset)
        assets.reference_available(command.projectId, value.asset.assetId)
    if model:
        try:
            validate_generation(configured, model, resolved)
        except (ValueError, ProjectError) as error:
            raise ContractError.from_error(error, item.id) from error
    return after
