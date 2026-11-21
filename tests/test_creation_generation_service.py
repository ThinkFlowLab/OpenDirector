"""Provider doubles exercise the real durable runtime, files and restart path."""
import asyncio
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from opendirector.application.creation_canvas import resolved_inputs
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.model_configs import ModelConfigs
from test_creation_canvas_service import project, media, send, text_material, ver


@pytest.fixture
def anyio_backend():
    return 'asyncio'


class Provider:
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.finish = asyncio.Event()

    def validate(self, kind, config):
        pass

    async def generate(self, config, task, submitted):
        self.calls.append(task)
        self.started.set()
        await self.finish.wait()
        return 'md', b'Actual generated text'


def runtime(project, provider):
    store, _, _ = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('agent', 'http://127.0.0.1:12345/v1', 'test-agent', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none')
    return CreationGeneration(store, configs, provider), config


def configure(project, config):
    store, pid, session = project
    target, spec = media(project)
    changed = spec.model_copy(update={'prompt': 'Use the source', 'modelConfigId': UUID(config['id'])})
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)], spec=changed).status == 'applied'
    return target, store.snapshot(pid).generationSpecs[-1]


def submit(project, target, spec):
    _, pid, _ = project
    return parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))


def request_cancel(store, pid, job):
    """Commit the durable stop intent directly, as job.cancel does before stopping."""
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='job.cancel',
        expectedVersions=[ver('job', job)], payload=dict(jobId=job.id)))
    def mark(before):
        current = next(j for j in before.jobs if j.id == job.id)
        if current.status in {'succeeded', 'cancelled'}:
            return before
        changed = current.model_copy(update={'cancelRequested': True, 'revision': current.revision + 1})
        return before.model_copy(update={'jobs': tuple(changed if j.id == changed.id else j for j in before.jobs)})
    return store.commit(command, mark, source='background')


@pytest.mark.anyio
@pytest.mark.parametrize('title', ['Output.md', 'Output.md.md'])
async def test_result_registration_uses_one_extension_when_the_node_title_has_one(project, title):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    try:
        target, spec = configure(project, config)
        assert send(store, pid, 'generationSpec.update', session=session,
            versions=[ver('generation_spec', spec)], spec=spec.model_copy(update={'prompt': title})).status == 'applied'
        spec = store.snapshot(pid).generationSpecs[-1]
        provider.finish.set()
        command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
            expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
            payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
        assert (await runner.execute(command, session=session)).status == 'accepted'
        await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
        snapshot = store.snapshot(pid)
        assert snapshot.jobs[0].status == 'succeeded'
        assert len(snapshot.assets) == 1
        assert snapshot.assets[0].name == 'Output.md'
    finally:
        await runner.close()


