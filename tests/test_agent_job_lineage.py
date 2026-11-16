"""A job accepted for an Agent tool call keeps that call's identity in its own committed record.

The Agent trace is a debugging artifact. These tests never read it: the originating turn, call
and command are recovered from the project's committed state alone, including after a crash and
a restart. Provider doubles only; nothing leaves the process.
"""
import asyncio
import json
from uuid import UUID, uuid4, uuid5

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
from test_creation_canvas_service import media, project, send, ver  # noqa: F401  (project is a fixture)


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
