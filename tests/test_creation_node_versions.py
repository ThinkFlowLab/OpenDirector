"""Full historical adoption restores one editable transaction, never execution facts."""
import asyncio
from copy import deepcopy
from uuid import uuid4

import pytest

from opendirector.application.creation_canvas import asset_ref, resolved_inputs
from opendirector.application.creation_history import CreationHistory
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import object_index
from test_creation_canvas_service import project, media, send, text_material, ver
from test_creation_generation_service import Provider, runtime, configure, anyio_backend


def versions(snapshot):
    return [ver(kind, obj) for (kind, _), obj in object_index(snapshot).items()]


def apply(store, pid, session, target, asset, policy='follow_current', expected=None):
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='canvas.applyVersion',
        expectedVersions=expected or versions(store.snapshot(pid)),
        payload=dict(itemId=target.id, asset=asset_ref(asset), referencePolicy=policy)))
    return command, store.execute(command, session=session)


async def generated(project):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    source, original = text_material(project)
    target, spec = configure(project, config)
    ref_id = uuid4()
    assert send(store, pid, 'reference.add', session=session, versions=versions(store.snapshot(pid)),
        reference=dict(id=ref_id, projectId=pid, targetSpecId=spec.id, binding='follow_current', source=dict(id=source.id))).status == 'applied'
    content = [dict(type='text', text='Before '), dict(type='reference', referenceId=ref_id),
               dict(type='text', text=' after '), dict(type='reference', referenceId=ref_id)]
    assert send(store, pid, 'generationSpec.setPrompt', session=session, versions=versions(store.snapshot(pid)),
        specId=spec.id, prompt='', promptContent=content).status == 'applied'
    spec = store.snapshot(pid).generationSpecs[-1]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=versions(store.snapshot(pid)),
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
    provider.finish.set()
    receipt = await runner.execute(command, session=session)
    assert receipt.status == 'accepted', receipt
    await asyncio.wait_for(provider.started.wait(), 3)
    await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
    await runner.close()
    state = store.snapshot(pid)
    assert state.jobs[-1].status == 'succeeded'
    return source, original, target, spec, ref_id, state.assets[-1], config


@pytest.mark.anyio
async def test_full_apply_uses_actual_inputs_with_hidden_follow_sources_and_atomic_undo_redo(project):
    store, pid, session = project
    source, original, target, spec, ref_id, output, _ = await generated(project)
    assert not CreationHistory(store).node_versions(pid, target.id)['versions'][0]['currentReferencesDiffer']
    frozen = deepcopy(store.snapshot(pid).jobs)
    assert send(store, pid, 'asset.writeText', session=session, versions=versions(store.snapshot(pid)), name='v2.md', text='New source', previousAsset=asset_ref(original)).status == 'applied'
    newer = store.snapshot(pid).assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=versions(store.snapshot(pid)), itemId=source.id, asset=asset_ref(newer)).status == 'applied'
    assert send(store, pid, 'canvas.hide', session=session, versions=versions(store.snapshot(pid)), itemId=source.id).status == 'applied'
    assert send(store, pid, 'reference.remove', session=session, versions=versions(store.snapshot(pid)), referenceId=ref_id).status == 'applied'
    assert send(store, pid, 'generationSpec.setPrompt', session=session, versions=versions(store.snapshot(pid)), specId=spec.id, prompt='New draft').status == 'applied'
    before = store.snapshot(pid)
    assert CreationHistory(store).node_versions(pid, target.id)['versions'][0]['currentReferencesDiffer']
    command, receipt = apply(store, pid, session, target, output)
    assert receipt.status == 'applied', receipt
    assert store.execute(command, session=session) == receipt
    after = store.snapshot(pid)
    assert after.jobs == frozen
    assert after.generationSpecs[-1].promptContent == frozen[0].inputSnapshot.spec.promptContent
    assert resolved_inputs(after, spec.id)[0].asset.assetId == newer.id
    assert after.references[0].id == ref_id and after.references[0].active
    assert not after.canvasItems[0].visible
    assert send(store, pid, 'history.undo', session=session, versions=versions(after), targetCommandId=command.commandId).status == 'applied'
    undone = store.snapshot(pid)
    assert undone.generationSpecs[-1].prompt == before.generationSpecs[-1].prompt
    assert not undone.references[0].active
    assert send(store, pid, 'history.redo', session=session, versions=versions(undone), targetCommandId=command.commandId).status == 'applied'
    assert store.snapshot(pid).jobs == frozen


