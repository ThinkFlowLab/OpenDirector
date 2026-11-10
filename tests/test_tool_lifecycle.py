"""Task reads, cancellation evidence and recovery through real project storage."""
import asyncio
from dataclasses import replace
import threading
from uuid import UUID, uuid4, uuid5

import httpx
import pytest

from opendirector.application.tool_operations import TOOLS, Output
from opendirector.application.tool_tasks import ToolTasks
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.integrations.model_adapters import ModelAdapter, VllmOmniVideo
from opendirector.domain.projects import ProjectError
from opendirector.media.async_work import blocking
from test_tool_task_history import tool_project
from test_creation_tool_drafts import prepared
from test_tool_tasks import project, configure, upload, png, H3


async def until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(.01)


def test_reads_never_create_a_ledger_or_change_a_project(tool_project):
    store, projects, _, pid, _, _, _, factory = tool_project
    service = factory()
    folder = store.root / 'Tool history' / 'tool-tasks'
    before = projects.snapshot(pid)
    assert not folder.exists()
    assert service.list(pid) == []
    assert not folder.exists()
    assert projects.snapshot(pid) == before


@pytest.mark.parametrize('status', ['queued', 'running', 'cancelled', 'interrupted', 'failed'])
def test_repeated_reads_preserve_task_bytes_and_placeholder(prepared, status):
    store, pid, session, service, value, *_ = prepared
    task, directory, _ = service._prepare(str(pid), value, session)
    task['status'] = status
    service._write(directory, task)
    path = directory / 'tool-tasks' / (task['id'] + '.json')
    before, contents, stat = store.snapshot(pid), path.read_bytes(), path.stat()
    for _ in range(3):
        assert service.get(str(pid), task['id'])['status'] == status
        assert service.list(str(pid))[0]['placement'] == 'pending'
    assert path.read_bytes() == contents and path.stat().st_mtime_ns == stat.st_mtime_ns
    assert store.snapshot(pid) == before


def test_startup_recovers_without_hiding_the_interrupted_target(prepared):
    store, pid, session, service, value, *_ = prepared
    task, _, _ = service._prepare(str(pid), value, session)
    async def run():
        await service.start()
        try:
            assert service.get(str(pid), task['id'])['status'] == 'interrupted'
            assert service.get(str(pid), task['id'])['placement'] == 'unplaced'
            assert store.snapshot(pid).canvasItems[1].visible
            before = store.snapshot(pid)
            await service.recover()
            assert store.snapshot(pid) == before
        finally:
            await service.close()
    asyncio.run(run())


def test_another_live_worker_is_not_marked_interrupted(tool_project):
    _, _, _, pid, session, _, value, factory = tool_project
    async def run():
        owner, peer = factory(concurrency=1), factory()
        await owner.limit.acquire()
        try:
            await owner.submit(pid, value, session)
            await peer.recover()
            assert peer.get(pid, value['id'])['status'] == 'queued'
            assert not peer.get(pid, value['id']).get('cancelRequested')
        finally:
            owner.limit.release()
            await owner.close()
            await peer.close()
    asyncio.run(run())


def test_queued_cancellation_is_durable_idempotent_and_never_submits(tool_project):
    _, _, _, pid, session, _, value, factory = tool_project
    async def run():
        service = factory()
        service.limit = asyncio.Semaphore(1)
        await service.limit.acquire()
        try:
            await service.submit(pid, value, session)
            first, second = await asyncio.gather(service.cancel(pid, value['id'], session), service.cancel(pid, value['id'], session))
            assert first['cancelOperationId'] == second['cancelOperationId']
            final = service.get(pid, value['id'])
            assert final['status'] == 'cancelled' and final['localState'] == 'stopped'
            assert final['modelCalls'] == [] and final['remoteCancellation'] == 'not_applicable'
            assert await service.cancel(pid, value['id'], session) == final
            replay = await service.submit(pid, value, session)
            assert replay['cancelOperationId'] == final['cancelOperationId'] and not service.jobs
        finally:
            service.limit.release()
            await service.close()
    asyncio.run(run())


def test_cancel_waits_for_blocking_work_to_stop(tool_project, monkeypatch):
    _, _, _, pid, session, _, value, factory = tool_project
    entered, release, exited = threading.Event(), threading.Event(), threading.Event()
    def local_work():
        entered.set()
        assert release.wait(5)
        exited.set()
    async def recipe(ctx):
        await blocking(local_work)
        pytest.fail('Cancellation must stop subsequent steps')
    monkeypatch.setitem(TOOLS, value['tool'], replace(TOOLS[value['tool']], recipe=recipe))
    async def run():
        service = factory()
        try:
            await service.submit(pid, value, session)
            await until(entered.is_set)
            accepted = await service.cancel(pid, value['id'], session, wait=False)
            assert accepted['cancelRequested'] and accepted['localState'] == 'stopping'
            await asyncio.sleep(.03)
            assert service.get(pid, value['id'])['localState'] == 'stopping' and not exited.is_set()
            release.set()
            await until(lambda: service.get(pid, value['id']).get('localState') == 'stopped')
            assert exited.is_set() and service.get(pid, value['id'])['status'] == 'cancelled'
        finally:
            release.set()
            await service.close()
    asyncio.run(run())


