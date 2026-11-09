"""Unified tool inputs and publication, independent of the canvas runtime."""
from uuid import UUID, uuid5

from opendirector.application.creation_canvas import CreationCanvas, asset_ref, current_asset
from opendirector.domain.creation.canvas import media_card_size
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.editors import ToolDraftBinding
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.projects import ProjectError


def editable(snapshot, item_id):
    item = next((item for item in snapshot.canvasItems if str(item.id) == str(item_id)), None)
    if item is None:
        raise ProjectError('工具来源节点不存在，请重新选择。', 409)
    try:
        CreationCanvas._editable(snapshot.model_dump(mode='json'), item.id)
    except ContractError as error:
        raise ProjectError(str(error), 409) from error
    return item


def target_intent(snapshot, item):
    """Attached configuration edits need not increment the canvas item version."""
    draft = getattr(item.binding, 'draftSpec', None)
    spec = next((value for value in snapshot.generationSpecs if draft and value.id == draft.id), None)
    editor_ids = {ref.id for ref in getattr(item, 'editors', ())}
    return dict(spec=spec.model_dump(mode='json') if spec else None,
                references=[ref.model_dump(mode='json') for ref in snapshot.references if draft and ref.targetSpecId == draft.id],
                editors=[doc.model_dump(mode='json') for doc in snapshot.editorDocuments if doc.id in editor_ids])


def freeze_inputs(service, project_id, value):
    snapshot = service.projects.snapshot(project_id)
    canvas = value.get('canvas')
    document = None
    if value.get('draft'):
        binding = ToolDraftBinding.model_validate(value['draft'])
        document = next((doc for doc in snapshot.editorDocuments if doc.id == binding.editorId), None)
        owner = editable(snapshot, binding.itemId)
        if (not document or document.kind != 'media_edit' or document.revision != binding.editorRevision
                or owner.revision != binding.itemRevision or not any(ref.id == document.id for ref in owner.editors)):
            raise ProjectError('工具草稿或来源版本已变化，请重新打开编辑器。', 409)
        data = document.data
        selected_model = data.parameters.get('imageModelConfigId')
        if selected_model and (value.get('modelConfigIds') or {}).get('image.edit') != selected_model:
            raise ProjectError('工具模型与已保存草稿不一致。', 409)
        if (not canvas or str(owner.id) != canvas['nodeId'] or list(map(str, data.sourceItems)) != canvas['sourceNodeIds']
                or data.tool != value['tool'] or data.parameters != value.get('parameters', {})
                or list(map(lambda ref: str(ref.assetId), data.sources)) != value['sourceAssetIds']
                or (str(data.selection.mask.assetId) if data.selection and data.selection.mask else None) != value.get('maskAssetId')
                or ([box.model_dump() for box in data.selection.boxes] if data.selection else []) != value.get('boxes', [])):
            raise ProjectError('工具请求与已保存草稿不一致，请重新读取后提交。', 409)
    sources = []
    for index, asset_id in enumerate(value['sourceAssetIds']):
        asset = service.assets.assets.get(project_id, asset_id)
        service.assets.assets.reference_available(project_id, asset_id)
        if document and asset_ref(asset) != document.data.sources[index]:
            raise ProjectError('工具素材版本已变化，请重新读取后提交。', 409)
        if canvas:
            owner = editable(snapshot, canvas['sourceNodeIds'][index])
            if current_asset(snapshot, owner) != asset:
                raise ProjectError('工具来源已变化，不能用旧选区提交新素材。', 409)
        sources.append(asset_ref(asset).model_dump(mode='json'))
    first = service.assets.assets.get(project_id, value['sourceAssetIds'][0])
    for key in ('maskAssetId', 'annotationAssetId'):
        if value.get(key):
            auxiliary = service.assets.assets.get(project_id, value[key])
            service.assets.assets.reference_available(project_id, value[key])
            if (auxiliary.kind != 'image' or first.kind != 'image'
                    or (auxiliary.metadata.width, auxiliary.metadata.height) != (first.metadata.width, first.metadata.height)):
                raise ProjectError('选区或标注尺寸与实际来源图片不一致。', 422)
    for box in value.get('boxes', []):
        if (first.kind not in {'image', 'video'} or box['x'] < 0 or box['y'] < 0 or box['width'] <= 0 or box['height'] <= 0
                or box['x'] + box['width'] > first.metadata.width or box['y'] + box['height'] > first.metadata.height):
            raise ProjectError('选区矩形超出实际来源媒体。', 422)
    target = None
    if canvas and canvas.get('targetNodeId'):
        target = editable(snapshot, canvas['targetNodeId'])
        if target.kind != canvas['targetKind'] or target.binding.role != 'empty':
            raise ProjectError('工具结果占位节点已变化。', 409)
    return dict(draftSnapshot=document.model_dump(mode='json') if document else None,
                draftBinding=value.get('draft'), sourceAssets=sources,
                targetSnapshot=target.model_dump(mode='json') if target else None,
                targetIntent=target_intent(snapshot, target) if target else None)


