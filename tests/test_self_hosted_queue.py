import asyncio
from uuid import uuid4

import pytest

from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.generation_runtime import _execution_timeout
from generation_helpers import new_project, prepared, tasks, cancel
from test_tool_tasks import mp4
from opendirector.domain.generation import GenerationError
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.providers import GenerationProviders

import httpx


pytestmark = pytest.mark.cpu


@pytest.fixture
def context(tmp_path):
    store, pid, session = new_project(tmp_path, '自部署排队')
    configs = ModelConfigs(tmp_path)
    config = configs.save('video', 'http://127.0.0.1:18092/v1', 'FastH3-Omni', '', connection_type='self_hosted')
    return store, session, {'id': str(pid)}, configs, config


def prepare(manager, context):
    store, session, project, _, config = context
    return prepared(manager, (store, project['id'], session), config, parameters={'videoMode': 'reference'})


def test_same_video_service_remains_queued_until_previous_task_finishes(context):
    store, _, project, configs, _ = context

    async def run():
        gates = [asyncio.Event(), asyncio.Event()]
        started = [asyncio.Event(), asyncio.Event()]

        class Provider:
            calls = []
            def validate(self, *args): pass
            async def generate(self, config, task, submitted):
                index = len(self.calls)
                self.calls.append(task['id'])
                await submitted(f'remote-{index}')
                started[index].set()
                await gates[index].wait()
                return 'mp4', mp4()

        provider = Provider()
        manager = CreationGeneration(store, configs, provider)
        first, second = prepare(manager, context), prepare(manager, context)
        try:
            manager._launch(*first)
            await asyncio.wait_for(started[0].wait(), 5)
            manager._launch(*second)
            await asyncio.sleep(.05)
            receipt = next(t for t in tasks(manager, project['id']) if t['id'] == second[0]['id'])
            assert receipt['status'] == 'queued' and receipt['phase'] == 'queued'
            assert receipt['externalTaskId'] is None and provider.calls == [first[0]['id']]
            gates[0].set()
            await asyncio.wait_for(started[1].wait(), 5)
            gates[1].set()
            await asyncio.gather(*(job.future for job in list(manager.jobs.values())))
            assert all(t['status'] == 'succeeded' for t in tasks(manager, project['id']))
            assert provider.calls == [first[0]['id'], second[0]['id']]
        finally:
            gates[0].set(); gates[1].set()
            await manager.close()
    asyncio.run(run())


def test_timeout_keeps_remote_id_and_explains_cloud_execution_continues(context, monkeypatch):
    store, _, project, configs, _ = context
    assert _execution_timeout({'kind': 'video', 'protocol': 'vllm_omni'}) == 14400
    assert _execution_timeout({'kind': 'image'}) == 1800
    monkeypatch.setattr('opendirector.application.generation_runtime._execution_timeout', lambda task: 1)

    class Provider:
        calls = 0
        def validate(self, *args): pass
        async def generate(self, config, task, submitted):
            self.calls += 1
            await submitted('existing-remote-job')
            await asyncio.Event().wait()

    async def run():
        provider = Provider()
        manager = CreationGeneration(store, configs, provider)
        try:
            manager._launch(*prepare(manager, context))
            await asyncio.gather(*(job.future for job in list(manager.jobs.values())))
            task = tasks(manager, project['id'])[0]
            assert task['status'] == 'interrupted' and task['recovery'] == 'remote'
            assert task['externalTaskId'] == 'existing-remote-job' and provider.calls == 1
            assert '云端任务未自动取消' in task['errorDetails']['message'] and '磁盘' not in task['errorDetails']['message']
        finally:
            await manager.close()
    asyncio.run(run())


def test_failed_video_download_keeps_remote_task_for_recovery_without_resubmission(context):
    store, _, project, configs, _ = context

    class Provider:
        calls = 0
        def validate(self, *args): pass
        async def generate(self, config, task, submitted):
            self.calls += 1
            await submitted('paid-remote-job')
            raise ProjectError('Download failed', 502)

    async def run():
        provider = Provider()
        manager = CreationGeneration(store, configs, provider)
        try:
            manager._launch(*prepare(manager, context))
            await asyncio.gather(*(job.future for job in list(manager.jobs.values())))
            task = tasks(manager, project['id'])[0]
            assert task['status'] == 'failed' and task['recovery'] == 'remote' and task['resumeAllowed'] is True
            assert task['externalTaskId'] == 'paid-remote-job' and provider.calls == 1
        finally:
            await manager.close()
    asyncio.run(run())