def test_cancel_during_asset_registration_preserves_output_without_adoption(tool_project, monkeypatch):
    _, projects, assets, pid, session, _, value, factory = tool_project
    entered, release = threading.Event(), threading.Event()
    async def recipe(ctx):
        return [Output('image', png(), 'png', 'Kept result')]
    monkeypatch.setitem(TOOLS, value['tool'], replace(TOOLS[value['tool']], recipe=recipe))
    original = assets.import_output
    def register(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)
    monkeypatch.setattr(assets, 'import_output', register)
    async def run():
        service = factory()
        before = projects.snapshot(pid).canvasItems
        try:
            await service.submit(pid, value, session)
            await until(entered.is_set)
            await service.cancel(pid, value['id'], session, wait=False)
            release.set()
            await until(lambda: service.get(pid, value['id']).get('localState') == 'stopped')
            task = service.get(pid, value['id'])
            assert task['status'] == 'cancelled' and len(task['outputs']) == 1
            assert projects.snapshot(pid).canvasItems == before
            assert assets.read_bytes(pid, task['outputs'][0]['id']) == png()
            with pytest.raises(ProjectError, match='尚未完成'):
                service.placement(pid, value['id'], 'placed', session)
            adopted = service.placement(pid, value['id'], 'placed', session, policy='explicit')
            assert adopted['status'] == 'cancelled' and adopted['placement'] == 'placed'
            assert len(projects.snapshot(pid).canvasItems) == len(before) + 1
        finally:
            release.set()
            await service.close()
    asyncio.run(run())


def test_completed_task_wins_a_later_cancel_request(tool_project):
    _, _, _, pid, session, _, value, factory = tool_project
    async def run():
        service = factory()
        try:
            await service.submit(pid, value, session)
            await asyncio.gather(*service.jobs.values())
            before = service.get(pid, value['id'])
            assert before['status'] == 'succeeded'
            assert await service.cancel(pid, value['id'], session) == before
        finally:
            await service.close()
    asyncio.run(run())


def video_service(project, handler):
    store, pid, session = project
    configs = configure(store, H3)
    source = upload(store, pid, session, 'source.png', png())
    value = dict(id=str(uuid4()), tool='dynamic-poster', sourceAssetIds=[source], parameters={})
    def factory():
        return ToolTasks(store.local, configs, CreationToolAssets(store), transport=httpx.MockTransport(handler), poll_interval=.01, projects=store)
    return pid, session, value, factory


@pytest.mark.parametrize('outcome,expected', [
    ('confirmed', 'confirmed'), ('accepted', 'requested'), ('timeout', 'unknown'),
    ('unsupported', 'unsupported'), ('failed', 'not_required'), ('completed', 'not_required'), ('wrong_id', 'requested'),
])
def test_remote_cancel_requires_actual_confirmation(project, monkeypatch, outcome, expected):
    requests = []
    def server(request):
        requests.append((request.method, request.url.path))
        if request.method == 'POST':
            return httpx.Response(200, json={'id': 'original'})
        if request.method == 'DELETE':
            if outcome == 'timeout':
                raise httpx.ReadTimeout('lost cancellation reply')
            if outcome == 'accepted':
                return httpx.Response(202)
            if outcome in {'failed', 'completed'}:
                return httpx.Response(200, json={'id': 'original', 'status': outcome})
            if outcome == 'wrong_id':
                return httpx.Response(200, json={'id': 'another-task', 'status': 'cancelled'})
            return httpx.Response(200, json={'id': 'original', 'status': 'cancelled'})
        return httpx.Response(200, json={'id': 'original', 'status': 'in_progress'})
    if outcome == 'unsupported':
        monkeypatch.setattr(VllmOmniVideo, 'cancel_video', ModelAdapter.cancel_video)
    pid, session, value, factory = video_service(project, server)
    async def run():
        service = factory()
        try:
            await service.submit(pid, value, session)
            await until(lambda: any(call.get('externalTaskId') for call in service.get(pid, value['id'])['modelCalls']))
            task = await service.cancel(pid, value['id'], session)
            assert task['status'] == 'cancelled' and task['remoteCancellation'] == expected
            assert task['modelCalls'][0]['externalTaskId'] == 'original'
            if outcome in {'failed', 'completed'}:
                assert task['modelCalls'][0]['state'] == ('failed' if outcome == 'failed' else 'succeeded')
            assert 'apiKey' not in task['modelCalls'][0]
            await service.recover()
            await service.cancel(pid, value['id'], session)
            assert sum(method == 'POST' for method, _ in requests) == 1
            assert sum(method == 'DELETE' for method, _ in requests) == (0 if outcome == 'unsupported' else 1)
        finally:
            await service.close()
    asyncio.run(run())


