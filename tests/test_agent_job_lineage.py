"""A job accepted for an Agent tool call keeps that call's identity in its own committed record.

The Agent trace is a debugging artifact. These tests never read it: the originating turn, call
and command are recovered from the project's committed state alone, including after a crash and
a restart. Provider doubles only; nothing leaves the process.
"""
import asyncio
import json
from uuid import UUID, uuid4, uuid5

from fastapi.testclient import TestClient
import pytest

from opendirector.agent.tools import AgentTools
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.base import agent_command_id
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.generation import Job
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.agent import Conversations
from opendirector_api.main import create_app
from test_creation_canvas_service import media, project, send, ver  # noqa: F401  (project is a fixture)


pytestmark = pytest.mark.cpu


@pytest.fixture
def anyio_backend():
    return 'asyncio'


class Provider:
    def __init__(self, mode='ok'):
        self.mode, self.calls, self.started = mode, [], asyncio.Event()

    def validate(self, kind, config):
        pass

    async def generate(self, config, task, submitted):
        self.calls.append(task['id'])
        self.started.set()
        if self.mode == 'hang':
            await asyncio.Event().wait()
        if self.mode == 'fail':
            raise ProjectError('provider exploded', 400)
        return 'md', b'generated'


def stack(project, provider):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('agent', 'http://127.0.0.1:12345/v1', 'gen', '', connection_type='self_hosted',
                          protocol='openai', auth_mode='none')
    runner = CreationGeneration(store, configs, provider)
    return runner, AgentTools(store, runner, configs), config


async def submit(tools, project, config, turn, call, before=None):
    store, pid, session = project
    item, spec = media(project, 'text')
    changed = spec.model_copy(update={'prompt': call, 'modelConfigId': UUID(config['id'])})
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)], spec=changed).status == 'applied'
    snapshot = store.snapshot(pid)
    spec = next(s for s in snapshot.generationSpecs if s.id == spec.id)
    item = next(i for i in snapshot.canvasItems if i.id == item.id)
    arguments = dict(type='generation.submit',
                     payload=dict(specId=str(spec.id), expectedSpecRevision=spec.revision, originItemId=str(item.id)),
                     expectedVersions=json.loads(json.dumps([ver('generation_spec', spec), ver('canvas_item', item)], default=str)))
    if before:
        before()
    return await tools.execute(pid, turn, session, call, 'execute_command', arguments, [], None)


def lineage_client(store):
    # The real application, so ProjectError and the other handlers apply. No `with`: lifespan (job recovery) never starts.
    return TestClient(create_app(store.local), headers={'X-OpenDirector-Request': '1'})


def jobs_url(pid, turn):
    return f'/api/creation/projects/{pid}/assistant/turns/{turn}/jobs'


def turn_jobs(client, pid, turn):
    response = client.get(jobs_url(pid, turn))
    assert response.status_code == 200, response.text
    return response.json()


def commit_files(store):
    return sorted((f.name, f.stat().st_mtime_ns) for f in store.local.root.rglob('commits/*.json'))


async def settled(runner):
    await asyncio.gather(*(job.future for job in list(runner.jobs.values())))


@pytest.mark.anyio
async def test_agent_job_origin_matches_the_committed_receipt(project):
    store, pid, session = project
    provider = Provider()
    runner, tools, config = stack(project, provider)
    turn, call = uuid4(), 'cli:' + str(uuid4())
    receipt = await submit(tools, project, config, turn, call)
    await settled(runner)
    await runner.close()
    assert receipt['status'] == 'accepted'
    command_id = agent_command_id(turn, call)
    assert UUID(receipt['commandId']) == command_id
    job = store.snapshot(pid).jobs[0]
    # Job -> Turn: stored on the job itself.
    assert (job.agentRunId, job.agentCallId) == (turn, call)
    # Turn -> Job and the derived identities agree with the committed receipt.
    assert receipt['jobIds'] == [str(job.id)] == [str(j) for j in store.receipt(pid, command_id).jobIds]
    assert job.id == uuid5(command_id, 'job')
    assert job.status == 'succeeded'


@pytest.mark.anyio
async def test_background_failure_is_reported_as_failure_with_the_original_identity(project):
    store, pid, session = project
    runner, tools, config = stack(project, Provider('fail'))
    turn = uuid4()
    receipt = await submit(tools, project, config, turn, 'call-1')
    await settled(runner)
    await runner.close()
    assert receipt['status'] == 'accepted'            # the tool call succeeded; the job did not
    [job] = store.snapshot(pid).jobs
    assert str(job.id) == receipt['jobIds'][0] and job.status == 'failed'
    assert (job.agentRunId, job.agentCallId) == (turn, 'call-1')
    assert job.errorDetails.message == 'provider exploded' and job.asset is None
    assert (job.recovery, job.resumeAllowed) == ('review', False)