@pytest.mark.parametrize('fail_first', [False, True])
@pytest.mark.parametrize('model', ['FastH3-Omni', 'MiniMaxAI/MiniMax-H3'])
def test_video_download_preserves_original_bytes_and_recovers_without_resubmission(context, fail_first, model):
    store, session, project, configs, saved = context
    config = configs.save('video', saved['url'], model, '', saved['id'], connection_type='self_hosted', protocol='vllm_omni')
    requests = []
    original = mp4(seconds=107 / 24)

    def respond(request):
        requests.append((request.method, request.url.path))
        if request.method == 'POST':
            return httpx.Response(200, json={'id': 'paid-remote-job', 'status': 'queued'})
        if request.url.path.endswith('/content'):
            if fail_first and sum(path.endswith('/content') for _, path in requests) == 1:
                return httpx.Response(500, text='Download failed')
            return httpx.Response(200, content=original, headers={'content-type': 'video/mp4'})
        return httpx.Response(200, json={'status': 'completed'})

    async def run():
        manager = CreationGeneration(store, configs)
        manager.provider = GenerationProviders(manager.store, httpx.MockTransport(respond), .001)
        try:
            manager._launch(*prepared(manager, (store, project['id'], session), config,
                parameters={'videoMode': 'reference', 'durationSeconds': 4.33}))
            await asyncio.gather(*(job.future for job in list(manager.jobs.values())))
            initial = tasks(manager, project['id'])[0]
            frozen = store.snapshot(project['id']).jobs[0].inputSnapshot
            if fail_first:
                assert initial['status'] == 'failed' and initial['recovery'] == 'remote' and initial['resumeAllowed'] is True
                await manager.recover(project['id'], initial['id'])
                await asyncio.gather(*(job.future for job in list(manager.jobs.values())))
            task = tasks(manager, project['id'])[0]
            assert task['status'] == 'succeeded' and task['id'] == initial['id']
            assert task['externalTaskId'] == 'paid-remote-job' and task['assetId']
            assert task['parameters'] == initial['parameters']
            assert store.snapshot(project['id']).jobs[0].inputSnapshot == frozen
            stream, asset = manager.assets.open_media(project['id'], task['assetId'])
            with stream:
                assert stream.read() == original
            assert asset.metadata.durationSeconds > 4.4
        finally:
            await manager.close()
    asyncio.run(run())
    assert [path for method, path in requests if method == 'POST'] == ['/v1/videos']
    assert sum(path.endswith('/content') for _, path in requests) == (2 if fail_first else 1)


@pytest.mark.parametrize('state', ['interrupted', 'failed'])
def test_interrupted_remote_video_can_be_cancelled_without_resubmission(context, state):
    store, session, project, configs, _ = context

    class Provider:
        cancelled = []
        def validate(self, *args): pass
        async def cancel(self, config, remote_id): self.cancelled.append(remote_id)

    async def run():
        provider = Provider()
        manager = CreationGeneration(store, configs, provider)
        task, pinned, _ = prepare(manager, context)
        task.update(status=state, externalTaskId='timed-out-remote', recovery='remote', resumeAllowed=True)
        manager.checkpoint(project['id'], task, pinned)
        try:
            await cancel(manager, project['id'], task['id'], session)
            receipt = tasks(manager, project['id'])[0]
            assert provider.cancelled == ['timed-out-remote']
            assert receipt['status'] == 'cancelled' and receipt['recovery'] == 'remote'
            assert receipt['resumeAllowed'] and not manager.jobs
        finally:
            await manager.close()
    asyncio.run(run())