def test_shutdown_keeps_remote_identity_and_recovery_only_observes(project):
    requests = []
    remote_status = 'in_progress'
    def server(request):
        requests.append(request.method)
        return httpx.Response(200, json={'id': 'original', **({'status': remote_status} if request.method == 'GET' else {})})
    pid, session, value, factory = video_service(project, server)
    async def run():
        service = factory()
        await service.submit(pid, value, session)
        await until(lambda: any(call.get('externalTaskId') for call in service.get(pid, value['id'])['modelCalls']))
        await service.close()
        task = service.get(pid, value['id'])
        assert task['status'] == 'interrupted' and not task['cancelRequested']
        assert task['modelCalls'][0]['externalTaskId'] == 'original'
        nonlocal remote_status
        remote_status = 'completed'
        restarted = factory()
        await restarted.start()
        try:
            task = restarted.get(pid, value['id'])
            assert task['status'] == 'interrupted' and task['modelCalls'][0]['state'] == 'succeeded'
            assert requests.count('POST') == 1 and requests.count('DELETE') == 0
        finally:
            await restarted.close()
    asyncio.run(run())


def test_lost_cancel_reply_is_queried_after_restart_without_a_second_delete(project):
    requests = []
    remote_status = 'in_progress'
    def server(request):
        requests.append(request.method)
        if request.method == 'POST':
            return httpx.Response(200, json={'id': 'original'})
        if request.method == 'DELETE':
            raise httpx.ReadTimeout('reply lost')
        return httpx.Response(200, json={'id': 'original', 'status': remote_status})
    pid, session, value, factory = video_service(project, server)
    async def run():
        service = factory()
        await service.submit(pid, value, session)
        await until(lambda: any(call.get('externalTaskId') for call in service.get(pid, value['id'])['modelCalls']))
        assert (await service.cancel(pid, value['id'], session))['remoteCancellation'] == 'unknown'
        await service.close()
        nonlocal remote_status
        remote_status = 'cancelled'
        restarted = factory()
        await restarted.start()
        try:
            assert restarted.get(pid, value['id'])['remoteCancellation'] == 'confirmed'
            assert requests.count('POST') == requests.count('DELETE') == 1
        finally:
            await restarted.close()
    asyncio.run(run())


def test_recovery_finds_asset_committed_before_ledger_ack(tool_project):
    _, _, assets, pid, session, _, value, factory = tool_project
    service = factory()
    task, _, _ = service._prepare(pid, value, session)
    output = assets.import_output(task, uuid5(UUID(task['id']), 'output-0'), 'preserved.png', png())
    async def run():
        await service.recover()
        recovered = service.get(pid, value['id'])
        assert recovered['status'] == 'interrupted'
        assert [entry['id'] for entry in recovered['outputs']] == [output['id']]
        await service.recover()
        assert len(service.get(pid, value['id'])['outputs']) == 1
        await service.close()
    asyncio.run(run())


def test_disconnected_submission_still_starts_its_accepted_execution(tool_project, monkeypatch):
    _, _, _, pid, session, _, value, factory = tool_project
    service = factory()
    entered, release = threading.Event(), threading.Event()
    original = service._prepare
    def prepare(*args):
        result = original(*args)
        entered.set()
        assert release.wait(5)
        return result
    monkeypatch.setattr(service, '_prepare', prepare)
    async def run():
        submitted = asyncio.create_task(service.submit(pid, value, session))
        try:
            await until(entered.is_set)
            submitted.cancel()
            with pytest.raises(asyncio.CancelledError):
                await submitted
            await service.recover()
            assert service.get(pid, value['id'])['status'] == 'queued'
            release.set()
            await until(lambda: service.get(pid, value['id'])['status'] == 'succeeded')
            assert len(service.get(pid, value['id'])['outputs']) == 1
        finally:
            release.set()
            await service.close()
    asyncio.run(run())


