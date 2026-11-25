"""Shared query entry points against committed projects and real small image files."""
import asyncio
import hashlib
from io import BytesIO
import json
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from PIL import Image
import pytest
from typer.testing import CliRunner

from generation_helpers import command, new_project, settled
from opendirector import cli
from opendirector.agent.tools import AgentTools
from opendirector.application.creation_canvas import CreationCanvas
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.commands import GenerationImpactQuery, parse_command
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector_api.main import create_app
from test_creation_canvas_service import send, ver
from test_generation_impact import graph, report, replace, uid

pytestmark = pytest.mark.cpu


class ImageProvider:
    """Only model execution is replaced; acceptance, files and adoption are real."""
    def __init__(self):
        self.calls = 0

    def validate(self, kind, config):
        assert kind == 'image'

    async def generate(self, config, task, submitted):
        self.calls += 1
        stream = BytesIO()
        Image.new('RGB', (16, 16), (self.calls * 20, 100, 120)).save(stream, 'PNG')
        return 'png', stream.getvalue()


@pytest.fixture
def saved(tmp_path):
    project = new_project(tmp_path, 'Dependency case')
    store, pid, session = project
    configs = ModelConfigs(tmp_path)
    config = configs.save('image', 'http://127.0.0.1:12345/v1', 'fixture-image', '',
        connection_type='self_hosted', auth_mode='none', protocol='openai')
    provider = ImageProvider()
    runner = CreationGeneration(store, configs, provider)
    specs, items = [], []

    async def build():
        for index in range(4):
            request = command(project, config, prompt=f'Frame {index}')
            state = store.snapshot(pid)
            spec, item = state.generationSpecs[-1], state.canvasItems[-1]
            if index in (1, 2):
                receipt = send(store, pid, 'reference.add', session=session,
                    versions=[ver('generation_spec', spec), ver('canvas_item', item)], reference=dict(
                        id=uuid4(), projectId=pid, targetSpecId=spec.id, binding='follow_current',
                        source=dict(id=items[-1])))
                assert receipt.status == 'applied', receipt
                state = store.snapshot(pid)
                spec = next(s for s in state.generationSpecs if s.id == spec.id)
                item = next(i for i in state.canvasItems if i.id == item.id)
                request = parse_command(dict(commandId=request.commandId, projectId=pid, type='generation.submit',
                    expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
                    payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
            receipt = await runner.execute(request, session=session)
            assert receipt.status == 'accepted', receipt
            await settled(runner)
            state = store.snapshot(pid)
            assert state.jobs[-1].status == 'succeeded'
            assert next(s for s in state.generationSpecs if s.id == spec.id).currentResultId is not None
            specs.append(spec.id)
            items.append(item.id)
        await runner.close()

    asyncio.run(build())
    return project, configs, runner, provider, specs, items


def impact_query(pid, roots, **kwargs):
    return GenerationImpactQuery(type='generation.impact', queryId=uuid4(), projectId=pid,
        rootSpecIds=tuple(roots), **kwargs)


def test_http_agent_and_cli_share_impact_report(saved, tmp_path, monkeypatch):
    (store, pid, session), configs, runner, provider, specs, _ = saved
    query = impact_query(pid, [specs[1]])
    api = TestClient(create_app(store.local, generation_provider=provider), headers={'X-OpenDirector-Request': '1'})
    response = api.post(f'/api/creation/projects/{pid}/queries', json=query.model_dump(mode='json'))
    assert response.status_code == 200, response.text
    expected = response.json()
    agent = asyncio.run(AgentTools(store, runner, configs).execute(pid, uuid4(), session, 'impact',
        'query', dict(type='generation.impact', rootSpecIds=[str(specs[1])]), [], None))
    assert agent == expected
    params = tmp_path / 'impact-query.json'
    params.write_text(json.dumps(dict(rootSpecIds=[str(specs[1])])), encoding='utf-8')
    for key in ('OPENDIRECTOR_AGENT_SOCKET', 'OPENDIRECTOR_AGENT_HOST', 'OPENDIRECTOR_PROJECT'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(cli.httpx, 'Client', lambda **kwargs: api)
    result = CliRunner().invoke(cli.app, ['--project', str(pid), 'query', 'generation.impact', '--file', str(params)])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == expected
    assert [i['reuseState'] for i in expected['items']] == ['reusable'] * 4


def files_under(path):
    return {str(p.relative_to(path)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in path.rglob('*') if p.is_file() and not p.name.endswith('.lock')}


def test_impact_query_is_read_only(saved, monkeypatch):
    (store, pid, session), _, _, provider, specs, _ = saved
    before = store.snapshot(pid).model_dump_json()
    files = files_under(store.local.repository)
    calls = provider.calls

    def forbidden(*args, **kwargs):
        raise AssertionError('Read-only query attempted a mutation or remote capability probe')

    monkeypatch.setattr(store, 'open', forbidden)
    monkeypatch.setattr(store, 'commit', forbidden)
    monkeypatch.setattr(CapabilityProbe, 'query', forbidden)
    canvas = CreationCanvas(store)
    first = canvas.query_snapshot(impact_query(pid, [specs[1]]))
    assert first == canvas.query_snapshot(impact_query(pid, [specs[1]]))
    assert store.snapshot(pid).model_dump_json() == before
    assert files_under(store.local.repository) == files
    assert provider.calls == calls


def test_snapshot_version_and_scope_limits(saved, monkeypatch):
    (store, pid, _), _, _, _, specs, _ = saved
    original = store.snapshot
    state = original(pid)
    reads = []

    def one_snapshot(key):
        reads.append(key)
        assert len(reads) == 1
        return state

    catalog = ModelConfigs.catalog_snapshot
    catalogs = []

    def one_catalog(self):
        catalogs.append(True)
        assert len(catalogs) == 1
        return catalog(self)

    monkeypatch.setattr(store, 'snapshot', one_snapshot)
    monkeypatch.setattr(ModelConfigs, 'catalog_snapshot', one_catalog)
    value = CreationCanvas(store).query_snapshot(impact_query(pid, [specs[1]]))
    assert value.projectVersion.revision == state.project.revision and value.eventCursor == state.eventCursor
    assert len(reads) == len(catalogs) == 1


@pytest.mark.parametrize('locale', ['zh-CN', 'en-US'])
def test_impact_errors_and_codes_are_locale_safe(saved, locale):
    (store, pid, _), _, _, provider, specs, _ = saved
    api = TestClient(create_app(store.local, generation_provider=provider),
        headers={'Accept-Language': locale, 'X-OpenDirector-Request': '1'})
    query = impact_query(pid, [specs[1]], maxNodes=3)
    response = api.post(f'/api/creation/projects/{pid}/queries', json=query.model_dump(mode='json'))
    assert response.status_code == 422 and response.json()['code'] == 'impact_scope_exceeded'
    message = response.json()['detail']
    assert ('上限' in message) if locale == 'zh-CN' else ('limit' in message and not any('\u4e00' <= c <= '\u9fff' for c in message))
    for roots in ([uuid4()], [pid]):  # foreign and wrong-kind identity
        response = api.post(f'/api/creation/projects/{pid}/queries', json=impact_query(pid, roots).model_dump(mode='json'))
        assert response.status_code == 404 and response.json()['code'] == 'missing_object'
        message = response.json()['detail']
        assert ('当前工程' in message) if locale == 'zh-CN' else (
            'no longer exists' in message and not any('\u4e00' <= c <= '\u9fff' for c in message))
    valid = impact_query(pid, [specs[1]]).model_dump(mode='json')
    english = api.post(f'/api/creation/projects/{pid}/queries', json=valid, headers={'Accept-Language': 'en-US'}).json()
    chinese = api.post(f'/api/creation/projects/{pid}/queries', json=valid, headers={'Accept-Language': 'zh-CN'}).json()
    assert english == chinese
    assert all(secret not in json.dumps(english) for secret in ('12345', str(store.local.repository), 'apiKey', 'Frame 0'))


def test_long_chain_cycles_and_scope_are_bounded():
    from opendirector.domain.creation.project import ProjectSnapshot
    from opendirector.domain.creation.validation import ContractError
    from test_creation_contracts import entity, PROJECT
    data = dict(project=dict(id=PROJECT, name='Long chain'), generationSpecs=[
        entity(10000+i, kind='image', purpose='generation', modelConfigId=uid(20)) for i in range(1200)],
        canvasItems=[entity(20000+i, kind='image', binding=dict(role='generation', objectRef=dict(id=uid(10000+i)))) for i in range(1200)],
        references=[entity(30000+i, binding='follow_current', targetSpecId=uid(10000+i), source=dict(id=uid(19999+i))) for i in range(1,1200)])
    state = ProjectSnapshot.model_validate(data)
    value = report(state, roots=(uid(10000),))
    assert len(value.items) == 1200 and value.items[-1].relation == 'downstream'
    assert value.items[-1].reuseState == 'no_result'
    with pytest.raises(ContractError) as error:
        report(state, roots=(uid(10000),), max_nodes=1199)
    assert error.value.issue.code == 'impact_scope_exceeded'
    cyclic = replace(graph(), 'references', 0, source=dict(id=uid(202)))
    value = report(cyclic)
    assert all(value.items[i].reuseState == 'unknown' for i in (1, 2))
    assert any(r.code == 'dependency_cycle' for r in value.items[1].reasons)


def submit_existing(saved, index, *, adopt=False):
    (store, pid, session), configs, _, provider, specs, items = saved

    async def generate():
        runner = CreationGeneration(store, configs, provider)
        state = store.snapshot(pid)
        spec = next(s for s in state.generationSpecs if s.id == specs[index])
        item = next(i for i in state.canvasItems if i.id == items[index])
        request = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
            expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)], payload=dict(
                specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id,
                adoptionPolicy='if_current' if adopt else 'candidate_only')))
        receipt = await runner.execute(request, session=session)
        assert receipt.status == 'accepted', receipt
        await settled(runner)
        await runner.close()
        state = store.snapshot(pid)
        job = next(j for j in state.jobs if j.id == receipt.jobIds[0])
        assert job.status == 'succeeded'
        return next(r for r in state.results if r.jobId == job.id)

    return asyncio.run(generate())


