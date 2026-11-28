"""Guide recovery uses the committed inputs of the original job."""
import asyncio
from uuid import UUID, uuid4

import pytest

from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.input_rules import input_rules
from opendirector.infrastructure.model_configs import ModelConfigs
from test_creation_assembly import upload_source
from test_creation_canvas_service import media, project, send, ver


@pytest.fixture
def anyio_backend():
    return 'asyncio'


class RecordingProvider:
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.finish = asyncio.Event()
        self.output = None

    def validate(self, kind, config):
        assert kind == 'video'

    async def generate(self, config, task, submitted):
        self.calls.append(task)
        self.started.set()
        await self.finish.wait()
        return 'mp4', self.output


@pytest.fixture
def service(project):
    store, _, _ = project
    configs = ModelConfigs(store.local.repository)
    url, model = 'http://127.0.0.1:12345/v1', 'FastH3-Omni'
    caps = input_rules(dict(kind='video', url=url, modelId=model, protocol='vllm_omni',
                           connectionType='self_hosted'))['videoCapabilities']

    def saved(*, enabled, identity=None):
        return configs.save('video', url, model, '', identity, connection_type='self_hosted', protocol='vllm_omni',
            auth_mode='none', capability_auto_check=False, video_capabilities={**caps, 'timelineGuides': enabled})

    config = saved(enabled=True)
    provider = RecordingProvider()
    return CreationGeneration(store, configs, provider), config, saved


