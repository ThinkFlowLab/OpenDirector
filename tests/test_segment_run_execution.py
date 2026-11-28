import asyncio
from contextlib import nullcontext
from threading import Event
from types import SimpleNamespace
from uuid import uuid4, uuid5

import pytest

from opendirector.application.creation_segment_run import SegmentRunExecutor
from opendirector.domain.creation.assets import AssetRef
from opendirector.domain.creation.canvas import GroupAssembly
from opendirector.domain.creation.segment_run import SegmentRunPlan
from opendirector.domain.generation import GenerationFailure
from opendirector.domain.projects import ProjectError


def record(**fields):
    return SimpleNamespace(**fields)


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture
def run(tmp_path):
    pid, gid, origin, spec, timeline, document, output = (uuid4() for _ in range(7))
    source = AssetRef(assetId=uuid4(), revision=1, fingerprint='sha256:' + 64 * 'a', kind='video')
    plan = SegmentRunPlan(source=source, fps=24, frameCount=5,
        entries=[dict(kind='source', sourceStart=0, sourceEnd=2),
                 dict(kind='generated', sourceStart=2, sourceEnd=5, itemId=origin, shot='first',
                      step={'kind': 'anchor'})])
    assembly = GroupAssembly(timelineItemId=timeline, outputItemId=output,
        clips=[dict(itemId=origin, inFrame=0, outFrame=3)])
    origin_node = record(id=origin, kind='video', revision=1,
        binding=record(role='generation', objectRef=record(id=spec), materialOverride=None))
    group = record(id=gid, kind='group', revision=1, runPlan=plan, runDefinitionId=None, assembly=assembly)
    timeline_node = record(id=timeline, kind='timeline', revision=1, binding=record(objectRef=record(id=document)))
    spec_record = record(id=spec, revision=1, currentResultId=None)
    snapshot = record(canvasItems=[group, origin_node, timeline_node], generationSpecs=[spec_record],
                      editorDocuments=[record(id=document, revision=1)], assets=[], results=[])
    projects = record(state_dir=tmp_path.resolve(), local=record(transaction=lambda: nullcontext(None)),
        snapshot=lambda project_id: snapshot, _find=lambda _, project_id: (tmp_path, None),
        _lease=lambda _, project_id, path, session: None)
    return record(projects=projects, snapshot=snapshot, pid=pid, gid=gid,
                  origin=origin, spec=spec_record, output=output)


class RecordingGeneration:
    """Model an accepted business job whose response is lost on shutdown."""
    def __init__(self, run, *, outcome='complete'):
        self.run = run
        self.outcome = outcome
        self.jobs = {}
        self.accepted = {}
        self.commands = []
        self.provider_calls = 0
        self.started = asyncio.Event()

    async def execute(self, command, *, source, run_execution_id):
        assert source == 'background' and command.payload.batchId == run_execution_id
        self.commands.append(command)
        if command.commandId in self.accepted:
            return self.accepted[command.commandId][0]
        self.provider_calls += 1
        job_id = uuid5(command.commandId, 'job')
        asset = AssetRef(assetId=uuid4(), revision=1, kind='video', fingerprint='sha256:' + 64 * 'b')
        receipt = record(status='accepted', jobIds=[job_id])
        job = record(id=job_id, originItemId=self.run.origin, batchId=command.payload.batchId,
                     status='succeeded', adopted=True, asset=asset, errorDetails=None)
        self.accepted[command.commandId] = receipt, job
        if self.outcome == 'unknown':
            job.status = 'interrupted'
            job.adopted = False
            job.resumeAllowed = False
            job.errorDetails = record(category='submission_unknown', message='Provider acceptance is unknown')
        elif self.outcome == 'unsettled':
            job.status = 'running'
            job.adopted = False
        else:
            snapshot = self.run.snapshot
            snapshot.assets.append(record(id=asset.assetId, revision=asset.revision,
                                          kind=asset.kind, fingerprint=asset.fingerprint))
            result_id = uuid4()
            snapshot.results.append(record(id=result_id, asset=asset))
            self.run.spec.currentResultId = result_id
        self.started.set()
        if self.outcome == 'complete':
            await asyncio.Event().wait()
        return receipt

    def get_job(self, project_id, job_id):
        return next((job for _, job in self.accepted.values() if str(job.id) == str(job_id)), None)

    async def recover(self, project_id, job_id):
        assert self.outcome == 'unsettled', 'A settled or unknown job should not be recovered'
        job = self.get_job(project_id, job_id)
        job.status = 'interrupted'
        job.resumeAllowed = True
        job.errorDetails = record(category='temporary', message='Polling the original provider job timed out')


