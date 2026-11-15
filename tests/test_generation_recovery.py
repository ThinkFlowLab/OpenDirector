import asyncio
import base64
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
from uuid import UUID, uuid4, uuid5

import httpx
from PIL import Image
import pytest
from fastapi.testclient import TestClient

from opendirector.application.creation_generation import CreationGeneration
from generation_helpers import new_project, prepared as prepare_command, settled, tasks
from opendirector.infrastructure.generation_results import GenerationResults
from opendirector.infrastructure.local_projects import LocalProjects, write_json
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.volcengine import VolcengineGeneration
from opendirector.integrations.providers import GenerationProviders
from opendirector_api.main import create_app


def png():
    stream = io.BytesIO()
    Image.new('RGB', (16, 12)).save(stream, 'PNG')
    return stream.getvalue()


@pytest.fixture
def context(tmp_path):
    store, pid, session = new_project(tmp_path, '恢复核对')
    return store, session, {'id': str(pid)}, ModelConfigs(tmp_path)


@pytest.fixture
def video(tmp_path):
    if not shutil.which('ffmpeg'):
        pytest.skip('media fixture requires ffmpeg')
    path = tmp_path / 'fixture.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.2',
                    '-pix_fmt', 'yuv420p', str(path)], check=True)
    return path.read_bytes()


def prepared(generation, project, session, config, kind='image'):
    return prepare_command(generation, (generation.projects, project['id'], session), config, kind=kind, prompt='制作测试素材')


@pytest.mark.parametrize('kind', ['image', 'video', 'audio', 'text'])
def test_unknown_submission_is_never_reposted_on_restart_or_manual_recovery(context, kind):
    store, session, project, configs = context
    config = configs.save('agent' if kind == 'text' else kind, 'https://ark.test', 'seed-tts-2.0' if kind == 'audio' else kind, 'private')
    requests = []
    def handle(request):
        requests.append(request)
        raise httpx.ReadTimeout('connection lost after submission', request=request)
    provider = VolcengineGeneration(store, httpx.MockTransport(handle), retry_delays=(0, 0))
    async def run():
        first = CreationGeneration(store, configs, provider)
        task, pinned, private = prepared(first, project, session, config, kind)
        first._launch(task, pinned, private)
        await settled(first)
        task_id = task['id']
        assert tasks(first, project['id'])[0]['recovery'] == 'review'
        await first.close()
        restarted = CreationGeneration(store, configs, provider)
        await restarted.start()
        for _ in range(2):
            await restarted.recover(project['id'], task_id)
            receipt = tasks(restarted, project['id'])[0]
            assert receipt['id'] == task_id and receipt['recovery'] == 'review'
            assert receipt['status'] == 'interrupted' and not receipt['resumeAllowed']
        assert len(requests) == 1 and requests[0].method == 'POST'
        assert store.snapshot(project['id']).assets == ()
        await restarted.close()
    asyncio.run(run())


def test_known_video_requeries_same_id_after_exhausted_poll_retries(context, video):
    store, session, project, configs = context
    config = configs.save('video', 'https://ark.test', 'video', 'private')
    calls, healthy = [], False
    def handle(request):
        calls.append(request)
        if request.method == 'POST': return httpx.Response(200, json={'id': 'known-task'})
        if request.url.host == 'cdn.test': return httpx.Response(200, content=video)
        if not healthy: return httpx.Response(503, json={'error': {'code': 'InternalError'}})
        assert request.url.path.endswith('/known-task')
        return httpx.Response(200, json={'status': 'succeeded', 'content': {'video_url': 'https://cdn.test/result'}})
    provider = VolcengineGeneration(store, httpx.MockTransport(handle), poll_interval=0, retry_delays=(0, 0))
    async def run():
        nonlocal healthy
        generation = CreationGeneration(store, configs, provider)
        task, pinned, private = prepared(generation, project, session, config, 'video')
        generation._launch(task, pinned, private)
        await settled(generation)
        receipt = tasks(generation, project['id'])[0]
        assert receipt['externalTaskId'] == 'known-task' and receipt['recovery'] == 'remote'
        assert sum(call.method == 'POST' for call in calls) == 1
        assert sum(call.method == 'GET' for call in calls) == 3
        await generation.close()
        healthy = True
        restarted = CreationGeneration(store, configs, provider)
        await restarted.start()
        await asyncio.gather(*(restarted.recover(project['id'], task['id']) for _ in range(2)))
        await settled(restarted)
        snapshot = store.snapshot(project['id'])
        assert snapshot.jobs[0].status == 'succeeded' and snapshot.jobs[0].adopted
        assert len(snapshot.assets) == 1
        assert snapshot.assets[0].provenance.jobId == UUID(task['id'])
        assert sum(call.method == 'POST' for call in calls) == 1
        assert len(calls) == 6  # POST, 3 failed GETs, one query, one download.
        await restarted.close()
    asyncio.run(run())


