"""Agent timeline creates retain unique canvas-node provenance (issue #117)."""
from uuid import uuid4

from opendirector.application.creation_canvas import asset_ref
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from test_creation_assembly import upload_source
from test_creation_canvas_service import project, send, ver


def _clip(asset, clip_id, *, start=None):
    clip = dict(id=clip_id, resource=dict(asset=asset_ref(asset), title=asset.name),
                inPoint=0, outPoint=asset.metadata.durationSeconds or 5)
    if asset.kind == 'audio' or start is not None:
        clip['start'] = 0 if start is None else start
    return clip


def _timeline(pid, clips, *, audio=False, connections=None):
    visual = [] if audio else clips
    tracks = [dict(id='visual', kind='visual', title='Visual', clips=visual)]
    if audio:
        tracks.append(dict(id='audio', kind='audio', title='Audio', clips=clips))
    document = dict(id=uuid4(), projectId=pid, kind='timeline',
                    data=dict(fps=30, width=1920, height=1080, tracks=tracks))
    if connections is not None:
        document['inputConnections'] = connections
    return document


def _create(store, pid, session, document, sources=()):
    item_id = uuid4()
    receipt = send(store, pid, 'creation.batch', session=session,
                   versions=[ver('canvas_item', source) for source in sources],
                   operations=[
                       dict(type='editor.create', payload=dict(document=document)),
                       dict(type='canvas.show', payload=dict(item=dict(
                           id=item_id, projectId=pid, kind='timeline',
                           binding=dict(role='editor', objectRef=dict(
                               id=document['id'], kind='timeline'))))),
                   ])
    assert receipt.status == 'applied', receipt
    return item_id


def _reopen(store, pid):
    return CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)


def _connections(snapshot, document_id):
    doc = next(doc for doc in snapshot.editorDocuments if doc.id == document_id)
    return doc, list(doc.inputConnections)


def test_agent_create_with_clip_assets_keeps_unique_visible_source_connections(project, tmp_path):
    store, pid, session = project
    first_source, first = upload_source(project, tmp_path, 'video', seconds=1)
    second_source, second = upload_source(project, tmp_path, 'video', seconds=2, color='red')
    document = _timeline(pid, [_clip(first, 'shot-a'), _clip(second, 'shot-b')])
    assert document.get('inputConnections', []) in ([], None)
    _create(store, pid, session, document, [first_source, second_source])

    restored, connections = _connections(_reopen(store, pid), document['id'])
    assert [(c.slotId, c.sourceId, c.asset.assetId) for c in connections] == [
        ('shot-a', first_source.id, first.id),
        ('shot-b', second_source.id, second.id),
    ]
    clips = [clip for track in restored.data.tracks for clip in track.clips]
    assert [clip.id for clip in clips] == ['shot-a', 'shot-b']
    assert [clip.inPoint for clip in clips] == [0, 0]
    assert [clip.outPoint for clip in clips] == [first.metadata.durationSeconds, second.metadata.durationSeconds]
    assert [clip.resource.asset.assetId for clip in clips] == [first.id, second.id]


def test_same_asset_on_two_visible_nodes_is_not_guessed(project, tmp_path):
    store, pid, session = project
    source, asset = upload_source(project, tmp_path, 'video')
    duplicate_id = uuid4()
    assert send(store, pid, 'canvas.show', session=session, item=dict(
        id=duplicate_id, projectId=pid, kind='video',
        binding=dict(role='material', objectRef=asset_ref(asset)))).status == 'applied'
    document = _timeline(pid, [_clip(asset, 'shot')])
    _create(store, pid, session, document, [source])
    _, connections = _connections(_reopen(store, pid), document['id'])
    assert connections == []


def _import_video(project, tmp_path, name, color='green', seconds=1):
    from test_creation_assets import import_asset
    import subprocess
    path = tmp_path / name
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                    f'color=c={color}:s=16x16:r=1', '-t', str(seconds),
                    '-pix_fmt', 'yuv420p', str(path)], check=True)
    asset, _, _ = import_asset(project, name, path.read_bytes())
    return asset


def test_imported_asset_without_canvas_node_stays_unconnected(project, tmp_path):
    store, pid, session = project
    source, _ = upload_source(project, tmp_path, 'video', seconds=1)
    orphan = _import_video(project, tmp_path, 'imported.mp4')
    document = _timeline(pid, [_clip(orphan, 'imported')])
    _create(store, pid, session, document, [source])
    _, connections = _connections(_reopen(store, pid), document['id'])
    assert connections == []


