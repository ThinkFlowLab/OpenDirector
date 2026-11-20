"""The Director Stage contract keeps imported model identity in project assets."""
from io import BytesIO
import json
import struct
from uuid import uuid4

from PIL import Image
import pytest

from opendirector.application.creation_canvas import asset_ref
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.editors import StageObject
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.creation_uploads import CreationUploads
from opendirector.infrastructure.local_projects import LocalProjects


def glb_bytes(document, binary=b''):
    payload = json.dumps(document).encode('utf-8')
    payload += b' ' * (-len(payload) % 4)
    body = struct.pack('<I4s', len(payload), b'JSON') + payload
    if binary:
        padded = binary + b'\x00' * (-len(binary) % 4)
        body += struct.pack('<I4s', len(padded), b'BIN\x00') + padded
    return struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body


def glb_bytes_of_raw(payload):
    """A GLB container whose JSON chunk is the literal bytes, unparsed."""
    padded = payload + b' ' * (-len(payload) % 4)
    body = struct.pack('<I4s', len(padded), b'JSON') + padded
    return struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body


def asset(kind='file'):
    from opendirector.domain.creation.assets import AssetRef

    return AssetRef(
        assetId=uuid4(),
        revision=1,
        fingerprint='sha256:' + 'a' * 64,
        kind=kind,
    )


def object_data(**changes):
    value = dict(
        id='actor',
        kind='gltf',
        name='Imported actor',
        color='#b8c5ff',
        position=dict(x=0.0, y=0.0, z=0.0),
        rotation=dict(x=0.0, y=0.0, z=0.0),
        scale=dict(x=1.0, y=1.0, z=1.0),
        keyframes=(),
        motionClips=(),
        asset=asset(),
        role='character',
        format='glb',
        animationNames=('Walk',),
        hasAnimation=True,
    )
    value.update(changes)
    return value


def test_imported_stage_object_requires_and_round_trips_file_identity():
    parsed = StageObject(**object_data())
    assert parsed.asset is not None
    assert parsed.asset.kind == 'file'
    assert parsed.animationNames == ('Walk',)
    assert parsed.model_dump(mode='json')['asset']['fingerprint'].startswith('sha256:')


@pytest.mark.parametrize(
    'changes',
    [
        {'asset': None},
        {'asset': asset('image')},
        {'kind': 'person', 'asset': asset(), 'role': 'character', 'format': 'glb'},
        {'kind': 'sphere', 'animationNames': ('Walk',), 'hasAnimation': True},
        {'role': None},
        {'format': None},
        {'hasAnimation': False},
        {'animationNames': ('Walk', '')},
        {'animationNames': (' ',)},
        {'role': 'scene', 'motionClips': ({
            'id': 'scene-motion',
            'start': 0.0,
            'duration': 1.0,
            'motion': {'preset': 'idle', 'speed': 1.0, 'amount': 1.0},
        },)},
        {'animationNames': (), 'hasAnimation': False, 'motionClips': ({
            'id': 'missing-animation',
            'start': 0.0,
            'duration': 1.0,
            'motion': {'preset': 'walk', 'speed': 1.0, 'amount': 1.0},
        },)},
    ],
)
def test_imported_stage_object_rejects_incomplete_or_incompatible_metadata(changes):
    with pytest.raises(ValueError):
        StageObject(**object_data(**changes))


CAMERA = dict(position=dict(x=5, y=3.5, z=7), target=dict(x=0, y=1, z=0), fov=50)
TRANSFORM = dict(position=dict(x=0, y=0, z=0), rotation=dict(x=0, y=0, z=0), scale=dict(x=1, y=1, z=1))


def stage_document(project_id, document_id, objects):
    return dict(id=document_id, projectId=project_id, revision=1, kind='director', inputConnections=[], data=dict(
        background='#151923', grid=True, duration=6, aspectRatio='16:9',
        activeCameraId='camera-1', cameraSource='camera', shots=[],
        cameras=[dict(id='camera-1', name='Camera', pose=dict(CAMERA), keyframes=[])],
        objects=objects))


