from uuid import uuid4
import pytest

from opendirector.application.creation_history import CreationHistory
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from test_creation_canvas_service import project, media, send, text_material, ver


def test_history_reads_take_the_catalog_lock_only_to_resolve_the_head(project, monkeypatch):
    store, pid, session = project
    item, _ = media(project)
    for x in (10, 20):
        send(store, pid, 'canvas.move', session=session, versions=[ver('canvas_item', item)],
             items=[dict(itemId=item.id, position=dict(x=x, y=0))])
        item = store.snapshot(pid).canvasItems[0]
    locks = []
    original = store.local.transaction
    def tracking():
        locks.append(1)
        return original()
    monkeypatch.setattr(store.local, 'transaction', tracking)
    cleared, entries = store.history_index(pid)
    # Reading hundreds of immutable commits used to hold the catalog lock for
    # longer than the 15 s contention budget, so unrelated saves were reported
    # as "storage busy"; only the head lookup may take it now.
    assert len(locks) == 1
    assert cleared == 0 and len(entries) >= 4
    locks.clear()
    records = store.history(pid)
    assert len(locks) == 1 and len(records) >= 4


def test_redo_follows_undo_order_and_new_edit_discards_redo_branch(project):
    store, pid, session = project
    item, _ = media(project)
    history = CreationHistory(store)
    moves = []
    for x in (10, 20):
        moves.append(send(store, pid, 'canvas.move', session=session, versions=[ver('canvas_item', item)],
            items=[dict(itemId=item.id, position=dict(x=x, y=0))]).commandId)
        item = store.snapshot(pid).canvasItems[0]
    for target in reversed(moves):
        assert send(store, pid, 'history.undo', session=session, versions=[ver('canvas_item', item)],
            targetCommandId=target).status == 'applied'
        item = store.snapshot(pid).canvasItems[0]
    assert next(row['commandId'] for row in history.operations(pid) if row['state'] == 'undone') == moves[0]
    for target, x in zip(moves, (10, 20)):
        assert send(store, pid, 'history.redo', session=session, versions=[ver('canvas_item', item)],
            targetCommandId=target).status == 'applied'
        item = store.snapshot(pid).canvasItems[0]
        assert item.position.x == x
    assert send(store, pid, 'history.undo', session=session, versions=[ver('canvas_item', item)],
        targetCommandId=moves[-1]).status == 'applied'
    item = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', item)],
        itemId=item.id, title='New branch').status == 'applied'
    assert not any(row['state'] == 'undone' for row in history.operations(pid))
    item = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'history.redo', session=session, versions=[ver('canvas_item', item)],
        targetCommandId=moves[-1]).status == 'rejected'
    assert store.snapshot(pid).canvasItems[0].position.x == 10


def test_history_index_preserves_already_accepted_replays_and_background_changes():
    first, second = uuid4(), uuid4()
    entries = [
        dict(commandId=first, type='canvas.move', source='ui', cursor=1),
        dict(commandId=uuid4(), type='history.undo', source='ui', cursor=2, targetCommandId=first),
        dict(commandId=uuid4(), type='canvas.update', source='background', cursor=3),
    ]
    assert CreationHistory._entry_states(0, list(reversed(entries)))[first] == 'undone'
    entries.extend([
        dict(commandId=second, type='canvas.move', source='ui', cursor=4),
        # Reconstruct accepted facts; do not retroactively erase a replay that
        # was accepted before branch invalidation was enforced.
        dict(commandId=uuid4(), type='history.redo', source='ui', cursor=5, targetCommandId=first),
    ])
    states = CreationHistory._entry_states(0, list(reversed(entries)))
    assert list(reversed(states)) == [first, second]
    assert states[first] == 'applied'


