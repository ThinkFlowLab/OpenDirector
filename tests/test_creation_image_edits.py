"""Generated image -> published layers -> reopen, selection and race protection."""
import asyncio
from io import BytesIO
from uuid import UUID, uuid4

import pytest
from PIL import Image

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref, current_asset
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from test_creation_canvas_service import project, media, send, ver
from test_creation_generation_service import Provider, anyio_backend
from test_creation_node_versions import versions


pytestmark = pytest.mark.cpu


def png(color):
    out = BytesIO()
    Image.new('RGB', (64, 64), color).save(out, 'PNG')
    return out.getvalue()


class ImageProvider(Provider):
    async def generate(self, config, task, submitted):
        self.calls.append(task)
        self.started.set()
        await self.finish.wait()
        return 'png', png('purple')


async def generated(project):
    store, pid, session = project
    provider = ImageProvider()
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', 'http://127.0.0.1:12345/v1', 'test-image', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none')
    runner = CreationGeneration(store, configs, provider)
    item, spec = media(project, 'image')
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)],
        spec=spec.model_copy(update={'prompt': 'A purple square', 'modelConfigId': UUID(config['id'])})).status == 'applied'
    provider.finish.set()
    await submit(project, runner)
    await asyncio.gather(*(j.future for j in list(runner.jobs.values())))
    assert store.snapshot(pid).jobs[0].status == 'succeeded'
    return runner, provider


async def submit(project, runner):
    store, pid, session = project
    before = store.snapshot(pid)
    spec, item = before.generationSpecs[0], before.canvasItems[0]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit', expectedVersions=versions(before),
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
    assert (await runner.execute(command, session=session)).status == 'accepted'


def edit_command(project, *, color='red'):
    store, pid, session = project
    assets = CreationAssets(store)
    handle = uuid4()
    writer = assets.uploads.begin(pid, handle, session, 'edited.png')
    writer.write(png(color))
    writer.finish()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=handle, name='edited.png', expectedKind='image').status == 'applied'
    before = store.snapshot(pid)
    item = before.canvasItems[0]
    source = current_asset(before, item)
    output = before.assets[-1]
    old = before.editorDocuments[0] if before.editorDocuments else None
    document = old.model_dump(mode='json') if old else dict(id=uuid4(), projectId=pid, kind='layers', data=dict(width=64, height=64, layers=[
        dict(id='original', name='Original', width=64, height=64,
            content=dict(kind='image', width=64, height=64, asset=asset_ref(source)))]))
    document['data']['background'] = '#ff0000' if color == 'red' else '#0000ff'
    operations = [dict(type='editor.save' if old else 'editor.create', payload=dict(document=document))]
    if not item.editors:
        operations.append(dict(type='canvas.attachEditor', payload=dict(itemId=item.id, editorId=document['id'])))
    operations.append(dict(type='canvas.applyEdit', payload=dict(itemId=item.id, editorId=document['id'], source=asset_ref(source), asset=asset_ref(output))))
    return parse_command(dict(commandId=uuid4(), projectId=pid, type='creation.batch', expectedVersions=versions(before), payload=dict(operations=operations)))


@pytest.mark.anyio
async def test_generated_image_edit_roundtrip_replay_selection_and_undo(project):
    store, pid, session = project
    runner, _ = await generated(project)
    try:
        original = store.snapshot(pid)
        command = edit_command(project)
        receipt = store.execute(command, session=session)
        assert receipt.status == 'applied', receipt
        assert store.execute(command, session=session) == receipt
        after = store.snapshot(pid)
        item = after.canvasItems[0]
        output = current_asset(after, item)
        assert item.binding.role == 'generation'
        assert after.jobs == original.jobs and after.results == original.results
        assert after.generationSpecs == original.generationSpecs
        assert output.provenance.source == 'edited'
        assert output.provenance.sources[0].assetId == original.assets[0].id
        assert output.provenance.editorRevision == after.editorDocuments[0].revision == 1
        restarted = CreationProjects(LocalProjects(store.local.repository))
        assert restarted.snapshot(pid) == after
        second = edit_command(project, color='blue')
        assert store.execute(second, session=session).status == 'applied'
        again = store.snapshot(pid)
        assert current_asset(again, again.canvasItems[0]).provenance.editorRevision == 2
        assert again.editorDocuments[0].id == after.editorDocuments[0].id
        selected = send(store, pid, 'result.select', session=session, versions=versions(again), specId=again.generationSpecs[0].id, resultId=original.results[0].id)
        assert selected.status == 'applied', selected
        chosen = store.snapshot(pid)
        assert current_asset(chosen, chosen.canvasItems[0]).id == original.assets[0].id
        assert not chosen.canvasItems[0].editors
        assert send(store, pid, 'history.undo', session=session, versions=versions(chosen), targetCommandId=selected.commandId).status == 'applied'
        undone = store.snapshot(pid)
        assert undone.canvasItems[0].editors == again.canvasItems[0].editors
        assert current_asset(undone, undone.canvasItems[0]).id == current_asset(again, again.canvasItems[0]).id
        # Explicit historical adoption restores the matching editable structure.
        restored = send(store, pid, 'canvas.applyVersion', session=session, versions=versions(undone),
            itemId=item.id, asset=asset_ref(output))
        assert restored.status == 'applied', restored
        historical = store.snapshot(pid)
        assert current_asset(historical, historical.canvasItems[0]).id == output.id
        assert historical.editorDocuments[0].data == after.editorDocuments[0].data
        assert historical.jobs == original.jobs and historical.results == original.results
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_pending_generation_cannot_replace_a_later_image_edit(project):
    store, pid, session = project
    runner, provider = await generated(project)
    try:
        provider.finish.clear()
        provider.started.clear()
        await submit(project, runner)
        await provider.started.wait()
        command = edit_command(project)
        receipt = store.execute(command, session=session)
        assert receipt.status == 'applied', receipt
        edited = store.snapshot(pid)
        provider.finish.set()
        await asyncio.gather(*(j.future for j in list(runner.jobs.values())))
        after = store.snapshot(pid)
        assert after.jobs[-1].status == 'succeeded' and not after.jobs[-1].adopted
        assert current_asset(after, after.canvasItems[0]).id == current_asset(edited, edited.canvasItems[0]).id
        assert after.canvasItems[0].editors == edited.canvasItems[0].editors
    finally:
        provider.finish.set()
        await runner.close()