def imported_stage_object(asset_value, **changes):
    value = dict(id='actor', kind='gltf', name='Imported actor', color='#b8c5ff',
                 keyframes=(), motionClips=(), asset=asset_value, role='character',
                 format='glb', animationNames=('Walk',), hasAnimation=True, **TRANSFORM)
    value.update(changes)
    return value


def test_editor_commands_resolve_every_imported_stage_asset_against_project_assets(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    pid, session = uuid4(), str(uuid4())
    assert projects.execute(parse_command(dict(projectId=pid, commandId=uuid4(), type='project.create',
                                               payload=dict(name='Assets')))).status == 'applied'
    projects.open(pid, session)

    def send(kind, command_id=None, versions=(), **payload):
        return projects.execute(parse_command(dict(projectId=pid, commandId=command_id or uuid4(),
                                                   type=kind, expectedVersions=versions, payload=payload)),
                                session=session)

    handle = uuid4()
    writer = CreationUploads(projects).begin(pid, handle, session, 'prop.glb')
    try:
        writer.write(glb_bytes(dict(asset=dict(version='2.0'), animations=[dict(name='Walk')])))
        info = writer.finish()
    finally:
        writer.abort()
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]
    assert asset.metadata.animationNames == ('Walk',)

    document_id = uuid4()
    document = stage_document(pid, document_id, [imported_stage_object(asset_ref(asset).model_dump(mode='json'))])
    assert send('editor.create', document=document).status == 'applied'

    forged = dict(assetId=str(uuid4()), revision=1, fingerprint='sha256:' + 'b' * 64, kind='file')
    changed = dict(document, data=dict(document['data'], objects=[imported_stage_object(forged)]))
    saved = send('editor.save', versions=[dict(objectType='editor_document', id=document_id, revision=1)],
                 document=changed)
    assert saved.status == 'rejected'
    current = projects.snapshot(pid).editorDocuments[0]
    assert current.id == document_id and current.data.objects[0].asset.assetId == asset.id

    replay = send('editor.save', command_id=saved.commandId,
                  versions=[dict(objectType='editor_document', id=document_id, revision=1)],
                  document=changed)
    assert replay.status == 'rejected' and replay.commandId == saved.commandId


