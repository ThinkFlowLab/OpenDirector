"""Provider doubles exercise the real durable runtime, files and restart path."""
import asyncio
from io import BytesIO
from threading import Event
from uuid import UUID, uuid4

import pytest
from PIL import Image

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref, resolved_inputs
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.generation import PromptText
from opendirector.domain.image_presets import FOUR_VIEW_FACE_EMPHASIS, FOUR_VIEW_FACE_TEXT, FOUR_VIEW_TEXT, PRESETS
from opendirector.infrastructure.model_configs import ModelConfigs
from test_creation_assembly import upload_source
from test_creation_canvas_service import project, media, send, text_material, ver


pytestmark = pytest.mark.cpu


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


@pytest.mark.parametrize('purpose', ['generation', 'draft'])
@pytest.mark.parametrize('guide_policy', ['legacy', 'all-guided', 'anchor-exempt'])
def test_assembly_segments_require_their_origin_and_configured_guide_at_generation_admission(project, tmp_path, purpose, guide_policy):
    store, pid, session = project
    require_guides = guide_policy != 'legacy'
    permit_unguided_anchor = guide_policy == 'anchor-exempt'
    configs = ModelConfigs(store.local.repository)
    config = configs.save('video', 'http://127.0.0.1:12345/v1', 'MiniMaxAI/MiniMax-H3', '',
        connection_type='self_hosted', protocol='vllm_omni', video_adapter='minimax_h3', capability_auto_check=False)
    runner = CreationGeneration(store, configs, Provider())
    clip, clip_spec = media(project, 'video', title='Segment B', purpose=purpose)
    other, other_spec = media(project, 'video', title='Opening anchor' if permit_unguided_anchor else 'Unlisted segment',
        purpose='generation')
    group_id, subgroup_id, timeline_id, document_id = uuid4(), uuid4(), uuid4(), uuid4()
    assembly = dict(timelineItemId=timeline_id, outputItemId=uuid4(), requireTimelineGuides=require_guides,
        clips=[dict(itemId=clip.id, inFrame=0, outFrame=24)])
    if permit_unguided_anchor:
        assembly['clips'].append(dict(itemId=other.id, inFrame=0, outFrame=24))
        assembly['guideExemptItemId'] = other.id
    receipt = send(store, pid, 'creation.batch', session=session, versions=[ver('canvas_item', clip), ver('canvas_item', other),
        ver('generation_spec', clip_spec), ver('generation_spec', other_spec)], operations=[
        dict(type='editor.create', payload=dict(document=dict(id=document_id, projectId=pid,
            kind='timeline', data=dict(width=960, height=544, fps=24,
                tracks=[dict(id='visual', kind='visual', title='Visual')])))),
        dict(type='canvas.show', payload=dict(item=dict(id=timeline_id, projectId=pid, kind='timeline',
            binding=dict(role='editor', objectRef=dict(id=document_id, kind='timeline'))))),
        dict(type='canvas.show', payload=dict(item=dict(id=group_id, projectId=pid, kind='group', assembly=assembly))),
        dict(type='canvas.show', payload=dict(item=dict(id=subgroup_id, projectId=pid, kind='group', parentId=group_id))),
        dict(type='canvas.update', payload=dict(itemId=clip.id, parentId=subgroup_id)),
        dict(type='canvas.update', payload=dict(itemId=other.id, parentId=group_id)),
        *[dict(type='generationSpec.update', payload=dict(spec=spec.model_copy(update={
            'prompt': 'A performer in a studio', 'modelConfigId': UUID(config['id']),
        }))) for spec in (clip_spec, other_spec)],
    ])
    assert receipt.status == 'applied', receipt
    group = next(item for item in store.snapshot(pid).canvasItems if item.id == group_id)
    assert ('requireTimelineGuides' in group.assembly.model_dump()) is require_guides
    assert ('guideExemptItemId' in group.assembly.model_dump()) is permit_unguided_anchor
    def request(spec_id, expected_item, origin=None):
        snapshot = store.snapshot(pid)
        spec = next(spec for spec in snapshot.generationSpecs if spec.id == spec_id)
        item = next(item for item in snapshot.canvasItems if item.id == expected_item)
        return parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
            expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
            payload=dict(specId=spec_id, expectedSpecRevision=spec.revision, originItemId=origin)))

    missing = runner.prepare(request(clip_spec.id, clip.id), session=session)
    assert missing.status == 'rejected'
    issue, = missing.issues
    assert (issue.code, issue.objectId, issue.message) == (
        'invalid_input', clip_spec.id, '分组片段提交时必须指定来源画布节点（originItemId）。')
    wrong = runner.prepare(request(clip_spec.id, other.id, other.id), session=session)
    assert wrong.status == 'rejected'
    assert wrong.issues[0].objectId == other.id
    assert store.snapshot(pid).jobs == ()

    if require_guides:
        blocked = runner.prepare(request(clip_spec.id, clip.id, clip.id), session=session)
        assert blocked.status == 'rejected'
        issue, = blocked.issues
        assert (issue.code, issue.objectId, issue.message) == (
            'reference_invalid', clip.id, '片段「Segment B」必须使用有效的 H3 时间线导帧。')
        assert store.snapshot(pid).jobs == ()
        _, guide = upload_source(project, tmp_path, 'video', seconds=3)
        guide_id = uuid4()
        snapshot = store.snapshot(pid)
        spec = next(spec for spec in snapshot.generationSpecs if spec.id == clip_spec.id)
        item = next(item for item in snapshot.canvasItems if item.id == clip.id)
        assert send(store, pid, 'creation.batch', session=session,
            versions=[ver('canvas_item', item), ver('generation_spec', spec)], operations=[
                dict(type='generationSpec.update', payload=dict(spec={
                    **spec.model_dump(), 'parameters': {'videoMode': 'reference',
                                                        'h3Segment': {'guideReferenceId': guide_id, 'sourceFrames': [0, 2]}},
                })),
                dict(type='reference.add', payload=dict(reference=dict(
                    id=guide_id, projectId=pid, targetSpecId=spec.id, binding='pinned', source=asset_ref(guide)))),
            ]).status == 'applied'
    command = request(clip_spec.id, clip.id, clip.id)
    accepted = runner.prepare(command, session=session)
    assert accepted.status == 'accepted', accepted
    assert runner.prepare(command, session=session) == accepted
    other_origin = other.id if permit_unguided_anchor else None
    standalone = runner.prepare(request(other_spec.id, other.id, other_origin), session=session)
    assert standalone.status == 'accepted', standalone
    jobs = store.snapshot(pid).jobs
    assert [(job.inputSnapshot.spec.id, job.originItemId) for job in jobs] == [
        (clip_spec.id, clip.id), (other_spec.id, other_origin),
    ]
    assert 'h3Guide' not in runner.task(jobs[1])
    if require_guides:
        assert runner.task(jobs[0])['h3Guide'] == {'assetId': str(guide.id), 'frames': (0, 2)}
        assert jobs[0].inputSnapshot.references[0].sourceVersion is None
    current_clip = next(item for item in store.snapshot(pid).canvasItems if item.id == clip.id)
    assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', current_clip)],
        itemId=clip.id, parentId=None).status == 'applied'
    detached = runner.prepare(request(clip_spec.id, clip.id), session=session)
    assert detached.status == ('rejected' if require_guides else 'accepted'), detached
    if require_guides:
        assert store.snapshot(pid).jobs == jobs
        assert runner.prepare(request(clip_spec.id, clip.id, clip.id), session=session).status == 'accepted'


