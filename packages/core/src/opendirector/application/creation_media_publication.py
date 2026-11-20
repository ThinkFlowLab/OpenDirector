"""Atomic publication of browser-produced media with a fixed editing basis."""
from pydantic import TypeAdapter

from opendirector.domain.creation.canvas import CanvasItem
from opendirector.domain.creation.project import ProjectSnapshot, asset_references
from opendirector.domain.creation.validation import ContractError
from .creation_canvas import current_asset, asset_ref


def publish_media(service, data, payload):
    item = service._editable(data, payload.itemId)
    snapshot = ProjectSnapshot.model_validate(data)
    owner = next(i for i in snapshot.canvasItems if i.id == payload.itemId)
    doc = payload.document
    if doc.projectId != snapshot.project.id or doc.revision != 1 or any(d.id == doc.id for d in snapshot.editorDocuments):
        raise ContractError('invalid_input', '编辑执行快照必须使用新的工程内身份。', doc.id)
    if doc.inputConnections:
        raise ContractError('invalid_input', '编辑输出不能伪造装配关系。', doc.id)
    if doc.kind == 'director':
        if owner.kind != 'external' or owner.binding.role != 'editor' or owner.binding.objectRef.id != payload.sourceEditorId:
            raise ContractError('reference_invalid', '导演预演来源已变化。', owner.id)
        original = next(d for d in snapshot.editorDocuments if d.id == payload.sourceEditorId)
        if original.kind != 'director' or original.data != doc.data or payload.source is not None:
            raise ContractError('revision_conflict', '预演输出与已确认的舞台版本不一致。', owner.id)
        allowed, sources = {'video'}, []
    else:
        actual = current_asset(snapshot, owner)
        if not actual or payload.source != asset_ref(actual) or doc.data.sourceItems != (owner.id,) or doc.data.sources != (payload.source,):
            raise ContractError('reference_invalid', '本地编辑的来源素材已变化。', owner.id)
        if payload.sourceEditorId is not None:
            raise ContractError('invalid_input', '媒体编辑须使用本次固定的素材输入。', owner.id)
        tool = doc.data.tool
        # Local operations preserve source type, except explicit frame/audio extraction.
        if tool == 'video-frame-capture':
            expected, allowed = 'video', {'image'}
        elif tool == 'extract-audio':
            expected, allowed = 'video', {'audio'}
            if not actual.metadata.hasAudio:
                raise ContractError('invalid_input', '来源视频没有可提取的音轨。', actual.id)
        elif tool in {'video-depth-capture', 'video-extend', 'video-partial-reshoot', 'video-trim', 'video-crop', 'video-edit', 'video-upscale', 'video-frame-interpolation', 'video-subtitle-erasure', 'video-matting', 'video-translation'}:
            expected, allowed = 'video', {'video'}
        elif tool in {'audio-trim', 'audio-separation'}:
            expected, allowed = ('video' if tool == 'audio-separation' and actual.kind == 'video' else 'audio'), {'audio'}
        else:
            expected, allowed = 'image', {'image', 'video'} if tool == 'dynamic-poster' else {'image'}
        if actual.kind != expected:
            raise ContractError('invalid_input', '编辑操作与来源媒体类型不匹配。', actual.id)
        sources = list(asset_references(doc))
    used = {r.assetId for r in asset_references(snapshot)}
    historical = {r.assetId for record in service.projects.history(snapshot.project.id) for r in asset_references(record.snapshot)}
    for ref in sources:
        service._available(service.assets._reference(snapshot, ref))
    for output in payload.outputs:
        asset = service.assets._reference(snapshot, output.asset)
        # Uploads come from the browser session; agents register the same
        # deliverables through artifact.publish. The invariant is freshness.
        if asset.kind not in allowed or asset.provenance.source not in {'upload', 'agent_written'} or asset.id in used | historical:
            raise ContractError('role_restricted', '输出必须是尚未发布且类型匹配的真实素材。', asset.id)
        service._available(asset)
        if doc.kind == 'director' and (asset.metadata.durationSeconds is None or abs(asset.metadata.durationSeconds - doc.data.duration) > .15):
            raise ContractError('invalid_input', '预演视频实际时长与执行快照不一致。', asset.id)
        if any(i['id'] == str(output.itemId) for i in data['canvasItems']):
            raise ContractError('invalid_input', '输出节点身份已存在。', output.itemId)
        record = service._get(data, 'asset', asset.id)
        record['provenance'] = dict(source='rendered' if doc.kind == 'director' else 'edited', sourceItemId=str(owner.id),
            editorDocumentId=str(doc.id), editorRevision=1, sources=[r.model_dump(mode='json') for r in dict((r.assetId, r) for r in sources).values()])
        result = TypeAdapter(CanvasItem).validate_python(dict(id=output.itemId, projectId=snapshot.project.id, kind=asset.kind,
            title=output.title, position=output.position, width=output.width, height=output.height, binding=dict(role='material', objectRef=output.asset)))
        data['canvasItems'].append(result.model_dump(mode='json'))
    # The frozen document belongs to this execution, never to the next draft.
    data['editorDocuments'].append(doc.model_dump(mode='json'))
