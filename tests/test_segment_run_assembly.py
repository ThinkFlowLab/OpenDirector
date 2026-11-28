from uuid import uuid4

import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_workflow_assembly import CreationWorkflowAssembly
from opendirector.domain.creation.assets import AssetProvenance
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.generation import InputSnapshot, Job, ResultVersion, VideoGenerationSpec, WorkflowGuide
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.projects import ProjectError
from opendirector.media.workflow_assembly import prepare_clip, probe_video_frames
from test_creation_canvas_service import project, send, ver
from test_creation_contracts import model, model_snapshot
from test_workflow_assembly import FORMAT, _audio, _ffmpeg, _levels, _source


def test_source_insert_preserves_order_and_frame_count_across_resize(tmp_path):
    source, output = tmp_path / 'source.mkv', tmp_path / 'insert.mp4'
    levels = _source(source)
    assert probe_video_frames(source, fps=24) == len(levels)

    with pytest.raises(ProjectError, match='尺寸'):
        prepare_clip(source, output, fps=24, width=48, height=32, in_frame=1, out_frame=4)

    prepare_clip(source, output, fps=24, width=48, height=32,
                 in_frame=1, out_frame=4, normalize_size=True)
    assert probe_video_frames(output, fps=24, width=48, height=32, exact_duration=True) == 3
    frames = _ffmpeg('-i', str(output), '-map', '0:v:0', '-vf', 'crop=32:32',
                     '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1')
    assert list(frames[::32 * 32 * 3 // 2]) == pytest.approx(levels[1:4], abs=2)


def test_assembler_publishes_source_inserts_and_generated_clips(project, tmp_path):
    store, pid, session = project
    assets = CreationAssets(store)
    seed = tmp_path / 'seed.mkv'
    levels = _source(seed)
    source, generated, sound = (tmp_path / filename for filename in ('source.mp4', 'take.mp4', 'source.m4a'))
    prepare_clip(seed, source, **FORMAT, in_frame=0, out_frame=6)
    prepare_clip(seed, generated, **FORMAT, in_frame=0, out_frame=3)
    _ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000',
            '-af', 'atrim=end_sample=12000', '-c:a', 'aac', str(sound))

    def register(path, kind):
        handle = uuid4()
        writer = assets.uploads.begin(pid, handle, session, path.name, expected_kind=kind)
        writer.write(path.read_bytes())
        writer.finish()
        receipt = send(store, pid, 'asset.import', session=session, uploadHandle=handle,
                       name=path.name, expectedKind=kind)
        assert receipt.status == 'applied', receipt
        asset_id = next(v.id for v in receipt.changed if v.objectType == 'asset')
        return next(asset for asset in store.snapshot(pid).assets if asset.id == asset_id)

    source_asset, take_asset, soundtrack = (register(source, 'video'), register(generated, 'video'), register(sound, 'audio'))
    config = model('video')
    spec = VideoGenerationSpec(id=uuid4(), projectId=pid, kind='video', purpose='generation',
                               modelConfigId=config.id, parameters={'videoMode': 'reference'})
    inputs = InputSnapshot(spec=spec, model=model_snapshot(config))
    group_id, timeline_id, document_id, item_id, output_id = (uuid4() for _ in range(5))
    execution_id = uuid4()
    job = Job(id=uuid4(), projectId=pid, originItemId=item_id, inputSnapshot=inputs,
              inputFingerprint=inputs.fingerprint(), execution={'kind': 'video'}, status='succeeded',
              phase='complete', recovery='done', asset=asset_ref(take_asset), adopted=True, batchId=execution_id)
    result = ResultVersion(id=uuid4(), projectId=pid, jobId=job.id, specId=spec.id,
                           inputFingerprint=job.inputFingerprint, asset=job.asset)
    group = dict(id=group_id, projectId=pid, kind='group')
    timeline = dict(id=timeline_id, projectId=pid, kind='timeline',
                    binding=dict(role='editor', objectRef=dict(id=document_id, kind='timeline')))
    item = dict(id=item_id, projectId=pid, kind='video', parentId=group_id,
                binding=dict(role='generation', objectRef=dict(id=spec.id)))
    document = dict(id=document_id, projectId=pid, kind='timeline', data=dict(**FORMAT, tracks=[
        dict(id='visual', kind='visual', title='Visual'),
        dict(id='audio', kind='audio', title='Audio', clips=[
            dict(id='soundtrack', resource=dict(asset=asset_ref(soundtrack), title=soundtrack.name, durationSeconds=.25),
                 start=0, inPoint=0, outPoint=.25)]),
    ]))
    setup = parse_command(dict(commandId=uuid4(), projectId=pid, type='canvas.show', payload={'item': group}))
    assert store.commit(setup, lambda before: ProjectSnapshot.model_validate({**before.model_dump(),
        'canvasItems': [group, timeline, item], 'editorDocuments': [document],
        'generationSpecs': [spec.model_copy(update={'currentResultId': result.id})],
        'jobs': [job], 'results': [result],
    }), session=session).status == 'applied'
    snapshot = store.snapshot(pid)
    assembly = dict(timelineItemId=timeline_id, outputItemId=output_id,
                    clips=[dict(itemId=item_id, inFrame=0, outFrame=3, reverse=True)])
    plan = dict(source=asset_ref(source_asset), fps=24, frameCount=6, entries=[
        dict(kind='source', sourceStart=0, sourceEnd=2),
        dict(kind='generated', sourceStart=2, sourceEnd=5, itemId=item_id, shot='shot', step={'kind': 'anchor'}),
        dict(kind='source', sourceStart=5, sourceEnd=6),
    ])
    publish = parse_command(dict(commandId=uuid4(), projectId=pid, type='group.publishRun',
        expectedVersions=[ver('canvas_item', snapshot.canvasItems[0])],
        payload=dict(groupId=group_id, assembly=assembly, plan=plan)))
    # Seed the immutable Run so this test exercises the assembler independently of the publisher.
    draft = snapshot.canvasItems[0]
    sealed = {**draft.model_dump(), 'revision': draft.revision + 1, 'assembly': assembly, 'runPlan': plan}
    receipt = store.commit(publish, lambda before: ProjectSnapshot.model_validate({**before.model_dump(),
        'canvasItems': [sealed, timeline, item],
    }), session=session)
    assert receipt.status == 'applied', receipt
    snapshot = store.snapshot(pid)
    versions = [*(ver('canvas_item', node) for node in snapshot.canvasItems[:2]),
                ver('editor_document', snapshot.editorDocuments[0])]
    reject = send(store, pid, 'group.assemble', session=session, versions=versions, groupId=group_id, jobIds=[job.id])
    assert reject.status == 'rejected'
    assert reject.issues[0].code == 'role_restricted'

    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='group.assemble', expectedVersions=versions,
                                 payload=dict(groupId=group_id, jobIds=[job.id])))
    assembler = CreationWorkflowAssembly(store)

    # A branch intentionally reuses a completed result while the canvas has no
    # current take and the original job retains its own execution id.
    branch_inputs = inputs.model_copy(update={'workflowGuide': WorkflowGuide(groupId=group_id, required=False)})
    fingerprint = branch_inputs.fingerprint()
    branch_job = job.model_copy(update={'inputSnapshot': branch_inputs, 'inputFingerprint': fingerprint, 'adopted': False})
    branch_asset = take_asset.model_copy(update={'provenance': AssetProvenance(
        source='generated', jobId=job.id, inputFingerprint=fingerprint)})
    branch_snapshot = ProjectSnapshot.model_validate({**snapshot.model_dump(),
        'assets': [branch_asset if asset.id == take_asset.id else asset for asset in snapshot.assets],
        'generationSpecs': [spec], 'jobs': [branch_job],
        'results': [result.model_copy(update={'inputFingerprint': fingerprint})],
    })
    assert assembler._inputs(command, branch_snapshot, uuid4(), {item_id: job.id}).sources[1][1] == branch_asset
    with pytest.raises(ContractError, match='组装任务与执行选定'):
        assembler._inputs(command, branch_snapshot, uuid4(), {item_id: uuid4()})

    different_run = assembler.execute(command.model_copy(update={'commandId': uuid4()}),
                                      source='background', run_execution_id=uuid4())
    assert different_run.status == 'rejected'
    assert different_run.issues[0].objectId == item_id
    receipt = assembler.execute(command, source='background', run_execution_id=execution_id)
    assert receipt.status == 'applied', receipt
    assert assembler.execute(command, source='background', run_execution_id=execution_id) == receipt

    snapshot = store.snapshot(pid)
    output_item = next(node for node in snapshot.canvasItems if node.id == output_id)
    output = tmp_path / 'published.mp4'
    stream, _ = assets.open_media(pid, output_item.binding.objectRef.assetId, snapshot=snapshot)
    with stream:
        output.write_bytes(stream.read())
    assert _levels(output) == pytest.approx([*levels[:2], *reversed(levels[:3]), levels[5]], abs=2)
    assert _audio(output) == _audio(sound)
    visual = snapshot.editorDocuments[0].data.tracks[0]
    assert [clip.outPoint * 24 for clip in visual.clips] == pytest.approx([2, 3, 1])
