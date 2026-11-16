"""Attached layer persistence, protected writes and reversible associations."""
from io import BytesIO
from uuid import uuid4

from PIL import Image

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_history import CreationHistory
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from test_creation_canvas_service import project, media, send, ver
from opendirector.application.creation_canvas import asset_ref

import pytest

pytestmark = pytest.mark.cpu


def layered_image(project):
    store, pid, session = project
    out = BytesIO()
    Image.new('RGB', (16, 16), 'red').save(out, 'PNG')
    assets = CreationAssets(store)
    handle = uuid4()
    writer = assets.uploads.begin(pid, handle, session, 'source.png')
    writer.write(out.getvalue())
    writer.finish()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=handle, name='source.png', expectedKind='image').status == 'applied'
    asset = store.snapshot(pid).assets[-1]
    item, _ = media(project, 'image')
    assert send(store, pid, 'canvas.materialize', session=session, versions=[ver('canvas_item', item)], itemId=item.id, asset=asset_ref(asset)).status == 'applied'
    item = store.snapshot(pid).canvasItems[0]
    document = dict(id=uuid4(), projectId=pid, kind='layers', data=dict(width=16, height=16, layers=[
        dict(id='original', name='Original', width=16, height=16, opacity=.7,
             content=dict(kind='image', width=16, height=16, asset=asset_ref(asset)),
             mask=[dict(mode='erase', size=2., points=[dict(x=1., y=2.)])])]))
    receipt = send(store, pid, 'creation.batch', session=session, versions=[ver('canvas_item', item)], operations=[
        dict(type='editor.create', payload=dict(document=document)),
        dict(type='canvas.attachEditor', payload=dict(itemId=item.id, editorId=document['id']))])
    assert receipt.status == 'applied', receipt
    return store.snapshot(pid).canvasItems[0], store.snapshot(pid).editorDocuments[0], asset


def test_layers_reopen_update_detach_undo_and_keep_source_protection(project):
    store, pid, session = project
    item, document, asset = layered_image(project)
    restarted = CreationProjects(LocalProjects(store.local.repository))
    snapshot = restarted.snapshot(pid)
    assert snapshot.editorDocuments[0] == document
    assert snapshot.canvasItems[0].editors[0].id == document.id
    stream, _ = CreationAssets(restarted).open_media(pid, asset.id)
    with stream, Image.open(stream) as image:
        assert image.size == (16, 16)
    updated = document.model_dump(mode='json')
    updated['data']['layers'][0]['opacity'] = .3
    assert send(restarted, pid, 'editor.save', session=session, versions=[ver('editor_document', document)], document=updated).status == 'applied'
    current = restarted.snapshot(pid)
    assert current.editorDocuments[0].id == document.id
    assert current.editorDocuments[0].revision == 2
    assert current.editorDocuments[0].data.layers[0].opacity == .3
    assert send(restarted, pid, 'editor.save', session=session, versions=[ver('editor_document', document)], document=updated).status == 'rejected'
    receipt = send(restarted, pid, 'canvas.detachEditor', session=session, versions=[ver('canvas_item', item)], itemId=item.id, editorId=document.id)
    assert receipt.status == 'applied'
    detached = restarted.snapshot(pid)
    assert not detached.canvasItems[0].editors
    assert len(detached.editorDocuments) == 1
    assert not CreationHistory(restarted).delete_preview(pid, [asset.id])['canDelete']
    restored = send(restarted, pid, 'history.undo', session=session,
                    versions=[ver('canvas_item', detached.canvasItems[0])], targetCommandId=receipt.commandId)
    assert restored.status == 'applied', restored
    assert restarted.snapshot(pid).canvasItems[0].editors[0].id == document.id


def test_attached_layer_writes_and_detach_respect_parent_lock(project):
    store, pid, session = project
    item, document, _ = layered_image(project)
    group = uuid4()
    assert send(store, pid, 'creation.batch', session=session, versions=[ver('canvas_item', item)], operations=[
        dict(type='canvas.show', payload=dict(item=dict(id=group, projectId=pid, kind='group', locked=True))),
        dict(type='canvas.update', payload=dict(itemId=item.id, parentId=group))]).status == 'applied'
    before = store.snapshot(pid)
    updated = document.model_dump(mode='json')
    updated['data']['background'] = '#ffffff'
    for kind, payload in [('editor.save', dict(document=updated)),
                          ('creation.batch', dict(operations=[dict(type='editor.save', payload=dict(document=updated))]))]:
        result = send(store, pid, kind, session=session, versions=[ver('editor_document', document)], **payload)
        assert result.status == 'rejected', result
        assert store.snapshot(pid) == before
    locked_item = before.canvasItems[0]
    result = send(store, pid, 'canvas.detachEditor', session=session, versions=[ver('canvas_item', locked_item)], itemId=item.id, editorId=document.id)
    assert result.status == 'rejected'
    assert store.snapshot(pid) == before


def test_duplicate_layer_association_rolls_back_new_document(project):
    store, pid, session = project
    item, document, _ = layered_image(project)
    before = store.snapshot(pid)
    duplicate = document.model_dump(mode='json')
    duplicate['id'] = str(uuid4())
    result = send(store, pid, 'creation.batch', session=session, versions=[ver('canvas_item', item)], operations=[
        dict(type='editor.create', payload=dict(document=duplicate)),
        dict(type='canvas.attachEditor', payload=dict(itemId=item.id, editorId=duplicate['id']))])
    assert result.status == 'rejected'
    assert store.snapshot(pid) == before