@pytest.mark.anyio
@pytest.mark.parametrize('hide_source_during', [False, True])
async def test_hidden_source_generation_frozen_history_restart_and_idempotent_command(project, hide_source_during):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    source, asset = text_material(project)
    assert send(store, pid, 'canvas.hide', session=session,
        versions=[ver('canvas_item', source)], itemId=source.id).status == 'applied'
    target, spec = configure(project, config)
    ref_id = uuid4()
    assert send(store, pid, 'reference.add', session=session,
        versions=[ver('canvas_item', target), ver('generation_spec', spec)],
        reference=dict(id=ref_id, projectId=pid, binding='follow_current', source=dict(id=source.id), targetSpecId=spec.id)).status == 'applied'
    spec = store.snapshot(pid).generationSpecs[-1]
    assert send(store, pid, 'generationSpec.setPrompt', session=session, versions=[ver('generation_spec', spec)],
        specId=spec.id, prompt='Use ', promptContent=[dict(type='text', text='Use '),
            dict(type='reference', referenceId=ref_id)]).status == 'applied'
    snapshot = store.snapshot(pid)
    # Restore the original acceptance scenario: the source remains hidden
    # when the job is accepted, and its active reference is a real input.
    assert resolved_inputs(snapshot, spec.id)[0].asset.assetId == asset.id
    from opendirector.application.creation_canvas import current_generation_inputs
    assert current_generation_inputs(snapshot, snapshot.generationSpecs[-1], None)[1][0].asset.assetId == asset.id
    assert not snapshot.canvasItems[0].visible
    target, spec = snapshot.canvasItems[-1], snapshot.generationSpecs[-1]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
    receipt = await runner.execute(command, session=session)
    assert receipt.status == 'accepted', receipt
    await asyncio.wait_for(provider.started.wait(), 3)
    frozen = store.snapshot(pid).jobs[0].inputSnapshot
    # Closing the canvas item is unrelated to the accepted task's lifetime.
    if hide_source_during:
        source = store.snapshot(pid).canvasItems[0]
        assert send(store, pid, 'canvas.show', session=session,
            versions=[ver('canvas_item', source)], item=source).status == 'applied'
        source = store.snapshot(pid).canvasItems[0]
        assert send(store, pid, 'canvas.hide', session=session,
            versions=[ver('canvas_item', source)], itemId=source.id).status == 'applied'
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', target)], itemId=target.id).status == 'applied'
    provider.finish.set()
    await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
    snapshot = store.snapshot(pid)
    assert snapshot.jobs[0].status == 'succeeded', snapshot.jobs[0]
    assert snapshot.jobs[0].adopted
    assert snapshot.jobs[0].inputSnapshot == frozen
    assert len(snapshot.results) == 1
    assert snapshot.jobs[0].inputSnapshot.references[0].asset.assetId == asset.id
    assert snapshot.generationSpecs[-1] == spec.model_copy(update={
        'revision': spec.revision + 1, 'currentResultId': snapshot.results[0].id})
    assert not any(i.visible for i in snapshot.canvasItems)
    assert snapshot.references[0].active and snapshot.references[0].source.id == source.id
    assert (await runner.execute(command, session=session)) == receipt
    assert len(provider.calls) == 1
    await runner.close()
    from opendirector.infrastructure.creation_projects import CreationProjects
    from opendirector.infrastructure.local_projects import LocalProjects
    reopened = CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)
    assert reopened == snapshot
    assert len(reopened.canvasItems) == 2  # No per-request execution node.


@pytest.mark.anyio
@pytest.mark.parametrize('binding', ['follow_current', 'pinned'])
@pytest.mark.parametrize('hidden_by', ['source', 'group'])
async def test_hidden_reference_keeps_structured_prompt_and_real_frozen_input(project, binding, hidden_by):
    from opendirector.application.creation_canvas import asset_ref, current_generation_inputs
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    try:
        source, asset = text_material(project, text='中文 source body')
        target, spec = configure(project, config)
        ref_id = uuid4()
        reference = dict(id=ref_id, projectId=pid, binding=binding, targetSpecId=spec.id,
            source=dict(id=source.id) if binding == 'follow_current' else asset_ref(asset))
        if binding == 'pinned': reference['sourceVersion'] = ver('canvas_item', source)
        assert send(store, pid, 'reference.add', session=session,
            versions=[ver('canvas_item', target), ver('generation_spec', spec)], reference=reference).status == 'applied'
        spec = store.snapshot(pid).generationSpecs[-1]
        assert send(store, pid, 'generationSpec.setPrompt', session=session,
            versions=[ver('generation_spec', spec)], specId=spec.id, prompt='Use @Source',
            promptContent=[dict(type='text', text='Use '), dict(type='reference', referenceId=ref_id)]).status == 'applied'
        hidden = source
        if hidden_by == 'group':
            parent_id = uuid4()
            assert send(store, pid, 'creation.batch', session=session,
                versions=[ver('canvas_item', source)], operations=[
                    dict(type='canvas.show', payload=dict(item=dict(id=parent_id, projectId=pid, kind='group'))),
                    dict(type='canvas.update', payload=dict(itemId=source.id, parentId=parent_id))]).status == 'applied'
            hidden = next(item for item in store.snapshot(pid).canvasItems if item.id == parent_id)
        assert send(store, pid, 'canvas.hide', session=session,
            versions=[ver('canvas_item', hidden)], itemId=hidden.id).status == 'applied'
        snapshot = store.snapshot(pid)
        spec = snapshot.generationSpecs[-1]
        effective, references = current_generation_inputs(snapshot, spec, None, visible=set())
        assert effective == spec and effective.promptContent[-1].referenceId == ref_id
        assert len(references) == 1 and references[0].asset.assetId == asset.id
        target = next(item for item in snapshot.canvasItems if item.id == target.id)
        provider.finish.set()
        command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
            expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
            payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
        assert (await runner.execute(command, session=session)).status == 'accepted'
        await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
        job = store.snapshot(pid).jobs[0]
        assert job.status == 'succeeded' and job.adopted
        assert job.inputSnapshot.spec.promptContent[-1].referenceId == ref_id
        assert job.inputSnapshot.references[0].asset.fingerprint == asset.fingerprint
        assert provider.calls[0]['referenceIds'] == [str(asset.id)]
        assert provider.calls[0]['promptContent'][-1]['assetId'] == str(asset.id)
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_changed_intent_retains_candidate_without_overwriting_edits(project):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    target, spec = configure(project, config)
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
    assert (await runner.execute(command, session=session)).status == 'accepted'
    await asyncio.wait_for(provider.started.wait(), 3)
    current = store.snapshot(pid).generationSpecs[-1]
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', current)],
        spec=current.model_copy(update={'prompt': 'My newer edit'})).status == 'applied'
    provider.finish.set()
    await asyncio.gather(*(j.future for j in list(runner.jobs.values())))
    snapshot = store.snapshot(pid)
    assert snapshot.jobs[0].status == 'succeeded', snapshot.jobs[0]
    assert not snapshot.jobs[0].adopted
    assert snapshot.generationSpecs[-1].prompt == 'My newer edit'
    assert snapshot.generationSpecs[-1].currentResultId is None
    assert len(snapshot.results) == len(snapshot.assets) == 1
    await runner.close()


