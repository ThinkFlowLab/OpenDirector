"""Local output is one transaction with frozen inputs, provenance and display identity."""
from uuid import uuid4

import pytest
from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_history import CreationHistory
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.domain.creation.assets import AssetProvenance
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from test_creation_canvas_service import project, send, ver
from test_creation_tool_drafts import png


pytestmark = pytest.mark.cpu


def prepared(project, count=2):
    store, pid, session = project
    assets = CreationToolAssets(store)
    def upload(color):
        record=assets.import_file(pid,uuid4(),color+'.png',png(color),session,provenance=AssetProvenance(source='upload'))
        return assets.assets.get(pid,record['id'])
    source=upload('blue')
    item_id=uuid4()
    assert send(store,pid,'canvas.show',session=session,item=dict(id=item_id,projectId=pid,kind='image',binding=dict(role='material',objectRef=asset_ref(source)))).status=='applied'
    outputs=[upload('red') for _ in range(count)]
    item=store.snapshot(pid).canvasItems[0]
    payload=dict(itemId=item.id,source=asset_ref(source),document=dict(id=uuid4(),projectId=pid,kind='media_edit',data=dict(tool='grid-split',sources=[asset_ref(source)],sourceItems=[item.id],parameters={'rows':1,'columns':count})),outputs=[dict(itemId=uuid4(),asset=asset_ref(a),title='Tile') for a in outputs])
    versions=[ver('canvas_item',item),*[ver('asset',a) for a in outputs]]
    return source,outputs,payload,versions


@pytest.mark.parametrize('actor',['ui','agent'])
def test_publication_is_atomic_replayable_and_survives_undo_and_restart(project,actor):
    store,pid,session=project
    source,outputs,payload,versions=prepared(project)
    command=parse_command(dict(commandId=uuid4(),projectId=pid,type='canvas.publishMedia',payload=payload,expectedVersions=versions))
    receipt=store.execute(command,session=session,source=actor)
    assert receipt.status=='applied',receipt
    assert store.execute(command,session=session,source=actor)==receipt
    saved=store.snapshot(pid)
    for output in outputs:
        actual=next(a for a in saved.assets if a.id==output.id)
        assert actual.provenance.source=='edited'
        assert actual.provenance.sources==(asset_ref(source),)
        assert actual.provenance.sourceItemId==saved.canvasItems[0].id
        assert actual.provenance.editorDocumentId==saved.editorDocuments[0].id
    assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)==saved
    assert not CreationHistory(store).delete_preview(pid,[source.id],clear_history=True)['canDelete']
    undo=send(store,pid,'history.undo',session=session,versions=[*[ver('canvas_item',i) for i in saved.canvasItems],*[ver('editor_document',d) for d in saved.editorDocuments]],targetCommandId=command.commandId)
    assert undo.status=='applied',undo
    assert sum(i.visible for i in store.snapshot(pid).canvasItems)==1
    assert len(store.snapshot(pid).editorDocuments)==1
    assert len(store.snapshot(pid).assets)==3


@pytest.mark.parametrize('change',['lock','stale','replace','missing_source','missing_output','used_output','duplicate_node','wrong_tool'])
def test_refusal_keeps_all_outputs_unpublished(project,change):
    store,pid,session=project
    source,outputs,payload,versions=prepared(project)
    if change in {'lock','stale'}:
        assert send(store,pid,'canvas.update',session=session,versions=versions,itemId=payload['itemId'],**({'locked':True} if change=='lock' else {'title':'Changed'})).status=='applied'
        if change=='lock':versions[0]=ver('canvas_item',store.snapshot(pid).canvasItems[0])
    elif change=='replace':
        assert send(store,pid,'canvas.materialize',session=session,versions=versions,itemId=payload['itemId'],asset=asset_ref(outputs[0])).status=='applied'
        versions[0]=ver('canvas_item',store.snapshot(pid).canvasItems[0])
    elif change in {'missing_source','missing_output'}:
        asset=source if change=='missing_source' else outputs[-1]
        (store.root/store.snapshot(pid).project.name/asset.path).unlink()
    elif change=='used_output':payload['outputs'][-1]['asset']=asset_ref(source);versions.append(ver('asset',source))
    elif change=='duplicate_node':payload['outputs'][-1]['itemId']=payload['itemId']
    elif change=='wrong_tool':payload['document']['data']['tool']='video-trim'
    before=store.snapshot(pid)
    receipt=send(store,pid,'canvas.publishMedia',session=session,versions=versions,**payload)
    assert receipt.status=='rejected',receipt
    assert store.snapshot(pid)==before