def test_waiting_for_one_service_does_not_block_other_services_and_can_be_cancelled(context):
    store, session, project, configs, _ = context
    other_config = configs.save('video', 'http://127.0.0.1:18093/v1', 'FastH3-Omni', '', connection_type='self_hosted')

    async def run():
        started, release = asyncio.Queue(), asyncio.Event()
        class Provider:
            calls = []
            def validate(self, *args): pass
            async def generate(self, config, task, submitted):
                self.calls.append(task['id'])
                await submitted('remote-' + task['id'])
                await started.put(task['id'])
                await release.wait()
                return 'mp4', mp4()
        provider = Provider()
        manager = CreationGeneration(store, configs, provider)
        first, queued = prepare(manager, context), prepare(manager, context)
        other = prepare(manager, (store, session, project, configs, other_config))
        try:
            manager._launch(*first)
            assert await asyncio.wait_for(started.get(), 5) == first[0]['id']
            manager._launch(*queued)
            manager._launch(*other)
            assert await asyncio.wait_for(started.get(), 5) == other[0]['id']
            assert queued[0]['id'] not in provider.calls
            await cancel(manager, project['id'], queued[0]['id'], session)
            release.set()
            await asyncio.gather(*(job.future for job in list(manager.jobs.values())))
            receipt = next(t for t in tasks(manager, project['id']) if t['id'] == queued[0]['id'])
            assert receipt['status'] == 'cancelled' and receipt['externalTaskId'] is None
            assert provider.calls == [first[0]['id'], other[0]['id']]
        finally:
            release.set()
            await manager.close()
    asyncio.run(run())


def test_queue_wait_is_not_part_of_execution_timeout(context, monkeypatch):
    store, _, project, configs, _ = context
    timed = []
    real_timeout = asyncio.timeout
    def execution_timeout(seconds):
        timed.append(seconds)
        return real_timeout(seconds)
    monkeypatch.setattr('opendirector.application.generation_runtime.asyncio.timeout', execution_timeout)

    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        class Provider:
            def validate(self, *args): pass
            async def generate(self, config, task, submitted):
                await submitted('known-' + task['id'])
                started.set()
                await release.wait()
                return 'mp4', mp4()
        manager = CreationGeneration(store, configs, Provider())
        try:
            manager._launch(*prepare(manager, context))
            await asyncio.wait_for(started.wait(), 5)
            manager._launch(*prepare(manager, context))
            await asyncio.sleep(.05)
            assert timed == [14400]
            release.set()
            await asyncio.gather(*(job.future for job in list(manager.jobs.values())))
            assert timed == [14400, 14400]
            assert all(t['status'] == 'succeeded' for t in tasks(manager, project['id']))
        finally:
            release.set()
            await manager.close()
    asyncio.run(run())


def test_interrupted_task_resumes_same_id_with_no_new_submission(context):
    store, session, project, configs, _ = context
    class Provider:
        recovered = []
        def validate(self, *args): pass
        async def generate(self, config, task, submitted):
            assert task['externalTaskId'] == 'original-remote'
            self.recovered.append((task['id'], task['externalTaskId']))
            return 'mp4', mp4()
    async def run():
        provider = Provider()
        manager = CreationGeneration(store, configs, provider)
        task, pinned, _ = prepare(manager, context)
        task.update(status='interrupted', phase='poll', externalTaskId='original-remote', recovery='remote', resumeAllowed=True)
        manager.checkpoint(project['id'], task, pinned)
        try:
            await asyncio.gather(*(manager.recover(project['id'], task['id']) for _ in range(2)))
            await asyncio.gather(*(job.future for job in list(manager.jobs.values())))
            assert provider.recovered == [(task['id'], 'original-remote')]
            assert tasks(manager, project['id'])[0]['status'] == 'succeeded'
        finally:
            await manager.close()
    asyncio.run(run())


def test_cancel_interrupted_task_rejects_changed_service(context):
    store, session, project, configs, config = context
    class Provider:
        def validate(self, *args): pass
        async def cancel(self, *args): raise AssertionError('Must not cancel on a different service')
    async def run():
        manager = CreationGeneration(store, configs, Provider())
        task, pinned, _ = prepare(manager, context)
        task.update(status='interrupted', phase='poll', externalTaskId='original-remote', recovery='remote', resumeAllowed=True)
        manager.checkpoint(project['id'], task, pinned)
        configs.save('video', 'http://127.0.0.1:19999/v1', 'FastH3-Omni', '', config['id'], connection_type='self_hosted')
        try:
            await cancel(manager, project['id'], task['id'], session)
            receipt = tasks(manager, project['id'])[0]
            assert receipt['status'] == 'cancelled' and receipt['externalTaskId'] == 'original-remote'
            assert receipt['errorDetails']['stage'] == 'cancel'
            assert store.snapshot(project['id']).jobs[0].remoteCancellation == 'unknown'
        finally:
            await manager.close()
    asyncio.run(run())


