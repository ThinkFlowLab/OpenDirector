"""Inline editing, direct reference commands and history share one relation."""
from uuid import uuid4
import pytest

from test_creation_canvas_service import project, text_material, media, send, ver
from opendirector.application.creation_canvas import resolved_inputs
from opendirector.domain.creation.commands import parse_command


pytestmark = pytest.mark.cpu


def setup_reference(project):
    store, pid, session = project
    source, asset = text_material(project, title='Original')
    target, spec = media(project)
    reference_id = uuid4()
    receipt = send(store, pid, 'creation.batch', session=session,
        versions=[ver('canvas_item', target), ver('generation_spec', spec)], operations=[
        dict(type='reference.add', payload=dict(reference=dict(id=reference_id, projectId=pid, targetSpecId=spec.id,
             binding='follow_current', source=dict(id=source.id)))),
        dict(type='generationSpec.setPrompt', payload=dict(specId=spec.id, prompt='untrusted fallback', promptContent=[
            dict(type='text', text='Before '), dict(type='reference', referenceId=reference_id),
            dict(type='text', text=' between '), dict(type='reference', referenceId=reference_id), dict(type='text', text=' after')]))])
    assert receipt.status == 'applied', receipt
    return source, target, store.snapshot(pid).generationSpecs[-1], store.snapshot(pid).references[-1], asset


def test_inline_repeat_delete_disconnect_and_undo_are_one_business_relationship(project):
    store, pid, session = project
    source, target, spec, ref, asset = setup_reference(project)
    assert spec.prompt == 'Before @Original between @Original after'
    assert len(resolved_inputs(store.snapshot(pid), spec.id)) == 1
    single = list(spec.promptContent)
    del single[3]
    result = send(store, pid, 'generationSpec.setPrompt', session=session, versions=[ver('generation_spec', spec)],
        specId=spec.id, prompt='', promptContent=[part.model_dump(mode='json') for part in single])
    assert result.status == 'applied', result
    assert store.snapshot(pid).references[-1].active
    before = store.snapshot(pid)
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='reference.remove',
        expectedVersions=[ver('reference', before.references[-1]), ver('generation_spec', before.generationSpecs[-1])], payload=dict(referenceId=ref.id)))
    result = store.execute(command, session=session)
    assert result.status == 'applied', result
    removed = store.snapshot(pid)
    assert not removed.references[-1].active
    assert all(part.type == 'text' for part in removed.generationSpecs[-1].promptContent)
    assert removed.generationSpecs[-1].prompt == 'Before  between  after'
    receipt = send(store, pid, 'history.undo', session=session, versions=[ver('reference', removed.references[-1]), ver('generation_spec', removed.generationSpecs[-1])], targetCommandId=command.commandId)
    assert receipt.status == 'applied', receipt
    restored = store.snapshot(pid)
    assert restored.references[-1].active and restored.generationSpecs[-1].promptContent == before.generationSpecs[-1].promptContent


def test_empty_structured_prompt_cannot_fall_back_to_deleted_inline_labels(project):
    store, pid, session = project
    _, _, spec, ref, _ = setup_reference(project)
    result = send(store, pid, 'generationSpec.setPrompt', session=session, versions=[ver('generation_spec', spec)], specId=spec.id,
        prompt='stale label must not survive', promptContent=[])
    assert result.status == 'applied', result
    assert store.snapshot(pid).generationSpecs[-1].prompt == ''
    # An API may retain an unmentioned reference; only an explicit remove edits it.
    assert store.snapshot(pid).references[-1].active


@pytest.mark.parametrize('binding', ['follow_current', 'pinned'])
def test_replacing_a_reference_to_the_same_source_commits_as_one_edit(project, binding):
    store, pid, session = project
    source, _, spec, ref, asset = setup_reference(project)
    if binding == 'pinned':
        from opendirector.application.creation_canvas import asset_ref
        receipt = send(store, pid, 'reference.update', session=session, versions=[ver('reference', ref)],
            reference={**ref.model_dump(mode='json'), 'binding': binding, 'source': asset_ref(asset).model_dump(mode='json')})
        assert receipt.status == 'applied', receipt
        ref = store.snapshot(pid).references[-1]
    replacement_id = uuid4()
    replacement = {**ref.model_dump(mode='json'), 'id': str(replacement_id), 'revision': 1, 'order': ref.order + 1}
    receipt = send(store, pid, 'creation.batch', session=session,
        versions=[ver('reference', ref), ver('generation_spec', spec)], operations=[
            dict(type='reference.remove', payload=dict(referenceId=ref.id)),
            dict(type='reference.add', payload=dict(reference=replacement)),
            dict(type='generationSpec.setPrompt', payload=dict(specId=spec.id, prompt='', promptContent=[
                dict(type='text', text='Keep '), dict(type='reference', referenceId=replacement_id)]))])
    assert receipt.status == 'applied', receipt
    from opendirector.infrastructure.creation_projects import CreationProjects
    from opendirector.infrastructure.local_projects import LocalProjects
    saved = CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)
    assert not next(item for item in saved.references if item.id == ref.id).active
    assert next(item for item in saved.references if item.id == replacement_id).active
    updated = next(item for item in saved.generationSpecs if item.id == spec.id)
    assert updated.prompt == ('Keep @Original' if binding == 'follow_current' else 'Keep @Original.md')
    assert updated.promptContent[-1].referenceId == replacement_id
    assert resolved_inputs(saved, spec.id)[0].asset.assetId == asset.id