@pytest.mark.anyio
async def test_one_turn_records_every_job_it_accepted_and_nothing_else(project):
    store, pid, session = project
    runner, tools, config = stack(project, Provider())
    turn, other = uuid4(), uuid4()
    first = await submit(tools, project, config, turn, 'call-a')
    second = await submit(tools, project, config, turn, 'call-b')
    await submit(tools, project, config, other, 'call-a')      # same call id, different turn
    item, spec = media(project, 'text')                        # a job nobody's Agent submitted
    spec = spec.model_copy(update={'prompt': 'ui', 'modelConfigId': UUID(config['id'])})
    current = store.snapshot(pid)
    base = next(s for s in current.generationSpecs if s.id == spec.id)
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', base)], spec=spec).status == 'applied'
    current = store.snapshot(pid)
    spec, item = next(s for s in current.generationSpecs if s.id == spec.id), next(i for i in current.canvasItems if i.id == item.id)
    ui = await runner.execute(parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id))), session=session)
    await settled(runner)
    await runner.close()
    jobs = store.snapshot(pid).jobs
    mine = [j for j in jobs if j.agentRunId == turn]
    assert sorted(str(j.id) for j in mine) == sorted([first['jobIds'][0], second['jobIds'][0]])
    assert {j.agentCallId for j in mine} == {'call-a', 'call-b'}
    assert sorted(j.agentCallId for j in jobs if j.agentRunId == other) == ['call-a']
    ui_job = next(j for j in store.snapshot(pid).jobs if str(j.id) == str(ui.jobIds[0]))
    assert ui_job.agentRunId is None and ui_job.status == 'succeeded'
    assert 'agentRunId' not in ui_job.model_dump(mode='json') and 'agentCallId' not in ui_job.model_dump(mode='json')


@pytest.mark.anyio
async def test_origin_survives_a_crash_after_the_commit_intent_is_durable(project):
    store, pid, session = project
    runner, tools, config = stack(project, Provider())
    def crash(stage):
        if stage == 'journaled':
            raise RuntimeError('process died')
    def arm():                       # only the submit commit is interrupted, not the fixture setup
        store._checkpoint = crash
    turn = uuid4()
    with pytest.raises(RuntimeError):
        await submit(tools, project, config, turn, 'call-1', before=arm)
    await runner.close()
    # New process: opening the project rolls the journaled commit forward.
    reopened = CreationProjects(LocalProjects(store.local.repository))
    provider = Provider()
    restarted = CreationGeneration(reopened, ModelConfigs(store.local.repository), provider)
    [job] = reopened.snapshot(pid).jobs
    assert (job.status, job.agentRunId, job.agentCallId) == ('queued', turn, 'call-1')
    assert reopened.receipt(pid, agent_command_id(turn, 'call-1')).jobIds == (job.id,)
    await restarted.start()
    await settled(restarted)
    await restarted.close()
    assert len(provider.calls) == 1
    assert reopened.snapshot(pid).jobs[0].status == 'succeeded'


@pytest.mark.anyio
async def test_interrupted_job_keeps_origin_and_a_restart_does_not_resubmit_it(project):
    store, pid, session = project
    provider = Provider('hang')
    runner, tools, config = stack(project, provider)
    turn = uuid4()
    await submit(tools, project, config, turn, 'call-1')
    await asyncio.wait_for(provider.started.wait(), 3)
    await runner.close()                                        # the service stops while the provider call is open
    reopened = CreationProjects(LocalProjects(store.local.repository))
    after = Provider()
    restarted = CreationGeneration(reopened, ModelConfigs(store.local.repository), after)
    await restarted.start()
    await restarted.close()
    [job] = reopened.snapshot(pid).jobs
    assert (job.status, job.agentRunId, job.agentCallId) == ('interrupted', turn, 'call-1')
    assert job.recovery == 'review' and not job.resumeAllowed
    assert after.calls == []                                     # no second paid submission


@pytest.mark.anyio
async def test_origin_is_recorded_whole_or_not_at_all_and_old_records_still_validate(project):
    store, pid, session = project
    runner, tools, config = stack(project, Provider())
    await submit(tools, project, config, uuid4(), 'call-1')
    await settled(runner)
    await runner.close()
    recorded = store.snapshot(pid).jobs[0].model_dump(mode='json')
    half = {key: value for key, value in recorded.items() if key != 'agentCallId'}
    with pytest.raises(ValueError):
        Job.model_validate(half)
    legacy = {key: value for key, value in recorded.items() if key not in {'agentRunId', 'agentCallId'}}
    assert Job.model_validate(legacy).agentRunId is None          # a record written before this field existed
    assert 'agentRunId' not in Job.model_validate(legacy).model_dump(mode='json')


def test_origin_can_only_be_written_by_submit_never_by_an_agent_checkpoint():
    from opendirector.agent.tools import COMMANDS
    assert 'job.checkpoint' not in COMMANDS and 'generation.submit' in COMMANDS


