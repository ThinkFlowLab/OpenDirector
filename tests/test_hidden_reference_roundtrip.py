"""Real frontend preparation and persisted commands agree on hidden inputs."""
import json
from pathlib import Path
import shutil
import subprocess
from uuid import uuid4

import pytest

from test_creation_canvas_service import project, send, ver, text_material, media
from opendirector.application.creation_canvas import current_generation_inputs, asset_ref
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects


@pytest.mark.parametrize('binding', ['follow_current', 'pinned'])
@pytest.mark.parametrize('hide_group', [False, True])
def test_hidden_reference_survives_frontend_edit_save_and_reopen(project, tmp_path, binding, hide_group):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node is required for the frontend/persistence boundary')
    store, pid, session = project
    source, asset = text_material(project, title='A')
    target, spec = media(project, title='B', purpose='generation')
    reference_id = uuid4()
    reference = dict(id=reference_id, projectId=pid, binding=binding, targetSpecId=spec.id,
                     source=dict(id=source.id) if binding == 'follow_current' else asset_ref(asset))
    if binding == 'pinned':
        reference['sourceVersion'] = ver('canvas_item', source)
    assert send(store, pid, 'reference.add', session=session,
                versions=[ver('generation_spec', spec), ver('canvas_item', target)], reference=reference).status == 'applied'
    spec = next(s for s in store.snapshot(pid).generationSpecs if s.id == spec.id)
    assert send(store, pid, 'generationSpec.setPrompt', session=session, versions=[ver('generation_spec', spec)],
                specId=spec.id, prompt='Use @A', promptContent=[dict(type='text', text='Use '),
                dict(type='reference', referenceId=reference_id)]).status == 'applied'
    hidden = source
    if hide_group:
        group_id = uuid4()
        assert send(store, pid, 'creation.batch', session=session, versions=[ver('canvas_item', source)], operations=[
            dict(type='canvas.show', payload=dict(item=dict(id=group_id, projectId=pid, kind='group'))),
            dict(type='canvas.update', payload=dict(itemId=source.id, parentId=group_id))]).status == 'applied'
        hidden = store.snapshot(pid).canvasItems[-1]
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', hidden)], itemId=hidden.id).status == 'applied'
    before, prepared = tmp_path / 'snapshot.json', tmp_path / 'prepared.json'
    before.write_text(store.snapshot(pid).model_dump_json(), encoding='utf-8')
    subprocess.run([node, str(Path(__file__).with_name('hidden_reference_roundtrip.mjs')),
                    str(before), str(prepared), str(target.id)], check=True, capture_output=True, timeout=20)
    result = json.loads(prepared.read_text(encoding='utf-8'))
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='creation.batch',
        expectedVersions=result['versions'], payload=dict(operations=result['operations'])))
    assert store.execute(command, session=session).status == 'applied'
    reopened = CreationProjects(store.local).snapshot(pid)
    saved = next(s for s in reopened.generationSpecs if s.id == spec.id)
    assert saved.prompt.endswith(' More')
    assert any(part.type == 'reference' and part.referenceId == reference_id for part in saved.promptContent)
    assert [r.id for r in reopened.references if r.active] == [reference_id]
    _, inputs = current_generation_inputs(reopened, saved, None)
    assert [item.asset.assetId for item in inputs] == [asset.id]
