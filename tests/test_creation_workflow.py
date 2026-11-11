"""Acceptance: current/hidden sources, immutable provenance and independent history."""
import asyncio
from io import BytesIO
from uuid import UUID, uuid4

from PIL import Image
import pytest

from opendirector.application.creation_canvas import CreationCanvas, asset_ref, resolved_inputs
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_history import CreationHistory
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.generation_errors import transport_failure
from test_creation_canvas_service import project, media, send, text_material, ver
from test_creation_generation_service import anyio_backend, Provider, runtime, configure


async def submit(runner, project, spec_id, origin=None, policy='if_current', *, batch_id=None, additional=False):
    store, pid, session = project
    current = store.snapshot(pid)
    spec = next(s for s in current.generationSpecs if s.id == spec_id)
    item = next((i for i in current.canvasItems if i.id == origin), None)
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('generation_spec', spec), *([ver('canvas_item', item)] if item else [])],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=origin, adoptionPolicy=policy,
                     batchId=batch_id, showAdditionalResult=additional)))
    receipt = await runner.execute(command, session=session)
    assert receipt.status == 'accepted', receipt
    return command, receipt


async def drain(runner):
    await asyncio.wait_for(asyncio.gather(*(j.future for j in list(runner.jobs.values()))), 10)


class Images(Provider):
    async def generate(self, config, task, submitted):
        self.calls.append(task)
        output = BytesIO()
        Image.new('RGB', (32, 24), 'red' if len(self.calls) == 1 else 'blue').save(output, 'PNG')
        return 'png', output.getvalue()