@pytest.mark.anyio
async def test_pin_apply_uses_frozen_assets_and_rejects_tampering_without_partial_writes(project):
    store, pid, session = project
    source, original, target, spec, _, output, _ = await generated(project)
    assert send(store, pid, 'asset.writeText', session=session, versions=versions(store.snapshot(pid)), name='v2.md', text='new', previousAsset=asset_ref(original)).status == 'applied'
    newer = store.snapshot(pid).assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=versions(store.snapshot(pid)), itemId=source.id, asset=asset_ref(newer)).status == 'applied'
    _, receipt = apply(store, pid, session, target, output, 'pinned')
    assert receipt.status == 'applied', receipt
    state = store.snapshot(pid)
    assert state.references[0].binding == 'pinned'
    assert resolved_inputs(state, spec.id)[0].asset.assetId == original.id
    (store.root / 'Unified' / original.path).write_bytes(b'tampered')
    _, receipt = apply(store, pid, session, target, output, 'pinned')
    assert receipt.status == 'rejected'
    assert store.snapshot(pid) == state
    assert not CreationHistory(store).reference_catalog(pid)[0]['available']


@pytest.mark.anyio
async def test_missing_model_remains_evidence_and_foreign_stale_locked_versions_are_rejected(project):
    store, pid, session = project
    _, _, target, _, _, output, config = await generated(project)
    from opendirector.infrastructure.model_configs import ModelConfigs
    ModelConfigs(store.local.repository).delete(config['id'])
    history = CreationHistory(store)
    rows = history.node_versions(pid, target.id)['versions']
    assert rows[0]['inputSnapshot'] and rows[0]['modelAvailable'] is False
    _, receipt = apply(store, pid, session, target, output)
    assert receipt.status == 'applied', receipt
    assert store.snapshot(pid).generationSpecs[-1].modelConfigId is None
    assert store.snapshot(pid).jobs[0].inputSnapshot.model.modelConfigId is not None
    unrelated, foreign = text_material(project, title='Foreign')
    before = store.snapshot(pid)
    assert apply(store, pid, session, target, foreign)[1].status == 'rejected'
    assert apply(store, pid, session, target, output, expected=[ver('canvas_item', target)])[1].status == 'rejected'
    assert store.snapshot(pid) == before
    assert send(store, pid, 'canvas.update', session=session, versions=versions(before), itemId=target.id, locked=True).status == 'applied'
    before = store.snapshot(pid)
    assert apply(store, pid, session, target, output)[1].status == 'rejected'
    assert store.snapshot(pid) == before


def test_manual_versions_query_hidden_family_and_apply_without_inventing_jobs(project):
    store, pid, session = project
    target, original = text_material(project)
    assert send(store, pid, 'asset.writeText', session=session, versions=versions(store.snapshot(pid)), name='v2.md', text='v2', previousAsset=asset_ref(original)).status == 'applied'
    newer = store.snapshot(pid).assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=versions(store.snapshot(pid)), itemId=target.id, asset=asset_ref(newer)).status == 'applied'
    assert send(store, pid, 'canvas.hide', session=session, versions=versions(store.snapshot(pid)), itemId=target.id).status == 'applied'
    history = CreationHistory(store)
    rows = history.node_versions(pid, target.id)['versions']
    assert {row['asset'].id for row in rows} == {original.id, newer.id}
    assert all(row['inputSnapshot'] is None for row in rows)
    assert apply(store, pid, session, target, original)[1].status == 'applied'
    snapshot = store.snapshot(pid)
    assert snapshot.canvasItems[0].binding.objectRef.assetId == original.id
    assert not snapshot.canvasItems[0].visible and not snapshot.jobs
    catalog = history.reference_catalog(pid)
    assert next(row for row in catalog if row['id'] == str(original.id))['available']
    assert not next(row for row in catalog if row['id'] == str(newer.id))['available']


