"""Keep confirmed guide requirements through canvas changes and execution."""
import asyncio
import subprocess
from uuid import UUID, uuid4

import pytest

from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.model_configs import ModelConfigs
from test_creation_assembly import upload_source
from test_creation_canvas_service import media, project, send, ver


def fresh(store, pid, collection, identity):
    return next(value for value in getattr(store.snapshot(pid), collection) if value.id == identity)


def plan(project, tmp_path, names, anchor, *, reverse=(), confirmed=True):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    model = configs.save('video', 'http://127.0.0.1:12345/v1', 'MiniMaxAI/MiniMax-H3', '',
        connection_type='self_hosted', protocol='vllm_omni', video_adapter='minimax_h3', capability_auto_check=False)
    group_id, timeline_id, document_id, output_id = (uuid4() for _ in range(4))
    _, soundtrack = upload_source(project, tmp_path, 'audio', seconds=len(names))
    steps = {name: media(project, 'video', title=f'Segment {name}', purpose='generation') for name in names}
    clips = [dict(itemId=item.id, inFrame=0, outFrame=24, reverse=name in reverse)
             for name, (item, _) in steps.items()]
    operations = [
        dict(type='canvas.show', payload=dict(item=dict(id=group_id, projectId=pid, kind='group'))),
        dict(type='editor.create', payload=dict(document=dict(id=document_id, projectId=pid, kind='timeline',
            data=dict(width=32, height=32, fps=24, tracks=[
                dict(id='visual', kind='visual', title='Video'),
                dict(id='audio', kind='audio', title='Original sound', clips=[dict(id='soundtrack',
                    resource=dict(asset=asset_ref(soundtrack), title=soundtrack.name),
                    start=0, inPoint=0, outPoint=len(names))]),
            ])))),
        dict(type='canvas.show', payload=dict(item=dict(id=timeline_id, projectId=pid, kind='timeline',
            binding=dict(role='editor', objectRef=dict(id=document_id, kind='timeline'))))),
    ]
    versions = []
    for name, (item, spec) in steps.items():
        versions.extend((ver('canvas_item', item), ver('generation_spec', spec)))
        operations.extend((
            dict(type='canvas.update', payload=dict(itemId=item.id, parentId=group_id)),
            dict(type='generationSpec.update', payload=dict(spec={**spec.model_dump(), 'prompt': f'Segment {name}',
                'modelConfigId': UUID(model['id']), 'parameters': {'videoMode': 'reference', 'durationSeconds': 4}})),
        ))
    assert send(store, pid, 'creation.batch', session=session, versions=versions, operations=operations).status == 'applied'
    group = fresh(store, pid, 'canvasItems', group_id)
    recipe = dict(timelineItemId=timeline_id, outputItemId=output_id, clips=clips, requireTimelineGuides=True,
                  guideExemptItemId=steps[anchor][0].id)
    receipt = None
    if confirmed:
        receipt = send(store, pid, 'group.configureAssembly', session=session, versions=[ver('canvas_item', group)],
                       groupId=group_id, assembly=recipe)
        assert receipt.status == 'applied', receipt
    return configs, group_id, steps, recipe, receipt


def submit(project, spec_id, origin=None):
    store, pid, _ = project
    spec = fresh(store, pid, 'generationSpecs', spec_id)
    versions = [ver('generation_spec', spec)]
    if origin is not None:
        versions.append(ver('canvas_item', fresh(store, pid, 'canvasItems', origin)))
    return parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit', expectedVersions=versions,
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=origin)))