@pytest.mark.anyio
async def test_stale_locked_or_reused_edit_is_rejected_atomically(project):
    store, pid, session = project
    runner, _ = await generated(project)
    try:
        command = edit_command(project)
        before = store.snapshot(pid)
        item = before.canvasItems[0]
        # Plain replacement remains forbidden for generation nodes.
        assert send(store, pid, 'canvas.materialize', session=session, versions=versions(before), itemId=item.id,
            asset=asset_ref(before.assets[-1]), discardGenerationDraft=True).status == 'rejected'
        assert send(store, pid, 'canvas.update', session=session, versions=versions(before), itemId=item.id, locked=True).status == 'applied'
        locked = store.snapshot(pid)
        assert store.execute(command, session=session).status == 'rejected'
        fresh = parse_command({**command.model_dump(), 'commandId': uuid4(), 'expectedVersions': versions(locked)})
        assert store.execute(fresh, session=session).status == 'rejected'
        assert store.snapshot(pid) == locked
        assert send(store, pid, 'canvas.update', session=session, versions=versions(locked), itemId=item.id, locked=False).status == 'applied'
        fresh = parse_command({**command.model_dump(), 'commandId': uuid4(), 'expectedVersions': versions(store.snapshot(pid))})
        assert store.execute(fresh, session=session).status == 'applied'
        published = store.snapshot(pid)
        reused = parse_command({**fresh.model_dump(), 'commandId': uuid4(), 'expectedVersions': versions(published)})
        assert store.execute(reused, session=session).status == 'rejected'
        assert store.snapshot(pid) == published
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_direct_edit_requires_document_version_and_available_output(project):
    store, pid, session = project
    runner, _ = await generated(project)
    try:
        batch = edit_command(project)
        operations = batch.payload.operations
        assert send(store, pid, 'creation.batch', session=session, versions=versions(store.snapshot(pid)),
            operations=[op.model_dump() for op in operations[:-1]]).status == 'applied'
        before = store.snapshot(pid)
        payload = operations[-1].payload
        with pytest.raises(ValueError):
            parse_command(dict(commandId=uuid4(), projectId=pid, type='canvas.applyEdit',
                expectedVersions=[v for v in versions(before) if v['objectType'] != 'editor_document'],
                payload=payload.model_dump()))
        wrong_source = {**payload.model_dump(), 'source': payload.asset}
        assert send(store, pid, 'canvas.applyEdit', session=session, versions=versions(before), **wrong_source).status == 'rejected'
        assert store.snapshot(pid) == before
        # Missing output files are rejected without publishing or changing provenance.
        asset = next(a for a in before.assets if a.id == payload.asset.assetId)
        stream, _ = CreationAssets(store).open_media(pid, asset.id)
        path = store.root / before.project.name / asset.path
        stream.close()
        content = path.read_bytes()
        path.unlink()
        rejected = send(store, pid, 'canvas.applyEdit', session=session, versions=versions(before), **payload.model_dump())
        assert rejected.status == 'rejected'
        assert store.snapshot(pid) == before
        path.write_bytes(content)
        applied = send(store, pid, 'canvas.applyEdit', session=session, versions=versions(before), **payload.model_dump())
        assert applied.status == 'applied', applied
    finally:
        await runner.close()

@pytest.mark.anyio
@pytest.mark.parametrize('changed', ['parent_lock', 'item_revision'])
async def test_hidden_result_edit_rechecks_original_version_and_current_parent_lock_on_save(project, changed):
    store, pid, session = project
    runner, _ = await generated(project)
    try:
        item_id = store.snapshot(pid).canvasItems[0].id
        parent_id = uuid4()
        assert send(store, pid, 'creation.batch', session=session, versions=versions(store.snapshot(pid)), operations=[
            dict(type='canvas.show', payload=dict(item=dict(id=parent_id, kind='group', projectId=pid))),
            dict(type='canvas.update', payload=dict(itemId=item_id, parentId=parent_id)),
            dict(type='canvas.hide', payload=dict(itemId=item_id)),
            dict(type='canvas.hide', payload=dict(itemId=parent_id)),
        ]).status == 'applied'
        edit = edit_command(project)
        # The modal pins its item and asset versions; the ancestor is checked by
        # the service at commit even though its version is absent from the draft.
        edit = parse_command({**edit.model_dump(), 'expectedVersions':
                              [v for v in edit.expectedVersions if v.id != parent_id]})
        patch = dict(itemId=parent_id, locked=True) if changed == 'parent_lock' else dict(itemId=item_id, title='Renamed')
        assert send(store, pid, 'canvas.update', session=session, versions=versions(store.snapshot(pid)), **patch).status == 'applied'
        before = store.snapshot(pid)
        receipt = store.execute(edit, session=session)
        assert receipt.status == 'rejected'
        assert receipt.issues[0].code == ('role_restricted' if changed == 'parent_lock' else 'revision_conflict')
        assert store.snapshot(pid) == before
        assert all(not item.visible for item in before.canvasItems)
        assert not before.editorDocuments
    finally:
        await runner.close()