@pytest.mark.parametrize('status, object_type, returned_id, terminal', [
    (200, 'video', 'original-remote', True),
    (400, 'video', 'original-remote', True),
    (400, 'video', 'another-job', False),
    (500, 'video', 'original-remote', True),
    (500, 'video', 'another-job', False),
    (500, 'error', 'original-remote', False),
    (503, 'video', 'original-remote', False),
])
def test_terminal_video_failure_requires_evidence_for_the_same_task(status, object_type, returned_id, terminal):
    calls = []
    def handle(request):
        calls.append(request.method)
        return httpx.Response(status, json={'id': returned_id, 'object': object_type,
            'status': 'failed', 'error': {'code': 500, 'message': 'private-diagnostic'}})
    provider = GenerationProviders(None, httpx.MockTransport(handle), retry_delays=())
    config = {'kind': 'video', 'protocol': 'vllm_omni', 'connectionType': 'self_hosted',
        'modelId': 'FastH3-Omni', 'url': 'http://model.test/v1', 'authMode': 'none'}
    task = {'kind': 'video', 'externalTaskId': 'original-remote'}
    async def run():
        with pytest.raises(GenerationError) as caught:
            await provider.generate(config, task, None)
        assert (caught.value.details.providerStatus == 'failed') is terminal
        assert 'private-diagnostic' not in str(caught.value)
    asyncio.run(run())
    assert calls == ['GET']


def test_confirmed_failed_video_does_not_recover_or_generate_again(context):
    store, session, project, configs, _ = context
    calls = []
    def handle(request):
        calls.append(request.method)
        return httpx.Response(500, json={'id': 'original-remote', 'object': 'video',
            'status': 'failed', 'error': {'code': 500, 'message': 'private-diagnostic'}})
    provider = GenerationProviders(store, httpx.MockTransport(handle), retry_delays=())
    async def run():
        manager = CreationGeneration(store, configs, provider)
        task, pinned, config = prepare(manager, context)
        task.update(phase='poll', externalTaskId='original-remote')
        manager.checkpoint(project['id'], task, pinned)
        try:
            manager._launch(task, pinned, config, 'remote')
            await asyncio.gather(*(job.future for job in list(manager.jobs.values())))
            receipt = tasks(manager, project['id'])[0]
            assert receipt['status'] == 'failed' and receipt['recovery'] == 'retry'
            assert not receipt['resumeAllowed'] and receipt['errorDetails']['providerStatus'] == 'failed'
            for _ in range(2):
                await manager.recover(project['id'], task['id'])
            assert calls == ['GET']
        finally:
            await manager.close()
    asyncio.run(run())


@pytest.mark.parametrize('model', ['FastH3-Omni', 'MiniMaxAI/MiniMax-H3'])
@pytest.mark.parametrize('state', ['failed', 'cancelled', 'expired'])
def test_both_video_adapters_recognize_terminal_status_without_new_submission(model, state):
    calls = []
    def handle(request):
        calls.append(request.method)
        return httpx.Response(200, json={'id': 'original-remote', 'object': 'video', 'status': state})
    provider = GenerationProviders(None, httpx.MockTransport(handle), retry_delays=())
    config = {'kind': 'video', 'protocol': 'vllm_omni', 'connectionType': 'self_hosted',
        'modelId': model, 'url': 'http://model.test/v1', 'authMode': 'none'}
    async def run():
        with pytest.raises(GenerationError) as caught:
            await provider.generate(config, {'kind': 'video', 'externalTaskId': 'original-remote'}, None)
        assert caught.value.details.providerStatus == state
    asyncio.run(run())
    assert calls == ['GET']