@pytest.mark.anyio
async def test_cancel_wins_over_an_in_flight_running_checkpoint(project, monkeypatch):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    target, spec = configure(project, config)
    started = asyncio.Event()
    release = Event()
    loop = asyncio.get_running_loop()
    commit = store.commit
    cancel = runner.cancel
    conflicts = []

    def hold_running_checkpoint(command, *args, **kwargs):
        if command.type == 'job.checkpoint' and command.payload.job.status == 'running':
            loop.call_soon_threadsafe(started.set)
            assert release.wait(10)
            receipt = commit(command, *args, **kwargs)
            conflicts.extend(issue.code for issue in receipt.issues)
            return receipt
        return commit(command, *args, **kwargs)

    async def release_after_cancelling(project_id, job_id, edit_session):
        # cancel() sends the worker's cancellation before it yields.
        loop.call_soon(release.set)
        await cancel(project_id, job_id, edit_session)

    monkeypatch.setattr(store, 'commit', hold_running_checkpoint)
    monkeypatch.setattr(runner, 'cancel', release_after_cancelling)
    try:
        submit = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
            expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
            payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
        assert (await runner.execute(submit, session=session)).status == 'accepted'
        await asyncio.wait_for(started.wait(), 5)
        job = store.snapshot(pid).jobs[0]
        command = parse_command(dict(commandId=uuid4(), projectId=pid, type='job.cancel',
            expectedVersions=[ver('job', job)], payload=dict(jobId=job.id)))
        assert (await runner.execute(command, session=session)).status == 'applied'
        final = store.snapshot(pid).jobs[0]
        assert conflicts == ['revision_conflict']
        assert final.id == job.id and final.cancelRequested
        assert final.status == 'cancelled'
        assert not final.resumeAllowed
        assert not provider.calls
    finally:
        release.set()
        await runner.close()