def test_history_toolbar_avoids_deep_copies_and_replay_reads_history_once(project, monkeypatch):
    from opendirector.infrastructure.creation_projects import CommitRecord
    store, pid, session = project
    item, _ = media(project)
    for x in range(1, 20):
        latest = send(store, pid, 'canvas.move', session=session, versions=[ver('canvas_item', item)],
            items=[dict(itemId=item.id, position=dict(x=x, y=0))])
        item = store.snapshot(pid).canvasItems[0]
    copied = []
    original = CommitRecord.model_copy
    def copy_record(self, **kwargs):
        copied.append(self.command.commandId)
        return original(self, **kwargs)
    monkeypatch.setattr(CommitRecord, 'model_copy', copy_record)
    history = CreationHistory(store)
    assert history.operations(pid)[0]['commandId'] == latest.commandId
    assert copied == []
    scans = []
    original_history = store._history
    def read_history(path, manifest):
        scans.append(manifest.head)
        return original_history(path, manifest)
    monkeypatch.setattr(store, '_history', read_history)
    assert send(store, pid, 'history.undo', session=session, versions=[ver('canvas_item', item)],
        targetCommandId=latest.commandId).status == 'applied'
    assert len(scans) == 1
    item = store.snapshot(pid).canvasItems[0]
    scans.clear()
    assert send(store, pid, 'history.redo', session=session, versions=[ver('canvas_item', item)],
        targetCommandId=latest.commandId).status == 'applied'
    assert len(scans) == 1
    assert copied == []


@pytest.mark.parametrize('verify_bytes', [False, True])
def test_warm_writes_reuse_validated_history_and_keep_idempotent_receipts(project, monkeypatch, verify_bytes):
    from opendirector.infrastructure.creation_projects import CommitRecord
    store, pid, session = project
    store._verify_record_bytes = verify_bytes
    item, _ = media(project)
    for x in range(1, 20):
        send(store, pid, 'canvas.move', session=session, versions=[ver('canvas_item', item)],
            items=[dict(itemId=item.id, position=dict(x=x, y=0))])
        item = store.snapshot(pid).canvasItems[0]
    store.history_index(pid)
    parsed = []
    for method in ('model_validate', 'model_validate_json'):
        original = getattr(CommitRecord, method)
        def decode(value, _original=original, **kwargs):
            parsed.append(1)
            return _original(value, **kwargs)
        monkeypatch.setattr(CommitRecord, method, decode)
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='canvas.move',
        expectedVersions=[ver('canvas_item', item)],
        payload=dict(items=[dict(itemId=item.id, position=dict(x=30, y=0))])))
    receipt = store.execute(command, session=session)
    assert receipt.status == 'applied'
    assert parsed == []  # Existing ancestors are checked without re-parsing.
    assert store.execute(command, session=session) == receipt
    assert len(parsed) <= 1  # Only the newly published head needs decoding.
    assert store.snapshot(pid).canvasItems[0].position.x == 30


def test_field_scoped_undo_preserves_other_fields_and_rejects_same_field_conflict(project):
    store, pid, session = project
    item, _ = media(project)
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='canvas.move',
        expectedVersions=[ver('canvas_item', item)], payload=dict(items=[dict(itemId=item.id, position=dict(x=50, y=25))])))
    assert store.execute(command, session=session).status == 'applied'
    moved = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', moved)], itemId=item.id, title='New title').status == 'applied'
    edited = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'history.undo', session=session, versions=[ver('canvas_item', edited)], targetCommandId=command.commandId).status == 'applied'
    undone = store.snapshot(pid).canvasItems[0]
    assert undone.title == 'New title' and undone.position.x == 0
    assert send(store, pid, 'history.redo', session=session, versions=[ver('canvas_item', undone)], targetCommandId=command.commandId).status == 'applied'
    redone = store.snapshot(pid).canvasItems[0]
    assert redone.title == 'New title' and redone.position.x == 50
    assert send(store, pid, 'canvas.move', session=session, versions=[ver('canvas_item', redone)], items=[dict(itemId=item.id, position=dict(x=90, y=25))]).status == 'applied'
    newer = store.snapshot(pid).canvasItems[0]
    receipt = send(store, pid, 'history.undo', session=session, versions=[ver('canvas_item', newer)], targetCommandId=command.commandId)
    assert receipt.status == 'rejected'
    assert store.snapshot(pid).canvasItems[0].position.x == 90


def deletion(project, asset, preview):
    store, pid, session = project
    snapshot = store.snapshot(pid)
    return parse_command(dict(commandId=uuid4(), projectId=pid, type='asset.delete',
        expectedVersions=[ver('asset', asset), *[ver('canvas_item', i) for i in snapshot.canvasItems if str(i.id) in preview['hiddenItemIds']]],
        expectedPreview=preview['fingerprint'], payload=dict(assetIds=[asset.id], clearHistory=preview['clearsAllUndoRedo'])))