async def finish(executor, run, operation):
    async with asyncio.timeout(3):
        while True:
            status = await executor.status(run.pid, operation)
            if status['status'] not in {'queued', 'running', 'pausing'}:
                return status
            await asyncio.sleep(.01)


@pytest.mark.anyio
async def test_paused_queued_run_survives_restart_and_resumes_same_execution(run):
    generation = RecordingGeneration(run, outcome='unknown')
    executor = SegmentRunExecutor(run.projects, generation)
    execution, pause_id, resume_id, session = (uuid4() for _ in range(4))
    await asyncio.to_thread(executor._accept, run.pid, run.gid, execution, session, 'start')
    try:
        paused = await executor.pause(run.pid, run.gid, session, operation_id=pause_id, input_fingerprint='pause')
        assert paused['executionId'] == str(execution)
        status = await finish(executor, run, execution)
        assert status['status'] == 'paused'
        assert status['steps'] == [{'itemId': str(run.origin), 'status': 'waiting', 'jobId': None}]
        assert generation.provider_calls == 0
    finally:
        await executor.close()

    restarted = SegmentRunExecutor(run.projects, generation)
    await restarted.start()
    try:
        assert (await restarted.latest(run.pid, run.gid))['status'] == 'paused'
        assert not restarted.workers
        with pytest.raises(ProjectError) as blocked:
            await restarted.submit(run.pid, run.gid, uuid4(), session)
        assert blocked.value.code == 'segment_run_busy'
        with pytest.raises(ProjectError) as conflict:
            await restarted.resume(run.pid, run.gid, session, operation_id=pause_id, input_fingerprint='resume')
        assert conflict.value.code == 'command_conflict'
        resumed = await restarted.resume(run.pid, run.gid, session, operation_id=resume_id, input_fingerprint='resume')
        assert resumed['executionId'] == str(execution)
        assert (await finish(restarted, run, execution))['status'] == 'needs_review'
        replayed = await restarted.resume(run.pid, run.gid, session, operation_id=resume_id, input_fingerprint='resume')
        assert replayed['executionId'] == str(execution)
        assert generation.provider_calls == 1
    finally:
        await restarted.close()


@pytest.mark.anyio
async def test_paused_old_definition_does_not_block_new_publication(run):
    generation = RecordingGeneration(run, outcome='unknown')
    executor = SegmentRunExecutor(run.projects, generation)
    previous, current, session = (uuid4() for _ in range(3))
    try:
        await asyncio.to_thread(executor._accept, run.pid, run.gid, previous, session, 'old')
        await executor.pause(run.pid, run.gid, session, operation_id=uuid4(), input_fingerprint='pause')
        assert (await finish(executor, run, previous))['status'] == 'paused'

        group = run.snapshot.canvasItems[0]
        group.runDefinitionId = uuid4()
        assert await executor.latest(run.pid, run.gid) is None
        assert (await executor.history(run.pid, run.gid))[0]['status'] == 'superseded'

        await executor.submit(run.pid, run.gid, current, session, input_fingerprint='new')
        assert (await finish(executor, run, current))['runDefinitionId'] == str(group.runDefinitionId)
        assert generation.provider_calls == 1
    finally:
        await executor.close()


@pytest.mark.anyio
@pytest.mark.parametrize('on_start', [False, True], ids=['explicit-reconcile', 'startup'])
async def test_known_disappeared_remote_task_releases_run_without_submission(run, on_start):
    generation = RecordingGeneration(run, outcome='unsettled')
    executor = SegmentRunExecutor(run.projects, generation)
    execution, session = uuid4(), uuid4()
    await executor.submit(run.pid, run.gid, execution, session)
    review = await finish(executor, run, execution)
    assert review['status'] == 'needs_review'
    payload = record(groupId=run.gid, executionId=execution)
    try:
        with pytest.raises(ProjectError) as pending:
            await executor.reconcile(run.pid, payload, session, operation_id=uuid4(), input_fingerprint='pending')
        assert pending.value.code == 'segment_run_reconciliation_pending'
        job = generation.get_job(run.pid, review['steps'][0]['jobId'])
        job.inputSnapshot = record(model=record(protocol='vllm_omni'))
        job.externalTaskId = 'video-known'
        job.errorDetails = GenerationFailure(category='input', stage='poll', httpStatus=404,
                                             message='The accepted task is missing.', suggestion='Start a new attempt.')
        job.resumeAllowed = False
        if on_start:
            await executor.close()
            executor = SegmentRunExecutor(run.projects, generation)
            await executor.start()
        else:
            operation = uuid4()
            applied = await executor.reconcile(run.pid, payload, session, operation_id=operation, input_fingerprint='closed')
            assert await executor.reconcile(run.pid, payload, session, operation_id=operation, input_fingerprint='closed') == applied
        settled = await executor.status(run.pid, execution)
        assert settled['status'] == 'failed'
        assert settled['issue']['code'] == 'segment_run_remote_missing'
        assert settled['steps'][0]['jobId'] == str(job.id)
        assert generation.provider_calls == 1
    finally:
        await executor.close()


