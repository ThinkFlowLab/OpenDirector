"""Real committed commands: no alternate graph and no visible execution nodes."""
from io import BytesIO
from uuid import uuid4

from PIL import Image
import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import CreationCanvas, asset_ref, resolved_inputs
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


def media(project, kind='text', title='Source', purpose='draft'):
    store, project_id, session = project
    spec_id, item_id = uuid4(), uuid4()
    receipt = send(store, project_id, 'creation.batch', session=session, operations=[
        dict(type='generationSpec.create', payload=dict(spec=dict(id=spec_id, projectId=project_id, kind=kind, purpose=purpose))),
        dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=project_id, kind=kind, title=title,
            binding=dict(role='empty', draftSpec=dict(id=spec_id)) if purpose == 'draft' else dict(role='generation', objectRef=dict(id=spec_id)))))])
    assert receipt.status == 'applied', receipt
    snapshot = store.snapshot(project_id)
    return next(i for i in snapshot.canvasItems if i.id == item_id), next(s for s in snapshot.generationSpecs if s.id == spec_id)


def text_material(project, title='Source', text='v1'):
    store, project_id, session = project
    item, _ = media(project, title=title)
    receipt = send(store, project_id, 'asset.writeText', session=session, name=title+'.md', text=text)
    assert receipt.status == 'applied'
    asset = store.snapshot(project_id).assets[-1]
    receipt = send(store, project_id, 'canvas.materialize', session=session, versions=[ver('canvas_item', item)], itemId=item.id, asset=asset_ref(asset))
    assert receipt.status == 'applied', receipt
    return store.snapshot(project_id).canvasItems[-1], asset


def test_hidden_follow_source_reopens_with_stable_identity_and_duplicate_reference_is_noop(project):
    store, pid, session = project
    source, asset = text_material(project)
    target, spec = media(project)
    ref = dict(id=uuid4(), projectId=pid, binding='follow_current', source=dict(id=source.id), targetSpecId=spec.id)
    receipt = send(store, pid, 'reference.add', session=session,
        versions=[ver('generation_spec', spec), ver('canvas_item', target)], reference=ref)
    assert receipt.status == 'applied', receipt
    current = store.snapshot(pid)
    assert current.canvasItems[-1].binding.role == 'generation'
    assert resolved_inputs(current, spec.id)[0].asset.assetId == asset.id
    ref['id'] = uuid4()
    spec = current.generationSpecs[-1]
    assert send(store, pid, 'reference.add', session=session, versions=[ver('generation_spec', spec)], reference=ref).status == 'noop'
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', source)], itemId=source.id).status == 'applied'
    reloaded = CreationProjects(LocalProjects(store.local.repository))
    current = reloaded.snapshot(pid)
    assert not current.canvasItems[0].visible
    assert resolved_inputs(current, spec.id)[0].asset.assetId == asset.id
    hidden = current.canvasItems[0]
    assert send(reloaded, pid, 'canvas.show', session=session, versions=[ver('canvas_item', hidden)], item=hidden).status == 'applied'
    assert len(reloaded.snapshot(pid).canvasItems) == 2


def test_projection_reuses_read_basis_checks_each_asset_once_and_rechecks_changed_files(project, monkeypatch):
    store, pid, session = project
    source, asset = text_material(project, text='v1')
    target, spec = media(project)
    assert send(store, pid, 'reference.add', session=session,
        versions=[ver('generation_spec', spec), ver('canvas_item', target)],
        reference=dict(id=uuid4(), projectId=pid, binding='follow_current', source=dict(id=source.id), targetSpecId=spec.id)).status == 'applied'
    canvas = CreationCanvas(store)
    loads, checks = [], []
    load, check = store._load, canvas.assets.reference_available
    def loading(*args, **kwargs):
        loads.append(1)
        return load(*args, **kwargs)
    def checking(project_id, asset_id, **kwargs):
        checks.append(asset_id)
        assert kwargs['snapshot'].project.id == pid
        return check(project_id, asset_id, **kwargs)
    monkeypatch.setattr(store, '_load', loading)
    monkeypatch.setattr(canvas.assets, 'reference_available', checking)
    projection = canvas.projection(pid)
    # The command above just published this head, so it may already be in hand;
    # the invariant is that a projection never loads the project more than once.
    assert len(loads) <= 1 and checks == [asset.id]
    assert projection['edges'][0]['state'] != 'unavailable'
    file = store.root / 'Unified' / asset.path
    original = file.read_bytes()
    file.write_bytes(b'v2')  # Same length; cached verification must still invalidate.
    assert canvas.projection(pid)['edges'][0]['state'] == 'unavailable'
    file.write_bytes(original)
    assert canvas.projection(pid)['edges'][0]['state'] != 'unavailable'
    file.unlink()
    assert canvas.projection(pid)['edges'][0]['state'] == 'unavailable'