@pytest.mark.anyio
async def test_full_hidden_reference_version_history_timeline_and_restart_loop(project):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', 'http://127.0.0.1:12345/v1', 'test-image', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none')
    provider = Images()
    runner = CreationGeneration(store, configs, provider)
    source, a1 = text_material(project, 'A', 'first source version')
    target, spec = media(project, 'image', title='B')
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)],
        spec=spec.model_copy(update={'modelConfigId': UUID(config['id']), 'prompt': 'Draw using the source'})).status == 'applied'
    spec = store.snapshot(pid).generationSpecs[-1]
    reference_id = uuid4()
    assert send(store, pid, 'reference.add', session=session, versions=[ver('generation_spec', spec), ver('canvas_item', target)],
        reference=dict(id=reference_id, projectId=pid, targetSpecId=spec.id, binding='follow_current', source=dict(id=source.id))).status == 'applied'
    spec = store.snapshot(pid).generationSpecs[-1]
    assert send(store, pid, 'generationSpec.setPrompt', session=session, versions=[ver('generation_spec', spec)],
        specId=spec.id, prompt='Draw using ', promptContent=[
            dict(type='text', text='Draw using '), dict(type='reference', referenceId=reference_id)]).status == 'applied'
    first_command, _ = await submit(runner, project, spec.id, target.id)
    await drain(runner)
    snapshot = store.snapshot(pid)
    b1 = snapshot.results[-1]
    assert snapshot.jobs[-1].status == 'succeeded'
    assert snapshot.jobs[-1].inputSnapshot.references[0].asset.assetId == a1.id
    assert CreationCanvas(store).projection(pid)['edges'][0]['state'] == 'used'
    assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', source)], itemId=source.id).status == 'applied'
    assert send(store, pid, 'asset.writeText', session=session, versions=[ver('asset', a1)], name='A-v2.md',
        text='second source version', previousAsset=asset_ref(a1)).status == 'applied'
    a2 = store.snapshot(pid).assets[-1]
    hidden = store.snapshot(pid).canvasItems[0]
    assert send(store, pid, 'canvas.materialize', session=session, versions=[ver('canvas_item', hidden)], itemId=hidden.id, asset=asset_ref(a2)).status == 'applied'
    snapshot = store.snapshot(pid)
    assert resolved_inputs(snapshot, spec.id)[0].asset.assetId == a2.id
    assert snapshot.jobs[0].inputSnapshot.references[0].asset.assetId == a1.id
    assert CreationCanvas(store).projection(pid)['edges'][0]['state'] == 'pending'
    await submit(runner, project, spec.id, target.id)
    await drain(runner)
    snapshot = store.snapshot(pid)
    b2 = snapshot.results[-1]
    # Visibility is presentation only: the second job consumes the new A2
    # bytes while the first job's accepted A1 snapshot remains immutable.
    frozen = snapshot.jobs[-1].inputSnapshot
    assert len(frozen.references) == 1
    assert frozen.references[0].referenceId == reference_id
    assert frozen.references[0].asset == asset_ref(a2)
    assert frozen.spec.promptContent[-1].referenceId == reference_id
    assert frozen.spec.prompt == 'Draw using @A'
    assert provider.calls[-1]['referenceIds'] == [str(a2.id)]
    assert snapshot.jobs[0].inputSnapshot.references[0].asset == asset_ref(a1)
    assert snapshot.jobs[-1].execution.size == '1024x1024'
    timeline_id, timeline_item = uuid4(), uuid4()
    timeline = dict(id=timeline_id, projectId=pid, kind='timeline', data=dict(fps=30, width=1920, height=1080,
        tracks=[dict(id='visual', kind='visual', title='Visual', clips=[dict(id='clip', inPoint=0, outPoint=2,
            resource=dict(asset=b2.asset, title='B-v2'))])]))
    assert send(store, pid, 'creation.batch', session=session, operations=[dict(type='editor.create', payload=dict(document=timeline)),
        dict(type='canvas.show', payload=dict(item=dict(id=timeline_item, projectId=pid, kind='timeline', binding=dict(role='editor', objectRef=dict(id=timeline_id, kind='timeline')))))]).status == 'applied'
    current = store.snapshot(pid).generationSpecs[-1]
    assert send(store, pid, 'result.select', session=session, versions=[ver('generation_spec', current)], specId=spec.id, resultId=b1.id).status == 'applied'
    snapshot = store.snapshot(pid)
    assert snapshot.generationSpecs[-1].currentResultId == b1.id
    assert snapshot.editorDocuments[-1].data.tracks[0].clips[0].resource.asset == b2.asset
    history = CreationHistory(store)
    versions = history.versions(pid, spec.id)
    assert len(versions['results']) == 2
    assert any(v['configurationCommandId'] == first_command.commandId for v in versions['results'])
    current = store.snapshot(pid)
    expected = [ver('generation_spec', current.generationSpecs[-1]), *[ver('reference', r) for r in current.references]]
    assert send(store, pid, 'generationSpec.restore', session=session, versions=expected, specId=spec.id,
        commandId=first_command.commandId, referencePolicy='pinned').status == 'applied'
    snapshot = store.snapshot(pid)
    assert resolved_inputs(snapshot, spec.id)[0].asset.assetId == a1.id
    assert snapshot.generationSpecs[-1].currentResultId == b1.id  # Config restoration did not choose a result.
    hidden = snapshot.canvasItems[0]
    assert send(store, pid, 'canvas.show', session=session, versions=[ver('canvas_item', hidden)], item=hidden).status == 'applied'
    assert len(store.snapshot(pid).canvasItems) == 3
    assert not history.delete_preview(pid, [a1.id], True)['canDelete']
    assert not history.delete_preview(pid, [b2.asset.assetId], True)['canDelete']
    before = store.snapshot(pid)
    await runner.close()
    reopened = CreationProjects(LocalProjects(store.local.repository))
    assert reopened.snapshot(pid) == before
    cursors = [event.cursor for event in reopened.changes(pid, after=0, limit=200)['events']]
    assert cursors == list(range(1, before.eventCursor + 1))
    assert not (store.root / 'Unified' / 'canvas.json').exists()
    assert not (store.root / 'Unified' / 'opendirector-canvas.json').exists()
    assert not (store.root / 'Unified' / 'tasks').exists()


@pytest.mark.anyio
async def test_result_registration_rechecks_concurrent_edit_without_resubmitting_provider(project, monkeypatch):
    store, pid, session = project
    provider = Provider(); provider.finish.set()
    runner, config = runtime(project, provider)
    item, spec = configure(project, config)
    register = runner.assets.register
    registrations = []
    def concurrent_edit(command, **kwargs):
        registrations.append(command.commandId)
        if len(registrations) == 1:
            current = store.snapshot(pid).generationSpecs[-1]
            assert send(store, pid, 'generationSpec.update', session=session,
                versions=[ver('generation_spec', current)],
                spec=current.model_copy(update={'prompt': 'Concurrent user intent'})).status == 'applied'
        return register(command, **kwargs)
    monkeypatch.setattr(runner.assets, 'register', concurrent_edit)
    await submit(runner, project, spec.id, item.id)
    await drain(runner)
    final = store.snapshot(pid)
    assert final.jobs[0].status == 'succeeded'
    assert not final.jobs[0].adopted
    assert final.generationSpecs[0].prompt == 'Concurrent user intent'
    assert final.generationSpecs[0].currentResultId is None
    assert len(final.assets) == len(final.results) == len(provider.calls) == 1
    assert len(registrations) == 2 and registrations[0] != registrations[1]
    assert len(final.canvasItems) == 1
    await runner.close()