def _numbered(title):
    head, separator, tail = title.rpartition(' ')
    return (head, int(tail)) if separator and head and tail.isascii() and tail.isdigit() else (title, None)


def result_title(snapshot, base, used=(), exclude=None):
    """Keep result names tied to their tool; a repeated run takes the next number."""
    family, index = _numbered(base)
    occupied = [item.title for item in snapshot.canvasItems
                if item.visible and item.title and (exclude is None or item.id != exclude)]
    taken = (*occupied, *used)
    if base not in taken:
        return base
    numbers = [0]
    for title in taken:
        head, number = _numbered(title)
        if head != family:
            continue
        numbers.append(1 if number is None else number)
    return f'{family} {max(numbers) + 1}'


def release_placeholder(service, task, session=None):
    """Release only the accepted task's unchanged target; never infer UI defaults."""
    snapshot = service.projects.snapshot(task['projectId'])
    saved = task.get('targetSnapshot')
    target = next((item for item in snapshot.canvasItems if saved and str(item.id) == saved['id']), None)
    if not target or not target.visible or target.binding.role != 'empty':
        return 'unplaced'
    # Layout is presentation. Creative changes, parent/lock changes and attached
    # configuration edits remain protected even when the task has failed.
    presentation = {'revision', 'position', 'width', 'height', 'zIndex'}
    current = target.model_dump(mode='json')
    if ({k:v for k,v in current.items() if k not in presentation} != {k:v for k,v in saved.items() if k not in presentation}
            or target_intent(snapshot, target) != task.get('targetIntent')):
        return 'unplaced'
    try:
        editable(snapshot, target.id)
    except ProjectError:
        return 'unplaced'
    command = parse_command(dict(commandId=uuid5(UUID(task['id']), f'unplaced:{target.revision}'), projectId=snapshot.project.id,
        type='canvas.hide', expectedVersions=[dict(objectType='canvas_item', id=target.id, revision=target.revision)], payload=dict(itemId=target.id)))
    receipt = service.projects.execute(command, session=session, source='background')
    if receipt.status == 'rejected':
        raise ProjectError('工具占位清理未确认：' + '；'.join(issue.message for issue in receipt.issues), 409)
    return 'unplaced'