def set_guide(project, downstream, upstream, source_frames):
    store, pid, session = project
    item, spec = downstream
    origin = fresh(store, pid, 'canvasItems', item.id)
    current = fresh(store, pid, 'generationSpecs', spec.id)
    guide_id = uuid4()
    payload = {**current.model_dump(), 'parameters': {**current.parameters.model_dump(),
               'h3Segment': dict(guideReferenceId=guide_id, sourceFrames=source_frames)}}
    reference = dict(id=guide_id, projectId=pid, targetSpecId=spec.id, binding='follow_current', source=dict(id=upstream.id))
    receipt = send(store, pid, 'creation.batch', session=session,
                   versions=[ver('canvas_item', origin), ver('generation_spec', current)], operations=[
        dict(type='generationSpec.update', payload=dict(spec=payload)),
        dict(type='reference.add', payload=dict(reference=reference)),
    ])
    assert receipt.status == 'applied', receipt


def assemble(project, group_id, jobs):
    store, pid, session = project
    group = fresh(store, pid, 'canvasItems', group_id)
    timeline = fresh(store, pid, 'canvasItems', group.assembly.timelineItemId)
    editor = fresh(store, pid, 'editorDocuments', timeline.binding.objectRef.id)
    versions = [ver('canvas_item', group), ver('canvas_item', timeline), ver('editor_document', editor)]
    output = next((item for item in store.snapshot(pid).canvasItems if item.id == group.assembly.outputItemId), None)
    if output:
        versions.append(ver('canvas_item', output))
    return send(store, pid, 'group.assemble', session=session, versions=versions, groupId=group_id,
                jobIds=[job.id for job in jobs])


@pytest.mark.parametrize('mutation', ['omit', 'disable', 'clear', 'change-anchor', 'remove-step'])
def test_a_saved_guide_plan_cannot_be_weakened_by_assembly_changes(project, tmp_path, mutation):
    store, pid, session = project
    _, group_id, steps, _, _ = plan(project, tmp_path, ('A', 'B'), 'A')
    group = fresh(store, pid, 'canvasItems', group_id)
    recipe = group.assembly.model_dump()
    if mutation == 'omit':
        recipe.pop('requireTimelineGuides')
        recipe.pop('guideExemptItemId')
    elif mutation == 'disable':
        recipe.update(requireTimelineGuides=False, guideExemptItemId=None)
    elif mutation == 'clear':
        recipe = None
    elif mutation == 'change-anchor':
        recipe['guideExemptItemId'] = steps['B'][0].id
    elif mutation == 'remove-step':
        recipe['clips'] = recipe['clips'][:1]
    before = store.snapshot(pid)
    receipt = send(store, pid, 'group.configureAssembly', session=session, versions=[ver('canvas_item', group)],
                   groupId=group_id, assembly=recipe)
    assert receipt.status == 'rejected', receipt
    assert receipt.issues[0].objectId == group_id
    assert store.snapshot(pid) == before


@pytest.mark.parametrize('entry_point', ['configure', 'batch'])
def test_first_save_of_a_segmented_workflow_cannot_omit_required_guides(project, tmp_path, entry_point):
    store, pid, session = project
    _, group_id, steps, recipe, _ = plan(project, tmp_path, ('A', 'B'), 'A', confirmed=False)
    _, spec = steps['A']
    current = fresh(store, pid, 'generationSpecs', spec.id)
    segmented = {**current.model_dump(), 'parameters': {**current.parameters.model_dump(), 'h3Segment': {}}}
    assert send(store, pid, 'generationSpec.update', session=session,
                versions=[ver('generation_spec', current)], spec=segmented).status == 'applied'
    recipe.pop('requireTimelineGuides')
    recipe.pop('guideExemptItemId')
    before = store.snapshot(pid)
    if entry_point == 'configure':
        group = fresh(store, pid, 'canvasItems', group_id)
        receipt = send(store, pid, 'group.configureAssembly', session=session, versions=[ver('canvas_item', group)],
                       groupId=group_id, assembly=recipe)
    else:
        group_id = uuid4()
        members = [fresh(store, pid, 'canvasItems', item.id) for item, _ in steps.values()]
        receipt = send(store, pid, 'creation.batch', session=session,
            versions=[ver('canvas_item', item) for item in members], operations=[
                dict(type='canvas.show', payload=dict(item=dict(id=group_id, projectId=pid, kind='group', assembly=recipe))),
                *[dict(type='canvas.update', payload=dict(itemId=item.id, parentId=group_id)) for item in members],
            ])
    assert receipt.status == 'rejected' and receipt.issues[0].objectId == group_id, receipt
    assert store.snapshot(pid) == before