def test_blank_rejected_and_batch_rolls_back_all_earlier_operations(project):
    store, pid, session = project
    source, _ = media(project)
    target, spec = media(project)
    before = store.snapshot(pid)
    receipt = send(store, pid, 'creation.batch', session=session,
        versions=[ver('canvas_item', target), ver('generation_spec', spec)], operations=[
            dict(type='canvas.update', payload=dict(itemId=target.id, title='Should roll back')),
            dict(type='reference.add', payload=dict(reference=dict(id=uuid4(), projectId=pid, binding='follow_current',
                source=dict(id=source.id), targetSpecId=spec.id)))])
    assert receipt.status == 'rejected'
    assert store.snapshot(pid) == before


def test_concurrent_move_and_locked_parent_do_not_overwrite_newer_state(project):
    store, pid, session = project
    item, _ = media(project)
    first = send(store, pid, 'canvas.move', session=session, versions=[ver('canvas_item', item)], items=[dict(itemId=item.id, position=dict(x=100, y=42))])
    assert first.status == 'applied'
    assert send(store, pid, 'canvas.move', session=session, versions=[ver('canvas_item', item)], items=[dict(itemId=item.id, position=dict(x=0, y=0))]).status == 'rejected'
    moved = store.snapshot(pid).canvasItems[0]
    assert moved.position.x == 100
    assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', moved)], itemId=moved.id, locked=True).status == 'applied'
    locked = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', locked)], itemId=locked.id).status == 'rejected'


@pytest.mark.parametrize('binding', ['follow_current', 'pinned'])
def test_frame_mode_limits_current_image_sources_and_rejects_over_limit_mode_switch(project, binding):
    from io import BytesIO
    from PIL import Image
    from opendirector.application.creation_assets import CreationAssets
    store, pid, session = project
    assets = CreationAssets(store)
    sources = []
    for index in range(3):
        image = BytesIO()
        Image.new('RGB', (8, 8), (index * 40, 50, 80)).save(image, 'PNG')
        handle = uuid4()
        writer = assets.uploads.begin(pid, handle, session, f'frame-{index}.png', expected_kind='image')
        writer.write(image.getvalue()); writer.finish()
        assert send(store, pid, 'asset.import', session=session, uploadHandle=handle, name=f'frame-{index}.png', expectedKind='image').status == 'applied'
        asset = store.snapshot(pid).assets[-1]
        node_id = uuid4()
        assert send(store, pid, 'canvas.show', session=session,
            item=dict(id=node_id, projectId=pid, kind='image', binding=dict(role='material', objectRef=asset_ref(asset)))).status == 'applied'
        sources.append((node_id, asset))
    target, spec = media(project, 'video')
    def connect(index):
        current = store.snapshot(pid)
        node_id, asset = sources[index]
        ref = dict(id=uuid4(), projectId=pid, targetSpecId=spec.id, binding=binding,
            source=dict(id=node_id) if binding == 'follow_current' else asset_ref(asset), order=index)
        return send(store, pid, 'reference.add', session=session, reference=ref,
            versions=[ver('generation_spec', current.generationSpecs[-1]), ver('canvas_item', current.canvasItems[-1])])
    assert connect(0).status == 'applied'
    assert connect(1).status == 'applied'
    before = store.snapshot(pid)
    rejected = connect(2)
    assert rejected.status == 'rejected' and '最多连接 2' in rejected.issues[0].message
    assert store.snapshot(pid) == before
    source = before.canvasItems[0]
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', source)], itemId=source.id).status == 'applied'
    # A hidden display does not free an active reference's business slot.
    hidden_limit = connect(2)
    assert hidden_limit.status == 'rejected' and '最多连接 2' in hidden_limit.issues[0].message
    spec = store.snapshot(pid).generationSpecs[-1]
    reference_spec = spec.model_copy(update={'parameters': spec.parameters.model_copy(update={'videoMode': 'reference'})})
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)], spec=reference_spec).status == 'applied'
    assert connect(2).status == 'applied'
    hidden = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'canvas.show', session=session, versions=[ver('canvas_item', hidden)], item=hidden).status == 'applied'
    current = store.snapshot(pid).generationSpecs[-1]
    rejected = send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', current)],
        spec=current.model_copy(update={'parameters': current.parameters.model_copy(update={'videoMode': 'first_frame'})}))
    assert rejected.status == 'rejected' and '最多连接 2' in rejected.issues[0].message
    assert store.snapshot(pid).generationSpecs[-1].parameters.videoMode == 'reference'