@pytest.mark.parametrize('pinned', [False, True], ids=['following', 'pinned'])
def test_reopenable_dependency_case_uses_real_commands_and_files(saved, tmp_path, pinned):
    from opendirector.infrastructure.creation_projects import CreationProjects
    from opendirector.infrastructure.local_projects import LocalProjects
    (store, pid, session), _, _, _, specs, items = saved
    canvas = CreationCanvas(store)
    query = impact_query(pid, [specs[1]])
    if pinned:
        state = store.snapshot(pid)
        reference = next(r for r in state.references if r.targetSpecId == specs[2])
        source = next(i for i in state.canvasItems if i.id == items[1])
        result = next(r for r in state.results if r.specId == specs[1])
        receipt = send(store, pid, 'reference.update', session=session,
            versions=[ver('reference', reference), ver('generation_spec', next(s for s in state.generationSpecs if s.id == specs[2]))],
            reference={**reference.model_dump(exclude={'binding', 'source'}), 'binding': 'pinned',
                'source': result.asset, 'sourceVersion': ver('canvas_item', source)})
        assert receipt.status == 'applied', receipt
        submit_existing(saved, 2, adopt=True)
    state = store.snapshot(pid)
    results = {r.id: r for r in state.results}
    selected = {s.id: results[s.currentResultId] for s in state.generationSpecs}
    timeline_id = uuid4()
    clips = [dict(id=key, resource=dict(asset=selected[specs[i]].asset, title=key), inPoint=0, outPoint=1)
             for key, i in (('B', 1), ('C', 2), ('D', 3))]
    receipt = send(store, pid, 'editor.create', session=session, document=dict(id=timeline_id, projectId=pid,
        kind='timeline', inputConnections=[dict(id=uuid4(), sourceId=items[1], slotId='B', asset=selected[specs[1]].asset)],
        data=dict(fps=24, width=16, height=16, tracks=[dict(id='v', kind='visual', title='Shots', clips=clips)])))
    assert receipt.status == 'applied', receipt
    assert all(item.reuseState == 'reusable' for item in canvas.query_snapshot(query).items)
    before = store.snapshot(pid)
    b = next(s for s in before.generationSpecs if s.id == specs[1])
    receipt = send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', b)],
        spec=b.model_copy(update={'prompt': 'Change only B'}))
    assert receipt.status == 'applied', receipt
    changed = canvas.query_snapshot(query)
    by_id = {i.specId: i for i in changed.items}
    assert by_id[specs[1]].reuseState == 'stale'
    assert (by_id[specs[2]].inputState, by_id[specs[2]].reuseState) == ('equal', 'reusable' if pinned else 'pending_upstream')
    assert by_id[specs[3]].reuseState == 'reusable'
    if not pinned:
        # Keep the actual public request/response as a reproducible handoff artifact.
        (tmp_path / 'impact-request.json').write_text(query.model_dump_json(indent=2), encoding='utf-8')
        (tmp_path / 'impact-response.json').write_text(changed.model_dump_json(indent=2), encoding='utf-8')
    candidate = submit_existing(saved, 1)
    pending = {i.specId: i for i in canvas.query_snapshot(query).items}
    assert pending[specs[2]].currentInputFingerprint == by_id[specs[2]].currentInputFingerprint
    assert pending[specs[2]].inputState == 'equal'
    state = store.snapshot(pid)
    b = next(s for s in state.generationSpecs if s.id == specs[1])
    receipt = send(store, pid, 'result.select', session=session, versions=[ver('generation_spec', b)],
        specId=b.id, resultId=candidate.id)
    assert receipt.status == 'applied', receipt
    after = canvas.query_snapshot(query)
    by_id = {i.specId: i for i in after.items}
    assert by_id[specs[2]].reuseState == ('reusable' if pinned else 'stale')
    assert by_id[specs[3]].reuseState == 'reusable'
    assert before.jobs == store.snapshot(pid).jobs[:len(before.jobs)]
    assert before.editorDocuments == store.snapshot(pid).editorDocuments
    snapshot_bytes = store.snapshot(pid).model_dump_json()
    files = files_under(store.local.repository)
    reopened = CreationProjects(LocalProjects(store.local.repository))
    assert CreationCanvas(reopened).query_snapshot(query) == after
    assert reopened.snapshot(pid).model_dump_json() == snapshot_bytes
    assert files_under(store.local.repository) == files
    # Remove one isolated result's real bytes, retaining all metadata and history.
    with store.local.transaction() as db:
        directory, _ = store._find(db, pid)
    (directory / 'assets' / str(selected[specs[3]].asset.assetId)).unlink()
    missing = {i.specId: i for i in CreationCanvas(reopened).query_snapshot(query).items}
    assert missing[specs[3]].reuseState == 'unavailable'
    assert reopened.snapshot(pid).model_dump_json() == snapshot_bytes