def test_delete_preview_protects_visible_and_undo_then_clears_only_canvas_undo(project):
    store, pid, session = project
    item, asset = text_material(project)
    history = CreationHistory(store)
    assert not history.delete_preview(pid, [asset.id], True)['canDelete']
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', item)], itemId=item.id).status == 'applied'
    assert not history.delete_preview(pid, [asset.id])['canDelete']
    preview = history.delete_preview(pid, [asset.id], True)
    assert preview['canDelete']
    command = deletion(project, asset, preview)
    receipt = store.execute(command, session=session)
    assert receipt.status == 'applied', receipt
    snapshot = store.snapshot(pid)
    assert not snapshot.assets and snapshot.canvasItems[0].binding.role == 'empty'
    assert not (store.root / 'Unified' / asset.path).exists()
    assert not history.operations(pid)
    assert store.execute(command, session=session) == receipt


def test_delete_expired_preview_and_restart_after_publication(project):
    store, pid, session = project
    item, asset = text_material(project)
    history = CreationHistory(store)
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', item)], itemId=item.id).status == 'applied'
    preview = history.delete_preview(pid, [asset.id], True)
    command = deletion(project, asset, preview)
    hidden = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', hidden)], itemId=item.id, title='New').status == 'applied'
    assert store.execute(command, session=session).status == 'rejected'
    assert (store.root / 'Unified' / asset.path).exists()
    command = deletion(project, asset, history.delete_preview(pid, [asset.id], True))
    def crash(stage):
        if stage == 'published':
            raise OSError('Injected crash before file deletion')
    store._checkpoint = crash
    import pytest
    with pytest.raises(OSError):
        store.execute(command, session=session)
    restarted = CreationProjects(LocalProjects(store.local.repository))
    assert not restarted.snapshot(pid).assets
    assert not (store.root / 'Unified' / asset.path).exists()
    assert restarted.execute(command, session=session).status == 'applied'


def test_asset_list_uses_hidden_current_and_history_usage_is_authoritative(project):
    store, pid, session = project
    item, asset = text_material(project)
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', item)], itemId=item.id).status == 'applied'
    listing = CreationHistory(store).asset_list(pid)
    assert listing['items'][0]['asset'].id == asset.id
    assert not listing['items'][0]['owners'][0]['visible']
    assert listing['items'][0]['usage']['used']


def test_undo_material_binding_restores_empty_without_deleting_immutable_asset(project):
    store, pid, session = project
    item, asset = text_material(project)
    materialize = next(record for record in store.history(pid) if record.command.type == 'canvas.materialize')
    assert send(store, pid, 'history.undo', session=session, versions=[ver('canvas_item', item)], targetCommandId=materialize.command.commandId).status == 'applied'
    snapshot = store.snapshot(pid)
    assert snapshot.canvasItems[0].binding.role == 'empty'
    assert snapshot.assets[0] == asset
    empty = snapshot.canvasItems[0]
    assert send(store, pid, 'history.redo', session=session, versions=[ver('canvas_item', empty)], targetCommandId=materialize.command.commandId).status == 'applied'
    assert store.snapshot(pid).canvasItems[0].binding.role == 'material'


def test_reference_remove_undo_retains_identity_and_monotonic_revision(project):
    store, pid, session = project
    source, _ = text_material(project)
    target, spec = media(project)
    reference_id = uuid4()
    assert send(store, pid, 'reference.add', session=session, versions=[ver('canvas_item', target), ver('generation_spec', spec)],
        reference=dict(id=reference_id, projectId=pid, targetSpecId=spec.id, binding='follow_current', source=dict(id=source.id))).status == 'applied'
    ref = store.snapshot(pid).references[0]
    remove = parse_command(dict(commandId=uuid4(), projectId=pid, type='reference.remove', expectedVersions=[ver('reference', ref)], payload=dict(referenceId=ref.id)))
    assert store.execute(remove, session=session).status == 'applied'
    inactive = store.snapshot(pid).references[0]
    assert not inactive.active and inactive.revision == 2
    assert send(store, pid, 'history.undo', session=session, versions=[ver('reference', inactive)], targetCommandId=remove.commandId).status == 'applied'
    revived = store.snapshot(pid).references[0]
    assert revived.active and revived.id == ref.id and revived.revision == 3
    # A pre-removal actor cannot mutate the revived reference with revision 1.
    assert send(store, pid, 'reference.remove', session=session, versions=[ver('reference', ref)], referenceId=ref.id).status == 'rejected'