def publish_outputs(service, task, session, policy):
    """Stable output identities + an atomic project command recover a lost ack."""
    from opendirector.application.tool_tasks import output_item_id
    snapshot = service.projects.snapshot(task['projectId'])
    canvas = task.get('canvas') or {}
    source = next((item for item in snapshot.canvasItems if str(item.id) == canvas.get('nodeId')), None)
    operations, versions = [], {}
    # Recover a committed publication before consulting subsequently edited
    # sources. Hidden outputs stay hidden on automatic acknowledgement.
    if policy == 'if_current' and task['outputs'] and all(
            (item := next((item for item in snapshot.canvasItems if str(item.id) == output_item_id(task, index, output['kind'])), None)) is not None
            and (asset := current_asset(snapshot, item)) is not None and str(asset.id) == output['id']
            for index, output in enumerate(task['outputs'])):
        return 'placed'
    def unplaced():
        return release_placeholder(service, task, session)
    def expect(kind, obj):
        versions[(kind, str(obj.id))] = dict(objectType=kind, id=obj.id, revision=obj.revision)
    # Completion itself never grants permission to overwrite the source. The
    # explicit operation only publishes owned outputs as separate editable nodes.
    if source:
        try:
            editable(snapshot, source.id)
        except ProjectError:
            if policy == 'if_current':
                return unplaced()
            raise
        expect('canvas_item', source)
    matching = True
    for index, item_id in enumerate(canvas.get('sourceNodeIds', [])):
        item = next((item for item in snapshot.canvasItems if str(item.id) == item_id), None)
        actual = current_asset(snapshot, item) if item else None
        expected = task.get('sourceAssets', [])[index] if task.get('sourceAssets') else None
        if not item or not item.visible or not actual or (expected and (str(actual.id), actual.fingerprint) != (expected['assetId'], expected['fingerprint'])):
            matching = False
        if item:
            try:
                editable(snapshot, item.id)
            except ProjectError:
                if policy == 'if_current':
                    return unplaced()
                raise
            expect('canvas_item', item)
    if policy == 'if_current' and not matching:
        return unplaced()
    titles = []
    for index, output in enumerate(task['outputs']):
        item_id = UUID(output_item_id(task, index, output['kind']))
        item = next((item for item in snapshot.canvasItems if item.id == item_id), None)
        asset = service.assets.assets.get(task['projectId'], output['id'])
        service.assets.assets.reference_available(task['projectId'], output['id'])
        while item and current_asset(snapshot, item) != asset:
            saved = task.get('targetSnapshot')
            pristine = saved and str(item.id) == saved['id'] and item.binding.role == 'empty' and item.title == saved['title'] and target_intent(snapshot, item) == task.get('targetIntent')
            allowed_hidden = policy == 'explicit' and task.get('placement') == 'unplaced' and pristine and not item.visible and item.revision == saved['revision'] + 1
            if not pristine or (item.revision != saved['revision'] and not allowed_hidden) or (not item.visible and not allowed_hidden):
                if policy == 'if_current':
                    return unplaced()
                # Publish separately when the user edited the placeholder.
                # The deterministic identity also recovers a lost acknowledgement.
                item_id = uuid5(UUID(task['id']), f'adopted-output-{index}:{item.id}:{item.revision}')
                item = next((node for node in snapshot.canvasItems if node.id == item_id), None)
                output['canvasItemId'] = str(item_id)
            else:
                break
        if item and current_asset(snapshot, item) == asset:
            if policy == 'explicit' and not item.visible:
                editable(snapshot, item.id)
                expect('canvas_item', item)
                operations.append(dict(type='canvas.show', payload=dict(item=item.model_dump(mode='json'))))
            continue
        # The placeholder already carries the tool/preset name in the UI language.
        title = result_title(snapshot, item.title if item else output['title'],
                             titles, item.id if item else None)
        titles.append(title)
        if item:
            editable(snapshot, item.id)
            expect('canvas_item', item)
            if not item.visible:
                operations.append(dict(type='canvas.show', payload=dict(item=item.model_dump(mode='json'))))
            if item.title != title:
                operations.append(dict(type='canvas.update', payload=dict(itemId=item.id, title=title)))
            operations.append(dict(type='canvas.materialize', payload=dict(itemId=item.id, asset=asset_ref(asset).model_dump(mode='json'), discardGenerationDraft=True)))
        else:
            width, height = media_card_size(asset.kind, asset.metadata.width, asset.metadata.height,
                                            source.width if source else 320, source.height if source else 240)
            operations.append(dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=snapshot.project.id,
                kind=asset.kind, title=title, position=dict(x=(source.position.x + source.width + 120 if source else 80) + index * 360, y=source.position.y if source else 80),
                width=width, height=height, binding=dict(role='material', objectRef=asset_ref(asset).model_dump(mode='json'))))))
        if asset.kind == 'image':
            editor_id = uuid5(UUID(task['id']), f'output-editor-{item_id}')
            # Continue editing the new pixels with fresh source identity. Never
            # carry an old mask or annotation onto the result's different pixels.
            parameters = {k: v for k, v in task['parameters'].items() if k != 'annotationDocument'}
            operations.extend([
                dict(type='editor.create', payload=dict(document=dict(id=editor_id, projectId=snapshot.project.id, kind='media_edit',
                    data=dict(tool=task['tool'], sourceItems=[item_id], sources=[asset_ref(asset).model_dump(mode='json')], parameters=parameters)))),
                dict(type='canvas.attachEditor', payload=dict(itemId=item_id, editorId=editor_id))])
    if operations:
        command = parse_command(dict(commandId=uuid5(UUID(task['id']), f'publish:{policy}:{snapshot.eventCursor}'), projectId=snapshot.project.id,
            type='creation.batch', expectedVersions=list(versions.values()), payload=dict(operations=operations)))
        receipt = service.projects.execute(command, session=session)
        if receipt.status == 'rejected':
            raise ProjectError('工具结果未采用：' + '；'.join(issue.message for issue in receipt.issues), 409)
    return 'placed'