@pytest.mark.anyio
async def test_never_shown_spec_executes_and_replay_does_not_create_a_display_owner(project):
    store, pid, session = project
    provider = Provider(); provider.finish.set()
    runner, config = runtime(project, provider)
    spec_id = uuid4()
    assert send(store, pid, 'generationSpec.create', session=session,
        spec=dict(id=spec_id, projectId=pid, kind='text', modelConfigId=config['id'], prompt='Independent business object', parameters=dict(maxTokens=256, thinking='high'))).status == 'applied'
    command, receipt = await submit(runner, project, spec_id)
    await drain(runner)
    snapshot = store.snapshot(pid)
    assert not snapshot.canvasItems
    assert snapshot.jobs[0].status == 'succeeded'
    assert snapshot.jobs[0].execution.maxTokens == 256
    assert snapshot.jobs[0].execution.thinking == 'high'
    listing = CreationHistory(store).asset_list(pid)
    assert len(listing['items']) == 1 and listing['items'][0]['specId'] == spec_id
    assert not listing['items'][0]['owners']
    assert await runner.execute(command, session=session) == receipt
    assert len(provider.calls) == 1
    await runner.close()


@pytest.mark.anyio
async def test_unknown_submission_is_never_automatically_repeated_on_recovery_or_restart(project):
    class Unknown(Provider):
        async def generate(self, config, task, submitted):
            self.calls.append(task)
            raise transport_failure('submit')
    store, pid, session = project
    provider = Unknown()
    runner, config = runtime(project, provider)
    item, spec = configure(project, config)
    _, receipt = await submit(runner, project, spec.id, item.id)
    await drain(runner)
    job = store.snapshot(pid).jobs[0]
    assert job.errorDetails.category == 'submission_unknown'
    assert job.recovery == 'review' and not job.resumeAllowed
    await runner.recover(str(pid), str(job.id))
    await runner.close()
    second = CreationGeneration(store, runner.configs, provider)
    await second.start()
    assert len(provider.calls) == 1
    assert not store.snapshot(pid).results
    await second.close()


@pytest.mark.anyio
async def test_cancel_intent_is_durable_and_command_replay_cannot_restart_generation(project):
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    item, spec = configure(project, config)
    original, accepted = await submit(runner, project, spec.id, item.id)
    await asyncio.wait_for(provider.started.wait(), 3)
    job = store.snapshot(pid).jobs[0]
    cancel = parse_command(dict(commandId=uuid4(), projectId=pid, type='job.cancel',
        expectedVersions=[ver('job', job)], payload=dict(jobId=job.id)))
    receipt = await runner.execute(cancel, session=session)
    assert receipt.status == 'applied'
    stopped = store.snapshot(pid).jobs[0]
    assert stopped.cancelRequested and stopped.status == 'cancelled'
    assert await runner.execute(cancel, session=session) == receipt
    assert await runner.execute(original, session=session) == accepted
    assert len(provider.calls) == 1
    assert not store.snapshot(pid).results
    await runner.close()


@pytest.mark.anyio
async def test_complete_bytes_recover_locally_after_registration_failure_without_provider_resubmit(project):
    store, pid, session = project
    provider = Provider(); provider.finish.set()
    runner, config = runtime(project, provider)
    item, spec = configure(project, config)
    def fail_registration(*args):
        raise OSError('Injected registration failure after complete bytes')
    runner._commit_output = fail_registration
    _, receipt = await submit(runner, project, spec.id, item.id)
    await drain(runner)
    failed = store.snapshot(pid).jobs[0]
    assert failed.recovery == 'local' and failed.resumeAllowed
    await runner.close()
    reopened = CreationProjects(LocalProjects(store.local.repository))
    second = CreationGeneration(reopened, runner.configs, provider)
    await second.start()
    await drain(second)
    done = reopened.snapshot(pid)
    assert done.jobs[0].status == 'succeeded', done.jobs[0]
    assert done.jobs[0].id == receipt.jobIds[0]
    assert len(done.assets) == len(done.results) == len(provider.calls) == 1
    await second.close()