@pytest.mark.anyio
async def test_disconnecting_start_caller_does_not_strand_the_accepted_execution(run, monkeypatch):
    generation = RecordingGeneration(run)
    executor = SegmentRunExecutor(run.projects, generation)
    operation = uuid4()
    saved, release = asyncio.Event(), Event()
    loop = asyncio.get_running_loop()
    original_accept = executor._accept

    def pause_after_write(*args):
        accepted = original_accept(*args)
        loop.call_soon_threadsafe(saved.set)
        assert release.wait(5)
        return accepted

    monkeypatch.setattr(executor, '_accept', pause_after_write)
    caller = asyncio.create_task(executor.submit(run.pid, run.gid, operation, uuid4()))
    try:
        await asyncio.wait_for(saved.wait(), 3)
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller
        assert (await executor.status(run.pid, operation))['status'] == 'queued'
        release.set()
        await asyncio.wait_for(generation.started.wait(), 3)
        status = await executor.status(run.pid, operation)
        assert status['status'] == 'running' and generation.provider_calls == 1
        assert generation.commands[0].payload.batchId == operation
    finally:
        release.set()
        await asyncio.gather(caller, return_exceptions=True)
        await executor.close()


@pytest.mark.anyio
async def test_restart_resolves_the_original_generation_receipt(run):
    generation = RecordingGeneration(run)
    executor = SegmentRunExecutor(run.projects, generation)
    operation = uuid4()
    receipt = await executor.submit(run.pid, run.gid, operation, uuid4())
    assert receipt['executionId'] == str(operation)
    await asyncio.wait_for(generation.started.wait(), 3)
    with pytest.raises(ProjectError) as conflict:
        await executor.submit(run.pid, uuid4(), operation, uuid4())
    assert conflict.value.code == 'command_conflict'
    await executor.close()

    restored = SegmentRunExecutor(run.projects, generation)
    assembled = []

    def assemble(command, *, source, run_execution_id):
        assert source == 'background' and run_execution_id == operation
        assembled.append(command)
        output_asset_id = uuid4()
        run.snapshot.assets.append(record(id=output_asset_id))
        run.snapshot.canvasItems.append(record(id=run.output,
            binding=record(role='material', objectRef=record(assetId=output_asset_id))))
        return record(status='applied', changed=[record(objectType='asset', id=output_asset_id)])

    restored.assembly.execute = assemble
    try:
        await restored.start()
        status = await finish(restored, run, operation)
        assert status['status'] == 'succeeded' and status['outputAssetId']
        assert generation.provider_calls == 1 and len(assembled) == 1
        assert len(generation.commands) == 2 and generation.commands[0] == generation.commands[1]
        assert assembled[0].payload.jobIds == (uuid5(generation.commands[0].commandId, 'job'),)
    finally:
        await restored.close()


@pytest.mark.anyio
@pytest.mark.parametrize(('outcome', 'issue'), [('unknown', 'submission_unknown'), ('unsettled', 'segment_run_job_unsettled')])
async def test_unresolved_job_stops_and_blocks_another_run_attempt(run, outcome, issue):
    generation = RecordingGeneration(run, outcome=outcome)
    executor = SegmentRunExecutor(run.projects, generation)
    operation = uuid4()
    try:
        await executor.submit(run.pid, run.gid, operation, uuid4())
        status = await finish(executor, run, operation)
        assert status['status'] == 'needs_review'
        assert status['issue']['code'] == issue
        assert status['issue']['itemId'] == str(run.origin)
        with pytest.raises(ProjectError) as conflict:
            await executor.submit(run.pid, run.gid, uuid4(), uuid4())
        assert conflict.value.code == 'segment_run_busy'
        replay = await executor.submit(run.pid, run.gid, operation, uuid4())
        assert replay == status and generation.provider_calls == 1
    finally:
        await executor.close()