def test_subject_reference_freezes_document_and_expands_assets(project):
    store, pid, session = project
    # Subject main images are real inspected uploads, not a synthetic subject asset.
    from PIL import Image
    from io import BytesIO
    from opendirector.application.creation_assets import CreationAssets
    assets = CreationAssets(store)
    image = BytesIO()
    Image.new('RGB', (32, 32), 'blue').save(image, 'PNG')
    handle = uuid4()
    writer = assets.uploads.begin(pid, handle, session, 'subject.png', expected_kind='image')
    writer.write(image.getvalue())
    writer.finish()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=handle, name='subject.png', expectedKind='image').status == 'applied'
    asset = store.snapshot(pid).assets[-1]
    doc_id, item_id = uuid4(), uuid4()
    assert send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=dict(id=doc_id, projectId=pid, kind='subject', data=dict(main=asset_ref(asset))))),
        dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=pid, kind='subject', binding=dict(role='editor', objectRef=dict(id=doc_id, kind='subject')))))
    ]).status == 'applied'
    target, spec = media(project, 'image')
    receipt = send(store, pid, 'reference.add', session=session, versions=[ver('canvas_item', target), ver('generation_spec', spec)],
        reference=dict(id=uuid4(), projectId=pid, targetSpecId=spec.id, binding='follow_current', source=dict(id=item_id)))
    assert receipt.status == 'applied', receipt
    resolved = resolved_inputs(store.snapshot(pid), spec.id)
    assert resolved[0].documentVersion.id == doc_id
    assert resolved[0].subjectRole == 'main'
    assert len(store.snapshot(pid).assets) == 1
    # Subject descriptions are persisted user annotations, not model inputs.
    from opendirector.domain.creation.generation import InputSnapshot
    from test_creation_contracts import model, model_snapshot
    config = model()
    input_spec = store.snapshot(pid).generationSpecs[-1].model_copy(update={'modelConfigId': config.id})
    before = InputSnapshot(spec=input_spec, model=model_snapshot(config), references=resolved)
    document = store.snapshot(pid).editorDocuments[-1]
    note = 'Private subject annotation, excluded from generation'
    updated = document.model_dump(mode='json')
    updated['data']['description'] = note
    assert send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', document)],
        document=updated).status == 'applied'
    after = InputSnapshot(spec=input_spec, model=model_snapshot(config), references=resolved_inputs(store.snapshot(pid), spec.id))
    assert store.snapshot(pid).editorDocuments[-1].data.description == note
    assert all(reference.asset.kind == 'image' for reference in after.references)
    assert note not in after.model_dump_json()
    assert after.references[0].documentVersion.revision > before.references[0].documentVersion.revision
    assert before.fingerprint() == after.fingerprint()


