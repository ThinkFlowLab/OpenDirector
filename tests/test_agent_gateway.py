import asyncio
from uuid import uuid4

import pytest

from capabilities import requires_posix

from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture
def gateway(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    business = AgentTools(projects, None, ModelConfigs(tmp_path))
    run = RunContext(runtime='codex', project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
        directory=tmp_path, config=None, messages=[], selected_skills=[])
    return ToolGateway(business, run)


@pytest.mark.anyio
async def test_concurrent_replay_executes_once_and_conflicting_input_is_rejected(gateway, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    effects = []
    async def execute(*args):
        entered.set()
        await release.wait()
        effects.append(args[3])
        return {'status': 'applied', 'commandId': args[3]}
    monkeypatch.setattr(gateway.business, 'execute', execute)
    first = asyncio.create_task(gateway.call('same-id', 'read_project', {}))
    await entered.wait()
    replay = asyncio.create_task(gateway.call('same-id', 'read_project', {}))
    conflict = await gateway.call('same-id', 'read', {'path': 'different'})
    assert conflict.error == '工具调用标识被用于不同输入。'
    release.set()
    left, right = await asyncio.gather(first, replay)
    assert left.value == right.value == {'status': 'applied', 'commandId': 'same-id', 'modelSelections': {}}
    assert effects == ['same-id']
    await gateway.close()


@pytest.mark.anyio
async def test_failed_calls_replay_without_limiting_subsequent_calls(gateway, monkeypatch):
    attempts = []
    async def execute(*args):
        attempts.append(args[3])
        raise ProjectError('Invalid reference')
    monkeypatch.setattr(gateway.business, 'execute', execute)
    first = await gateway.call('0', 'read_project', {})
    assert first.error == 'Invalid reference'
    assert (await gateway.call('0', 'read_project', {})).value == first.value
    for number in range(1, 32):
        assert (await gateway.call(str(number), 'read_project', {})).error == 'Invalid reference'
    assert len(attempts) == 32
    await gateway.close()


@pytest.mark.anyio
async def test_disconnect_keeps_accepted_operation_and_close_blocks_new_calls(gateway, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    committed = []
    async def execute(*args):
        entered.set()
        await release.wait()
        committed.append('receipt')
        return {'status': 'accepted', 'jobIds': ['job-1']}
    monkeypatch.setattr(gateway.business, 'execute', execute)
    waiter = asyncio.create_task(gateway.call('submit', 'read_project', {}))
    await entered.wait()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    close = asyncio.create_task(gateway.close())
    await asyncio.sleep(0)
    assert (await gateway.call('another', 'read_project', {})).error == '本轮工具入口已关闭。'
    assert not close.done()
    release.set()
    await close
    assert committed == ['receipt']


@pytest.mark.anyio
async def test_rejected_receipt_and_forged_scope_are_consistent(gateway, monkeypatch):
    async def execute(*args):
        return {'status': 'rejected', 'issues': [{'message': 'Revision conflict'}]}
    monkeypatch.setattr(gateway.business, 'execute', execute)
    outcome = await gateway.call('reject', 'read_project', {})
    assert outcome.value['status'] == 'rejected'
    assert outcome.event('read_project') == {'type': 'tool', 'name': 'read_project', 'status': 'failed', 'error': 'Revision conflict'}
    forged = await gateway.call('forged', 'read_project', {'projectId': str(uuid4())})
    assert forged.error == '工具参数缺失或包含未定义字段。'
    await gateway.close()


@pytest.mark.anyio
@requires_posix()
async def test_skill_read_resolves_directory_alias_and_preserves_boundary(gateway, tmp_path):
    skill = tmp_path / 'skills' / 'character-replacement'
    skill.mkdir(parents=True)
    resource = skill / 'SKILL.md'
    resource.write_text('character replacement skill')
    alias = tmp_path / 'skill-alias'
    alias.symlink_to(skill, target_is_directory=True)
    gateway.roots = [alias]

    canonical = await gateway.call('canonical', 'read', {'path': str(resource.resolve())})
    aliased = await gateway.call('alias', 'read', {'path': str(alias / 'SKILL.md')})
    assert canonical.error is None and aliased.error is None
    assert canonical.value == aliased.value == 'character replacement skill'

    outside = tmp_path / 'outside.md'
    outside.write_text('outside skill boundary')
    (skill / 'escape.md').symlink_to(outside)
    for call_id, path in [('traversal', alias / '..' / '..' / 'outside.md'),
                          ('symlink', skill / 'escape.md')]:
        rejected = await gateway.call(call_id, 'read', {'path': str(path)})
        assert rejected.error == '只能读取已发现技能目录内的文本资源。'
    await gateway.close()


@pytest.mark.anyio
async def test_canvas_hide_schema_and_field_errors(gateway):
    from opendirector.agent.tools import tools
    item = str(uuid4())
    schema = next(tool['function']['parameters'] for tool in tools()
                  if tool['function']['name'] == 'execute_command')
    assert schema['$defs']['ObjectVersion']['properties']['revision']['type'] == 'integer'
    description = await gateway.call('schema', 'command_schema', {'type': 'canvas.hide'})
    assert 'clear the canvas' in description.value['description']
    bad = await gateway.call('bad', 'execute_command', {'type': 'canvas.hide',
        'payload': {'itemId': item}, 'expectedVersions': [
            {'objectType': 'canvas_item', 'id': item, 'revision': '1'}]})
    assert 'expectedVersions.0.revision' in bad.error
    assert 'integer' in bad.error and 'tagged-union' not in bad.error
    assert set(bad.value) == {'error'}



@pytest.mark.anyio
async def test_clear_canvas_preserves_contents_and_respects_locks(gateway):
    from opendirector.domain.creation.commands import parse_command
    projects, run = gateway.business.projects, gateway.run
    projects.execute(parse_command(dict(type='project.create', projectId=run.project_id,
        commandId=uuid4(), payload={'name': 'Canvas removal'})))
    projects.open(run.project_id, run.session)
    for index in range(3):
        result = await gateway.call(f'create-{index}', 'execute_command',
            {'type': 'asset.writeText', 'payload': {'name': f'{index}.md', 'text': 'keep'}})
        assert not result.error
    snapshot = await gateway.call('before', 'read_project', {})
    project = snapshot.value['project']
    # Written assets have no canvas projection until explicitly shown.
    for index, asset in enumerate(project['assets']):
        item = {'id': str(uuid4()), 'projectId': str(run.project_id), 'kind': 'text',
            'title': asset['name'], 'position': {'x': index * 100, 'y': 0},
            'locked': index == 2, 'binding': {'role': 'material', 'objectRef': {
                'assetId': asset['id'], 'revision': asset['revision'],
                'fingerprint': asset['fingerprint'], 'kind': 'text'}}}
        shown = await gateway.call(f'show-{index}', 'execute_command',
            {'type': 'canvas.show', 'payload': {'item': item}})
        assert not shown.error, shown
    visible = (await gateway.call('visible', 'read_project', {})).value['project']
    first = visible['canvasItems'][0]
    assert not (await gateway.call('already-hidden', 'execute_command', {'type': 'canvas.hide',
        'payload': {'itemId': first['id']}, 'expectedVersions': [
            {'objectType': 'canvas_item', 'id': first['id'], 'revision': first['revision']}]})).error
    before = (await gateway.call('before-clear', 'read_project', {})).value['project']
    for index, item in enumerate(before['canvasItems']):
        if not item['visible']:
            continue
        if not item['locked']:
            invalid = await gateway.call(f'invalid-{index}', 'execute_command', {'type': 'canvas.hide',
                'payload': {'itemId': item['id']}, 'expectedVersions': [
                    {'objectType': 'canvas_item', 'id': item['id'], 'revision': str(item['revision'])}]})
            assert 'expectedVersions.0.revision' in invalid.error
        hidden = await gateway.call(f'hide-{index}', 'execute_command', {'type': 'canvas.hide',
            'payload': {'itemId': item['id']}, 'expectedVersions': [
                {'objectType': 'canvas_item', 'id': item['id'], 'revision': item['revision']}]})
        assert bool(hidden.error) == item['locked']
    after = (await gateway.call('after', 'read_project', {})).value['project']
    assert [item['visible'] for item in after['canvasItems']] == [False, False, True]
    assert after['canvasItems'][0] == before['canvasItems'][0]
    assert after['assets'] == before['assets']
    assert after['canvasItems'][2] == before['canvasItems'][2]


@pytest.mark.anyio
async def test_batch_schema_and_rejection_preserve_agent_scope(gateway):
    schema = (await gateway.call('schema', 'command_schema', {'type': 'creation.batch', 'path': 'payload.operations'})).value
    choices = schema['items']['branches']
    assert 'canvas.hide' in choices
    assert 'canvas.applyEdit' not in choices
    branch = choices['canvas.hide']
    expanded = (await gateway.call('expand', 'command_schema',
        {'type': 'creation.batch', 'path': branch['path']})).value
    assert expanded['fields']['type']['const'] == 'canvas.hide'
    rejected = await gateway.call('restricted', 'execute_command', {'type': 'creation.batch',
        'payload': {'operations': [{'type': 'canvas.applyEdit', 'payload': {
            'itemId': str(uuid4()), 'source': {'assetId': str(uuid4()), 'revision': 1,
            'fingerprint': 'sha256:' + '0' * 64, 'kind': 'image'}, 'asset': {'assetId': str(uuid4()), 'revision': 1,
            'fingerprint': 'sha256:' + '0' * 64, 'kind': 'image'}, 'editorId': str(uuid4())}}]}})
    assert rejected.error == '批量命令包含未开放的 Agent 操作。'


@pytest.mark.anyio
async def test_batch_hide_is_atomic_and_replayable(gateway):
    from opendirector.domain.creation.commands import parse_command
    run = gateway.run
    gateway.business.projects.execute(parse_command(dict(type='project.create', projectId=run.project_id,
        commandId=uuid4(), payload={'name': 'Batch'})))
    gateway.business.projects.open(run.project_id, run.session)
    ids = [str(uuid4()), str(uuid4())]
    shown = await gateway.call('show', 'execute_command', {'type': 'creation.batch', 'payload': {
        'operations': [{'type': 'canvas.show', 'payload': {'item': {'id': identity,
            'projectId': str(run.project_id), 'kind': 'text', 'position': {'x': 0, 'y': 0},
            'binding': {'role': 'empty'}}}} for identity in ids]}})
    assert not shown.error, shown
    discovered = (await gateway.call('discover', 'read_project', {})).value
    schema = (await gateway.call('batch-schema', 'command_schema', {'type': 'creation.batch'})).value
    assert discovered['commandMetadata']['creation.batch']['description'] == schema['description']
    assert 'atomically' in schema['description']
    assert set(discovered['commandMetadata']) == set(discovered['commands'])
    for kind, metadata in discovered['commandMetadata'].items():
        command_schema = (await gateway.call('schema-' + kind, 'command_schema', {'type': kind})).value
        assert command_schema['description'] == metadata['description']
        assert len(metadata['description']) <= 120
    arguments = {'type': 'creation.batch', 'payload': {'operations': [
        {'type': 'canvas.hide', 'payload': {'itemId': identity}} for identity in ids]},
        'expectedVersions': [{'objectType': 'canvas_item', 'id': identity, 'revision': 1} for identity in ids]}
    stale = {**arguments, 'expectedVersions': [*arguments['expectedVersions'][:-1],
        {**arguments['expectedVersions'][-1], 'revision': 2}]}
    assert (await gateway.call('stale', 'execute_command', stale)).error
    snapshot = (await gateway.call('unchanged', 'read_project', {})).value['project']
    assert all(item['visible'] for item in snapshot['canvasItems'])
    hidden = await gateway.call('hide', 'execute_command', arguments)
    assert not hidden.error, hidden
    assert (await gateway.call('hide', 'execute_command', arguments)).value == hidden.value
    snapshot = (await gateway.call('hidden', 'read_project', {})).value['project']
    assert all(not item['visible'] and item['revision'] == 2 for item in snapshot['canvasItems'])


@pytest.mark.anyio
async def test_selected_models_are_turn_context_not_global_state(gateway, monkeypatch):
    selected = str(uuid4())
    from dataclasses import replace
    run = replace(gateway.run, model_selections={'image': selected})
    gateway = ToolGateway(gateway.business, run)
    run.model_selections['image'] = 'changed'
    async def read(*args):
        return {'project': {}, 'models': []}
    monkeypatch.setattr(gateway.business, 'execute', read)
    result = await gateway.call('read', 'read_project', {})
    assert result.value['modelSelections'] == {'image': selected}



@pytest.mark.anyio
@pytest.mark.parametrize(('kind', 'payload', 'object_type'), [
    ('generation.submit', {'specId': str(uuid4()), 'expectedSpecRevision': 1}, 'generation_spec'),
    ('canvas.hide', {'itemId': str(uuid4())}, 'canvas_item'),
])
async def test_missing_versions_identify_target(gateway, kind, payload, object_type):
    result = await gateway.call('missing', 'execute_command', {'type': kind, 'payload': payload})
    identity = payload.get('specId', payload.get('itemId'))
    assert f'{object_type}:{identity}' in result.error
    assert 'expectedVersions' in result.error


@pytest.mark.anyio
async def test_model_preferences_do_not_add_a_business_veto(gateway):
    from opendirector.domain.creation.commands import parse_command
    run, projects = gateway.run, gateway.business.projects
    projects.execute(parse_command(dict(type='project.create', projectId=run.project_id,
        commandId=uuid4(), payload={'name': 'Model preference'})))
    projects.open(run.project_id, run.session)
    gateway.model_selections['image'] = str(uuid4())
    alternative = str(uuid4())
    result = await gateway.call('create', 'execute_command', {'type': 'generationSpec.create',
        'payload': {'spec': {'id': str(uuid4()), 'projectId': str(run.project_id),
            'kind': 'image', 'purpose': 'generation', 'modelConfigId': alternative}}})
    assert not result.error, result
    assert str(projects.snapshot(run.project_id).generationSpecs[0].modelConfigId) == alternative


@pytest.mark.anyio
async def test_close_cancels_pending_canvas_status_wait(gateway, monkeypatch):
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    async def execute(*args):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(gateway.business, 'execute', execute)
    waiter = asyncio.create_task(gateway.call('status', 'query', {'type': 'canvas.status', 'objectId': str(uuid4()), 'waitSeconds': 30}))
    await entered.wait()
    await asyncio.wait_for(gateway.close(), timeout=1)
    assert cancelled.is_set()
    with pytest.raises(asyncio.CancelledError):
        await waiter


@pytest.mark.anyio
async def test_default_runtime_accepts_cli_command_without_help_state(gateway, monkeypatch):
    from dataclasses import replace

    gateway.run = replace(gateway.run, runtime='default')
    calls = []

    async def execute(*args):
        calls.append(args[4])
        return {'status': 'ok'}

    monkeypatch.setattr(gateway.business, 'execute', execute)
    arguments = {'type': 'canvas.show', 'payload': {}}
    assert not (await gateway.call('first', 'execute_command', arguments)).error
    assert calls == ['execute_command']
