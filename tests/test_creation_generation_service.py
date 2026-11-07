"""Provider doubles exercise the real durable runtime, files and restart path."""
import asyncio
from uuid import UUID, uuid4

import pytest

from opendirector.application.creation_canvas import resolved_inputs
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.commands import parse_command
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
async def test_hidden_source_generation_frozen_history_restart_and_idempotent_command(project):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    source, asset = text_material(project)
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
    target, spec = snapshot.canvasItems[-1], snapshot.generationSpecs[-1]
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
    receipt = await runner.execute(command, session=session)
    assert receipt.status == 'accepted', receipt
    await asyncio.wait_for(provider.started.wait(), 3)
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', source)], itemId=source.id).status == 'applied'
    # Closing the canvas item is unrelated to the accepted task's lifetime.
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', target)], itemId=target.id).status == 'applied'
    provider.finish.set()
    await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
    snapshot = store.snapshot(pid)
    assert snapshot.jobs[0].status == 'succeeded', snapshot.jobs[0]
    assert not snapshot.jobs[0].adopted  # Hiding the source changed the current inputs.
    assert len(snapshot.results) == 1
    assert snapshot.jobs[0].inputSnapshot.references[0].asset.assetId == asset.id
    assert snapshot.generationSpecs[-1] == spec
    assert not any(i.visible for i in snapshot.canvasItems)
    assert (await runner.execute(command, session=session)) == receipt
    assert len(provider.calls) == 1
    await runner.close()
    from opendirector.infrastructure.creation_projects import CreationProjects
    from opendirector.infrastructure.local_projects import LocalProjects
    reopened = CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)
    assert reopened == snapshot
    assert len(reopened.canvasItems) == 2  # No per-request execution node.


@pytest.mark.anyio
async def test_hiding_mentioned_source_during_generation_preserves_spec_and_candidate(project):
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
        assert not snapshot.jobs[0].adopted
        assert snapshot.jobs[0].inputSnapshot.references[0].asset.assetId == asset.id
        assert snapshot.generationSpecs[-1] == spec
        assert len(snapshot.results) == 1
        assert len(provider.calls) == 1
    finally:
        provider.finish.set()
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