@pytest.mark.anyio
async def test_interrupted_remote_video_resumes_original_external_id_after_restart(project, tmp_path):
    import shutil
    import subprocess
    if not shutil.which('ffmpeg'):
        pytest.skip('Real output inspection needs ffmpeg fixture generation')
    video = tmp_path / 'provider.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:r=24',
                    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True)
    class Remote(Provider):
        paid = 0
        async def generate(self, config, task, submitted):
            self.calls.append(task)
            if not task['externalTaskId']:
                self.paid += 1
                await submitted('original-provider-task')
                raise transport_failure('poll')
            assert task['externalTaskId'] == 'original-provider-task'
            return 'mp4', video.read_bytes()
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('video', 'http://127.0.0.1:12345/v1', 'MiniMax-H3', '', connection_type='self_hosted', protocol='vllm_omni', auth_mode='none')
    provider = Remote()
    runner = CreationGeneration(store, configs, provider)
    item, spec = media(project, 'video')
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)],
        spec=spec.model_copy(update={'modelConfigId': UUID(config['id']), 'prompt': 'A blue scene'})).status == 'applied'
    await submit(runner, project, spec.id, item.id)
    await drain(runner)
    interrupted = store.snapshot(pid).jobs[0]
    assert interrupted.status == 'interrupted' and interrupted.externalTaskId == 'original-provider-task'
    assert interrupted.recovery == 'remote' and interrupted.resumeAllowed
    await runner.close()
    reopened = CreationProjects(LocalProjects(store.local.repository))
    second = CreationGeneration(reopened, configs, provider)
    await second.start()
    await drain(second)
    final = reopened.snapshot(pid)
    assert final.jobs[0].status == 'succeeded', final.jobs[0]
    assert final.jobs[0].id == interrupted.id
    assert provider.paid == 1 and len(provider.calls) == 2
    assert final.assets[0].metadata.width == 32
    assert not (store.root / 'Unified' / 'tasks').exists()
    await second.close()


@pytest.mark.anyio
async def test_real_agent_adapter_uses_frozen_reference_names_and_ignores_presentation_only_changes(project):
    import json
    import httpx
    from opendirector.integrations.providers import GenerationProviders
    store, pid, session = project
    runner, config = runtime(project, Provider())
    captured = []
    def service(request):
        captured.append(json.loads(request.content))
        content = ('data: {"choices":[{"delta":{"content":"An actual adapter result"},"finish_reason":null}]}\n\n'
                   'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
                   'data: [DONE]\n\n')
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=content)
    runner.provider = GenerationProviders(runner.store, transport=httpx.MockTransport(service))
    source, asset = text_material(project, title='A', text='Original source body')
    target, spec = configure(project, config)
    ref_id = uuid4()
    assert send(store, pid, 'reference.add', session=session, versions=[ver('canvas_item', target), ver('generation_spec', spec)],
        reference=dict(id=ref_id, projectId=pid, targetSpecId=spec.id, binding='follow_current', source=dict(id=source.id))).status == 'applied'
    spec = store.snapshot(pid).generationSpecs[-1]
    assert send(store, pid, 'generationSpec.setPrompt', session=session, versions=[ver('generation_spec', spec)], specId=spec.id,
        prompt='Use @A', promptContent=[dict(type='text', text='Use '), dict(type='reference', referenceId=ref_id)]).status == 'applied'
    await runner.limit.acquire(); await runner.limit.acquire()
    try:
        await submit(runner, project, spec.id, target.id)
        assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', source)], itemId=source.id, title='Renamed node').status == 'applied'
        assert send(store, pid, 'asset.updateMetadata', session=session, versions=[ver('asset', asset)], assetId=asset.id, name='Renamed-file.md').status == 'applied'
    finally:
        runner.limit.release(); runner.limit.release()
    await drain(runner)
    snapshot = store.snapshot(pid)
    assert snapshot.jobs[0].status == 'succeeded', snapshot.jobs[0]
    assert snapshot.jobs[0].adopted
    assert len(captured) == 1
    actual = json.dumps(captured[0]['messages'], ensure_ascii=False)
    assert 'Original source body' in actual and 'A.md' in actual
    assert 'Renamed' not in actual
    assert CreationCanvas(store).projection(pid)['edges'][0]['state'] == 'used'
    await runner.close()


@pytest.mark.anyio
async def test_two_runtime_owners_cannot_submit_the_same_durable_job_twice(project):
    store, pid, session = project
    provider = Provider()
    first, config = runtime(project, provider)
    item, spec = configure(project, config)
    _, receipt = await submit(first, project, spec.id, item.id)
    await asyncio.wait_for(provider.started.wait(), 3)
    second = CreationGeneration(CreationProjects(LocalProjects(store.local.repository)), first.configs,
        provider)
    await second.recover(str(pid), str(receipt.jobIds[0]))
    await drain(second)
    assert len(provider.calls) == 1
    provider.finish.set()
    await drain(first)
    assert store.snapshot(pid).jobs[0].status == 'succeeded'
    await first.close(); await second.close()