def test_plain_text_video_freezes_effective_mode_without_rewriting_intent(project):
    store, pid, session = project
    provider = Provider()
    runner, _ = runtime(project, provider)
    config = runner.configs.save('video', 'http://127.0.0.1:12345/v1', 'standard-video-fixture', '',
        connection_type='self_hosted', protocol='vllm_omni', auth_mode='none', video_adapter='standard',
        video_capabilities={'outputs': [{'resolution': '480P', 'width': 832, 'height': 480, 'durations': [5]}],
                            'defaultResolution': '480P', 'defaultDuration': 5, 'dimensionStep': 2})
    target, spec = media(project, 'video')
    spec = spec.model_copy(update={'prompt': 'A blue sky', 'modelConfigId': UUID(config['id']),
        'parameters': spec.parameters.model_copy(update={'videoMode': 'reference', 'resolution': '480P'})})
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)], spec=spec).status == 'applied'
    before = store.snapshot(pid)
    spec, target = before.generationSpecs[-1], before.canvasItems[-1]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('generation_spec', spec), ver('canvas_item', target)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
    receipt = runner.prepare(command, session=session)
    assert receipt.status == 'accepted', receipt
    after = store.snapshot(pid)
    assert after.generationSpecs[-1].parameters.videoMode == 'reference'
    job = after.jobs[-1]
    assert job.inputSnapshot.spec.parameters.videoMode == 'first_frame'
    assert runner.task(job)['videoMode'] == 'first_frame'
    assert job.execution.size == '832x480'
    assert job.execution.durationSeconds == 5
    assert runner.prepare(command, session=session) == receipt
    assert len(store.snapshot(pid).jobs) == 1