def test_history_cannot_remove_the_saved_guide_requirement_while_steps_remain(project, tmp_path):
    store, pid, session = project
    _, group_id, _, _, confirmed = plan(project, tmp_path, ('A', 'B'), 'A')
    before = store.snapshot(pid)
    receipt = send(store, pid, 'history.undo', session=session, targetCommandId=confirmed.commandId)
    assert receipt.status == 'rejected' and receipt.issues[0].objectId == group_id, receipt
    assert store.snapshot(pid) == before


def test_a_batch_cannot_make_a_plan_step_unguided_by_removing_its_guide_fields(project, tmp_path):
    store, pid, session = project
    configs, _, steps, _, _ = plan(project, tmp_path, ('A', 'B'), 'A')
    item, spec = steps['B']
    set_guide(project, steps['B'], steps['A'][0], (0, 21))
    current = fresh(store, pid, 'generationSpecs', spec.id)
    reference = fresh(store, pid, 'references', current.parameters.h3Segment.guideReferenceId)
    receipt = send(store, pid, 'creation.batch', session=session,
        versions=[ver('generation_spec', current), ver('reference', reference)], operations=[
            dict(type='reference.remove', payload=dict(referenceId=reference.id)),
            dict(type='generationSpec.update', payload=dict(spec={**current.model_dump(),
                'parameters': {**current.parameters.model_dump(), 'h3Segment': None}})),
        ])
    assert receipt.status == 'applied', receipt
    runner = CreationGeneration(store, configs)
    rejected = runner.prepare(submit(project, spec.id, item.id), session=session)
    assert rejected.status == 'rejected' and rejected.issues[0].objectId == item.id, rejected
    assert store.snapshot(pid).jobs == ()


def test_a_guide_plan_keeps_the_step_after_reparenting_and_rejects_a_spec_alias(project, tmp_path):
    store, pid, session = project
    configs, group_id, steps, _, _ = plan(project, tmp_path, ('A', 'B'), 'A')
    item, spec = steps['B']
    group = fresh(store, pid, 'canvasItems', group_id)
    recipe = group.assembly.model_dump()
    recipe['clips'] = tuple(reversed(recipe['clips']))
    assert send(store, pid, 'group.configureAssembly', session=session, versions=[ver('canvas_item', group)],
                groupId=group_id, assembly=recipe).status == 'applied'
    assert fresh(store, pid, 'canvasItems', group_id).assembly.guideExemptItemId == steps['A'][0].id
    current = fresh(store, pid, 'canvasItems', item.id)
    assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', current)],
                itemId=item.id, parentId=None).status == 'applied'
    alias_id = uuid4()
    assert send(store, pid, 'canvas.show', session=session, item=dict(id=alias_id, projectId=pid, kind='video',
                binding=dict(role='generation', objectRef=dict(id=spec.id)))).status == 'applied'
    runner = CreationGeneration(store, configs)
    for origin in (None, alias_id, item.id):
        receipt = runner.prepare(submit(project, spec.id, origin), session=session)
        assert receipt.status == 'rejected', receipt
    assert store.snapshot(pid).jobs == ()


class VideoProvider:
    def __init__(self, output):
        self.output = output
        self.calls = []

    def validate(self, kind, config):
        assert kind == 'video'

    async def generate(self, config, task, submitted):
        self.calls.append(task.copy())
        await submitted(f'fixture-{len(self.calls)}')
        return 'mp4', self.output