def test_foreign_project_root_never_switches_or_opens_a_session(saved, tmp_path):
    from test_creation_canvas_service import media
    from opendirector.domain.creation.validation import ContractError
    (store, pid, _), _, _, _, specs, _ = saved
    other = new_project(tmp_path, 'Other')
    _, foreign = media(other)
    before = store.snapshot(pid)
    with pytest.raises(ContractError) as error:
        CreationCanvas(store).query_snapshot(impact_query(pid, [foreign.id]))
    assert error.value.issue.code == 'missing_object'
    assert store.snapshot(pid) == before


def test_cached_capability_rules_are_shared_across_query_entries_without_probing(tmp_path, monkeypatch):
    from test_request_capability_acceptance import image_runtime, submit
    from test_tool_tasks import png, upload
    project = new_project(tmp_path)
    store, pid, session = project
    runner, config, probe, queries, posts = image_runtime(project, 2)
    source = upload(store, str(pid), session, 'source.png', png())
    request = command(project, config, references=[source])
    try:
        assert submit('service', project, runner, probe, request)['status'] == 'accepted'
        state = store.snapshot(pid)
        assert state.jobs[0].inputSnapshot.model.inputRules.maxImages == 2
        spec_id = state.generationSpecs[0].id
        query = impact_query(pid, [spec_id])
        api = TestClient(create_app(store.local, generation_provider=runner.provider, capability_probe=probe),
            headers={'X-OpenDirector-Request': '1'})

        def forbidden(*args, **kwargs):
            raise AssertionError('Impact queries must only read the existing capability cache')

        monkeypatch.setattr(probe, 'query', forbidden)
        monkeypatch.setattr(probe, 'query_many', forbidden)
        http = api.post(f'/api/creation/projects/{pid}/queries', json=query.model_dump(mode='json'))
        assert http.status_code == 200, http.text
        agent = asyncio.run(AgentTools(store, runner, runner.configs).execute(pid, uuid4(), session, 'impact-cache',
            'query', dict(type='generation.impact', rootSpecIds=[str(spec_id)]), [], None))
        assert http.json() == agent
        assert CreationCanvas(store, availability=runner.availability).query_snapshot(query).model_dump(mode='json') == agent
        assert [(i['inputState'], i['reuseState']) for i in agent['items']] == [('equal', 'reusable')]
        assert len(queries) == len(posts) == 1
        assert store.snapshot(pid) == state
    finally:
        probe.close()