def test_hidden_group_projection_and_show_child_restore_ancestor_identity(project):
    store, pid, session = project
    child, asset = text_material(project)
    parent_id = uuid4()
    assert send(store, pid, 'creation.batch', session=session, versions=[ver('canvas_item', child)], operations=[
        dict(type='canvas.show', payload=dict(item=dict(id=parent_id, projectId=pid, kind='group'))),
        dict(type='canvas.update', payload=dict(itemId=child.id, parentId=parent_id))]).status == 'applied'
    parent = store.snapshot(pid).canvasItems[-1]
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', parent)], itemId=parent.id).status == 'applied'
    projection = CreationCanvas(store).projection(pid)
    assert not projection['visibleItemIds']
    assert set(projection['hiddenItemIds']) == {child.id, parent.id}
    snapshot = store.snapshot(pid)
    current_child, current_parent = snapshot.canvasItems
    assert send(store, pid, 'canvas.show', session=session, versions=[ver('canvas_item', current_child), ver('canvas_item', current_parent)], item=current_child).status == 'applied'
    assert set(CreationCanvas(store).projection(pid)['visibleItemIds']) == {child.id, parent.id}
    assert len(store.snapshot(pid).assets) == 1


def test_reveal_batch_preserves_content_and_groups_rejects_stale_input_and_undoes_visibility(project):
    store, pid, session = project
    first, _ = text_material(project, title='First')
    second, _ = text_material(project, title='Second')
    target, spec = media(project)
    parent_id = uuid4()
    assert send(store, pid, 'creation.batch', session=session,
        versions=[ver('canvas_item', first), ver('canvas_item', second), ver('canvas_item', target), ver('generation_spec', spec)], operations=[
            dict(type='canvas.show', payload=dict(item=dict(id=parent_id, projectId=pid, kind='group'))),
            *[dict(type='canvas.update', payload=dict(itemId=item.id, parentId=parent_id)) for item in (first, second)],
            *[dict(type='reference.add', payload=dict(reference=dict(id=uuid4(), projectId=pid,
                binding='follow_current', source=dict(id=item.id), targetSpecId=spec.id, order=index)))
                for index, item in enumerate((first, second))],
        ]).status == 'applied'
    parent = store.snapshot(pid).canvasItems[-1]
    assert send(store, pid, 'canvas.hide', session=session,
        versions=[ver('canvas_item', parent)], itemId=parent.id).status == 'applied'
    before = store.snapshot(pid)
    sources = [item for item in before.canvasItems if item.id in {first.id, second.id}]
    operations = [dict(type='canvas.show', payload=dict(item=item)) for item in sources]
    versions = [ver('canvas_item', item) for item in before.canvasItems]
    # Concurrent changes reject the whole reveal, including its ancestor group.
    assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', sources[1])],
        itemId=second.id, title='New title while hidden').status == 'applied'
    current = store.snapshot(pid)
    assert send(store, pid, 'creation.batch', session=session, versions=versions, operations=operations).status == 'rejected'
    assert store.snapshot(pid) == current
    sources = [item for item in current.canvasItems if item.id in {first.id, second.id}]
    receipt = send(store, pid, 'creation.batch', session=session,
        versions=[ver('canvas_item', item) for item in current.canvasItems],
        operations=[dict(type='canvas.show', payload=dict(item=item)) for item in sources])
    assert receipt.status == 'applied', receipt
    after = store.snapshot(pid)
    assert set(CreationCanvas(store).projection(pid)['visibleItemIds']) == {item.id for item in after.canvasItems}
    for old, new in zip(current.canvasItems, after.canvasItems):
        assert old.model_dump(exclude={'visible', 'revision'}) == new.model_dump(exclude={'visible', 'revision'})
    for field in ('assets', 'generationSpecs', 'references', 'jobs', 'results', 'editorDocuments'):
        assert getattr(current, field) == getattr(after, field)
    assert send(store, pid, 'history.undo', session=session,
        versions=[ver('canvas_item', item) for item in after.canvasItems], targetCommandId=receipt.commandId).status == 'applied'
    assert CreationCanvas(store).projection(pid)['visibleItemIds'] == [target.id]


def test_missing_and_blank_text_sources_are_unavailable_and_cannot_be_connected(project):
    store, pid, session = project
    source, asset = text_material(project, text='   ')
    target, spec = media(project)
    projection = CreationCanvas(store).projection(pid)
    assert not projection['capabilities'][str(source.id)].canUseAsReference
    receipt = send(store, pid, 'reference.add', session=session, versions=[ver('canvas_item', target), ver('generation_spec', spec)],
        reference=dict(id=uuid4(), projectId=pid, targetSpecId=spec.id, binding='follow_current', source=dict(id=source.id)))
    assert receipt.status == 'rejected'
    assert not store.snapshot(pid).references
    (store.root / 'Unified' / asset.path).unlink()
    assert not CreationCanvas(store).projection(pid)['capabilities'][str(source.id)].canExport