@pytest.mark.anyio
async def test_hiding_mentioned_source_during_generation_preserves_spec_and_adoption(project):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    try:
        source, asset = text_material(project)
        target, spec = configure(project, config)
        ref_id = uuid4()
        assert send(store, pid, 'reference.add', session=session,
            versions=[ver('canvas_item', target), ver('generation_spec', spec)],
            reference=dict(id=ref_id, projectId=pid, binding='follow_current',
                source=dict(id=source.id), targetSpecId=spec.id)).status == 'applied'
        spec = store.snapshot(pid).generationSpecs[-1]
        assert send(store, pid, 'generationSpec.setPrompt', session=session,
            versions=[ver('generation_spec', spec)], specId=spec.id,
            prompt='Use ', promptContent=[dict(type='text', text='Use '),
                dict(type='reference', referenceId=ref_id)]).status == 'applied'
        spec = store.snapshot(pid).generationSpecs[-1]
        target = next(item for item in store.snapshot(pid).canvasItems if item.id == target.id)
        command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
            expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
            payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
        assert (await runner.execute(command, session=session)).status == 'accepted'
        await asyncio.wait_for(provider.started.wait(), 3)
        assert send(store, pid, 'canvas.hide', session=session,
            versions=[ver('canvas_item', source)], itemId=source.id).status == 'applied'
        provider.finish.set()
        await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
        snapshot = store.snapshot(pid)
        assert snapshot.jobs[0].status == 'succeeded'
        assert snapshot.jobs[0].adopted
        assert snapshot.jobs[0].inputSnapshot.references[0].asset.assetId == asset.id
        assert snapshot.generationSpecs[-1] == spec.model_copy(update={
            'revision': spec.revision + 1, 'currentResultId': snapshot.results[0].id})
        assert len(snapshot.results) == 1
        assert len(provider.calls) == 1
    finally:
        provider.finish.set()
        await runner.close()


@pytest.mark.anyio
async def test_checkpoint_reconciles_cancellation_committed_between_read_and_write(project, monkeypatch):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    target, spec = configure(project, config)
    receipt = runner.prepare(submit(project, target, spec), session=session)
    assert receipt.status == 'accepted', receipt
    running = runner.task(store.snapshot(pid).jobs[0])
    running.update(status='running', phase='queued')
    runner.checkpoint(pid, running, runner.directory(pid))
    stale = runner.task(store.snapshot(pid).jobs[0])
    stale.update(status='running', phase='submit')
    original = runner.projects.commit
    commits = []
    def injecting(work, apply, **kwargs):
        if work.type == 'job.checkpoint':
            commits.append(work)
            if len(commits) == 1:
                current = store.snapshot(pid).jobs[0]
                request_cancel(store, pid, current)
        return original(work, apply, **kwargs)
    monkeypatch.setattr(runner.projects, 'commit', injecting)
    runner.checkpoint(pid, stale, runner.directory(pid))
    final = store.snapshot(pid).jobs[0]
    assert final.status == 'running' and final.cancelRequested
    assert final.errorDetails is None
    assert len(commits) == 2, 'the stale save was rejected once and then retried'
    assert provider.calls == []
    await runner.close()


@pytest.mark.anyio
async def test_checkpoint_keeps_terminal_cancellation_against_a_stale_worker(project):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    target, spec = configure(project, config)
    receipt = runner.prepare(submit(project, target, spec), session=session)
    assert receipt.status == 'accepted', receipt
    request_cancel(store, pid, store.snapshot(pid).jobs[0])
    cancelled = runner.task(store.snapshot(pid).jobs[0])
    cancelled.update(status='cancelled', recovery='review', resumeAllowed=False)
    runner.checkpoint(pid, cancelled, runner.directory(pid))
    before = store.snapshot(pid).jobs[0]
    assert before.status == 'cancelled' and before.cancelRequested
    stale = runner.task(before)
    stale.update(status='running', phase='submit', recovery='submit', resumeAllowed=True)
    runner.checkpoint(pid, stale, runner.directory(pid))
    after = store.snapshot(pid).jobs[0]
    assert after.status == 'cancelled'
    assert after == before
    assert provider.calls == []
    await runner.close()


@pytest.mark.anyio
async def test_checkpoint_leaves_a_succeeded_job_unchanged(project):
    store, pid, session = project
    provider = Provider()
    provider.finish.set()
    runner, config = runtime(project, provider)
    target, spec = configure(project, config)
    receipt = await runner.execute(submit(project, target, spec), session=session)
    assert receipt.status == 'accepted', receipt
    await asyncio.gather(runner.jobs[str(receipt.jobIds[0])].future, return_exceptions=True)
    succeeded = store.snapshot(pid).jobs[0]
    assert succeeded.status == 'succeeded'
    stale = runner.task(succeeded)
    stale.update(status='running', phase='submit', recovery='submit', resumeAllowed=True)
    runner.checkpoint(pid, stale, runner.directory(pid))
    assert store.snapshot(pid).jobs[0] == succeeded
    await runner.close()


