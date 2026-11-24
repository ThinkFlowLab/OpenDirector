import asyncio
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.application.creation_generation import CreationGeneration
from opendirector.infrastructure.model_configs import ModelConfigs
from generation_helpers import new_project, command, prepared, tasks
from test_tool_tasks import png
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.app_settings import AppSettings
from opendirector.infrastructure.local_projects import LocalProjects, read_json
from opendirector_api.main import create_app


pytestmark = pytest.mark.cpu


def test_default_and_saved_settings_survive_application_restart(tmp_path):
    headers = {'X-OpenDirector-Request': '1'}
    store = LocalProjects(tmp_path)
    with TestClient(create_app(store), headers=headers) as client:
        assert client.get('/api/settings').json() == {'removeWatermark': True}
        assert not (store.state_dir / 'settings.json').exists()
        for value in (False, True, False):
            response = client.patch('/api/settings', json={'removeWatermark': value})
            assert response.status_code == 200
            assert response.json() == {'removeWatermark': value}
    with TestClient(create_app(LocalProjects(tmp_path)), headers=headers) as client:
        assert client.get('/api/settings').json() == {'removeWatermark': False}
    assert read_json(store.state_dir / 'settings.json') == {'version': 1, 'removeWatermark': False}
    assert not store.root.exists()


@pytest.mark.parametrize('invalid', [None, {}, {'removeWatermark': None}, {'removeWatermark': 1},
                                    {'removeWatermark': 'false'}, {'removeWatermark': True, 'unknown': 1}])
def test_invalid_requests_do_not_change_saved_settings(tmp_path, invalid):
    settings = AppSettings(tmp_path)
    settings.update({'removeWatermark': False})
    before = settings.path.read_bytes()
    with TestClient(create_app(LocalProjects(tmp_path)), headers={'X-OpenDirector-Request': '1'}) as client:
        assert client.patch('/api/settings', json=invalid).status_code == 422
        assert settings.path.read_bytes() == before
        assert client.get('/api/settings').json() == {'removeWatermark': False}


def test_settings_routes_keep_local_request_protection(tmp_path):
    with TestClient(create_app(LocalProjects(tmp_path)), headers={'X-OpenDirector-Request': '1'}) as client:
        assert client.get('/api/settings', headers={'Origin': 'https://untrusted.example'}).status_code == 403
        assert client.get('/api/settings', headers={'Host': 'untrusted.example'}).status_code == 403
        assert client.patch('/api/settings', json={'removeWatermark': False}, headers={'X-OpenDirector-Request': ''}).status_code == 403
        assert client.get('/api/settings').json() == {'removeWatermark': True}


@pytest.mark.parametrize('contents', ['{broken', '[]', '{"version":2,"removeWatermark":true}',
                                      '{"version":1}', '{"version":1,"removeWatermark":"true"}',
                                      '{"version":1,"removeWatermark":false,"unknown":1}'])
def test_corrupt_settings_are_reported_and_preserved(tmp_path, contents):
    settings = AppSettings(tmp_path)
    settings.path.write_text(contents)
    for operation in (settings.get, lambda: settings.update({'removeWatermark': True})):
        with pytest.raises(ProjectError, match='原文件未覆盖'):
            operation()
        assert settings.path.read_text() == contents


def test_failed_atomic_replace_preserves_settings_and_removes_temporary_file(tmp_path, monkeypatch):
    from opendirector.infrastructure import local_projects

    settings = AppSettings(tmp_path)
    settings.update({'removeWatermark': False})
    before = settings.path.read_bytes()
    def fail(*args):
        raise OSError('simulated disk failure')
    with TestClient(create_app(LocalProjects(tmp_path)), headers={'X-OpenDirector-Request': '1'}) as client:
        monkeypatch.setattr(local_projects.os, 'replace', fail)
        assert client.patch('/api/settings', json={'removeWatermark': True}).status_code == 503
        assert settings.path.read_bytes() == before
        assert client.get('/api/settings').json() == {'removeWatermark': False}
        assert not list(settings.path.parent.glob('.opendirector-*.tmp'))


@pytest.mark.parametrize('kind', ['image', 'video', 'audio', 'text'])
@pytest.mark.parametrize('remove', [False, True])
def test_task_snapshots_settings_and_duplicate_submission_keeps_original(tmp_path, kind, remove):
    project = new_project(tmp_path)
    store, pid, session = project
    configs = ModelConfigs(tmp_path)
    generation = CreationGeneration(store, configs)
    config = configs.save('agent' if kind == 'text' else kind, 'https://ark.test', 'seed-tts-2.0' if kind == 'audio' else kind, 'private')
    generation.settings.update({'removeWatermark': remove})
    request = command(project, config)
    receipt = generation.prepare(request, session=session)
    assert receipt.status == 'accepted', receipt
    task = tasks(generation, pid)[0]
    if kind in {'image', 'video'}: assert task['parameters']['watermark'] is not remove
    else: assert 'watermark' not in task['parameters']
    before = store.snapshot(pid)
    generation.settings.update({'removeWatermark': not remove})
    assert generation.prepare(request, session=session) == receipt
    assert store.snapshot(pid) == before
    new_task, _, _ = prepared(generation, project, config)
    if kind in {'image', 'video'}: assert new_task['parameters']['watermark'] is remove


def test_queued_task_recovery_uses_saved_parameters_after_restart(tmp_path):
    project = new_project(tmp_path)
    store, pid, session = project
    configs = ModelConfigs(tmp_path)
    config = configs.save('image', 'https://ark.test', 'image', 'private')
    generation = CreationGeneration(store, configs)
    task, _, _ = prepared(generation, project, config)
    assert task['parameters']['watermark'] is False
    generation.settings.update({'removeWatermark': False})
    calls = []
    class Provider:
        def validate(self, *args): pass
        async def generate(self, config, task, submitted):
            calls.append(deepcopy(task))
            return 'png', png()
    async def run():
        restarted = CreationGeneration(store, configs, Provider())
        await restarted.recover(pid, task['id'])
        await asyncio.gather(*(job.future for job in list(restarted.jobs.values())))
        assert len(calls) == 1 and calls[0]['parameters']['watermark'] is False
        snapshot = store.snapshot(pid)
        assert snapshot.jobs[0].status == 'succeeded'
        saved = restarted.store.asset(pid, snapshot.assets[0].id)[0]
        restarted.settings.update({'removeWatermark': True})
        assert restarted.store.asset(pid, snapshot.assets[0].id)[0] == saved
        await restarted.close()
    asyncio.run(run())