def prepare_job(project, service, tmp_path, *, guided):
    store, project_id, session = project
    runner, config, _ = service
    item, spec = media(project, 'video', title='Continuation step', purpose='generation')
    operations = []
    guide = None
    parameters = {'videoMode': 'reference'}
    if guided:
        source, guide = upload_source(project, tmp_path, 'video', seconds=3)
        guide_id = uuid4()
        parameters = {'videoMode': 'reference', 'h3Segment': {'guideReferenceId': str(guide_id), 'sourceFrames': [2, 0]}}
        operations.append(dict(type='reference.add', payload=dict(reference=dict(id=guide_id, projectId=project_id,
            targetSpecId=spec.id, binding='follow_current', source=dict(id=source.id)))))
    operations.insert(0, dict(type='generationSpec.update', payload=dict(spec={**spec.model_dump(),
        'prompt': 'Animate a colored block', 'modelConfigId': UUID(config['id']), 'parameters': parameters})))
    receipt = send(store, project_id, 'creation.batch', session=session, versions=[ver('generation_spec', spec)], operations=operations)
    assert receipt.status == 'applied', receipt
    current = store.snapshot(project_id)
    item = next(i for i in current.canvasItems if i.id == item.id)
    spec = next(s for s in current.generationSpecs if s.id == spec.id)
    command = parse_command(dict(commandId=uuid4(), projectId=project_id, type='generation.submit',
        expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
    receipt = runner.prepare(command, session=session)
    assert receipt.status == 'accepted', receipt
    return runner.get_job(project_id, receipt.jobIds[0]), item, guide


@pytest.mark.anyio
@pytest.mark.requires_ffmpeg
async def test_recovery_keeps_the_frozen_guide_after_source_is_rebound(project, service, tmp_path):
    store, project_id, session = project
    runner, _, _ = service
    job, _, guide = prepare_job(project, service, tmp_path, guided=True)
    reference = job.inputSnapshot.timeline_guide()
    assert reference.asset == asset_ref(guide)
    _, replacement = upload_source(project, tmp_path, 'video')
    source = next(item for item in store.snapshot(project_id).canvasItems if item.id == reference.sourceVersion.id)
    receipt = send(store, project_id, 'canvas.materialize', session=session, versions=[ver('canvas_item', source)],
                   itemId=source.id, asset=asset_ref(replacement))
    assert receipt.status == 'applied', receipt
    try:
        await runner.recover(str(project_id), str(job.id))
        await asyncio.wait_for(runner.provider.started.wait(), timeout=10)
        assert runner.provider.calls[0]['h3Guide'] == {'assetId': str(guide.id), 'frames': (2, 0)}
        assert runner.get_job(project_id, job.id).inputSnapshot.timeline_guide() == reference
    finally:
        await runner.close()


@pytest.mark.anyio
@pytest.mark.requires_ffmpeg
@pytest.mark.parametrize('changed', ['source_bytes', 'deployment'])
async def test_recovery_blocks_unverifiable_guides_before_provider_call(project, service, tmp_path, changed):
    _, project_id, session = project
    runner, config, save = service
    job, _, guide = prepare_job(project, service, tmp_path, guided=True)
    if changed == 'source_bytes':
        (runner.directory(project_id) / 'assets' / str(guide.id)).write_bytes(b'not the frozen guide')
        command = parse_command(dict(commandId=uuid4(), projectId=project_id, type='job.recover',
            expectedVersions=[ver('job', job)], payload=dict(jobId=job.id)))
        receipt = await runner.execute(command, session=session)
        assert receipt.status == 'rejected' and receipt.issues[0].code == 'reference_invalid', receipt
    else:
        save(enabled=False, identity=config['id'])
    await runner.recover(str(project_id), str(job.id))
    await asyncio.gather(*(worker.future for worker in runner.jobs.values()))
    stopped = runner.get_job(project_id, job.id)
    assert stopped.status == 'interrupted' and stopped.recovery == 'review' and not stopped.resumeAllowed
    assert stopped.errorDetails.category == 'reference' and stopped.errorDetails.stage == 'prepare'
    assert stopped.inputSnapshot.timeline_guide().asset == asset_ref(guide)
    assert not runner.provider.calls


@pytest.mark.anyio
async def test_recovery_cannot_resume_an_old_unguided_job_as_a_required_step(project, service, tmp_path):
    _, project_id, _ = project
    runner, _, _ = service
    job, item, _ = prepare_job(project, service, tmp_path, guided=False)
    assert job.inputSnapshot.workflowGuide is None
    protect_job(project, item)
    await runner.recover(str(project_id), str(job.id))
    stopped = runner.get_job(project_id, job.id)
    assert stopped.status == 'interrupted' and stopped.recovery == 'review'
    assert stopped.errorDetails.category == 'reference' and item.title in stopped.errorDetails.message
    assert not runner.provider.calls


def protect_job(project, item):
    store, project_id, session = project
    group, timeline, editor = uuid4(), uuid4(), uuid4()
    receipt = send(store, project_id, 'creation.batch', session=session, versions=[ver('canvas_item', item)], operations=[
        dict(type='editor.create', payload=dict(document=dict(id=editor, projectId=project_id, kind='timeline',
            data=dict(width=960, height=544, fps=24, tracks=[dict(id='visual', title='Visual', kind='visual')])))),
        dict(type='canvas.show', payload=dict(item=dict(id=timeline, projectId=project_id, kind='timeline',
            binding=dict(role='editor', objectRef=dict(id=editor, kind='timeline'))))),
        dict(type='canvas.show', payload=dict(item=dict(id=group, projectId=project_id, kind='group',
            assembly=dict(timelineItemId=timeline, outputItemId=uuid4(), requireTimelineGuides=True,
                          clips=[dict(itemId=item.id, inFrame=0, outFrame=24)])))),
        dict(type='canvas.update', payload=dict(itemId=item.id, parentId=group)),
    ])
    assert receipt.status == 'applied', receipt


def test_explicit_h3_segment_needs_a_guide_or_a_planned_anchor(project, service, tmp_path):
    store, project_id, session = project
    runner, _, _ = service
    ordinary, item, _ = prepare_job(project, service, tmp_path, guided=False)
    spec = ordinary.inputSnapshot.spec
    changed = {**spec.model_dump(mode='json'), 'parameters': {**spec.parameters.model_dump(mode='json'), 'h3Segment': {}}}
    assert send(store, project_id, 'generationSpec.update', session=session,
                versions=[ver('generation_spec', spec)], spec=changed).status == 'applied'
    spec = next(s for s in store.snapshot(project_id).generationSpecs if s.id == spec.id)
    command = parse_command(dict(commandId=uuid4(), projectId=project_id, type='generation.submit',
        expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
    rejected = runner.prepare(command, session=session)
    issue, = rejected.issues
    assert rejected.status == 'rejected' and issue.objectId == item.id and issue.code == 'reference_invalid', rejected
    assert store.snapshot(project_id).jobs == (ordinary,)


@pytest.mark.anyio
@pytest.mark.requires_ffmpeg
async def test_an_old_unguided_job_can_finish_without_being_adopted_after_protection(project, service, tmp_path):
    store, project_id, _ = project
    runner, _, _ = service
    job, item, _ = prepare_job(project, service, tmp_path, guided=False)
    _, output = upload_source(project, tmp_path, 'video')
    try:
        await runner.recover(str(project_id), str(job.id))
        await asyncio.wait_for(runner.provider.started.wait(), timeout=10)
        worker = runner.jobs[str(job.id)].future
        protect_job(project, item)
        runner.provider.output = (runner.directory(project_id) / 'assets' / str(output.id)).read_bytes()
        runner.provider.finish.set()
        await asyncio.wait_for(worker, timeout=10)
        completed = runner.get_job(project_id, job.id)
        assert completed.status == 'succeeded' and not completed.adopted and completed.asset is not None
        current = next(s for s in store.snapshot(project_id).generationSpecs if s.id == job.inputSnapshot.spec.id)
        assert current.currentResultId is None
    finally:
        await runner.close()