def test_hidden_following_and_fixed_versions_survive_source_changes(project):
    store, pid, session = project
    source, _, spec, ref, first = setup_reference(project)
    assert send(store, pid, 'asset.writeText', session=session, name='next.md', text='v2').status == 'applied'
    second = store.snapshot(pid).assets[-1]
    from opendirector.application.creation_canvas import asset_ref
    assert send(store, pid, 'canvas.materialize', session=session, versions=[ver('canvas_item', source)], itemId=source.id, asset=asset_ref(second)).status == 'applied'
    source = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', source)], itemId=source.id).status == 'applied'
    assert resolved_inputs(store.snapshot(pid), spec.id)[0].asset.assetId == second.id
    fixed = dict(id=uuid4(), projectId=pid, targetSpecId=spec.id, binding='pinned', source=asset_ref(first).model_dump(mode='json'), order=1)
    current = store.snapshot(pid).generationSpecs[-1]
    receipt = send(store, pid, 'reference.add', session=session, versions=[ver('generation_spec', current)], reference=fixed)
    assert receipt.status == 'applied', receipt.issues
    assert {value.asset.assetId for value in resolved_inputs(store.snapshot(pid), spec.id)} == {first.id, second.id}


@pytest.mark.parametrize('binding', ['follow_current', 'pinned'])
def test_persisted_editor_undo_restores_same_identity_with_versions(project, binding):
    store, pid, session = project
    source, target, spec, ref, asset = setup_reference(project)
    if binding == 'pinned':
        from opendirector.application.creation_canvas import asset_ref
        receipt = send(store, pid, 'reference.update', session=session, versions=[ver('reference', ref)],
            reference={**ref.model_dump(mode='json'), 'binding': binding, 'source': asset_ref(asset).model_dump(mode='json')})
        assert receipt.status == 'applied', receipt
        ref = store.snapshot(pid).references[-1]
    historical = store.snapshot(pid)
    result = send(store, pid, 'reference.remove', session=session,
        versions=[ver('reference', ref), ver('generation_spec', spec)], referenceId=ref.id)
    assert result.status == 'applied', result
    removed = store.snapshot(pid)
    inactive = removed.references[-1]
    # A stale editor and a retargeted restore must fail without partial writes.
    result = send(store, pid, 'reference.restore', session=session, versions=[ver('reference', ref)],
        reference={**ref.model_dump(mode='json'), 'active': True})
    assert result.status == 'rejected' and store.snapshot(pid) == removed
    other, _ = media(project)
    result = send(store, pid, 'reference.restore', session=session, versions=[ver('reference', inactive)],
        reference={**inactive.model_dump(mode='json'), 'active': True, 'targetSpecId': other.binding.draftSpec.id})
    assert result.status == 'rejected'
    current = store.snapshot(pid)
    receipt = send(store, pid, 'creation.batch', session=session,
        versions=[ver('reference', inactive), ver('generation_spec', current.generationSpecs[-2])], operations=[
            dict(type='reference.restore', payload=dict(reference={**inactive.model_dump(mode='json'), 'active': True})),
            dict(type='generationSpec.setPrompt', payload=dict(specId=spec.id, prompt='',
                promptContent=[part.model_dump(mode='json') for part in spec.promptContent]))])
    assert receipt.status == 'applied', receipt
    restored = store.snapshot(pid)
    assert restored.references[-1].id == ref.id and restored.references[-1].active
    assert restored.references[-1].revision == inactive.revision + 1
    assert restored.generationSpecs[-2].prompt == ('Before @Original.md between @Original.md after' if binding == 'pinned' else spec.prompt)
    assert resolved_inputs(restored, spec.id)[0].asset.assetId == asset.id
    assert historical.references[-1].active and historical.references[-1].revision == ref.revision