@pytest.mark.anyio
async def test_turn_jobs_route_resolves_job_receipt_and_failure_without_the_trace(project):
    store, pid, session = project
    runner, tools, config = stack(project, Provider())
    turn, call = uuid4(), 'cli:' + str(uuid4())
    receipt = await submit(tools, project, config, turn, call)
    await settled(runner)
    await runner.close()
    failing, failing_tools, failing_config = stack(project, Provider('fail'))
    failed_turn = uuid4()
    failed_receipt = await submit(failing_tools, project, failing_config, failed_turn, 'call-1')
    await settled(failing)
    await failing.close()
    client = lineage_client(store)
    [row] = turn_jobs(client, pid, turn)
    assert (row['jobId'], row['commandId'], row['callId'], row['status']) == (receipt['jobIds'][0], receipt['commandId'], call, 'succeeded')
    assert row['asset']['assetId'] and row['errorDetails'] is None
    assert turn_jobs(client, pid, uuid4()) == []
    [bad] = turn_jobs(client, pid, failed_turn)
    assert bad['jobId'] == failed_receipt['jobIds'][0] and bad['status'] == 'failed'
    assert bad['errorDetails']['message'] == 'provider exploded' and bad['asset'] is None
    assert (bad['recovery'], bad['resumeAllowed']) == ('review', False)


@pytest.mark.anyio
async def test_job_is_still_traced_after_the_agent_trace_file_is_deleted(project):
    store, pid, session = project
    runner, tools, config = stack(project, Provider())
    turn = uuid4()
    receipt = await submit(tools, project, config, turn, 'call-1')
    await settled(runner)
    await runner.close()
    trace = Conversations(store).path(pid) / 'agent-runs' / f'{turn}.opencode.jsonl'
    trace.parent.mkdir(parents=True, exist_ok=True)
    trace.write_text('{"debug": "tool call"}\n', encoding='utf-8')
    client = lineage_client(store)
    assert client.get(f'/api/creation/projects/{pid}/assistant/traces/{turn}/opencode').status_code == 200
    trace.unlink()
    assert client.get(f'/api/creation/projects/{pid}/assistant/traces/{turn}/opencode').status_code == 404
    [row] = turn_jobs(client, pid, turn)
    assert (row['jobId'], row['callId'], row['commandId']) == (receipt['jobIds'][0], 'call-1', receipt['commandId'])
    job = store.snapshot(pid).jobs[0]
    assert (job.agentRunId, job.agentCallId) == (turn, 'call-1')
    assert store.receipt(pid, agent_command_id(turn, 'call-1')).jobIds == (job.id,)


def test_saved_native_trace_masks_credentials_when_served(project):
    store, pid, _ = project
    turn = uuid4()
    trace = Conversations(store).path(pid) / 'agent-runs' / f'{turn}.deepseek.jsonl'
    trace.parent.mkdir(parents=True, exist_ok=True)
    fake_secret = 'sk-' + 'a' * 32
    fake_auth = 'Bearer ' + 'b' * 28
    trace.write_text(json.dumps({'text': f'value: {fake_secret}\nheader: {fake_auth}'}) + '\n'
                     + json.dumps({'text': 'normal tool receipt'}) + '\n', encoding='utf-8')

    response = lineage_client(store).get(f'/api/creation/projects/{pid}/assistant/traces/{turn}/deepseek')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert [json.loads(line)['text'] for line in response.text.splitlines()] == [
        'value: [redacted]\nheader: [redacted]', 'normal tool receipt',
    ]
    assert fake_secret in trace.read_text(encoding='utf-8')


@pytest.mark.anyio
async def test_turn_jobs_route_order_does_not_depend_on_stored_order(project, monkeypatch):
    store, pid, session = project
    runner, tools, config = stack(project, Provider())
    turn = uuid4()
    for call in ('call-a', 'call-b', 'call-c'):
        await submit(tools, project, config, turn, call)
    await settled(runner)
    await runner.close()
    client = lineage_client(store)
    expected = [row['callId'] for row in turn_jobs(client, pid, turn)]
    assert expected == ['call-a', 'call-b', 'call-c']      # creation order
    original = CreationProjects.snapshot
    monkeypatch.setattr(CreationProjects, 'snapshot',
                        lambda self, project_id: (lambda s: s.model_copy(update={'jobs': tuple(reversed(s.jobs))}))(original(self, project_id)))
    assert [row['callId'] for row in turn_jobs(client, pid, turn)] == expected


def test_turn_jobs_route_uses_the_application_error_for_an_unknown_project(project):
    store, pid, session = project
    response = lineage_client(store).get(jobs_url(uuid4(), uuid4()))
    assert response.status_code == 404
    assert response.json()['code']


@pytest.mark.anyio
async def test_lineage_reads_never_write_or_start_work(project):
    store, pid, session = project
    provider = Provider()
    runner, tools, config = stack(project, provider)
    turn = uuid4()
    await submit(tools, project, config, turn, 'call-1')
    await settled(runner)
    await runner.close()
    client = lineage_client(store)
    before, calls, cursor = commit_files(store), len(provider.calls), store.snapshot(pid).eventCursor
    for _ in range(3):
        turn_jobs(client, pid, turn)
        store.receipt(pid, agent_command_id(turn, 'call-1'))
    assert (commit_files(store), len(provider.calls), store.snapshot(pid).eventCursor) == (before, calls, cursor)
    assert runner.jobs == {}
