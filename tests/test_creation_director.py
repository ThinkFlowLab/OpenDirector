"""Director stage service boundary: identity survives create, save, undo, redo and reload."""
from uuid import uuid4

import pytest

from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects


@pytest.fixture
def project(tmp_path):
    store = CreationProjects(LocalProjects(tmp_path))
    project_id = uuid4()
    assert send(store, project_id, 'project.create', name='Unified').status == 'applied'
    session = str(uuid4())
    store.open(project_id, session)
    return store, project_id, session


def send(store, project_id, kind, *, session=None, versions=(), **payload):
    command = parse_command(dict(commandId=uuid4(), projectId=project_id, type=kind,
                                expectedVersions=versions, payload=payload))
    return store.execute(command, session=session)


def ver(kind, obj):
    return dict(objectType=kind, id=obj.id, revision=obj.revision)


CAMERA = dict(position=dict(x=5, y=3.5, z=7), target=dict(x=0, y=1, z=0), fov=45)
TRANSFORM = dict(position=dict(x=0, y=0, z=0), rotation=dict(x=0, y=0, z=0), scale=dict(x=1, y=1, z=1))


def director_document(project_id, document_id, *, camera_name='Camera 1',
                      camera_keyframes=(), object_keyframes=()):
    """The committed shape the canvas projection sends for a fresh local stage."""
    return dict(id=document_id, projectId=project_id, revision=1, kind='director', inputConnections=[], data=dict(
        background='#151923', grid=True, duration=6, aspectRatio='16:9',
        activeCameraId='camera-1', cameraSource='camera', shots=[],
        cameras=[dict(id='camera-1', name=camera_name, pose=dict(CAMERA), keyframes=list(camera_keyframes))],
        objects=[dict(id='actor', kind='person', name='Actor', color='#a09af9', motionClips=[],
                      keyframes=list(object_keyframes), **TRANSFORM)]))


def test_director_stage_identity_survives_save_undo_redo_and_reload(project):
    store, pid, session = project
    document_id, item_id = uuid4(), uuid4()
    receipt = send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=director_document(pid, document_id))),
        dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=pid, kind='external',
            title='Director Stage', binding=dict(role='editor', objectRef=dict(id=document_id, kind='director')))))])
    assert receipt.status == 'applied', receipt

    def stage(from_store=None):
        snapshot = (from_store or store).snapshot(pid)
        return (next(i for i in snapshot.canvasItems if i.id == item_id),
                next(d for d in snapshot.editorDocuments if d.id == document_id))

    item, document = stage()
    assert (item.kind, item.binding.role, item.binding.objectRef.kind) == ('external', 'editor', 'director')
    assert item.binding.objectRef.id == document.id
    assert document.kind == 'director' and document.revision == 1
    assert not document.data.cameras[0].keyframes and not document.data.objects[0].keyframes

    reread_item, reread_document = stage()
    assert reread_item == item and reread_document == document

    saved = send(store, pid, 'editor.save', session=session,
        versions=[ver('editor_document', document)],
        document=director_document(pid, document_id, camera_name='验收机位',
            camera_keyframes=[dict(id='cam-6', time=6, value=dict(CAMERA, position=dict(x=2, y=3.5, z=7)))],
            object_keyframes=[dict(id='obj-6', time=6, value=dict(TRANSFORM, position=dict(x=2, y=0, z=0)))]))
    assert saved.status == 'applied', saved
    saved_item, edited = stage()
    assert saved_item.id == item.id and edited.id == document.id
    assert edited.revision == 2 and edited.data.cameras[0].name == '验收机位'
    assert [f.time for f in edited.data.cameras[0].keyframes] == [6]
    assert [f.time for f in edited.data.objects[0].keyframes] == [6]
    assert edited.data.objects[0].id == document.data.objects[0].id

    assert send(store, pid, 'history.undo', session=session,
        versions=[ver('editor_document', edited)], targetCommandId=saved.commandId).status == 'applied'
    undo_item, undo_document = stage()
    assert (undo_item.id, undo_document.id) == (item.id, document.id)
    assert undo_document.revision == 3 and undo_document.data == document.data
    assert undo_item.binding == item.binding

    assert send(store, pid, 'history.redo', session=session,
        versions=[ver('editor_document', undo_document)], targetCommandId=saved.commandId).status == 'applied'
    redo_item, redo_document = stage()
    assert (redo_item.id, redo_document.id) == (item.id, document.id)
    assert redo_document.revision == 4 and redo_document.data == edited.data
    assert redo_item.binding == item.binding

    reloaded = CreationProjects(LocalProjects(store.local.repository))
    reopen_item, reopen_document = stage(reloaded)
    assert reopen_item == redo_item and reopen_document == redo_document