@pytest.mark.anyio
async def test_text_agent_preserves_manual_versions_and_new_handwriting_requires_explicit_result_selection(project):
    from opendirector.application.creation_canvas import current_asset
    store, pid, session = project
    provider = Provider()
    runner, config = runtime(project, provider)
    item, original = text_material(project, title='Handwritten', text='Original handwritten body')
    spec_id = uuid4()
    assert send(store, pid, 'generationSpec.create', session=session,
        spec=dict(id=spec_id, projectId=pid, kind='text', modelConfigId=config['id'], prompt='Write an alternative')).status == 'applied'
    spec = store.snapshot(pid).generationSpecs[-1]
    assert send(store, pid, 'canvas.configure', session=session, versions=[ver('canvas_item', item), ver('generation_spec', spec)],
        itemId=item.id, specId=spec_id, preserveMaterial=True).status == 'applied'
    snapshot = store.snapshot(pid)
    assert current_asset(snapshot, snapshot.canvasItems[0]).id == original.id
    await submit(runner, project, spec_id, item.id)
    await asyncio.wait_for(provider.started.wait(), 3)
    assert send(store, pid, 'asset.writeText', session=session, versions=[ver('asset', original)],
        name='New-handwriting.md', text='My edit made while the model was running', previousAsset=asset_ref(original)).status == 'applied'
    current = store.snapshot(pid)
    edited = current.assets[-1]
    assert send(store, pid, 'canvas.materialize', session=session, versions=[ver('canvas_item', current.canvasItems[0])],
        itemId=item.id, asset=asset_ref(edited), discardGenerationDraft=True).status == 'applied'
    provider.finish.set()
    await drain(runner)
    snapshot = store.snapshot(pid)
    assert snapshot.jobs[0].status == 'succeeded' and not snapshot.jobs[0].adopted
    assert current_asset(snapshot, snapshot.canvasItems[0]).id == edited.id
    assert snapshot.generationSpecs[-1].currentResultId is None
    result = snapshot.results[0]
    assert send(store, pid, 'result.select', session=session,
        versions=[ver('generation_spec', snapshot.generationSpecs[-1]), ver('canvas_item', snapshot.canvasItems[0])],
        specId=spec_id, resultId=result.id).status == 'applied'
    snapshot = store.snapshot(pid)
    assert current_asset(snapshot, snapshot.canvasItems[0]).id == result.asset.assetId
    assert len(snapshot.assets) == 3
    assert (store.root / 'Unified' / original.path).read_text() == 'Original handwritten body'
    await runner.close()


@pytest.mark.anyio
@pytest.mark.parametrize('hide_origin', [False, True])
async def test_batch_results_are_presented_without_execution_nodes_and_hidden_batches_do_not_pop_up(project, hide_origin):
    class HeldImages(Images):
        async def generate(self, config, task, submitted):
            self.started.set()
            await self.finish.wait()
            return await super().generate(config, task, submitted)
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', 'http://127.0.0.1:12345/v1', 'test-image', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none')
    provider = HeldImages()
    runner = CreationGeneration(store, configs, provider)
    item, spec = media(project, 'image')
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)],
        spec=spec.model_copy(update={'modelConfigId': UUID(config['id']), 'prompt': 'A batch of images'})).status == 'applied'
    batch_id = uuid4()
    await submit(runner, project, spec.id, item.id, batch_id=batch_id)
    additional, receipt = await submit(runner, project, spec.id, item.id, 'candidate_only', batch_id=batch_id, additional=True)
    await asyncio.wait_for(provider.started.wait(), 3)
    if hide_origin:
        origin = store.snapshot(pid).canvasItems[0]
        assert send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', origin)], itemId=origin.id).status == 'applied'
    provider.finish.set()
    await drain(runner)
    snapshot = store.snapshot(pid)
    assert len(snapshot.assets) == len(snapshot.results) == len(snapshot.jobs) == 2, [(j.status, j.phase, j.errorDetails) for j in snapshot.jobs]
    assert len(snapshot.generationSpecs) == 1
    assert len(snapshot.canvasItems) == (1 if hide_origin else 2)
    assert snapshot.canvasItems[0].width / snapshot.canvasItems[0].height == pytest.approx(4 / 3)
    assert max(snapshot.canvasItems[0].width, snapshot.canvasItems[0].height) == max(item.width, item.height)
    if not hide_origin:
        assert snapshot.canvasItems[1].binding.role == 'material'
        assert snapshot.canvasItems[1].width / snapshot.canvasItems[1].height == pytest.approx(4 / 3)
    else:
        assert not snapshot.canvasItems[0].visible
    assert await runner.execute(additional, session=session) == receipt
    assert len(store.snapshot(pid).canvasItems) == len(snapshot.canvasItems)
    assert len(provider.calls) == 2
    await runner.close()