def test_unplaced_audio_publication_retries_with_one_hidden_source_and_preserves_undo(project):
    from test_creation_node_versions import versions
    from test_voice_library import wav

    store, pid, session = project
    service = CreationToolAssets(store)
    def upload(seconds):
        record = service.import_file(pid, uuid4(), 'clip.wav', wav(seconds), session, provenance=AssetProvenance(source='upload'))
        return service.assets.get(pid, record['id'])

    source, output = upload(2), upload(1)
    previous_id, anchor_id, output_id = uuid4(), uuid4(), uuid4()
    earlier = send(store, pid, 'canvas.show', session=session, item=dict(id=previous_id, projectId=pid, kind='group'))
    anchor = send(store, pid, 'creation.batch', session=session, versions=[ver('asset', source)], operations=[
        dict(type='canvas.show', payload=dict(item=dict(id=anchor_id, kind='audio', projectId=pid,
             binding=dict(role='material', objectRef=asset_ref(source))))),
        dict(type='canvas.hide', payload=dict(itemId=anchor_id)),
    ])
    assert earlier.status == anchor.status == 'applied'
    def node(item_id):
        return next(item for item in store.snapshot(pid).canvasItems if item.id == item_id)
    assert not node(anchor_id).visible and node(anchor_id).revision == 1
    assert anchor.commandId not in CreationHistory(store).states(pid)
    document = dict(id=uuid4(), projectId=pid, kind='media_edit', data=dict(tool='audio-trim',
                    sourceItems=[anchor_id], sources=[asset_ref(source)], parameters={}))
    payload = dict(itemId=anchor_id, source=asset_ref(source), document=document,
                   outputs=[dict(itemId=output_id, asset=asset_ref(output), title='Trim')])
    current = [ver('canvas_item', node(anchor_id)), ver('asset', output)]
    stale = [{**current[0], 'revision': 2}, current[1]]
    before = store.snapshot(pid)
    refusal = send(store, pid, 'canvas.publishMedia', session=session, versions=stale, **payload)
    assert refusal.status == 'rejected' and store.snapshot(pid) == before
    publish = parse_command(dict(commandId=uuid4(), projectId=pid, type='canvas.publishMedia', payload=payload, expectedVersions=current))
    receipt = store.execute(publish, session=session)
    assert receipt.status == 'applied', receipt
    assert store.execute(publish, session=session) == receipt
    persisted = next(a for a in store.snapshot(pid).assets if a.id == output.id)
    assert persisted.provenance.sources == (asset_ref(source),) and persisted.provenance.sourceItemId == anchor_id
    for transition, target, expected in [('undo', receipt, (True, False)), ('undo', earlier, (False, False)),
                                         ('redo', earlier, (True, False)), ('redo', receipt, (True, True))]:
        state = 'applied' if transition == 'undo' else 'undone'
        offered = next(entry for entry in CreationHistory(store).operations(pid) if entry['state'] == state)
        assert offered['commandId'] == target.commandId
        result = send(store, pid, 'history.' + transition, session=session, versions=versions(store.snapshot(pid)),
                      targetCommandId=target.commandId)
        assert result.status == 'applied', result
        assert not node(anchor_id).visible and node(anchor_id).revision == 1
        assert (node(previous_id).visible, node(output_id).visible) == expected