def test_create_generation_is_visible_without_a_job_and_replayable(project):
    store, pid, session = project
    spec_id, item_id = uuid4(), uuid4()
    value = dict(commandId=uuid4(), projectId=pid, type='canvas.createGeneration', payload={
        'spec': dict(id=spec_id, projectId=pid, kind='image', purpose='generation', prompt='A lake'),
        'item': dict(id=item_id, projectId=pid, kind='image', title='Lake',
            binding=dict(role='generation', objectRef=dict(id=spec_id)))})
    command = parse_command(value)
    receipt = store.execute(command, session=session)
    assert receipt.status == 'applied', receipt.issues
    assert store.execute(command, session=session) == receipt
    snapshot = store.snapshot(pid)
    assert snapshot.canvasItems[0].visible
    assert snapshot.canvasItems[0].binding.objectRef.id == spec_id
    assert snapshot.generationSpecs[0].prompt == 'A lake'
    assert not snapshot.jobs
    undo = send(store, pid, 'history.undo', session=session,
        versions=[ver('canvas_item', snapshot.canvasItems[0])], targetCommandId=command.commandId)
    assert undo.status == 'applied', undo.issues
    undone = store.snapshot(pid)
    assert not any(item.visible for item in undone.canvasItems)


def test_create_generation_reference_failure_rolls_back(project):
    store, pid, session = project
    spec_id = uuid4()
    before = store.snapshot(pid)
    receipt = send(store, pid, 'canvas.createGeneration', session=session,
        spec=dict(id=spec_id, projectId=pid, kind='image', purpose='generation'),
        item=dict(id=uuid4(), projectId=pid, kind='image',
            binding=dict(role='generation', objectRef=dict(id=spec_id))),
        references=[dict(id=uuid4(), projectId=pid, targetSpecId=spec_id,
            binding='follow_current', source=dict(id=uuid4()))])
    assert receipt.status == 'rejected'
    assert store.snapshot(pid) == before


def test_create_generation_connects_existing_reference(project):
    store, pid, session = project
    source, _ = text_material(project)
    spec_id, item_id, reference_id = uuid4(), uuid4(), uuid4()
    receipt = send(store, pid, 'canvas.createGeneration', session=session,
        spec=dict(id=spec_id, projectId=pid, kind='text', purpose='generation', prompt='Continue the story'),
        item=dict(id=item_id, projectId=pid, kind='text',
            binding=dict(role='generation', objectRef=dict(id=spec_id))),
        references=[dict(id=reference_id, projectId=pid, targetSpecId=spec_id,
            binding='follow_current', source=dict(id=source.id))])
    assert receipt.status == 'applied', receipt.issues
    snapshot = store.snapshot(pid)
    assert next(ref for ref in snapshot.references if ref.id == reference_id).source.id == source.id
    assert next(item for item in snapshot.canvasItems if item.id == item_id).visible
    assert not snapshot.jobs


def test_canvas_item_status_is_scoped_and_read_only(project):
    store, pid, session = project
    item, _ = text_material(project)
    before = store.snapshot(pid)
    canvas = CreationCanvas(store)
    result = canvas.item_status(pid, item.id)
    assert result['item']['id'] == str(item.id)
    assert result['status'] == 'idle'
    assert result['asset']['id'] == str(item.binding.objectRef.assetId)
    assert store.snapshot(pid) == before
    from opendirector.domain.projects import ProjectError
    with pytest.raises(ProjectError, match='当前工程'):
        canvas.item_status(pid, uuid4())


def test_canvas_item_wait_returns_on_change_and_timeout(project, monkeypatch):
    import asyncio
    store, pid, session = project
    item, _ = media(project)
    canvas = CreationCanvas(store)
    states = [{'status': 'running', 'revision': 1}, {'status': 'succeeded', 'revision': 2}]
    monkeypatch.setattr(canvas, 'item_status', lambda *args: states.pop(0) if len(states) > 1 else states[0])
    result = asyncio.run(canvas.wait_item_status(pid, item.id, 2))
    assert result['status'] == 'succeeded'
    monkeypatch.setattr(canvas, 'item_status', lambda *args: {'status': 'running'})
    assert asyncio.run(canvas.wait_item_status(pid, item.id, .01)) == {'status': 'running'}


