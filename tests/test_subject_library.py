"""Subject library preparation, owned copies and atomic import validation."""
from copy import deepcopy
from uuid import uuid4

from test_library import app, client, store, png, upload
from test_creation_canvas_service import project, send, ver
from opendirector.application.creation_canvas import asset_ref
from opendirector.infrastructure.creation_uploads import CreationUploads

import pytest

pytestmark = pytest.mark.cpu


def test_subject_slot_validation_uses_actual_media_and_fifteen_second_limit(tmp_path):
    import wave
    import pytest
    from opendirector.application.subject_library import SubjectLibrary
    from opendirector.domain.projects import ProjectError
    for seconds in (10, 16):
        path = tmp_path / f'voice-{seconds}.bin'
        with wave.open(str(path), 'wb') as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(8000)
            stream.writeframes(bytes(8000 * 2 * seconds))
        if seconds == 10:
            kind, facts = SubjectLibrary.inspect(path, 'voice')
            assert kind == 'audio' and facts.durationSeconds == 10
        else:
            with pytest.raises(ProjectError, match='15 秒'):
                SubjectLibrary.inspect(path, 'voice')
        with pytest.raises(ProjectError):
            SubjectLibrary.inspect(path, 'auxiliary:0')


def subject_item(client, *, main=None, aux=()):
    main = main or upload(client, png('red')).json()['blob']
    response = client.post('/api/library/items/from-subject', json=dict(projectId=str(uuid4()), nodeId=str(uuid4()), name='Library hero',
        description='Display annotation', category='character', main=main, auxiliaries=list(aux)))
    assert response.status_code == 200, response.text
    return response.json()


def test_prepare_enforces_revision_state_and_every_blob(client):
    item = subject_item(client)
    def prepare(revision=1):
        return client.post('/api/library/subjects/prepare', json=dict(items=[dict(id=item['id'], revision=revision)]))
    response = prepare()
    assert response.status_code == 200, response.text
    prepared = response.json()[0]
    assert prepared['media'][0]['kind'] == 'image'
    assert prepared['media'][0]['metadata']['width'] == 13
    assert client.get('/api/library/subjects').json()[0]['available'] is True
    copied = client.get(f"/api/library/items/{item['id']}/subject-media/main?revision=1")
    assert copied.content == png('red')
    assert prepare(2).status_code == 409
    client.post('/api/library/items/trash', json=dict(itemIds=[item['id']]))
    assert prepare().status_code == 409
    assert client.get(f"/api/library/items/{item['id']}/subject-media/main?revision=1").status_code == 409


def test_prepare_rejects_blank_duplicate_and_incomplete_subjects(client, tmp_path):
    blank = client.post('/api/library/items/from-subject', json=dict(projectId=str(uuid4()), nodeId=str(uuid4()), name='Blank')).json()
    assert client.post('/api/library/subjects/prepare', json=dict(items=[dict(id=blank['id'], revision=1)])).status_code == 422
    item = subject_item(client)
    duplicate = subject_item(client, main=item['subject']['main'], aux=[item['subject']['main']])
    assert client.post('/api/library/subjects/prepare', json=dict(items=[dict(id=duplicate['id'], revision=1)])).status_code == 422
    (tmp_path / '.opendirector' / 'library' / 'blobs' / item['subject']['main']).unlink()
    assert client.post('/api/library/subjects/prepare', json=dict(items=[dict(id=item['id'], revision=1)])).status_code == 410
    assert all(not row['available'] for row in client.get('/api/library/subjects').json())


def register_image(project, color='red'):
    store, pid, session = project
    writer = CreationUploads(store).begin(pid, uuid4(), session, 'image.png')
    try:
        writer.write(png(color)); info = writer.finish()
    finally:
        writer.abort()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=info.id, name=info.name, expectedKind='image').status == 'applied'
    return store.snapshot(pid).assets[-1]


def test_import_snapshot_is_verified_and_undo_is_one_atomic_operation(project):
    from opendirector.application.subject_library import SubjectLibrary
    from opendirector.application.library import Library
    from opendirector.domain.creation.library import LibrarySubjectSnapshot
    store, pid, session = project
    library = Library(store)
    sha = library.store.put_blob(png('red'))
    source = library.add_subject(pid, uuid4(), 'Hero', LibrarySubjectSnapshot(main=sha))
    asset = register_image(project)
    doc_id, item_id, import_id = uuid4(), uuid4(), uuid4()
    operations = [dict(type='editor.create', payload=dict(document=dict(id=doc_id, projectId=pid, kind='subject', data=dict(main=asset_ref(asset),
        librarySource=dict(itemId=source.id, revision=source.revision, importId=import_id))))),
        dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=pid, kind='subject', title='Hero', binding=dict(role='editor', objectRef=dict(id=doc_id, kind='subject'))))) ]
    receipt = send(store, pid, 'creation.batch', session=session, operations=operations)
    assert receipt.status == 'applied', receipt
    assert store.snapshot(pid).editorDocuments[-1].data.librarySource.itemId == source.id
    saved = SubjectLibrary(store).backup(pid, item_id)
    assert saved.subject.main == sha
    undone = send(store, pid, 'history.undo', session=session, versions=[ver('canvas_item', store.snapshot(pid).canvasItems[-1]), ver('editor_document', store.snapshot(pid).editorDocuments[-1])], targetCommandId=receipt.commandId)
    assert undone.status == 'applied', undone
    assert all(not item.visible for item in store.snapshot(pid).canvasItems)
    assert send(store, pid, 'history.redo', session=session, versions=[ver('canvas_item', store.snapshot(pid).canvasItems[-1]), ver('editor_document', store.snapshot(pid).editorDocuments[-1])], targetCommandId=receipt.commandId).status == 'applied'
    # Changing the declared import to use other bytes must reject the whole batch.
    different = register_image(project, 'blue')
    current = store.snapshot(pid)
    document = current.editorDocuments[-1].model_dump(mode='json')
    document['data']['main'] = asset_ref(different).model_dump(mode='json')
    document['data']['librarySource']['importId'] = str(uuid4())
    result = send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', current.editorDocuments[-1])], document=document)
    assert result.status == 'rejected'
    assert store.snapshot(pid) == current
    # Project copies remain readable after the library's last blob owner is purged.
    library.trash([source.id, saved.id]); library.purge()
    from opendirector.application.creation_assets import CreationAssets
    stream, _ = CreationAssets(store).open_media(pid, asset.id)
    with stream:
        assert stream.read() == png('red')