def test_mixed_unique_source_and_external_asset_only_binds_the_unique_node(project, tmp_path):
    store, pid, session = project
    source, visible = upload_source(project, tmp_path, 'video', seconds=1)
    external = _import_video(project, tmp_path, 'external.mp4', color='green', seconds=2)
    document = _timeline(pid, [_clip(visible, 'from-node'), _clip(external, 'external')])
    _create(store, pid, session, document, [source])
    _, connections = _connections(_reopen(store, pid), document['id'])
    assert [(c.slotId, c.sourceId, c.asset.assetId) for c in connections] == [
        ('from-node', source.id, visible.id),
    ]


def test_explicit_input_connections_keep_ids_and_are_not_replaced(project, tmp_path):
    store, pid, session = project
    source, asset = upload_source(project, tmp_path, 'video')
    connection_id = uuid4()
    document = _timeline(pid, [_clip(asset, 'shot')], connections=[
        dict(id=connection_id, sourceId=source.id, slotId='shot', asset=asset_ref(asset)),
    ])
    _create(store, pid, session, document, [source])
    _, connections = _connections(_reopen(store, pid), document['id'])
    assert len(connections) == 1
    assert connections[0].id == connection_id
    assert connections[0].sourceId == source.id


def test_save_binds_only_newly_added_clips(project, tmp_path):
    store, pid, session = project
    first_source, first = upload_source(project, tmp_path, 'video', seconds=1, color='blue')
    second_source, second = upload_source(project, tmp_path, 'video', seconds=2, color='red')
    document = _timeline(pid, [_clip(first, 'existing')])
    # Create without auto-binding by also showing a duplicate of the first asset,
    # then hide the duplicate so a later unique match exists for the new clip only.
    duplicate_id = uuid4()
    assert send(store, pid, 'canvas.show', session=session, item=dict(
        id=duplicate_id, projectId=pid, kind='video',
        binding=dict(role='material', objectRef=asset_ref(first)))).status == 'applied'
    _create(store, pid, session, document, [first_source])
    _, initial = _connections(store.snapshot(pid), document['id'])
    assert initial == []
    duplicate = next(item for item in store.snapshot(pid).canvasItems if item.id == duplicate_id)
    assert send(store, pid, 'canvas.hide', session=session,
                versions=[ver('canvas_item', duplicate)], itemId=duplicate_id).status == 'applied'

    current = store.snapshot(pid).editorDocuments[-1]
    changed = current.model_dump(mode='json')
    changed['data']['tracks'][0]['clips'].append(_clip(second, 'added'))
    receipt = send(store, pid, 'editor.save', session=session,
                   versions=[ver('editor_document', current)], document=changed)
    assert receipt.status == 'applied', receipt
    restored, connections = _connections(_reopen(store, pid), document['id'])
    assert [(c.slotId, c.sourceId) for c in connections] == [('added', second_source.id)]
    assert [clip.id for track in restored.data.tracks for clip in track.clips] == ['existing', 'added']


def test_hidden_only_source_is_not_bound(project, tmp_path):
    store, pid, session = project
    source, asset = upload_source(project, tmp_path, 'video')
    assert send(store, pid, 'canvas.hide', session=session,
                versions=[ver('canvas_item', source)], itemId=source.id).status == 'applied'
    document = _timeline(pid, [_clip(asset, 'shot')])
    hidden = next(item for item in store.snapshot(pid).canvasItems if item.id == source.id)
    _create(store, pid, session, document, [hidden])
    _, connections = _connections(_reopen(store, pid), document['id'])
    assert connections == []


def test_same_batch_can_show_unique_source_after_editor_create(project, tmp_path):
    store, pid, session = project
    asset = _import_video(project, tmp_path, 'batch.mp4')
    source_id = uuid4()
    document = _timeline(pid, [_clip(asset, 'shot')])
    timeline_item = uuid4()
    receipt = send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=document)),
        dict(type='canvas.show', payload=dict(item=dict(
            id=timeline_item, projectId=pid, kind='timeline',
            binding=dict(role='editor', objectRef=dict(id=document['id'], kind='timeline'))))),
        dict(type='canvas.show', payload=dict(item=dict(
            id=source_id, projectId=pid, kind='video',
            binding=dict(role='material', objectRef=asset_ref(asset))))),
    ])
    assert receipt.status == 'applied', receipt
    _, connections = _connections(_reopen(store, pid), document['id'])
    assert [(c.slotId, c.sourceId, c.asset.assetId) for c in connections] == [
        ('shot', source_id, asset.id),
    ]
