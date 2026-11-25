"""Crop documents and copies preserve source identities and independent edits."""
import asyncio
from uuid import uuid4

import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref, current_asset
from opendirector.application.creation_history import CreationHistory
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.editors import ImageCropOptions
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from test_creation_canvas_service import project, send
from test_creation_generation_service import anyio_backend
from test_creation_image_edits import generated, png
from test_creation_node_versions import versions


pytestmark = pytest.mark.cpu


def crop_command(project, item_id, *, brightness=125):
    store, pid, session = project
    assets = CreationAssets(store)
    handle = uuid4()
    writer = assets.uploads.begin(pid, handle, session, 'crop.png')
    writer.write(png('red' if brightness == 125 else 'blue'))
    writer.finish()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=handle, name='crop.png', expectedKind='image').status == 'applied'
    snapshot = store.snapshot(pid)
    item = next(i for i in snapshot.canvasItems if i.id == item_id)
    source = current_asset(snapshot, item)
    attached = next((r for r in item.editors if r.kind == 'image_crop'), None)
    old = next((d for d in snapshot.editorDocuments if attached and d.id == attached.id), None)
    doc = dict(id=old.id if old else uuid4(), revision=old.revision if old else 1, projectId=pid, kind='image_crop',
        data=dict(source=old.data.source if old else asset_ref(source), width=64, height=64,
            options=ImageCropOptions(rotation=90, brightness=brightness).model_dump()))
    operations = [dict(type='editor.save' if old else 'editor.create', payload=dict(document=doc))]
    if not attached:
        operations.append(dict(type='canvas.attachEditor', payload=dict(itemId=item.id, editorId=doc['id'])))
    operations.append(dict(type='canvas.applyEdit', payload=dict(itemId=item.id, editorId=doc['id'], source=asset_ref(source), asset=asset_ref(snapshot.assets[-1]))))
    return parse_command(dict(commandId=uuid4(), projectId=pid, type='creation.batch', expectedVersions=versions(snapshot), payload=dict(operations=operations)))


@pytest.mark.anyio
async def test_crop_reopen_recrop_history_and_result_selection(project):
    store, pid, session = project
    runner, _ = await generated(project)
    try:
        original = store.snapshot(pid)
        item = original.canvasItems[0]
        command = crop_command(project, item.id)
        receipt = store.execute(command, session=session)
        assert receipt.status == 'applied', receipt
        assert store.execute(command, session=session) == receipt
        first = store.snapshot(pid)
        assert first.editorDocuments[0].data.source.assetId == original.assets[0].id
        assert first.editorDocuments[0].data.options.brightness == 125
        restarted = CreationProjects(LocalProjects(store.local.repository))
        assert restarted.snapshot(pid) == first
        again = crop_command(project, item.id, brightness=150)
        assert store.execute(again, session=session).status == 'applied'
        second = store.snapshot(pid)
        assert second.editorDocuments[0].id == first.editorDocuments[0].id
        assert second.editorDocuments[0].revision == 2
        assert second.editorDocuments[0].data.source == first.editorDocuments[0].data.source
        assert second.jobs == original.jobs and second.results == original.results
        assert not CreationHistory(store).delete_preview(pid, [original.assets[0].id])['canDelete']
        first_output = current_asset(first, first.canvasItems[0])
        restored = send(store, pid, 'canvas.applyVersion', session=session, versions=versions(second), itemId=item.id, asset=asset_ref(first_output))
        assert restored.status == 'applied', restored
        historical = store.snapshot(pid)
        assert historical.editorDocuments[0].data.options.brightness == 125
        assert historical.canvasItems[0].editors[0].kind == 'image_crop'
        assert send(store, pid, 'result.select', session=session, versions=versions(historical), specId=original.generationSpecs[0].id, resultId=original.results[0].id).status == 'applied'
        selected = store.snapshot(pid)
        assert not selected.canvasItems[0].editors
        assert current_asset(selected, selected.canvasItems[0]).id == original.assets[0].id
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_copied_generation_and_crop_documents_are_independent(project):
    store, pid, session = project
    runner, _ = await generated(project)
    try:
        before = store.snapshot(pid)
        spec_id, copy_id = uuid4(), uuid4()
        spec = before.generationSpecs[0].model_dump(mode='json')
        spec.update(id=str(spec_id), revision=1, currentResultId=None)
        image = before.canvasItems[0].model_dump(mode='json')
        image.update(id=str(copy_id), revision=1,
            binding=dict(role='generation', objectRef=dict(objectType='generation_spec', id=spec_id), materialOverride=asset_ref(before.assets[0])))
        assert send(store, pid, 'creation.batch', session=session, operations=[
            dict(type='generationSpec.create', payload=dict(spec=spec)),
            dict(type='canvas.show', payload=dict(item=image))]).status == 'applied'
        copied = store.snapshot(pid)
        assert current_asset(copied, copied.canvasItems[-1]).id == before.assets[0].id
        assert copied.jobs == before.jobs and copied.results == before.results
        assert store.execute(crop_command(project, copy_id), session=session).status == 'applied'
        edited = store.snapshot(pid)
        assert edited.canvasItems[0] == before.canvasItems[0]
        assert edited.generationSpecs[0] == before.generationSpecs[0]
        assert current_asset(edited, edited.canvasItems[-1]).id != before.assets[0].id
        assert edited.generationSpecs[-1].currentResultId is None
        # A copy may submit its own future generation; it does not borrow a Job.
        copied_spec = next(s for s in edited.generationSpecs if s.id == spec_id)
        submitted = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
            expectedVersions=versions(edited), payload=dict(specId=spec_id,
                expectedSpecRevision=copied_spec.revision, originItemId=copy_id)))
        assert (await runner.execute(submitted, session=session)).status == 'accepted'
        await asyncio.gather(*(j.future for j in list(runner.jobs.values())))
        completed = store.snapshot(pid)
        new_job = next(j for j in completed.jobs if j.originItemId == copy_id)
        assert new_job.status == 'succeeded' and new_job.adopted
        assert completed.canvasItems[0] == before.canvasItems[0]
        assert completed.jobs[0] == before.jobs[0]
        assert not next(i for i in completed.canvasItems if i.id == copy_id).editors
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_crop_rejects_unrelated_source_and_false_geometry_atomically(project):
    store, pid, session = project
    runner, _ = await generated(project)
    try:
        command = crop_command(project, store.snapshot(pid).canvasItems[0].id)
        before = store.snapshot(pid)
        for invalid in ('source', 'width'):
            raw = command.model_dump(mode='json')
            raw['commandId'] = str(uuid4())
            doc = raw['payload']['operations'][0]['payload']['document']['data']
            doc[invalid] = asset_ref(before.assets[-1]).model_dump(mode='json') if invalid == 'source' else 63
            receipt = store.execute(parse_command(raw), session=session)
            assert receipt.status == 'rejected', receipt
            assert store.snapshot(pid) == before
    finally:
        await runner.close()


@pytest.mark.parametrize('options, expected', [
    (dict(rotation=90, aspect='4:3'), (240, 180)),
    (dict(rotation=90, aspect='9:16'), (180, 320)),
    (dict(aspect='free', freeWidth=25, freeHeight=50), (80, 120)),
    (dict(aspect='1:1', zoom=200), (120, 120)),
])
def test_crop_dimensions_follow_rotation_ratio_and_zoom(options, expected):
    assert ImageCropOptions(**options).output_size(320, 240) == expected