@pytest.mark.anyio
async def test_checkpoint_does_not_retry_an_unrelated_rejection(project, monkeypatch):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    target, spec = configure(project, config)
    receipt = runner.prepare(submit(project, target, spec), session=session)
    assert receipt.status == 'accepted', receipt
    calls = []
    def rejecting(work, apply, **kwargs):
        calls.append(work)
        return SimpleNamespace(status='rejected', issues=(SimpleNamespace(code='invalid_input'),))
    monkeypatch.setattr(runner.projects, 'commit', rejecting)
    task = runner.task(store.snapshot(pid).jobs[0])
    task.update(status='running', phase='submit')
    with pytest.raises(ProjectError) as failure:
        runner.checkpoint(pid, task, runner.directory(pid))
    assert failure.value.status == 409
    assert len(calls) == 1
    assert store.snapshot(pid).jobs[0].status == 'queued'
    await runner.close()


@pytest.mark.anyio
async def test_cancel_committed_during_submit_checkpoint_does_not_fail_or_call_provider(project, monkeypatch):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    target, spec = configure(project, config)
    original = runner.projects.commit
    loop = asyncio.get_running_loop()
    ready = asyncio.Event()
    injected, cancels, worker = {'done': False, 'conflicts': 0}, [], {}
    def injecting(work, apply, **kwargs):
        if work.type == 'job.checkpoint' and work.payload.job.phase == 'submit' and not injected['done']:
            injected['done'] = True
            current = store.snapshot(pid).jobs[0]
            request_cancel(store, pid, current)
            worker['future'] = runner.jobs[str(current.id)].future
            loop.call_soon_threadsafe(lambda: cancels.append(asyncio.ensure_future(
                runner.cancel(str(pid), str(current.id), session))))
            loop.call_soon_threadsafe(ready.set)
        receipt = original(work, apply, **kwargs)
        if work.type == 'job.checkpoint' and receipt.status == 'rejected':
            injected['conflicts'] += 1
        return receipt
    monkeypatch.setattr(runner.projects, 'commit', injecting)
    receipt = await runner.execute(submit(project, target, spec), session=session)
    assert receipt.status == 'accepted', receipt
    await asyncio.wait_for(ready.wait(), 5)
    await asyncio.gather(worker['future'], return_exceptions=True)
    await asyncio.gather(*cancels, return_exceptions=True)
    final = store.snapshot(pid).jobs[0]
    assert final.status == 'cancelled', final
    assert final.cancelRequested and final.errorDetails is None
    assert injected['done'] and injected['conflicts'] >= 1
    assert provider.calls == []
    assert not store.snapshot(pid).results
    await runner.close()


@pytest.mark.anyio
async def test_stale_checkpoint_preserves_the_saved_remote_identity_after_cancellation(project):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    target, spec = configure(project, config)
    assert runner.prepare(submit(project, target, spec), session=session).status == 'accepted'
    stale = runner.task(store.snapshot(pid).jobs[0])
    remote = dict(stale, status='running', phase='poll', externalTaskId='remote-accepted-1')
    runner.checkpoint(pid, remote, runner.directory(pid))
    request_cancel(store, pid, store.snapshot(pid).jobs[0])
    stopped = runner.task(store.snapshot(pid).jobs[0])
    stopped.update(status='cancelled', recovery='remote', resumeAllowed=False)
    runner.checkpoint(pid, stopped, runner.directory(pid))
    before = store.snapshot(pid).jobs[0]
    stale.update(status='running', phase='submit', externalTaskId=None)
    runner.checkpoint(pid, stale, runner.directory(pid))
    after = store.snapshot(pid).jobs[0]
    assert after == before
    assert after.externalTaskId == 'remote-accepted-1'
    assert provider.calls == []
    await runner.close()