@pytest.mark.anyio
async def test_active_job_blocks_version_application_and_pin_subject_expansion_keeps_roles(project):
    from io import BytesIO
    from PIL import Image
    from uuid import UUID
    from opendirector.application.creation_assets import CreationAssets
    from opendirector.infrastructure.model_configs import ModelConfigs
    store, pid, session = project
    provider = Provider()
    runner, _ = runtime(project, provider)
    main, auxiliary = [], []
    image_bytes = b''
    for color, destination in [('red', main), ('blue', auxiliary)]:
        buffer = BytesIO()
        Image.new('RGB', (32, 32), color).save(buffer, 'PNG')
        image_bytes = buffer.getvalue()
        handle = uuid4()
        writer = CreationAssets(store).uploads.begin(pid, handle, session, 'subject.png', expected_kind='image')
        writer.write(image_bytes)
        writer.finish()
        assert send(store, pid, 'asset.import', session=session, uploadHandle=handle, name='subject.png', expectedKind='image').status == 'applied'
        destination.append(store.snapshot(pid).assets[-1])
    doc_id, source_id = uuid4(), uuid4()
    assert send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=dict(id=doc_id, projectId=pid, kind='subject', data=dict(main=asset_ref(main[0]), auxiliaries=[asset_ref(auxiliary[0])])))),
        dict(type='canvas.show', payload=dict(item=dict(id=source_id, projectId=pid, kind='subject', binding=dict(role='editor', objectRef=dict(id=doc_id, kind='subject')))))
    ]).status == 'applied'
    config = ModelConfigs(store.local.repository).save('image', 'http://127.0.0.1:12345/v1', 'test-image', '', connection_type='self_hosted', protocol='openai', auth_mode='none')
    target, spec = media(project, 'image')
    assert send(store, pid, 'generationSpec.update', session=session, versions=versions(store.snapshot(pid)), spec=spec.model_copy(update={'prompt': 'Image', 'modelConfigId': UUID(config['id'])})).status == 'applied'
    ref_id = uuid4()
    assert send(store, pid, 'reference.add', session=session, versions=versions(store.snapshot(pid)), reference=dict(id=ref_id, projectId=pid, targetSpecId=spec.id, source=dict(id=source_id), binding='follow_current')).status == 'applied'
    assert send(store, pid, 'generationSpec.setPrompt', session=session, versions=versions(store.snapshot(pid)), specId=spec.id, prompt='', promptContent=[dict(type='reference', referenceId=ref_id), dict(type='text', text=' image'), dict(type='reference', referenceId=ref_id)]).status == 'applied'
    async def generate(config, task, submitted):
        provider.started.set()
        await provider.finish.wait()
        return 'png', image_bytes
    provider.generate = generate
    spec = store.snapshot(pid).generationSpecs[-1]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit', expectedVersions=versions(store.snapshot(pid)), payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
    assert (await runner.execute(command, session=session)).status == 'accepted'
    provider.finish.set()
    await asyncio.wait_for(provider.started.wait(), 3)
    await asyncio.gather(*(j.future for j in list(runner.jobs.values())))
    output = store.snapshot(pid).assets[-1]
    frozen = store.snapshot(pid).jobs[0]
    assert frozen.status == 'succeeded'
    _, receipt = apply(store, pid, session, target, output, 'pinned')
    assert receipt.status == 'applied', receipt
    state = store.snapshot(pid)
    active = [r for r in state.references if r.active]
    assert {r.subjectRole for r in active} == {'main', 'auxiliary'}
    from opendirector.application.creation_canvas import reference_evidence
    assert all(r.sourceVersion.id == source_id for r in active)
    assert all(reference_evidence(state, state.generationSpecs[-1], r) == 'used' for r in active)
    assert len(state.generationSpecs[-1].promptContent) == 5  # Both occurrences expand.
    assert state.jobs[0] == frozen
    # A second accepted task holds the node until its actual outcome is settled.
    provider.started.clear()
    provider.finish.clear()
    spec = state.generationSpecs[-1]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit', expectedVersions=versions(state), payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
    assert (await runner.execute(command, session=session)).status == 'accepted'
    await asyncio.wait_for(provider.started.wait(), 3)
    before = store.snapshot(pid)
    assert apply(store, pid, session, target, output)[1].status == 'rejected'
    assert store.snapshot(pid) == before
    provider.finish.set()
    await asyncio.gather(*(j.future for j in list(runner.jobs.values())))
    await runner.close()


@pytest.mark.anyio
async def test_pinned_history_retains_source_edges_and_does_not_rewrite_neighbors(project):
    from opendirector.application.creation_canvas import CreationCanvas, reference_evidence
    store, pid, session = project
    source, original, target, spec, ref_id, output, _ = await generated(project)
    assert send(store, pid, 'asset.writeText', session=session, versions=versions(store.snapshot(pid)), name='new.md', text='changed', previousAsset=asset_ref(original)).status == 'applied'
    newer = store.snapshot(pid).assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=versions(store.snapshot(pid)), itemId=source.id, asset=asset_ref(newer)).status == 'applied'
    before = store.snapshot(pid)
    command, receipt = apply(store, pid, session, target, output, 'pinned')
    assert receipt.status == 'applied'
    state = store.snapshot(pid)
    pin = next(r for r in state.references if r.id == ref_id)
    assert pin.sourceVersion.id == source.id
    assert resolved_inputs(state, spec.id)[0].asset.assetId == original.id
    assert state.canvasItems[0] == before.canvasItems[0]
    assert state.jobs == before.jobs and state.results == before.results
    assert reference_evidence(state, state.generationSpecs[-1], pin) == 'pending'
    edge = next(e for e in CreationCanvas(store).projection(pid)['edges'] if e['referenceId'] == ref_id)
    assert edge['sourceItemId'] == source.id
    assert send(store, pid, 'canvas.hide', session=session, versions=versions(state), itemId=source.id).status == 'applied'
    assert resolved_inputs(store.snapshot(pid), spec.id)[0].asset.assetId == original.id
    assert apply(store, pid, session, source, original)[1].status == 'applied'
    state = store.snapshot(pid)
    assert reference_evidence(state, state.generationSpecs[-1], pin) == 'used'
    assert state.jobs == before.jobs


