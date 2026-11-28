import subprocess
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_workflow_assembly import CreationWorkflowAssembly
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.generation import InputSnapshot, Job, ResultVersion, VideoGenerationSpec
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.projects import ProjectError
from opendirector.media.workflow_assembly import assemble_clips, prepare_clip
from opendirector_api.main import create_app
from test_creation_canvas_service import project, send, ver
from test_creation_contracts import asset, model, model_snapshot


FORMAT = {'fps': 24, 'width': 32, 'height': 32}


def _ffmpeg(*arguments, data=None):
    return subprocess.run(
        ['ffmpeg', '-nostdin', '-v', 'error', '-xerror', *arguments],
        input=data,
        capture_output=True,
        check=True,
    ).stdout


def _source(path):
    levels = [30, 60, 90, 120, 150, 180]
    pixels = 32 * 32
    video = b''.join(bytes([level]) * pixels + bytes([128]) * (pixels // 2) for level in levels)
    _ffmpeg('-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', '32x32',
            '-framerate', '24', '-i', 'pipe:0', '-c:v', 'ffv1', str(path), data=video)
    return levels


def _levels(path):
    data = _ffmpeg('-i', str(path), '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1')
    return list(data[::32 * 32 * 3 // 2])


def _audio(path):
    return _ffmpeg('-i', str(path), '-map', '0:a:0', '-f', 's16le', 'pipe:1')


def test_frame_windows_publish_exact_order_and_original_audio(tmp_path):
    source = tmp_path / 'raw.mkv'
    levels = _source(source)
    original = source.read_bytes()
    reverse, forward = tmp_path / "reverse's clip.mp4", tmp_path / 'forward.mp4'
    prepare_clip(source, reverse, **FORMAT, in_frame=1, out_frame=4, reverse=True, frame_limit=5)
    prepare_clip(source, forward, **FORMAT, in_frame=1, out_frame=3)
    expected_reverse = [levels[i] for i in (3, 2, 1)]
    assert _levels(reverse) == pytest.approx(expected_reverse, abs=2)
    assert _levels(forward) == pytest.approx(levels[1:3], abs=2)
    assert source.read_bytes() == original

    soundtrack = tmp_path / 'original.m4a'
    _ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000',
            '-af', 'atrim=end_sample=10000', '-c:a', 'aac', str(soundtrack))
    output = tmp_path / 'output.mp4'
    assemble_clips([reverse, forward], soundtrack, output, **FORMAT, frames=5)
    assert _levels(output) == pytest.approx(expected_reverse + levels[1:3], abs=2)
    assert _audio(output) == _audio(soundtrack)


def test_assembly_rejects_missing_frames_and_short_soundtrack(tmp_path):
    source = tmp_path / 'raw.mkv'
    _source(source)
    output = tmp_path / 'output.mp4'
    with pytest.raises(ProjectError, match='有效帧数') as error:
        prepare_clip(source, output, **FORMAT, in_frame=1, out_frame=5, reverse=True, frame_limit=4)
    assert error.value.code == 'workflow_media_invalid'
    assert not output.exists()

    clip = tmp_path / 'retained.mp4'
    prepare_clip(source, clip, **FORMAT, in_frame=1, out_frame=5)
    soundtrack = tmp_path / 'short.m4a'
    _ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000',
            '-af', 'atrim=end_sample=1000', '-c:a', 'aac', str(soundtrack))
    with pytest.raises(ProjectError, match='原声音轨未覆盖') as error:
        assemble_clips([clip], soundtrack, output, **FORMAT, frames=4)
    assert error.value.code == 'workflow_media_invalid'
    assert not output.exists()


@pytest.mark.parametrize(('title', 'recipe_matches'), [
    ('Segment B', 1), ('', 1), ('Segment B', 0), ('Segment B', 2),
], ids=['named', 'untitled', 'outside-recipe', 'ambiguous'])
def test_assembly_reports_where_legacy_job_lacks_an_origin(project, title, recipe_matches):
    store, pid, session = project
    config = model('video')
    spec = VideoGenerationSpec(id=uuid4(), projectId=pid, kind='video',
        purpose='generation', modelConfigId=config.id)
    inputs = InputSnapshot(spec=spec, model=model_snapshot(config))
    video = asset(10, 'video').model_copy(update={'projectId': pid})
    audio = asset(11, 'audio').model_copy(update={'projectId': pid})
    job = Job(id=uuid4(), projectId=pid, inputSnapshot=inputs, inputFingerprint=inputs.fingerprint(),
        execution=dict(kind='video'), status='succeeded', phase='complete', recovery='done',
        asset=asset_ref(video), adopted=True)
    result = ResultVersion(id=uuid4(), projectId=pid, specId=spec.id, jobId=job.id,
        inputFingerprint=job.inputFingerprint, asset=job.asset)
    specs = [spec.model_copy(update={'currentResultId': result.id})]
    if not recipe_matches:
        specs.append(spec.model_copy(update={'id': uuid4()}))
    group_id, timeline_id, document_id = uuid4(), uuid4(), uuid4()
    segments = [dict(id=uuid4(), projectId=pid, kind='video', parentId=group_id, title=title,
        binding=dict(role='generation', objectRef=dict(id=specs[-1].id)))]
    if recipe_matches == 2:
        segments.append({**segments[0], 'id': uuid4(), 'title': 'Segment C'})
    outside = dict(id=uuid4(), projectId=pid, kind='video', title='Outside recipe',
        binding=dict(role='generation', objectRef=dict(id=spec.id)))
    group = dict(id=group_id, projectId=pid, kind='group',
        assembly=dict(timelineItemId=timeline_id, outputItemId=uuid4(),
            clips=[dict(itemId=item['id'], inFrame=0, outFrame=24) for item in segments]))
    timeline = dict(id=timeline_id, projectId=pid, kind='timeline',
        binding=dict(role='editor', objectRef=dict(id=document_id, kind='timeline')))
    document = dict(id=document_id, projectId=pid, kind='timeline', data=dict(**FORMAT, tracks=[
        dict(id='visual', kind='visual', title='Visual'),
        dict(id='audio', kind='audio', title='Audio', clips=[
            dict(id='soundtrack', resource=dict(asset=asset_ref(audio), title=audio.name, durationSeconds=4),
                start=0, inPoint=0, outPoint=len(segments))]),
    ]))
    # Seed a successful record accepted before grouped submissions required an origin.
    setup = parse_command(dict(commandId=uuid4(), projectId=pid, type='canvas.show', payload=dict(item=group)))
    assert store.commit(setup, lambda before: ProjectSnapshot.model_validate({**before.model_dump(),
        'assets': [video, audio], 'generationSpecs': specs, 'jobs': [job], 'results': [result],
        'canvasItems': [group, timeline, outside, *segments], 'editorDocuments': [document],
    }), session=session).status == 'applied'
    before = store.snapshot(pid)
    items = {item.id: item for item in before.canvasItems}
    receipt = send(store, pid, 'group.assemble', session=session, groupId=group_id, jobIds=[job.id],
        versions=[ver('canvas_item', items[group_id]), ver('canvas_item', items[timeline_id]),
            ver('editor_document', before.editorDocuments[0])])
    assert receipt.status == 'rejected'
    issue, = receipt.issues
    assert issue.code == 'reference_invalid'
    if recipe_matches == 1:
        segment_id = segments[0]['id']
        assert issue.objectId == segment_id
        assert issue.message == f'组装片段「{title or segment_id}」的生成任务缺少来源画布节点（originItemId）。'
    else:
        assert issue.objectId == job.id
        assert issue.message == f'生成任务「{job.id}」（规格 {spec.id}）缺少来源画布节点（originItemId），无法确定对应的组装片段。'
    assert store.snapshot(pid) == before
    if title and recipe_matches == 1:
        client = TestClient(create_app(store.local), headers={'X-OpenDirector-Request': '1'})
        path = f'/api/creation/projects/{pid}/receipts/{receipt.commandId}'
        for language, message in [
            ('zh-CN', issue.message),
            ('en-US', f'The generation job for assembly segment “{title}” is missing its source canvas node (originItemId).'),
        ]:
            response = client.get(path, headers={'Accept-Language': language})
            assert response.status_code == 200, response.text
            displayed, = response.json()['issues']
            assert (displayed['code'], displayed['objectId'], displayed['message']) == (
                'reference_invalid', str(segment_id), message)


@pytest.mark.parametrize('guide_state', [
    'legacy', 'unguided', 'unresolved', 'context-only', 'pinned', 'exempt', 'exempt-unresolved',
])
def test_workflow_assembly_checks_guide_in_the_adopted_job_not_the_current_spec(project, guide_state):
    store, pid, session = project
    config = model('video', modelId='MiniMaxAI/MiniMax-H3', connectionType='self_hosted', videoAdapter='minimax_h3')
    group_id, timeline_id, document_id, item_id, guide_id = (uuid4() for _ in range(5))
    video, audio, guide_asset = [asset(number, kind).model_copy(update={'projectId': pid})
                                for number, kind in [(10, 'video'), (11, 'audio'), (12, 'video')]]
    guide_plan = {'guideReferenceId': guide_id, 'sourceFrames': [0, 21]}
    spec_payload = dict(id=uuid4(), projectId=pid, kind='video', purpose='generation', modelConfigId=config.id)
    current_params = dict(videoMode='reference')
    frozen_params = dict(videoMode='reference')
    if guide_state != 'legacy':
        current_params['h3Segment'] = guide_plan
        frozen_params['h3Segment'] = {} if guide_state in {'unguided', 'exempt'} else guide_plan
    current_spec = VideoGenerationSpec(**spec_payload, parameters=current_params)
    frozen_spec = VideoGenerationSpec(**spec_payload, parameters=frozen_params)
    guide_reference = dict(referenceId=guide_id, role='reference', asset=asset_ref(guide_asset), metadata=guide_asset.metadata,
        transmission='context_only' if guide_state == 'context-only' else 'content')
    inputs = InputSnapshot(spec=frozen_spec, model=model_snapshot(config),
        references=[guide_reference] if guide_state in {'context-only', 'pinned'} else [])
    job = Job(id=uuid4(), projectId=pid, originItemId=item_id, inputSnapshot=inputs, inputFingerprint=inputs.fingerprint(),
        execution=dict(kind='video'), status='succeeded', phase='complete', recovery='done',
        asset=asset_ref(video), adopted=True)
    result = ResultVersion(id=uuid4(), projectId=pid, specId=frozen_spec.id, jobId=job.id,
        inputFingerprint=job.inputFingerprint, asset=job.asset)
    group = dict(id=group_id, projectId=pid, kind='group', assembly=dict(timelineItemId=timeline_id,
        outputItemId=uuid4(), clips=[dict(itemId=item_id, inFrame=0, outFrame=24)],
        requireTimelineGuides=guide_state != 'legacy',
        guideExemptItemId=item_id if guide_state in {'exempt', 'exempt-unresolved'} else None))
    item = dict(id=item_id, projectId=pid, kind='video', parentId=group_id, title='Segment B · Anchor',
        binding=dict(role='generation', objectRef=dict(id=current_spec.id)))
    timeline = dict(id=timeline_id, projectId=pid, kind='timeline',
        binding=dict(role='editor', objectRef=dict(id=document_id, kind='timeline')))
    document = dict(id=document_id, projectId=pid, kind='timeline', data=dict(**FORMAT, tracks=[
        dict(id='visual', kind='visual', title='Visual'),
        dict(id='audio', kind='audio', title='Audio', clips=[
            dict(id='soundtrack', resource=dict(asset=asset_ref(audio), title=audio.name, durationSeconds=4),
                start=0, inPoint=0, outPoint=1)]),
    ]))
    setup = parse_command(dict(commandId=uuid4(), projectId=pid, type='canvas.show', payload=dict(item=group)))
    assert store.commit(setup, lambda before: ProjectSnapshot.model_validate({**before.model_dump(),
        'assets': [video, audio, guide_asset], 'jobs': [job], 'results': [result],
        'generationSpecs': [current_spec.model_copy(update={'currentResultId': result.id})],
        'references': [] if guide_state == 'legacy' else [dict(id=guide_id, projectId=pid, targetSpecId=current_spec.id,
            binding='pinned', source=asset_ref(guide_asset))],
        'canvasItems': [group, timeline, item], 'editorDocuments': [document],
    }), session=session).status == 'applied'
    before = store.snapshot(pid)
    items = {item.id: item for item in before.canvasItems}
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='group.assemble',
        payload=dict(groupId=group_id, jobIds=[job.id]),
        expectedVersions=[ver('canvas_item', items[group_id]), ver('canvas_item', items[timeline_id]),
                          ver('editor_document', before.editorDocuments[0])]))
    if guide_state in {'legacy', 'pinned', 'exempt'}:
        inputs = CreationWorkflowAssembly(store)._inputs(command, before)
        assert inputs.sources == ((items[group_id].assembly.clips[0], video),)
    else:
        receipt = store.execute(command, session=session)
        assert receipt.status == 'rejected'
        issue, = receipt.issues
        assert (issue.code, issue.objectId, issue.message) == (
            'reference_invalid', item_id, '片段「Segment B · Anchor」必须使用有效的 H3 时间线导帧。')
        assert store.snapshot(pid) == before
