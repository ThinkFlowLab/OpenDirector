"""The public Run commands execute a frozen two-segment plan through FastH3 multipart and assembly."""
import asyncio
from email.parser import BytesParser
from email.policy import default
from io import BytesIO
import json
import time
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
from PIL import Image
import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_generation import ProviderMedia
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.input_rules import input_rules
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.providers import GenerationProviders
from opendirector_api.main import create_app
from test_creation_assembly import upload_source
from test_creation_canvas_service import media, project, send, ver
from test_vllm_omni_h3 import FakeOmni, H3
from test_workflow_assembly import FORMAT, _audio, _ffmpeg, _levels
from test_workflow_guide_policy import fresh, set_guide


pytestmark = [pytest.mark.cpu, pytest.mark.requires_ffmpeg]


def _video(path, frames):
    pixels = 32 * 32
    data = b''.join(bytes([level]) * pixels + bytes([128]) * (pixels // 2) for level in frames)
    _ffmpeg('-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '32x32', '-r', '24', '-i', 'pipe:0',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path), data=data)


def _draft(project, tmp_path):
    store, pid, session = project
    fast = {**H3, 'modelId': 'FastH3-Omni'}
    capabilities = {**input_rules(fast)['videoCapabilities'], 'timelineGuides': True}
    config = ModelConfigs(store.local.repository).save(
        'video', fast['url'], fast['modelId'], 'token', connection_type='self_hosted',
        protocol='vllm_omni', auth_mode='bearer', capability_auto_check=False,
        video_capabilities=capabilities)

    source = tmp_path / 'working-source.mp4'
    _video(source, [25] * 48)
    assets = CreationAssets(store)
    handle = uuid4()
    upload = assets.uploads.begin(pid, handle, session, source.name, expected_kind='video')
    upload.write(source.read_bytes())
    upload.finish()
    receipt = send(store, pid, 'asset.import', session=session, uploadHandle=handle, name=source.name, expectedKind='video')
    assert receipt.status == 'applied', receipt
    source_asset = store.snapshot(pid).assets[-1]
    reference = tmp_path / 'prepared-input.mp4'
    _video(reference, [25] * 107)
    handle = uuid4()
    upload = assets.uploads.begin(pid, handle, session, reference.name, expected_kind='video')
    upload.write(reference.read_bytes())
    upload.finish()
    receipt = send(store, pid, 'asset.import', session=session, uploadHandle=handle,
                   name=reference.name, expectedKind='video')
    assert receipt.status == 'applied', receipt
    reference_asset = store.snapshot(pid).assets[-1]

    _, sound = upload_source(project, tmp_path, 'audio', seconds=2)
    a = media(project, 'video', title='Reverse A', purpose='generation')
    b = media(project, 'video', title='Anchor B', purpose='generation')
    group_id, timeline_id, document_id, output_id = (uuid4() for _ in range(4))
    operations = [
        dict(type='canvas.show', payload=dict(item=dict(id=group_id, projectId=pid, kind='group', title='Two segments'))),
        dict(type='editor.create', payload=dict(document=dict(id=document_id, projectId=pid, kind='timeline',
            data=dict(**FORMAT, tracks=[
                dict(id='visual', kind='visual', title='Visual'),
                dict(id='audio', kind='audio', title='Original sound', clips=[dict(id='soundtrack',
                    resource=dict(asset=asset_ref(sound), title=sound.name, durationSeconds=2),
                    start=0, inPoint=0, outPoint=2)]),
            ])))),
        dict(type='canvas.show', payload=dict(item=dict(id=timeline_id, projectId=pid, kind='timeline',
            binding=dict(role='editor', objectRef=dict(id=document_id, kind='timeline'))))),
    ]
    versions = []
    for item, spec in (a, b):
        versions.extend((ver('canvas_item', item), ver('generation_spec', spec)))
        operations.extend((
            dict(type='canvas.update', payload=dict(itemId=item.id, parentId=group_id)),
            dict(type='generationSpec.update', payload=dict(spec={**spec.model_dump(), 'prompt': item.title,
                'modelConfigId': config['id'], 'parameters': dict(videoMode='reference', durationSeconds=107 / 24, seed=27)})),
            dict(type='reference.add', payload=dict(reference=dict(id=uuid4(), projectId=pid,
                targetSpecId=spec.id, order=1, binding='pinned', source=asset_ref(reference_asset)))),
        ))
    receipt = send(store, pid, 'creation.batch', session=session, versions=versions, operations=operations)
    assert receipt.status == 'applied', receipt
    set_guide(project, a, b[0], (21, 0))
    group = fresh(store, pid, 'canvasItems', group_id)
    recipe = dict(timelineItemId=timeline_id, outputItemId=output_id, clips=[
        dict(itemId=a[0].id, inFrame=0, outFrame=23, reverse=True, frameLimit=23),
        dict(itemId=b[0].id, inFrame=0, outFrame=23),
    ])
    plan = dict(source=asset_ref(source_asset), fps=24, frameCount=48, entries=[
        dict(kind='source', sourceStart=0, sourceEnd=2),
        dict(kind='generated', sourceStart=2, sourceEnd=25, itemId=a[0].id, shot='same-shot',
             step=dict(kind='continuation', upstreamItemId=b[0].id, sourceFrames=[21, 0])),
        dict(kind='generated', sourceStart=25, sourceEnd=48, itemId=b[0].id, shot='same-shot',
             step=dict(kind='anchor')),
    ])
    return group, a, b, recipe, plan


@pytest.mark.parametrize('pause, static_guide', [(False, False), (True, False), (False, True)],
                         ids=['uninterrupted', 'pause-and-resume', 'static-anchor-guide'])
def test_published_run_executes_anchor_then_reverse_continuation_without_a_session(
    project, tmp_path, pause, static_guide,
):
    store, pid, session = project
    group, (a, a_spec), (b, b_spec), recipe, plan = _draft(project, tmp_path)
    if static_guide:
        _, guide_asset = upload_source(project, tmp_path, 'image')
        guide_id = uuid4()
        current = fresh(store, pid, 'generationSpecs', b_spec.id)
        receipt = send(store, pid, 'creation.batch', session=session,
            versions=[ver('generation_spec', current)], operations=[
                dict(type='reference.add', payload=dict(reference=dict(id=guide_id, projectId=pid,
                    targetSpecId=current.id, binding='pinned', source=asset_ref(guide_asset), order=2))),
                dict(type='generationSpec.update', payload=dict(spec={**current.model_dump(),
                    'parameters': {**current.parameters.model_dump(),
                                   'h3Segment': {'guideReferenceId': guide_id, 'outputFrame': 0}}})),
            ])
        assert receipt.status == 'applied', receipt
    generated = tmp_path / 'result.mp4'
    levels = list(range(50, 157))
    _video(generated, levels)
    remote = FakeOmni(generated.read_bytes())
    request_received, allow_result = Event(), Event()
    guide_levels = []

    async def transport(request):
        response = remote(request)
        if request.method == 'POST':
            if len(remote.posts) == 1:
                request_received.set()
                assert await asyncio.to_thread(allow_result.wait, 10)
            else:
                mime = BytesParser(policy=default).parsebytes(
                    b'Content-Type: ' + request.headers['content-type'].encode() + b'\r\n\r\n' + request.content)
                for part in mime.iter_parts():
                    if part.get_param('name', header='content-disposition') == 'guide_files':
                        with Image.open(BytesIO(part.get_payload(decode=True))) as image:
                            guide_levels.append(image.convert('L').getpixel((16, 16)))
        return response

    store_port = ProviderMedia(SimpleNamespace(assets=CreationAssets(store)))
    provider = GenerationProviders(store_port, httpx.MockTransport(transport), poll_interval=0)
    app = create_app(store.local, generation_provider=provider)
    base = f'/api/creation/projects/{pid}'

    def command(kind, payload, *, versions=(), operation=None, status=200):
        value = parse_command(dict(type=kind, projectId=pid, commandId=operation or uuid4(),
                                   expectedVersions=versions, payload=payload))
        response = client.post(base + '/commands', json=value.model_dump(mode='json'))
        assert response.status_code == status, response.text
        return response.json()

    with TestClient(app, headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session,
                                  'Accept-Language': 'en-US'}) as client:
        saved_spec = fresh(store, pid, 'generationSpecs', a_spec.id)
        blank = command('generationSpec.update', dict(spec={**saved_spec.model_dump(), 'prompt': ''}),
                        versions=[ver('generation_spec', saved_spec)])
        assert blank['status'] == 'applied', blank
        rejected = command('group.publishRun', dict(groupId=group.id, plan=plan, assembly=recipe),
                           versions=[ver('canvas_item', group)])
        assert rejected['status'] == 'rejected' and rejected['issues'][0]['objectId'] == str(a.id), rejected
        assert remote.posts == []
        draft_spec = fresh(store, pid, 'generationSpecs', a_spec.id)
        restored = command('generationSpec.update', dict(spec={**draft_spec.model_dump(), 'prompt': saved_spec.prompt}),
                           versions=[ver('generation_spec', draft_spec)])
        assert restored['status'] == 'applied', restored

        published = command('group.publishRun', dict(groupId=group.id, plan=plan, assembly=recipe,
                            planLocale='zh-CN', planNotes='先执行 B，再反向续接 A。'),
                            versions=[ver('canvas_item', group)])
        assert published['status'] == 'applied', json.dumps(published['issues'], ensure_ascii=False)
        sealed = fresh(store, pid, 'canvasItems', group.id)
        plan_node = fresh(store, pid, 'canvasItems', sealed.runPlanItemId)
        assert plan_node.visible and plan_node.kind == 'text'
        assert published['planItemId'] == str(plan_node.id)
        assert any(value['id'] == str(plan_node.id) for value in published['changed'])
        assert plan_node.title == '分段计划'
        plan_body = client.get(f'{base}/assets/{plan_node.binding.objectRef.assetId}/content')
        assert plan_body.is_success and '源片帧区间' in plan_body.text and '先执行 B，再反向续接 A。' in plan_body.text

        assert '| 是否满足 17k+5 |' in plan_body.text
        assert plan_body.text.count('| 是（107 帧） |') == 2

        changed = command('group.configureAssembly', dict(groupId=group.id, assembly=None),
                          versions=[ver('canvas_item', sealed)])
        assert changed['status'] == 'rejected', changed
        timeline = fresh(store, pid, 'canvasItems', sealed.assembly.timelineItemId)
        lock = command('canvas.update', dict(itemId=timeline.id, locked=True),
                       versions=[ver('canvas_item', timeline)])
        assert lock['status'] == 'rejected', lock
        before = fresh(store, pid, 'generationSpecs', a_spec.id)
        changed = command('generationSpec.update', dict(spec={**before.model_dump(), 'prompt': 'Different prompt'}),
                          versions=[ver('generation_spec', before)])
        assert changed['status'] == 'rejected', changed
        origin = fresh(store, pid, 'canvasItems', a.id)
        direct = command('generation.submit', dict(specId=before.id, expectedSpecRevision=before.revision,
                         originItemId=a.id), versions=[ver('generation_spec', before), ver('canvas_item', origin)])
        assert direct['status'] == 'rejected' and direct['issues'][0]['code'] == 'role_restricted', direct

        execution_id = uuid4()
        group_payload = {'groupId': group.id}

        def query(*, latest=False):
            query_type, object_id = ('run.groupExecution.get', group.id) if latest else ('run.execution.get', execution_id)
            response = client.post(base + '/queries', json=dict(type=query_type, projectId=str(pid),
                                   objectId=str(object_id), queryId=str(uuid4())))
            assert response.is_success, response.text
            return response.json()

        assert query(latest=True) is None
        if pause:
            inactive = command('group.pauseRun', group_payload, status=409)
            assert inactive['code'] == 'segment_run_no_execution'
            assert 'no execution available' in inactive['detail']
        started = command('group.startRun', group_payload, operation=execution_id)
        assert started['status'] in {'applied', 'accepted'}, started
        assert started['runExecutionId'] == str(execution_id)
        assert command('group.startRun', group_payload, operation=execution_id) == started

        try:
            assert request_received.wait(5), query()
            assert query(latest=True)['executionId'] == str(execution_id)
            if pause:
                pause_id = uuid4()
                paused = command('group.pauseRun', group_payload, operation=pause_id)
                assert paused['runExecutionId'] == str(execution_id)
                assert command('group.pauseRun', group_payload, operation=pause_id) == paused
                assert query()['status'] == 'pausing'
            assert client.delete(f'/api/creation/sessions/{session}').is_success
        finally:
            allow_result.set()
        if pause:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                execution = query(latest=True)
                if execution['status'] != 'pausing':
                    break
                time.sleep(.025)
            assert execution['status'] == 'paused', execution
            assert len(remote.posts) == 1
            anchor_job, = store.snapshot(pid).jobs
            assert anchor_job.status == 'succeeded' and str(anchor_job.id) == execution['steps'][0]['jobId']
            assert command('group.resumeRun', group_payload, status=409)['code'] == 'session_expired'
            assert client.post(base + '/open').is_success
            assert command('group.startRun', group_payload, status=409)['code'] == 'segment_run_busy'
            resume_id = uuid4()
            resumed = command('group.resumeRun', group_payload, operation=resume_id)
            assert resumed['runExecutionId'] == str(execution_id)
            assert command('group.resumeRun', group_payload, operation=resume_id) == resumed
            assert client.delete(f'/api/creation/sessions/{session}').is_success

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            execution = query()
            if execution['status'] not in {'queued', 'running'}:
                break
            time.sleep(.025)
        assert execution['status'] == 'succeeded', execution

        assert len(remote.posts) == 2
        anchor, continuation = remote.posts
        if static_guide:
            assert json.loads(anchor[0]['timeline_guides']) == [
                {'frame_index': 0, 'image': {'upload_index': 0}},
            ]
            assert anchor[1] == [
                ('input_references', 'video_1.mp4', 'video/mp4'),
                ('guide_files', 'guide_0.png', 'image/png'),
            ]
            assert '图片 → 第 0 帧' in plan_body.text
        else:
            assert 'timeline_guides' not in anchor[0]
        assert json.loads(continuation[0]['timeline_guides']) == [
            {'frame_index': 0, 'image': {'upload_index': 0}},
            {'frame_index': 21, 'image': {'upload_index': 1}},
        ]
        assert [upload for upload in continuation[1] if upload[0] == 'guide_files'] == [
            ('guide_files', 'guide_0.png', 'image/png'), ('guide_files', 'guide_1.png', 'image/png'),
        ]
        assert guide_levels[0] > guide_levels[1] + 15  # Raw donor frame 21 is visibly brighter than raw frame 0.
        assert [(step['itemId'], step['status']) for step in execution['steps']] == [
            (str(b.id), 'succeeded'), (str(a.id), 'succeeded'),
        ]
        anchor_job, guided_job = store.snapshot(pid).jobs
        if static_guide:
            assert anchor_job.inputSnapshot.timeline_guide().asset == asset_ref(guide_asset)
        assert guided_job.inputSnapshot.timeline_guide(required=True).asset == anchor_job.asset
        assert guided_job.inputSnapshot.spec.parameters.h3Segment.sourceFrames == (21, 0)
        final = client.get(f"{base}/assets/{execution['outputAssetId']}/content")
        assert final.is_success, final.text
        output = tmp_path / 'published.mp4'
        output.write_bytes(final.content)
        assert _levels(output) == pytest.approx([25, 25, *reversed(levels[:23]), *levels[:23]], abs=2)
        assert _audio(output)


@pytest.mark.parametrize('regenerate_anchor', [False, True], ids=['reuse-anchor', 'replace-guide'])
def test_published_run_step_regenerate_adopt_and_restart(project, tmp_path, regenerate_anchor):
    store, pid, session = project
    group, (a, _), (b, _), recipe, plan = _draft(project, tmp_path)
    generated = tmp_path / 'result.mp4'
    regenerated = tmp_path / 'candidate.mp4'
    _video(generated, list(range(50, 157)))
    _video(regenerated, list(range(90, 197)))
    remote = FakeOmni(generated.read_bytes())
    store_port = ProviderMedia(SimpleNamespace(assets=CreationAssets(store)))
    provider = GenerationProviders(store_port, httpx.MockTransport(remote), poll_interval=0)
    app = create_app(store.local, generation_provider=provider)
    base = f'/api/creation/projects/{pid}'

    def command(kind, payload, *, versions=(), operation=None, status=200):
        request = parse_command(dict(type=kind, projectId=pid, commandId=operation or uuid4(),
                                     expectedVersions=versions, payload=payload))
        response = client.post(base + '/commands', json=request.model_dump(mode='json'))
        assert response.status_code == status, response.text
        return response.json()

    def query(kind, object_id):
        response = client.post(base + '/queries', json=dict(type=kind, projectId=str(pid),
                               objectId=str(object_id), queryId=str(uuid4())))
        assert response.is_success, response.text
        return response.json()

    def wait(execution_id, status):
        deadline = time.monotonic() + 15
        while True:
            execution = query('run.execution.get', execution_id)
            if execution['status'] == status:
                return execution
            assert execution['status'] not in {'failed', 'needs_review'} and time.monotonic() < deadline, execution
            time.sleep(.025)

    with TestClient(app, headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}) as client:
        target = {'groupId': group.id}
        published = command('group.publishRun', {**target, 'plan': plan, 'assembly': recipe},
                            versions=[ver('canvas_item', group)])
        assert published['status'] == 'applied', published
        assert query('run.groupExecutions.list', group.id) == {'executions': []}

        first_operation = uuid4()
        started = command('group.stepRun', target, operation=first_operation)
        assert command('group.stepRun', target, operation=first_operation) == started
        first_id = started['runExecutionId']
        first_target = {**target, 'executionId': first_id}
        paused = wait(first_id, 'paused')
        assert paused['nextStep']['itemId'] == str(a.id)
        assert len(remote.posts) == 1 and paused['outputAssetId'] is None

        assert command('group.stepRun', first_target)['runExecutionId'] == first_id
        paused = wait(first_id, 'paused')
        assert paused['nextStep']['kind'] == 'assembly'
        assert len(remote.posts) == 2 and paused['outputAssetId'] is None
        assert command('group.stepRun', first_target)['runExecutionId'] == first_id
        original = wait(first_id, 'succeeded')
        original_asset = original['outputAssetId']
        original_content = client.get(f'{base}/assets/{original_asset}/content')
        assert original_content.is_success
        original_anchor, original_continuation = store.snapshot(pid).jobs

        item = b if regenerate_anchor else a
        regenerate = {**first_target, 'itemId': item.id}
        stale = command('group.regenerateRunStep', {**regenerate, 'expectedExecutionId': uuid4()}, status=409)
        assert stale['code'] == 'segment_run_stale_execution'
        remote.video = regenerated.read_bytes()
        regeneration_id = uuid4()
        regeneration = command('group.regenerateRunStep', {**regenerate, 'expectedExecutionId': first_id},
                               operation=regeneration_id)
        assert command('group.regenerateRunStep', {**regenerate, 'expectedExecutionId': first_id},
                       operation=regeneration_id) == regeneration
        branch_id = regeneration['runExecutionId']
        assert branch_id != first_id
        waited = client.post(f'{base}/queries', json={
            'type': 'run.execution.get', 'projectId': str(pid), 'queryId': str(uuid4()),
            'objectId': str(branch_id), 'waitSeconds': 10,
        })
        assert waited.is_success, waited.text
        review = waited.json()
        assert review['status'] == 'awaiting_selection'
        assert review['baseExecutionId'] == first_id and review['reviewItemId'] == str(item.id)
        assert len(remote.posts) == 3
        chosen, = review['candidates']
        candidate_state = store.snapshot(pid)
        candidate_job = candidate_state.jobs[-1]
        previous = original_anchor if regenerate_anchor else original_continuation
        candidate_spec = next(spec for spec in candidate_state.generationSpecs if spec.id == previous.inputSnapshot.spec.id)
        current_result = next(result for result in candidate_state.results if result.id == candidate_spec.currentResultId)
        assert chosen['jobId'] == str(candidate_job.id) and not candidate_job.adopted
        assert current_result.jobId == previous.id
        seed = candidate_job.inputSnapshot.spec.parameters.seed
        assert seed is not None and seed != candidate_spec.parameters.seed == 27
        assert remote.posts[-1][0]['seed'] == str(seed)
        if not regenerate_anchor:
            assert candidate_job.inputSnapshot.timeline_guide(required=True).asset == original_anchor.asset
        assert len({entry['executionId'] for entry in query('run.groupExecutions.list', group.id)['executions']}) == 2

        branch_target = {**target, 'executionId': branch_id}
        missing = command('group.adoptRunCandidate', {**branch_target, 'jobId': original_anchor.id}, status=409)
        assert missing['code'] == 'segment_run_candidate_missing'
        adoption_id = uuid4()
        adoption = {**branch_target, 'jobId': chosen['jobId']}
        selected = command('group.adoptRunCandidate', adoption, operation=adoption_id)
        assert selected['runExecutionId'] == branch_id
        assert command('group.adoptRunCandidate', adoption, operation=adoption_id) == selected
        completed = wait(branch_id, 'succeeded')
        assert completed['outputAssetId'] != original_asset
        assert query('run.execution.get', first_id)['outputAssetId'] == original_asset
        assert client.get(f'{base}/assets/{original_asset}/content').content == original_content.content
        jobs = {str(job.id): job for job in store.snapshot(pid).jobs}
        branch_anchor, branch_continuation = (jobs[entry['jobId']] for entry in completed['steps'])
        if regenerate_anchor:
            assert len(remote.posts) == 4
            assert branch_anchor.id == candidate_job.id and branch_continuation.id != original_continuation.id
        else:
            assert len(remote.posts) == 3
            assert branch_anchor.id == original_anchor.id and str(branch_anchor.batchId) == first_id
            assert branch_continuation.id == candidate_job.id
        assert branch_continuation.inputSnapshot.timeline_guide(required=True).asset == branch_anchor.asset
        assert str(jobs[str(original_anchor.id)].batchId) == str(jobs[str(original_continuation.id)].batchId) == first_id

        if regenerate_anchor:
            requests_before_restart = len(remote.posts)
            restart_operation = uuid4()
            restarted = command('group.restartRun', branch_target, operation=restart_operation)
            assert restarted['runExecutionId'] not in {first_id, branch_id}
            assert command('group.restartRun', branch_target, operation=restart_operation) == restarted
            renewed = wait(restarted['runExecutionId'], 'succeeded')
            assert len(remote.posts) == requests_before_restart + 2
            restarted_jobs = store.snapshot(pid).jobs[-2:]
            assert {str(job.batchId) for job in restarted_jobs} == {renewed['executionId']}

            # Select the original continuation even though its guide is no longer the latest anchor job.
            historical = command('group.regenerateRunStep', {**first_target, 'itemId': a.id,
                                  'expectedExecutionId': renewed['executionId']})
            historical_review = wait(historical['runExecutionId'], 'awaiting_selection')
            assert historical_review['baseExecutionId'] == first_id
            historical_job = store.snapshot(pid).jobs[-1]
            assert historical_job.inputSnapshot.timeline_guide(required=True).asset == original_anchor.asset
            assert historical_job.inputSnapshot.timeline_guide(required=True).asset != restarted_jobs[0].asset


def test_known_vllm_poll_404_settles_run_and_allows_segment_regeneration(project, tmp_path):
    store, pid, session = project
    group, (continuation, _), (anchor, _), recipe, plan = _draft(project, tmp_path)
    output = tmp_path / 'result.mp4'
    _video(output, list(range(50, 157)))
    remote = FakeOmni(output.read_bytes())
    missing_polls = []

    def transport(request):
        if request.method == 'GET' and request.url.path == '/v1/videos/video_gen_2':
            missing_polls.append(request.url.path)
            return httpx.Response(404, json={'detail': 'Video task not found'})
        return remote(request)

    def open_app():
        store_port = ProviderMedia(SimpleNamespace(assets=CreationAssets(store)))
        provider = GenerationProviders(store_port, httpx.MockTransport(transport), poll_interval=0)
        return TestClient(create_app(store.local, generation_provider=provider), headers={
            'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session,
            'Accept-Language': 'en-US',
        })

    base = f'/api/creation/projects/{pid}'

    def command(kind, payload, *, versions=()):
        request = parse_command(dict(type=kind, projectId=pid, commandId=uuid4(),
                                     expectedVersions=versions, payload=payload))
        response = client.post(base + '/commands', json=request.model_dump(mode='json'))
        assert response.is_success, response.text
        return response.json()

    def execution(execution_id):
        response = client.post(base + '/queries', json=dict(type='run.execution.get', projectId=str(pid),
                               objectId=str(execution_id), queryId=str(uuid4())))
        assert response.is_success, response.text
        return response.json()

    def settled(execution_id):
        deadline = time.monotonic() + 15
        while True:
            run = execution(execution_id)
            if run['status'] not in {'queued', 'running', 'pausing'}:
                return run
            assert time.monotonic() < deadline, run
            time.sleep(.025)

    target = {'groupId': group.id}
    with open_app() as client:
        published = command('group.publishRun', {**target, 'plan': plan, 'assembly': recipe},
                            versions=[ver('canvas_item', group)])
        assert published['status'] == 'applied', published
        started = command('group.startRun', target)
        execution_id = started['runExecutionId']
        failed = settled(execution_id)
        assert failed['status'] == 'failed' and failed['outputAssetId'] is None, failed
        assert failed['issue']['code'] == 'segment_run_remote_missing'
        assert 'Regenerate this segment' in failed['issue']['message']
        assert failed['issue']['itemId'] == str(continuation.id)
        anchor_job, missing_job = store.snapshot(pid).jobs
        assert anchor_job.originItemId == anchor.id and anchor_job.status == 'succeeded'
        assert missing_job.originItemId == continuation.id and missing_job.externalTaskId == 'video_gen_2'
        assert missing_job.status == 'failed' and not missing_job.resumeAllowed and missing_job.recovery == 'retry'
        assert missing_job.errorDetails.stage == 'poll' and missing_job.errorDetails.httpStatus == 404
        assert len(remote.posts) == 2 and len(missing_polls) == 1

    journal = store.state_dir / 'segment-run-executions' / f'{pid}-{execution_id}.json'
    existing = json.loads(journal.read_text(encoding='utf-8'))
    # Simulate the execution state saved by a service that had not yet reconciled this Job.
    legacy = json.dumps({**existing, 'status': 'needs_review', 'issue': {
        'code': 'segment_run_job_unsettled', 'message': 'Check the original task.',
        'itemId': str(continuation.id),
    }})
    journal.write_text(legacy, encoding='utf-8')
    legacy_job = missing_job.model_copy(update={'revision': missing_job.revision + 1, 'resumeAllowed': True,
                                                'recovery': 'remote'})
    checkpoint = parse_command(dict(type='job.checkpoint', projectId=pid, commandId=uuid4(),
                                    expectedVersions=[ver('job', missing_job)], payload=dict(job=legacy_job)))
    updated = store.commit(checkpoint, lambda snapshot: snapshot.model_copy(update={'jobs': (anchor_job, legacy_job)}),
                           source='background')
    assert updated.status == 'applied', updated
    with open_app() as client:
        reconciled = execution(execution_id)
        assert reconciled['status'] == 'failed' and reconciled['issue']['code'] == 'segment_run_remote_missing'
        assert len(remote.posts) == 2 and len(missing_polls) == 1
        assert not store.snapshot(pid).jobs[-1].resumeAllowed

        journal.write_text(legacy, encoding='utf-8')
        selection = {**target, 'executionId': execution_id}
        checked = command('group.reconcileRun', selection)
        assert checked['runExecutionId'] == execution_id and execution(execution_id)['status'] == 'failed'
        assert len(remote.posts) == 2 and len(missing_polls) == 1

        redrawn = command('group.regenerateRunStep', {**selection, 'itemId': continuation.id})
        branch = settled(redrawn['runExecutionId'])
        assert branch['status'] == 'awaiting_selection' and branch['baseExecutionId'] == execution_id, branch
        candidate, = branch['candidates']
        candidate_job = store.snapshot(pid).jobs[-1]
        assert candidate['jobId'] == str(candidate_job.id) and candidate_job.id != missing_job.id
        assert candidate_job.inputSnapshot.timeline_guide(required=True).asset == anchor_job.asset
        assert len(remote.posts) == 3 and len(missing_polls) == 1