@pytest.mark.parametrize('failure', ['limit', 'foreign_root'])
def test_agent_gateway_preserves_impact_error_codes(saved, tmp_path, failure):
    from opendirector.agent.context import RunContext
    from opendirector.agent.gateway import ToolGateway
    (store, pid, session), configs, runner, _, specs, _ = saved
    arguments = dict(type='generation.impact', rootSpecIds=[str(specs[0])])
    if failure == 'limit':
        arguments['maxNodes'] = 1
        expected = 'impact_scope_exceeded'
    else:
        arguments['rootSpecIds'] = [str(uuid4())]
        expected = 'missing_object'
    run = RunContext(runtime='codex', project_id=pid, turn_id=uuid4(), session=session,
        directory=tmp_path, config=None, messages=[], selected_skills=[])

    async def query():
        gateway = ToolGateway(AgentTools(store, runner, configs), run)
        try:
            result = await gateway.call('impact-rejected', 'query', arguments)
            assert result.error
            assert result.value['code'] == expected
            assert result.event('query')['code'] == expected
        finally:
            await gateway.close()

    asyncio.run(query())


@pytest.mark.parametrize('entry', ['service', 'http', 'agent'])
def test_impact_reuses_controlled_file_verification_and_detects_replacements(saved, monkeypatch, entry):
    from opendirector.application import creation_assets
    from test_tool_tasks import png
    (store, pid, session), configs, runner, provider, specs, _ = saved
    query = impact_query(pid, [specs[1]])
    canvas = CreationCanvas(store)
    api = TestClient(create_app(store.local, generation_provider=provider), headers={'X-OpenDirector-Request': '1'})
    agent = AgentTools(store, runner, configs)
    calls = []
    original = creation_assets.stream_identity

    def identity(stream):
        calls.append(stream)
        return original(stream)

    monkeypatch.setattr(creation_assets, 'stream_identity', identity)

    def read():
        if entry == 'service':
            return canvas.query_snapshot(query).model_dump(mode='json')
        if entry == 'http':
            response = api.post(f'/api/creation/projects/{pid}/queries', json=query.model_dump(mode='json'))
            assert response.status_code == 200, response.text
            return response.json()
        return asyncio.run(agent.execute(pid, uuid4(), session, 'impact-files', 'query',
            dict(type='generation.impact', rootSpecIds=[str(specs[1])]), [], None))

    assert all(item['reuseState'] == 'reusable' for item in read()['items'])
    assert len(calls) == 4
    assert all(item['reuseState'] == 'reusable' for item in read()['items'])
    assert len(calls) == 4  # unchanged file signatures reuse the safe reader's cache
    state = store.snapshot(pid)
    adopted = next(r for r in state.results if r.specId == specs[3])
    with store.local.transaction() as db:
        directory, _ = store._find(db, pid)
    output = directory / 'assets' / str(adopted.asset.assetId)
    output.write_bytes(png(color='black'))
    assert next(i for i in read()['items'] if i['specId'] == str(specs[3]))['reuseState'] == 'unavailable'
    assert len(calls) == 5
    output.unlink()
    assert next(i for i in read()['items'] if i['specId'] == str(specs[3]))['reuseState'] == 'unavailable'
    assert store.snapshot(pid) == state