@pytest.mark.parametrize('configuration_change', ['changed', 'deleted'])
def test_image_download_recovers_from_private_locator_without_resubmitting(context, configuration_change):
    store, session, project, configs = context
    config = configs.save('image', 'https://ark.test', 'image', 'private')
    calls, healthy = [], False
    locator = 'https://cdn.test/result?signature=private-download-token'
    def handle(request):
        calls.append(request)
        if request.method == 'POST': return httpx.Response(200, json={'data': [{'url': locator}]})
        assert 'authorization' not in request.headers
        if not healthy: raise httpx.ReadTimeout('download failed', request=request)
        return httpx.Response(200, content=png())
    provider = VolcengineGeneration(store, httpx.MockTransport(handle), retry_delays=(0, 0))
    async def run():
        nonlocal healthy
        generation = CreationGeneration(store, configs, provider)
        task, pinned, private = prepared(generation, project, session, config)
        generation._launch(task, pinned, private)
        await settled(generation)
        snapshot = store.snapshot(project['id'])
        assert snapshot.jobs[0].recovery == 'download'
        assert 'private-download-token' not in snapshot.model_dump_json()
        cache = GenerationResults(pinned, task['id'])
        if os.name == 'posix': assert (cache.directory / 'result.json').stat().st_mode & 0o777 == 0o600
        await generation.close()
        # Local download recovery does not depend on the selected model remaining configured.
        if configuration_change == 'changed':
            configs.save('image', 'https://changed.test', 'different-image', 'changed', config['id'])
        else:
            configs.delete(config['id'])
        healthy = True
        restarted = CreationGeneration(store, configs, provider)
        await restarted.start()
        await settled(restarted)
        snapshot = store.snapshot(project['id'])
        assert len(snapshot.assets) == 1 and snapshot.jobs[0].status == 'succeeded'
        assert sum(call.method == 'POST' for call in calls) == 1 and len(calls) == 5
        assert not cache.directory.exists()
        await restarted.close()
    asyncio.run(run())


@pytest.mark.parametrize('configuration_change', ['changed', 'deleted'])
@pytest.mark.parametrize('redirect', [False, True])
def test_self_hosted_download_recovery_keeps_origin_without_credentials_or_redirects(context, configuration_change, redirect):
    store, session, project, configs = context
    config = configs.save('image', 'http://127.0.0.1:9000/v1', 'custom-image', 'original-key',
                          connection_type='self_hosted', protocol='openai')
    calls, healthy = [], False
    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            return httpx.Response(200, json={'data': [{'url': 'http://127.0.0.1:9000/content'}]})
        if not healthy: raise httpx.ReadTimeout('download outage', request=request)
        if redirect and request.url.path.endswith('/content'):
            return httpx.Response(302, headers={'Location': '/result.png'})
        return httpx.Response(200, content=png())
    provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0, retry_delays=(0, 0))
    async def run():
        nonlocal healthy
        first = CreationGeneration(store, configs, provider)
        try:
            first._launch(*prepared(first, project, session, config))
            await settled(first)
            assert store.snapshot(project['id']).jobs[0].recovery == 'download'
        finally:
            await first.close()
        if configuration_change == 'deleted':
            configs.delete(config['id'])
        else:
            configs.save('image', 'http://127.0.0.1:9001/v1', 'replacement', 'replacement-key', config['id'],
                         connection_type='self_hosted', protocol='openai')
        healthy = True
        before = len(calls)
        restarted = CreationGeneration(store, configs, provider)
        try:
            await restarted.start()
            await settled(restarted)
            snapshot = store.snapshot(project['id'])
            assert snapshot.jobs[0].status == ('failed' if redirect else 'succeeded')
            assert len(snapshot.assets) == (0 if redirect else 1)
            assert len(calls) == before + 1
            assert str(calls[-1].url) == 'http://127.0.0.1:9000/content'
            assert 'authorization' not in calls[-1].headers
            assert sum(call.method == 'POST' for call in calls) == 1
        finally:
            await restarted.close()
    asyncio.run(run())