def test_stack_document_retains_hidden_material_even_after_clearing_undo(project):
    store, pid, session = project
    item, asset = text_material(project)
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', item)], itemId=item.id).status == 'applied'
    assert send(store, pid, 'editor.create', session=session,
        document=dict(id=uuid4(), projectId=pid, kind='stack', data=dict(nodeIds=[item.id]))).status == 'applied'
    preview = CreationHistory(store).delete_preview(pid, [asset.id], True)
    assert not preview['canDelete']
    assert any(reason['type'] == 'editor_document' for reason in preview['usage'][0]['reasons'])


def test_asset_list_batches_history_and_tool_dependencies_without_stale_usage(project, monkeypatch):
    from opendirector.infrastructure.creation_projects import durable_json
    from opendirector.ports.gateway import gateway

    store, pid, session = project
    item, material = text_material(project)
    assert send(store, pid, 'canvas.update', session=session,
                versions=[ver('canvas_item', item)], itemId=item.id, title='Hidden node').status == 'applied'
    item = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'canvas.hide', session=session,
                versions=[ver('canvas_item', item)], itemId=item.id).status == 'applied'
    for name in ['Tool input', 'Unused']:
        assert send(store, pid, 'asset.writeText', session=session, name=name + '.md', text=name).status == 'applied'
    snapshot = store.snapshot(pid)
    tool_input, unused = snapshot.assets[-2:]
    task_id = str(uuid4())
    folder = store.root / 'Unified' / 'tool-tasks'
    folder.mkdir()
    ledger = folder / f'{task_id}.json'
    durable_json(ledger, dict(id=task_id, sourceAssetIds=[str(tool_input.id)], outputs=[]))
    loads, history_reads, ledger_reads = [], [], []
    load, history, read = store._load, store.history, gateway().read_json
    def loading(*args, **kwargs):
        loads.append(1)
        return load(*args, **kwargs)
    def records(*args, **kwargs):
        history_reads.append(1)
        return history(*args, **kwargs)
    def reading(path):
        ledger_reads.append(path)
        return read(path)
    monkeypatch.setattr(store, '_load', loading)
    monkeypatch.setattr(store, 'history', records)
    monkeypatch.setattr(gateway(), 'read_json', reading)
    service = CreationHistory(store)
    listing = service.asset_list(pid)
    assert len(history_reads) == 1 and len(loads) == 1
    assert ledger_reads == [ledger]
    assert listing['eventCursor'] == snapshot.eventCursor
    assert [row['asset'].id for row in listing['items']] == [unused.id, tool_input.id, material.id]
    rows = {row['asset'].id: row for row in listing['items']}
    assert rows[material.id]['owners'] == [dict(itemId=item.id, title='Hidden node', visible=False)]
    assert rows[material.id]['usage']['hiddenItemIds'] == [str(item.id)]
    assert any(reason['type'] == 'undo_history' for reason in rows[material.id]['usage']['reasons'])
    assert rows[tool_input.id]['usage']['reasons'] == [dict(type='tool_task', id=task_id)]
    assert not rows[unused.id]['usage']['used']
    assert service.asset_list(pid, usage='unused')['total'] == 1
    page = service.asset_list(pid, usage='used', offset=1, limit=1)
    assert page['total'] == 2 and page['items'][0]['asset'].id == material.id
    assert service.asset_list(pid, text='HIDDEN NODE')['items'][0]['asset'].id == material.id
    assert service.asset_list(pid, text='TOOL')['items'][0]['asset'].id == tool_input.id
    # Re-read the independent ledger on the next request, even at the same cursor.
    durable_json(ledger, dict(id=task_id, sourceAssetIds=[], outputs=[]))
    refreshed = service.asset_list(pid, usage='unused')
    assert refreshed['eventCursor'] == listing['eventCursor']
    assert {row['asset'].id for row in refreshed['items']} == {tool_input.id, unused.id}