def test_disconnected_cancel_keeps_the_durable_stop_request(tool_project, monkeypatch):
    _, _, _, pid, session, _, value, factory = tool_project
    service = factory()
    service.limit = asyncio.Semaphore(1)
    entered, release = threading.Event(), threading.Event()
    original = service._request_cancel
    def request(*args):
        result = original(*args)
        entered.set()
        assert release.wait(5)
        return result
    monkeypatch.setattr(service, '_request_cancel', request)
    async def run():
        await service.limit.acquire()
        try:
            await service.submit(pid, value, session)
            cancelled = asyncio.create_task(service.cancel(pid, value['id'], session))
            await until(entered.is_set)
            cancelled.cancel()
            with pytest.raises(asyncio.CancelledError):
                await cancelled
            release.set()
            await until(lambda: service.get(pid, value['id']).get('localState') == 'stopped')
            assert service.get(pid, value['id'])['status'] == 'cancelled'
        finally:
            release.set()
            service.limit.release()
            await service.close()
    asyncio.run(run())


def test_unknown_submission_is_preserved_across_recovery_and_replay(project):
    requests = []
    def server(request):
        requests.append(request.method)
        raise httpx.ReadTimeout('submission reply lost')
    pid, session, value, factory = video_service(project, server)
    async def run():
        service = factory()
        try:
            await service.submit(pid, value, session)
            await asyncio.gather(*service.jobs.values())
            task = service.get(pid, value['id'])
            assert task['modelCalls'][0]['state'] == 'unknown'
            assert task['modelCalls'][0]['externalTaskId'] is None
            cancelled = await service.cancel(pid, value['id'], session)
            assert cancelled['remoteCancellation'] == 'unknown'
            await service.recover()
            replay = await service.submit(pid, value, session)
            assert replay['id'] == task['id'] and replay['remoteCancellation'] == 'unknown'
            assert requests == ['POST']
        finally:
            await service.close()
    asyncio.run(run())


def test_multistep_recipe_keeps_each_remote_call_and_only_cancels_the_outstanding_one(project, monkeypatch):
    from opendirector.domain.capabilities import VideoRequest
    requests = []
    submitted = 0
    def server(request):
        nonlocal submitted
        requests.append((request.method, request.url.path))
        if request.method == 'POST':
            submitted += 1
            return httpx.Response(200, json={'id': f'remote-{submitted}'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=b'first clip bytes')
        remote_id = request.url.path.rsplit('/', 1)[-1]
        status = 'cancelled' if request.method == 'DELETE' else 'completed' if remote_id == 'remote-1' else 'in_progress'
        return httpx.Response(200, json={'id': remote_id, 'status': status})
    async def recipe(ctx):
        for _ in range(2):
            await ctx._video(VideoRequest(prompt='clip', seconds=4, first_frame=png()), None)
        pytest.fail('second step should be cancelled')
    monkeypatch.setitem(TOOLS, 'dynamic-poster', replace(TOOLS['dynamic-poster'], recipe=recipe))
    pid, session, value, factory = video_service(project, server)
    async def run():
        service = factory()
        try:
            await service.submit(pid, value, session)
            await until(lambda: len(service.get(pid, value['id'])['modelCalls']) == 2 and
                        service.get(pid, value['id'])['modelCalls'][1].get('externalTaskId') is not None)
            task = await service.cancel(pid, value['id'], session)
            assert [call['externalTaskId'] for call in task['modelCalls']] == ['remote-1', 'remote-2']
            assert [call['state'] for call in task['modelCalls']] == ['succeeded', 'cancelled']
            assert [path for method, path in requests if method == 'DELETE'] == ['/v1/videos/remote-2']
        finally:
            await service.close()
    asyncio.run(run())


def test_cancel_api_returns_accepted_intent_while_local_work_is_still_stopping(tool_project, monkeypatch):
    from fastapi.testclient import TestClient
    from opendirector_api.main import create_app
    store, _, _, pid, session, _, value, _ = tool_project
    entered, release = threading.Event(), threading.Event()
    def work():
        entered.set()
        assert release.wait(5)
    async def recipe(ctx):
        await blocking(work)
        pytest.fail('must not continue after cancel')
    monkeypatch.setitem(TOOLS, value['tool'], replace(TOOLS[value['tool']], recipe=recipe))
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}
    with TestClient(create_app(store), headers=headers) as client:
        path = f'/api/creation/projects/{pid}/tool-tasks'
        try:
            assert client.post(path, json=value).status_code == 202
            assert entered.wait(5)
            rejected = client.post(path + '/' + value['id'] + '/cancel', headers={**headers, 'X-OpenDirector-Session': str(uuid4())})
            assert rejected.status_code == 409
            assert not client.get(path + '/' + value['id']).json()['cancelRequested']
            first = client.post(path + '/' + value['id'] + '/cancel').json()
            assert first['localState'] == 'stopping' and first['cancelRequested']
            repeated = client.post(path + '/' + value['id'] + '/cancel').json()
            assert repeated['cancelOperationId'] == first['cancelOperationId']
            assert client.get(path + '/' + value['id']).json()['localState'] == 'stopping'
        finally:
            release.set()