@pytest.mark.parametrize('failure', ['before_publish', 'after_publish', 'receipt'])
def test_saved_results_recover_locally_without_duplicate_assets_or_adoption(context, monkeypatch, failure):
    store, session, project, configs = context
    config = configs.save('image', 'https://unused.test', 'image', 'private')
    class Provider:
        calls = 0
        def validate(self, kind, config): pass
        async def generate(self, config, task, submitted):
            self.calls += 1
            return 'png', png()
    provider = Provider()
    async def run():
        generation = CreationGeneration(store, configs, provider)
        task, pinned, private = prepared(generation, project, session, config)
        with monkeypatch.context() as patch:
            if failure in {'before_publish', 'after_publish'}:
                commit = generation._commit_output
                def broken(*args, **kwargs):
                    if failure == 'after_publish': commit(*args, **kwargs)
                    raise OSError('publication interrupted')
                patch.setattr(generation, '_commit_output', broken)
            else:
                save = generation.checkpoint
                def broken(owner, value, directory):
                    if value['status'] == 'succeeded': raise OSError('receipt interrupted')
                    return save(owner, value, directory)
                patch.setattr(generation, 'checkpoint', broken)
            generation._launch(task, pinned, private)
            await settled(generation)
        before = store.snapshot(project['id'])
        await generation.close()
        restarted = CreationGeneration(store, configs, provider)
        await restarted.start()
        await settled(restarted)
        snapshot = store.snapshot(project['id'])
        assert snapshot.jobs[0].status == 'succeeded' and snapshot.jobs[0].adopted
        assert len(snapshot.assets) == len(snapshot.results) == 1 and provider.calls == 1
        if failure != 'before_publish': assert snapshot == before
        await restarted.recover(project['id'], task['id'])
        assert store.snapshot(project['id']) == snapshot
        await restarted.close()
    asyncio.run(run())


def test_proven_unsubmitted_queue_runs_once_on_restart(context):
    store, session, project, configs = context
    config = configs.save('image', 'https://ark.test', 'image', 'private')
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})
    provider = VolcengineGeneration(store, httpx.MockTransport(handle))
    async def run():
        generation = CreationGeneration(store, configs, provider)
        prepared(generation, project, session, config)
        await generation.start()
        await settled(generation)
        assert tasks(generation, project['id'])[0]['status'] == 'succeeded'
        await generation.start()
        assert len(calls) == 1
        await generation.close()
    asyncio.run(run())


def test_temporary_query_and_download_failures_retry_reads_only(context, video):
    store, session, project, configs = context
    config = configs.save('video', 'https://ark.test', 'video', 'private')
    counts = {'submit': 0, 'poll': 0, 'download': 0}
    def handle(request):
        stage = 'submit' if request.method == 'POST' else 'download' if request.url.host == 'cdn.test' else 'poll'
        counts[stage] += 1
        if stage == 'submit': return httpx.Response(200, json={'id': 'same-task'})
        if counts[stage] == 1: return httpx.Response(503)
        if stage == 'poll': return httpx.Response(200, json={'status': 'succeeded', 'content': {'video_url': 'https://cdn.test/result'}})
        return httpx.Response(200, content=video)
    provider = VolcengineGeneration(store, httpx.MockTransport(handle), retry_delays=(0, 0))
    async def run():
        generation = CreationGeneration(store, configs, provider)
        task, pinned, private = prepared(generation, project, session, config, 'video')
        generation._launch(task, pinned, private)
        await settled(generation)
        assert tasks(generation, project['id'])[0]['status'] == 'succeeded'
        assert counts == {'submit': 1, 'poll': 2, 'download': 2}
        await generation.close()
    asyncio.run(run())


def test_recovery_api_checks_session_and_keeps_unknown_request_read_only(context):
    from opendirector.domain.creation.commands import parse_command
    from test_creation_canvas_service import ver
    store, session, project, configs = context
    config = configs.save('image', 'https://unused.test', 'image', 'private')
    class Provider:
        def validate(self, kind, config): pass
        async def generate(self, config, task, submitted):
            raise AssertionError('Unknown submission must not be repeated')
    provider = Provider()
    generation = CreationGeneration(store, configs, provider)
    task, pinned, _ = prepared(generation, project, session, config)
    task.update(status='interrupted', phase='submit', recovery='review', resumeAllowed=False)
    generation.checkpoint(project['id'], task, pinned)
    job = store.snapshot(project['id']).jobs[0]
    request = parse_command(dict(commandId=uuid4(), projectId=project['id'], type='job.recover',
        expectedVersions=[ver('job', job)], payload=dict(jobId=job.id))).model_dump(mode='json')
    url = f'/api/creation/projects/{project["id"]}/commands'
    with TestClient(create_app(store.local, generation_provider=provider), headers={
            'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}) as client:
        assert client.post(url, json=request, headers={'X-OpenDirector-Session': str(uuid4())}).status_code == 409
        for _ in range(2):
            response = client.post(url, json=request)
            assert response.status_code == 200, response.text
        snapshot = store.snapshot(project['id'])
        assert snapshot.assets == () and len(snapshot.jobs) == 1
        assert snapshot.jobs[0].recovery == 'review' and not snapshot.jobs[0].resumeAllowed