def test_version_counts_include_manual_history_but_not_layout_or_reapplication(project, monkeypatch):
    store, pid, session = project
    node, first = text_material(project)
    assert send(store, pid, 'asset.writeText', session=session, versions=versions(store.snapshot(pid)), name='two.md', text='two', previousAsset=asset_ref(first)).status == 'applied'
    second = store.snapshot(pid).assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=versions(store.snapshot(pid)), itemId=node.id, asset=asset_ref(second)).status == 'applied'
    assert apply(store, pid, session, node, first)[1].status == 'applied'
    assert send(store, pid, 'canvas.hide', session=session, versions=versions(store.snapshot(pid)), itemId=node.id).status == 'applied'
    history = CreationHistory(store)
    from opendirector.application.creation_assets import CreationAssets
    monkeypatch.setattr(CreationAssets, 'open_media', lambda *args: pytest.fail('counts must not read media'))
    counts = history.version_counts(pid)
    assert counts['counts'][str(node.id)] == 2
    assert counts['eventCursor'] == store.snapshot(pid).eventCursor


@pytest.mark.anyio
async def test_restore_changes_outgoing_evidence_without_mutating_downstream(project):
    from opendirector.application.creation_canvas import reference_evidence
    store, pid, session = project
    _, _, target, _, _, output, config = await generated(project)
    provider = Provider()
    runner, _ = runtime(project, provider)
    downstream, downstream_spec = configure(project, config)
    ref_id = uuid4()
    assert send(store, pid, 'reference.add', session=session, versions=versions(store.snapshot(pid)),
        reference=dict(id=ref_id, projectId=pid, targetSpecId=downstream_spec.id, binding='follow_current', source=dict(id=target.id))).status == 'applied'
    downstream_spec = store.snapshot(pid).generationSpecs[-1]
    provider.finish.set()
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=versions(store.snapshot(pid)), payload=dict(specId=downstream_spec.id,
        expectedSpecRevision=downstream_spec.revision, originItemId=downstream.id)))
    assert (await runner.execute(command, session=session)).status == 'accepted'
    await asyncio.wait_for(provider.started.wait(), 3)
    await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
    await runner.close()
    assert send(store, pid, 'asset.writeText', session=session, versions=versions(store.snapshot(pid)), name='edited.md', text='new local text', previousAsset=asset_ref(output)).status == 'applied'
    changed_asset = store.snapshot(pid).assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=versions(store.snapshot(pid)), itemId=target.id, asset=asset_ref(changed_asset), discardGenerationDraft=True).status == 'applied'
    before = store.snapshot(pid)
    ref = next(ref for ref in before.references if ref.id == ref_id)
    spec = next(spec for spec in before.generationSpecs if spec.id == downstream_spec.id)
    assert reference_evidence(before, spec, ref) == 'pending'
    command, receipt = apply(store, pid, session, target, output, 'pinned')
    assert receipt.status == 'applied'
    after = store.snapshot(pid)
    assert next(item for item in after.canvasItems if item.id == downstream.id) == next(item for item in before.canvasItems if item.id == downstream.id)
    assert next(item for item in after.generationSpecs if item.id == spec.id) == spec
    assert next(item for item in after.references if item.id == ref_id) == ref
    assert after.jobs == before.jobs and after.results == before.results
    assert reference_evidence(after, spec, ref) == 'used'
    undo = send(store, pid, 'history.undo', session=session, versions=versions(after), targetCommandId=command.commandId)
    assert undo.status == 'applied', undo
    assert reference_evidence(store.snapshot(pid), spec, ref) == 'pending'