@pytest.mark.requires_ffmpeg
@pytest.mark.parametrize(('order', 'anchor', 'links'), [
    (('A', 'B', 'C', 'D', 'E'), 'B', [('A', 'B', (21, 0)), ('C', 'B', (0, 21)), ('D', 'C', (0, 21)), ('E', 'D', (0, 21))]),
    (('First', 'Next'), 'First', [('Next', 'First', (3, 24))]),
], ids=['case03-b-first', 'two-stage'])
def test_workflow_accepts_only_its_anchor_unguided_and_assembles_frozen_guide_versions(project, tmp_path, order, anchor, links):
    store, pid, session = project
    configs, group_id, steps, _, _ = plan(project, tmp_path, order, anchor, reverse=('A',))
    fixture = tmp_path / 'generated.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=32x32:r=24:d=4',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(fixture)], check=True)
    provider = VideoProvider(fixture.read_bytes())

    async def run():
        runner = CreationGeneration(store, configs, provider)
        async def generate(name):
            item, spec = steps[name]
            receipt = await runner.execute(submit(project, spec.id, item.id), session=session)
            assert receipt.status == 'accepted', receipt
            job_id, = receipt.jobIds
            worker = runner.jobs.get(str(job_id))
            if worker is not None:
                await asyncio.wait_for(worker.future, 10)
            job = fresh(store, pid, 'jobs', job_id)
            assert job.status == 'succeeded' and job.adopted, job
            assert job.inputSnapshot.workflowGuide.groupId == group_id
            assert job.inputSnapshot.workflowGuide.required == (name != anchor)
            return job

        try:
            for name, source, frames in links:
                item, spec = steps[name]
                blocked = runner.prepare(submit(project, spec.id, item.id), session=session)
                assert blocked.status == 'rejected' and blocked.issues[0].objectId == item.id, blocked
                set_guide(project, steps[name], steps[source][0], frames)
            first, _, _ = links[0]
            first_item, first_spec = steps[first]
            assert runner.prepare(submit(project, first_spec.id, first_item.id), session=session).status == 'rejected'
            assert store.snapshot(pid).jobs == () and provider.calls == []

            jobs = {anchor: await generate(anchor)}
            assert 'h3Guide' not in provider.calls[0]
            for name, source, frames in links:
                job = jobs[name] = await generate(name)
                guide_id = job.inputSnapshot.spec.parameters.h3Segment.guideReferenceId
                guide = next(ref for ref in job.inputSnapshot.references if ref.referenceId == guide_id)
                assert guide.sourceVersion.id == steps[source][0].id
                assert guide.asset == jobs[source].asset
                assert provider.calls[-1]['h3Guide'] == {'assetId': str(guide.asset.assetId), 'frames': frames}

            # Callers can supply job IDs in generation order. Published clip order
            # is the plan order, which starts at A in the Case03 topology.
            published = assemble(project, group_id, jobs.values())
            assert published.status == 'applied', published
            rendered = store.snapshot(pid)
            document = next(doc for doc in rendered.editorDocuments if doc.kind == 'timeline')
            clip_assets = {asset.id: asset for asset in rendered.assets}
            assert [clip_assets[clip.resource.asset.assetId].provenance.sourceItemId
                    for clip in document.data.tracks[0].clips] == [steps[name][0].id for name in order]

            # The adopted upstream can change independently. Downstream history
            # retains the version it actually used and can't be mixed silently.
            jobs[anchor] = await generate(anchor)
            before = store.snapshot(pid)
            mismatch = assemble(project, group_id, jobs.values())
            assert mismatch.status == 'rejected', mismatch
            assert mismatch.issues[0].objectId == first_item.id
            assert mismatch.issues[0].message == f'片段「{first_item.title}」的冻结导帧来源与本次采用的上游结果不一致。'
            assert store.snapshot(pid) == before
        finally:
            await runner.close()

    asyncio.run(run())