def stage_project(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    pid, session = uuid4(), str(uuid4())
    assert projects.execute(parse_command(dict(projectId=pid, commandId=uuid4(), type='project.create',
                                               payload=dict(name='Assets')))).status == 'applied'
    projects.open(pid, session)

    def send(kind, command_id=None, versions=(), **payload):
        return projects.execute(parse_command(dict(projectId=pid, commandId=command_id or uuid4(),
                                                   type=kind, expectedVersions=versions, payload=payload)),
                                session=session)

    def upload(name, content):
        writer = CreationUploads(projects).begin(pid, uuid4(), session, name)
        try:
            writer.write(content)
            return writer.finish()
        finally:
            writer.abort()

    return projects, pid, send, upload


def test_editor_commands_reject_stage_objects_pinning_non_model_files(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    info = upload('prop.fbx', b'Kaydara FBX Binary\x20\x20\x00\x1a\x00')
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]
    assert asset.metadata.mimeType == 'application/octet-stream' and asset.metadata.selfContained is None
    document = stage_document(pid, uuid4(), [imported_stage_object(asset_ref(asset).model_dump(mode='json'))])
    assert send('editor.create', document=document).status == 'rejected'
    assert projects.snapshot(pid).editorDocuments == ()


def test_editor_commands_reject_stage_objects_pinning_external_gltf(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    scene = json.dumps(dict(asset=dict(version='2.0'), buffers=[dict(uri='scene.bin', byteLength=4)])).encode('utf-8')
    info = upload('scene.gltf', scene)
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]
    assert asset.metadata.mimeType == 'model/gltf+json' and asset.metadata.selfContained is False
    objects = [dict(imported_stage_object(asset_ref(asset).model_dump(mode='json')),
                    format='gltf', animationNames=(), hasAnimation=False)]
    assert send('editor.create', document=stage_document(pid, uuid4(), objects)).status == 'rejected'
    assert projects.snapshot(pid).editorDocuments == ()


def test_editor_commands_accept_and_round_trip_self_contained_gltf(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    scene = json.dumps(dict(asset=dict(version='2.0'), animations=[dict(name='Idle')])).encode('utf-8')
    info = upload('scene.gltf', scene)
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]
    assert asset.metadata.mimeType == 'model/gltf+json' and asset.metadata.selfContained is True
    objects = [dict(imported_stage_object(asset_ref(asset).model_dump(mode='json')),
                    format='gltf', animationNames=('Idle',))]
    document_id = uuid4()
    assert send('editor.create', document=stage_document(pid, document_id, objects)).status == 'applied'
    reopened = CreationProjects(LocalProjects(projects.local.repository))
    stored = reopened.snapshot(pid).editorDocuments[0]
    assert stored.id == document_id and stored.data.objects[0].asset == asset_ref(asset)
    assert stored.data.objects[0].format == 'gltf' and stored.data.objects[0].animationNames == ('Idle',)


def test_editor_commands_reject_stage_objects_mixing_gltf_format_with_glb_bytes(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    scene = json.dumps(dict(asset=dict(version='2.0'), animations=[dict(name='Idle')])).encode('utf-8')
    info = upload('scene.gltf', scene)
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]
    assert asset.metadata.mimeType == 'model/gltf+json'
    # The declared container format must match the pinned bytes' media type.
    objects = [dict(imported_stage_object(asset_ref(asset).model_dump(mode='json')), format='glb')]
    assert send('editor.create', document=stage_document(pid, uuid4(), objects)).status == 'rejected'
    assert projects.snapshot(pid).editorDocuments == ()


def test_editor_commands_reject_stage_objects_pinning_malformed_glb(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    info = upload('prop.glb', b'glTF' + b'\x00' * 9)
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]
    assert asset.metadata.mimeType == 'application/octet-stream' and asset.metadata.selfContained is None
    document = stage_document(pid, uuid4(), [imported_stage_object(asset_ref(asset).model_dump(mode='json'))])
    assert send('editor.create', document=document).status == 'rejected'
    assert projects.snapshot(pid).editorDocuments == ()


def test_truncated_glb_with_valid_header_stays_a_generic_file(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    # Version 2 and a plausible magic, but the declared total exceeds the file.
    info = upload('prop.glb', b'glTF' + struct.pack('<II', 2, 4096))
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]
    assert asset.metadata.mimeType == 'application/octet-stream' and asset.metadata.selfContained is None
    document = stage_document(pid, uuid4(), [imported_stage_object(asset_ref(asset).model_dump(mode='json'))])
    assert send('editor.create', document=document).status == 'rejected'
    assert projects.snapshot(pid).editorDocuments == ()


def test_editor_commands_reject_animation_metadata_not_backed_by_asset_bytes(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    info = upload('actor.glb', glb_bytes(dict(asset=dict(version='2.0'), animations=[dict(name='Walk')])))
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]

    def document_with(names):
        return stage_document(pid, uuid4(), [imported_stage_object(asset_ref(asset).model_dump(mode='json'),
                                              animationNames=names, hasAnimation=bool(names))])

    forged = send('editor.create', document=document_with(('Run',)))
    assert forged.status == 'rejected' and projects.snapshot(pid).editorDocuments == ()

    claimed = send('editor.create', document=document_with(('Walk',)))
    assert claimed.status == 'applied', claimed
    assert projects.snapshot(pid).editorDocuments[0].data.objects[0].animationNames == ('Walk',)


def test_animation_names_fall_back_to_the_loader_convention_for_unnamed_clips(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    info = upload('actor.glb', glb_bytes(dict(asset=dict(version='2.0'), animations=[dict(channels=[])])))
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]
    assert asset.metadata.animationNames == ('animation_0',)

    def document_with(names):
        return stage_document(pid, uuid4(), [imported_stage_object(asset_ref(asset).model_dump(mode='json'),
                                              animationNames=names, hasAnimation=bool(names))])

    assert send('editor.create', document=document_with(('clip-1',))).status == 'rejected'
    assert send('editor.create', document=document_with(('animation_0',))).status == 'applied'


def test_oversized_stage_models_are_rejected_before_parsing(tmp_path):
    from opendirector.domain.projects import ProjectError

    projects, pid, send, upload = stage_project(tmp_path)
    oversized = 100 * 1024 * 1024 + 1
    with pytest.raises(ProjectError) as glb_error:
        upload('prop.glb', b'glTF' + struct.pack('<II', 2, 12) + b'x' * oversized)
    assert glb_error.value.status == 413
    with pytest.raises(ProjectError) as gltf_error:
        upload('scene.gltf', b'{"asset":' + b' ' * oversized)
    assert gltf_error.value.status == 413
    # Oversized JSON without a model suffix stays a generic file, not a stage error.
    info = upload('data.json', b'{"payload":' + b' ' * oversized)
    assert info.kind == 'file' and info.metadata.mimeType == 'application/octet-stream'


def png_bytes():
    buffer = BytesIO()
    Image.new('RGB', (13, 7), 'purple').save(buffer, format='PNG')
    return buffer.getvalue()


def test_director_still_pins_a_registered_image_asset_and_survives_reload(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    info = upload('board.png', png_bytes())
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    image = projects.snapshot(pid).assets[-1]
    document = stage_document(pid, uuid4(), [])
    document['data']['still'] = asset_ref(image).model_dump(mode='json')
    assert send('editor.create', document=document).status == 'applied'
    reopened = CreationProjects(LocalProjects(projects.local.repository)).snapshot(pid)
    assert reopened.editorDocuments[0].data.still == asset_ref(image)


def test_director_still_rejects_dangling_and_non_image_assets(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    dangling = stage_document(pid, uuid4(), [])
    dangling['data']['still'] = dict(assetId=str(uuid4()), revision=1, fingerprint='sha256:' + 'b' * 64, kind='image')
    assert send('editor.create', document=dangling).status == 'rejected'
    info = upload('prop.glb', glb_bytes(dict(asset=dict(version='2.0'))))
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    model = projects.snapshot(pid).assets[-1]
    document = stage_document(pid, uuid4(), [])
    document['data']['still'] = asset_ref(model).model_dump(mode='json')
    assert send('editor.create', document=document).status == 'rejected'
    assert projects.snapshot(pid).editorDocuments == ()


def test_deeply_nested_model_json_stays_a_generic_file(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    # Deep nesting makes the C parser raise RecursionError, not ValueError;
    # uploads must fail closed as generic files instead of raising.
    nested = b'[' * 5000 + b']' * 5000
    info = upload('scene.gltf', nested)
    assert info.kind == 'file' and info.metadata.mimeType == 'application/octet-stream'
    info = upload('prop.glb', glb_bytes_of_raw(nested))
    assert info.kind == 'file' and info.metadata.mimeType == 'model/gltf-binary'
    assert info.metadata.selfContained is False


def test_model_json_head_behind_long_whitespace_prefix_is_still_a_model(tmp_path):
    projects, pid, send, upload = stage_project(tmp_path)
    # A browser JSON.parse accepts any leading whitespace, so classification
    # must not stop at the 4096-byte probe window.
    scene = b' ' * 8192 + json.dumps(dict(asset=dict(version='2.0'), animations=[dict(name='Idle')])).encode('utf-8')
    info = upload('scene', scene)
    assert info.kind == 'file' and info.metadata.mimeType == 'model/gltf+json'
    assert info.metadata.selfContained is True and info.metadata.animationNames == ('Idle',)