@pytest.mark.anyio
async def test_follow_history_next_execution_uses_current_source_and_keeps_old_execution(project):
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.infrastructure.model_configs import ModelConfigs
    from opendirector.application.creation_node_versions import current_references_differ
    store, pid, session = project
    source, original, target, spec, _, output, _ = await generated(project)
    old_job = store.snapshot(pid).jobs[0]
    # Presentation-only changes do not trigger a reference-content warning.
    moved = store.snapshot(pid).model_copy(update={'canvasItems': tuple(
        item.model_copy(update={'title': 'Renamed', 'revision': item.revision + 1}) if item.id == source.id else item
        for item in store.snapshot(pid).canvasItems)})
    assert not current_references_differ(moved, old_job.inputSnapshot)
    assert send(store, pid, 'asset.writeText', session=session, versions=versions(store.snapshot(pid)),
        name='new.md', text='Current canvas reference', previousAsset=asset_ref(original)).status == 'applied'
    newer = store.snapshot(pid).assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=versions(store.snapshot(pid)),
        itemId=source.id, asset=asset_ref(newer)).status == 'applied'
    assert apply(store, pid, session, target, output)[1].status == 'applied'
    assert current_references_differ(store.snapshot(pid), old_job.inputSnapshot)
    assert store.snapshot(pid).jobs[0] == old_job
    provider = Provider()
    provider.finish.set()
    runner = CreationGeneration(store, ModelConfigs(store.local.repository), provider)
    try:
        current = next(value for value in store.snapshot(pid).generationSpecs if value.id == spec.id)
        command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
            expectedVersions=versions(store.snapshot(pid)),
            payload=dict(specId=spec.id, expectedSpecRevision=current.revision, originItemId=target.id)))
        assert (await runner.execute(command, session=session)).status == 'accepted'
        await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
        latest = store.snapshot(pid).jobs[-1]
        assert latest.status == 'succeeded'
        assert latest.inputSnapshot.references[0].asset.assetId == newer.id
        assert store.snapshot(pid).jobs[0] == old_job
        assert not current_references_differ(store.snapshot(pid), latest.inputSnapshot)
    finally:
        await runner.close()


def test_listing_scans_shared_records_without_copying_or_exposing_them(project, monkeypatch):
    store, pid, session = project
    node, first = text_material(project)
    assert send(store, pid, 'asset.writeText', session=session, versions=versions(store.snapshot(pid)),
        name='second.md', text='second', previousAsset=asset_ref(first)).status == 'applied'
    second = store.snapshot(pid).assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=versions(store.snapshot(pid)),
        itemId=node.id, asset=asset_ref(second)).status == 'applied'
    before = [record.model_dump_json() for record in store.records(pid)]
    # history() deep-copies every commit; long projects took seconds per dialog open.
    monkeypatch.setattr(store, 'history', lambda *args: pytest.fail('listing must not copy every commit'))
    listing = CreationHistory(store).node_versions(pid, node.id)
    assert {row['asset'].id for row in listing['versions']} == {first.id, second.id}
    shared = store.records(pid)[0].snapshot
    shared_objects = {id(asset) for asset in shared.assets} | {id(item) for item in shared.canvasItems}
    assert id(listing['item']) not in shared_objects
    assert not {id(row['asset']) for row in listing['versions']} & shared_objects
    assert [record.model_dump_json() for record in store.records(pid)] == before


def test_listing_and_counts_load_history_once_and_recheck_changed_files(project, monkeypatch):
    store, pid, session = project
    node, first = text_material(project)
    assert send(store, pid, 'asset.writeText', session=session, versions=versions(store.snapshot(pid)),
        name='second.md', text='second', previousAsset=asset_ref(first)).status == 'applied'
    second = store.snapshot(pid).assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=versions(store.snapshot(pid)),
        itemId=node.id, asset=asset_ref(second)).status == 'applied'
    history = CreationHistory(store)
    original = store._history
    calls = []
    def read(*args):
        calls.append(1)
        return original(*args)
    monkeypatch.setattr(store, '_history', read)
    listing = history.node_versions(pid, node.id)
    assert len(calls) == 1
    assert all(row['available'] for row in listing['versions'])
    calls.clear()
    history.version_counts(pid)
    assert len(calls) == 1
    # A warm verification cache cannot hide replacement or missing media.
    path = store.root / 'Unified' / first.path
    path.write_bytes(b'changed')
    calls.clear()
    listing = history.node_versions(pid, node.id)
    assert len(calls) == 1
    assert not next(row for row in listing['versions'] if row['asset'].id == first.id)['available']
    path.unlink()
    assert not next(row for row in history.node_versions(pid, node.id)['versions'] if row['asset'].id == first.id)['available']