@pytest.mark.parametrize('binding', ['follow_current', 'pinned'])
def test_canvas_reference_sources_create_a_connected_video_node(project, binding):
    store, pid, session = project
    assets = CreationAssets(store)
    image = BytesIO()
    Image.new('RGB', (16, 16), 'blue').save(image, 'PNG')
    handle = uuid4()
    writer = assets.uploads.begin(pid, handle, session, 'reference.png', expected_kind='image')
    writer.write(image.getvalue())
    writer.finish()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=handle,
        name='reference.png', expectedKind='image').status == 'applied'
    asset = store.snapshot(pid).assets[-1]
    source_id = uuid4()
    assert send(store, pid, 'canvas.show', session=session, item=dict(id=source_id,
        projectId=pid, kind='image', binding=dict(role='material', objectRef=asset_ref(asset)))).status == 'applied'
    canvas = CreationCanvas(store)
    before = store.snapshot(pid)
    sources = canvas.item_status(pid, source_id)['referenceSources']
    assert store.snapshot(pid) == before
    spec_id, target_id, ref_id = uuid4(), uuid4(), uuid4()
    source = sources['followCurrent'] if binding == 'follow_current' else sources['pinned']
    receipt = send(store, pid, 'canvas.createGeneration', session=session,
        spec=dict(id=spec_id, projectId=pid, kind='video', purpose='generation', prompt='Animate the reference',
            parameters=dict(durationSeconds=5, videoMode='reference')),
        item=dict(id=target_id, projectId=pid, kind='video',
            binding=dict(role='generation', objectRef=dict(id=spec_id))),
        references=[dict(id=ref_id, projectId=pid, targetSpecId=spec_id, **source)])
    assert receipt.status == 'applied', receipt.issues
    projection = canvas.projection(pid)
    assert projection['edges'] == [dict(referenceId=ref_id, sourceItemId=source_id,
        targetSpecId=spec_id, state='pending')]
    current = store.snapshot(pid)
    assert next(item for item in current.canvasItems if item.id == target_id).visible
    assert not current.jobs
    pinned = current.references[0].source if binding == 'pinned' else None
    assert resolved_inputs(current, spec_id)[0].asset.assetId == asset.id
    assert canvas.item_status(pid, target_id)['referenceSources'] is None
    if pinned is not None:
        assert pinned == asset_ref(asset)


@pytest.mark.parametrize('size', [(600, 600), (600, 900), (900, 600)])
@pytest.mark.parametrize('explicit', [False, True])
def test_material_show_uses_media_ratio_unless_size_authored(project, size, explicit):
    store, pid, session = project
    image = BytesIO()
    Image.new('RGB', size, 'blue').save(image, 'PNG')
    handle = uuid4()
    writer = CreationAssets(store).uploads.begin(pid, handle, session, 'image.png', expected_kind='image')
    writer.write(image.getvalue())
    writer.finish()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=handle,
        name='image.png', expectedKind='image').status == 'applied'
    asset = store.snapshot(pid).assets[-1]
    item_id = uuid4()
    item = dict(id=item_id, projectId=pid, kind='image', binding=dict(role='material', objectRef=asset_ref(asset)))
    if explicit:
        item.update(width=400, height=200)
    assert send(store, pid, 'canvas.show', session=session, item=item).status == 'applied'
    saved = next(item for item in store.snapshot(pid).canvasItems if item.id == item_id)
    if explicit:
        assert (saved.width, saved.height) == (400, 200)
    else:
        assert saved.width / saved.height == pytest.approx(size[0] / size[1], abs=.005)
        assert max(saved.width, saved.height) == 352
    reloaded = CreationProjects(LocalProjects(store.local.repository))
    restored = next(item for item in reloaded.snapshot(pid).canvasItems if item.id == item_id)
    assert (restored.width, restored.height) == (saved.width, saved.height)
    assert restored.binding.objectRef == asset_ref(asset)