def test_asset_list_visibility_uses_all_owners_and_group_visibility_before_paging(project):
    store, pid, session = project
    item, asset = text_material(project)
    service = CreationHistory(store)
    assert service.asset_list(pid, visibility='visible')['total'] == 1
    assert service.asset_list(pid, visibility='hidden')['total'] == 0
    parent_id = uuid4()
    assert send(store, pid, 'creation.batch', session=session, versions=[ver('canvas_item', item)], operations=[
        dict(type='canvas.show', payload=dict(item=dict(id=parent_id, projectId=pid, kind='group'))),
        dict(type='canvas.update', payload=dict(itemId=item.id, parentId=parent_id)),
    ]).status == 'applied'
    parent = next(i for i in store.snapshot(pid).canvasItems if i.id == parent_id)
    assert send(store, pid, 'canvas.hide', session=session,
                versions=[ver('canvas_item', parent)], itemId=parent.id).status == 'applied'
    hidden = service.asset_list(pid, visibility='hidden')
    assert hidden['total'] == 1 and hidden['items'][0]['usage']['used']
    assert service.asset_list(pid, visibility='visible')['total'] == 0
    # Another visible owner makes this shared asset displayed even with a hidden owner.
    duplicate = item.model_copy(update={'id': uuid4(), 'parentId': None, 'title': 'Second owner'})
    assert send(store, pid, 'canvas.show', session=session, item=duplicate).status == 'applied'
    assert service.asset_list(pid, visibility='visible')['total'] == 1
    assert service.asset_list(pid, visibility='hidden')['total'] == 0
    assert send(store, pid, 'asset.writeText', session=session, name='Unplaced.md', text='Unplaced').status == 'applied'
    unplaced = store.snapshot(pid).assets[-1]
    page = service.asset_list(pid, visibility='hidden', limit=1)
    assert page['total'] == 1 and page['items'][0]['asset'].id == unplaced.id
    assert service.asset_list(pid, visibility='hidden', offset=1, limit=1)['items'] == []
    assert service.asset_list(pid, visibility='visible', text='SECOND')['items'][0]['asset'].id == asset.id


def test_asset_categories_include_subject_and_timeline_nodes_with_counts_before_paging(project):
    from io import BytesIO
    from PIL import Image
    from opendirector.application.creation_assets import CreationAssets
    from opendirector.application.creation_canvas import asset_ref

    store, pid, session = project
    image = BytesIO()
    Image.new('RGB', (16, 16), 'blue').save(image, 'PNG')
    handle = uuid4()
    writer = CreationAssets(store).uploads.begin(pid, handle, session, 'Subject.png', expected_kind='image')
    writer.write(image.getvalue())
    writer.finish()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=handle,
                name='Subject.png', expectedKind='image').status == 'applied'
    asset = store.snapshot(pid).assets[0]
    subject_id, timeline_id = uuid4(), uuid4()
    assert send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=dict(id=subject_id, projectId=pid, kind='subject', data=dict(main=asset_ref(asset))))),
        dict(type='canvas.show', payload=dict(item=dict(id=uuid4(), projectId=pid, kind='subject', title='Actor', binding=dict(role='editor', objectRef=dict(id=subject_id, kind='subject'))))),
        dict(type='editor.create', payload=dict(document=dict(id=timeline_id, projectId=pid, kind='timeline', data=dict(fps=30, width=1920, height=1080,
            tracks=[dict(id='visual', kind='visual', title='Visual', clips=[dict(id='clip', inPoint=0, outPoint=2, resource=dict(asset=asset_ref(asset), title='Subject'))])])))),
        dict(type='canvas.show', payload=dict(item=dict(id=uuid4(), projectId=pid, kind='timeline', title='Scene', binding=dict(role='editor', objectRef=dict(id=timeline_id, kind='timeline'))))),
    ]).status == 'applied'
    assert send(store, pid, 'asset.writeText', session=session, name='Notes.md', text='Notes').status == 'applied'
    service = CreationHistory(store)
    for category in ['image', 'subject', 'timeline']:
        page = service.asset_list(pid, category=category, limit=1)
        assert page['total'] == 1
        if category == 'image':
            assert page['items'][0]['asset'].id == asset.id and not page['nodes']
        else:
            assert not page['items'] and len(page['nodes']) == 1
            assert page['nodes'][0]['title'] == ('Actor' if category == 'subject' else 'Scene')
            assert page['nodes'][0]['asset'].id == asset.id
        assert page['counts'] == dict(all=4, image=1, video=0, audio=0, text=1, subject=1, timeline=1)
        assert service.asset_list(pid, category=category, offset=1, limit=1)['total'] == 1
        assert not service.asset_list(pid, category=category, offset=1, limit=1)['nodes']
    assert service.asset_list(pid, limit=1)['total'] == 4
    assert service.asset_list(pid, category='video')['total'] == 0
    searched = service.asset_list(pid, category='text', text='NOTES')
    assert searched['total'] == searched['counts']['all'] == searched['counts']['text'] == 1
    assert searched['counts']['image'] == 0
    empty_document, empty_item = uuid4(), uuid4()
    assert send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=dict(id=empty_document, projectId=pid, kind='subject', data={}))),
        dict(type='canvas.show', payload=dict(item=dict(id=empty_item, projectId=pid, kind='subject', title='Empty actor', binding=dict(role='editor', objectRef=dict(id=empty_document, kind='subject'))))),
    ]).status == 'applied'
    item = next(item for item in store.snapshot(pid).canvasItems if item.id == empty_item)
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', item)], itemId=item.id).status == 'applied'
    empty = service.asset_list(pid, category='subject', text='empty', visibility='hidden')
    assert empty['total'] == 1 and empty['nodes'][0]['asset'] is None
    assert empty['nodes'][0]['itemId'] == empty_item and not empty['nodes'][0]['visible']
    assert service.asset_list(pid, category='subject', text='empty', visibility='visible')['total'] == 0


