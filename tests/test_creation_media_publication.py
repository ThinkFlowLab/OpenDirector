"""Local output is one transaction with frozen inputs, provenance and display identity."""
import shutil
import subprocess
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


def test_agent_video_trim_publishes_one_visible_fixed_source_clip(project, tmp_path, monkeypatch):
    from opendirector.application import creation_video_trim

    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('Video trim requires FFmpeg and ffprobe')
    store, pid, session = project
    input_file = tmp_path / 'source.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
        'color=red:size=64x48:rate=24:d=1', '-f', 'lavfi', '-i', 'color=blue:size=64x48:rate=24:d=1',
        '-f', 'lavfi', '-i', 'sine=duration=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
        '-map', '[v]', '-map', '2:a:0', '-c:v', 'libx264', '-c:a', 'aac', str(input_file)], check=True)
    assets = CreationToolAssets(store)
    record = assets.import_file(pid, uuid4(), input_file.name, input_file.read_bytes(), session,
        provenance=AssetProvenance(source='upload'))
    source = asset_ref(assets.assets.get(pid, record['id']))
    first, source_id = uuid4(), uuid4()
    for identity in (first, source_id):
        assert send(store, pid, 'canvas.show', session=session, item=dict(id=identity, projectId=pid, kind='video',
            title='Same source', binding=dict(role='material', objectRef=source))).status == 'applied'
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='video.trim', payload=dict(sourceItemId=source_id,
        source=source, startSeconds=1.25, endSeconds=1.75, name='Middle clip.mp4')))
    source_item = next(item for item in store.snapshot(pid).canvasItems if item.id == source_id)
    assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', source_item)],
        itemId=source_id, title='Renamed after planning').status == 'applied'
    paths = []
    original_trim = creation_video_trim.trim
    def render(raw, seconds, out, *, start):
        paths.extend((raw, out))
        original_trim(raw, seconds, out, start=start)
    monkeypatch.setattr(creation_video_trim, 'trim', render)
    receipt = store.execute(command, session=session, source='agent')
    assert receipt.status == 'applied', receipt
    assert len(paths) == 2 and all(not path.exists() for path in paths)
    saved = store.snapshot(pid)
    output = next(asset for asset in saved.assets if asset.id != source.assetId)
    item = next(item for item in saved.canvasItems if item.id not in {first, source_id})
    assert item.visible and item.binding.objectRef == asset_ref(output)
    assert output.metadata.durationSeconds == pytest.approx(.5, abs=1 / 24)
    assert output.metadata.hasAudio
    assert output.provenance.sourceItemId == source_id
    assert output.provenance.sources == (source,)
    document = next(document for document in saved.editorDocuments if document.id == output.provenance.editorDocumentId)
    assert document.data.sourceItems == (source_id,)
    assert document.data.sources == (source,)
    assert document.data.parameters == {'startSeconds': 1.25, 'endSeconds': 1.75}
    with assets.assets.open_media(pid, output.id)[0] as stream:
        persisted = tmp_path / 'persisted.mp4'
        persisted.write_bytes(stream.read())
    pixel = subprocess.check_output(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(persisted), '-vf', 'scale=1:1',
        '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
    assert pixel[2] > 200 and pixel[0] < 30

    source_item = next(item for item in saved.canvasItems if item.id == source_id)
    assert send(store, pid, 'canvas.materialize', session=session, versions=[ver('canvas_item', source_item)],
        itemId=source_id, asset=asset_ref(output)).status == 'applied'
    def unexpected_render(*_args, **_kwargs):
        pytest.fail('Replay or stale plans must not invoke FFmpeg')
    monkeypatch.setattr('opendirector.application.creation_video_trim.trim', unexpected_render)
    assert store.execute(command, session=session, source='agent') == receipt
    stale_request = command.model_copy(update={'commandId': uuid4()})
    rejected = store.execute(stale_request, session=session, source='agent')
    assert rejected.status == 'rejected'
    assert rejected.issues[0].code == 'reference_invalid' and rejected.issues[0].objectId == source_id
    assert len(store.snapshot(pid).assets) == 2

    def replace_during_render(raw, seconds, out, *, start):
        render(raw, seconds, out, start=start)
        other = next(item for item in store.snapshot(pid).canvasItems if item.id == first)
        assert send(store, pid, 'canvas.materialize', session=session, versions=[ver('canvas_item', other)],
            itemId=first, asset=asset_ref(output)).status == 'applied'
    monkeypatch.setattr(creation_video_trim, 'trim', replace_during_render)
    race = command.model_copy(update={'commandId': uuid4(), 'payload': command.payload.model_copy(update={'sourceItemId': first})})
    rejected = store.execute(race, session=session, source='agent')
    assert rejected.status == 'rejected' and rejected.issues[0].objectId == first
    after_race = store.snapshot(pid)
    assert len(after_race.assets) == 2 and len(after_race.editorDocuments) == 1 and len(after_race.canvasItems) == 3
    assert len(paths) == 4 and all(not path.exists() for path in paths)


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