@pytest.mark.anyio
@pytest.mark.parametrize('preset_key, with_reference, face_emphasis, user_prompt, steps', [
    pytest.param('four-view', False, False, '蓝色外套和短发', (FOUR_VIEW_TEXT,), id='four-view-text'),
    pytest.param('four-view', False, True, '', (FOUR_VIEW_FACE_TEXT,), id='four-view-text-face-emphasis'),
    pytest.param('four-view', True, False, '', PRESETS['four-view'].prompts, id='four-view-reference'),
    pytest.param('four-view', 'duplicate', False, '', PRESETS['four-view'].prompts, id='four-view-duplicate-image'),
    pytest.param('four-view', True, True, '', (FOUR_VIEW_FACE_EMPHASIS,), id='four-view-reference-face-emphasis'),
    *(
        pytest.param(key, with_image, False, '' if with_image else '暖色调，主体偏左。',
                     preset.prompts if with_image else preset.text_prompts,
                     id=f'{key}-{"reference" if with_image else "text"}')
        for key, preset in PRESETS.items() if key != 'four-view'
        for with_image in (False, True)
    ),
])
async def test_image_preset_freezes_the_instructions_for_the_available_inputs(
    project, preset_key, with_reference, face_emphasis, user_prompt, steps,
):
    store, pid, session = project
    expected = steps[0] if len(steps) == 1 else '\n'.join([
        '按以下顺序逐张生成：', *(f'{index}. {step}' for index, step in enumerate(steps, 1)),
    ])

    class ImageProvider(Provider):
        async def generate(self, config, task, submitted):
            self.calls.append(task)
            image = BytesIO()
            Image.new('RGB', (32, 32), 'blue').save(image, 'PNG')
            return 'png', image.getvalue()

    provider = ImageProvider()
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', 'http://127.0.0.1:12345/v1', 'fixture-image', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none', capability_auto_check=False)
    runner = CreationGeneration(store, configs, provider)
    try:
        target, spec = media(project, kind='image')
        content = (PromptText(type='text', text=user_prompt),) if user_prompt else ()
        changed = spec.model_copy(update={'modelConfigId': UUID(config['id']), 'prompt': user_prompt,
            'promptContent': content,
            'parameters': spec.parameters.model_copy(update={'preset': preset_key, 'faceEmphasis': face_emphasis})})
        assert send(store, pid, 'generationSpec.update', session=session,
            versions=[ver('generation_spec', spec)], spec=changed).status == 'applied'
        if with_reference:
            image = BytesIO()
            Image.new('RGB', (32, 32), 'red').save(image, 'PNG')
            handle = uuid4()
            writer = CreationAssets(store).uploads.begin(pid, handle, session, 'reference.png', expected_kind='image')
            writer.write(image.getvalue())
            writer.finish()
            assert send(store, pid, 'asset.import', session=session, uploadHandle=handle,
                name='reference.png', expectedKind='image').status == 'applied'
            snapshot = store.snapshot(pid)
            linked = send(store, pid, 'reference.add', session=session, versions=[
                ver('canvas_item', snapshot.canvasItems[0]),
                ver('generation_spec', snapshot.generationSpecs[0])], reference=dict(
                id=uuid4(), projectId=pid, binding='pinned', source=asset_ref(snapshot.assets[0]),
                targetSpecId=spec.id))
            assert linked.status == 'applied', linked
            if with_reference == 'duplicate':
                source, _ = media(project, kind='image', title='Same image on canvas')
                materialized = send(store, pid, 'canvas.materialize', session=session,
                    versions=[ver('canvas_item', source)], itemId=source.id, asset=asset_ref(snapshot.assets[0]))
                assert materialized.status == 'applied', materialized
                snapshot = store.snapshot(pid)
                linked = send(store, pid, 'reference.add', session=session, versions=[
                    ver('canvas_item', snapshot.canvasItems[0]),
                    ver('generation_spec', snapshot.generationSpecs[0])], reference=dict(
                    id=uuid4(), projectId=pid, binding='follow_current', source=dict(id=source.id),
                    targetSpecId=spec.id, order=1))
                assert linked.status == 'applied', linked
        for _ in range(2):
            before = store.snapshot(pid)
            target, spec = before.canvasItems[0], before.generationSpecs[0]
            command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
                expectedVersions=[ver('canvas_item', target), ver('generation_spec', spec)],
                payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
            receipt = await runner.execute(command, session=session)
            assert receipt.status == 'accepted', receipt
            await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
            after = store.snapshot(pid)
            job = next(job for job in after.jobs if job.id in receipt.jobIds)
            assert job.status == 'succeeded' and job.adopted
            assert job.inputSnapshot.presetPrompt == expected
            assert after.generationSpecs[0].prompt == user_prompt
            assert after.generationSpecs[0].promptContent == content
        assert len(provider.calls) == 2
        for call in provider.calls:
            assert len(call['referenceIds']) == int(bool(with_reference))
            if face_emphasis:
                assert '眼睛、鼻子和嘴留在画外' in call['prompt']
                assert all(detail not in call['prompt'] for detail in ('卡通角色', '大头', '短颈', '无颈', '下巴'))
            assert ('参考图' in call['prompt']) == bool(with_reference)
            assert call['prompt'] == (f'{expected}\n\n{user_prompt}' if user_prompt else expected)
            assert call['promptContent'] == (
                [dict(type='text', text=expected + '\n\n'), dict(type='text', text=user_prompt)]
                if user_prompt else [dict(type='text', text=expected)])
    finally:
        await runner.close()



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