def test_asset_used_only_by_an_active_pinned_reference_stays_listed_after_becoming_a_source(project):
    from opendirector.application.creation_canvas import asset_ref
    store, pid, session = project
    assert send(store, pid, 'asset.writeText', session=session, name='pinned.md', text='fixed').status == 'applied'
    source = store.snapshot(pid).assets[-1]
    target_item, spec = media(project, title='Target')
    reference = dict(id=uuid4(), projectId=pid, targetSpecId=spec.id, binding='pinned',
                     source=asset_ref(source).model_dump(mode='json'), order=0)
    assert send(store, pid, 'reference.add', session=session,
                versions=[ver('generation_spec', spec), ver('canvas_item', target_item)],
                reference=reference).status == 'applied'
    service = CreationHistory(store)
    def listed(**kwargs):
        return {row['asset'].id for row in service.asset_list(pid, **kwargs)['items']}
    def catalog():
        return next(row for row in service.reference_catalog(pid) if row['id'] == str(source.id))
    assert source.id in listed() and source.id in listed(visibility='hidden')
    assert catalog()['available']
    # Any newer asset naming it in provenance.sources, like a generated result, makes it historical.
    assert send(store, pid, 'asset.writeText', session=session, versions=[ver('asset', source)], name='derived.md',
                text='derived', previousAsset=asset_ref(source).model_dump(mode='json')).status == 'applied'
    assert store.snapshot(pid).assets[-1].provenance.sources == (asset_ref(source),)
    # Becoming another asset's source must not hide media a live configuration still pins.
    assert source.id in listed() and source.id in listed(visibility='hidden')
    assert catalog()['available'] and catalog()['fileAvailable']
    reopened = CreationHistory(CreationProjects(LocalProjects(store.local.repository)))
    assert source.id in {row['asset'].id for row in reopened.asset_list(pid, visibility='hidden')['items']}
    assert service.usage(store.snapshot(pid), source.id)['used']
    current = next(item for item in store.snapshot(pid).references if item.id == reference['id'])
    target = next(item for item in store.snapshot(pid).generationSpecs if item.id == spec.id)
    assert send(store, pid, 'reference.remove', session=session,
                versions=[ver('reference', current), ver('generation_spec', target)],
                referenceId=current.id).status == 'applied'
    # Once removed, it is again only a historical source, as before.
    assert source.id not in listed()
    assert not catalog()['available']
    # Delete protection is unchanged: the derived version and history still depend on it.
    assert service.usage(store.snapshot(pid), source.id)['used']
