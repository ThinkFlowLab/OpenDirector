"""Retired endpoints and startup cannot read, execute or repair historical data."""

import pytest
import json
from uuid import uuid4

from fastapi.testclient import TestClient

from legacy_fixtures import legacy_project
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app


pytestmark = pytest.mark.cpu


def files(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}


def test_retired_routes_are_absent_and_startup_preserves_old_data(tmp_path):
    local = LocalProjects(tmp_path)
    old = legacy_project(local)
    pid, sid = old['id'], str(uuid4())
    task_id = str(uuid4())
    directory = local.root / old['name']
    (directory / 'tasks').mkdir()
    (directory / 'tasks' / (task_id + '.json')).write_text(json.dumps(dict(
        id=task_id, projectId=pid, status='queued', phase='queued', kind='image', prompt='must not execute')))
    (directory / 'agent-runs').mkdir()
    (directory / 'agent-runs' / 'run.json').write_text('{"status":"running","private":"keep"}')
    scratch = local.state_dir / 'scratch'
    scratch.mkdir()
    (scratch / 'conversation.json').write_text('{"draft":"never delete"}')
    config = ModelConfigs(tmp_path).save('image', 'http://fixture.invalid/v1', 'fixture', 'test-secret', protocol='openai')
    credentials = (local.state_dir / 'models.json').read_bytes()
    operation = json.dumps(dict(id=pid, old='Legacy', new='Do not replay', before={'name': 'Legacy'}))
    with local.transaction() as db:
        db.execute('CREATE TABLE renames (id TEXT PRIMARY KEY, operation TEXT NOT NULL)')
        db.execute('INSERT INTO renames VALUES (?,?)', (pid, operation))
        db.execute('CREATE TABLE projects (id TEXT PRIMARY KEY)')
        db.execute('INSERT INTO projects VALUES (?)', (pid,))
    before = files(directory)
    class Provider:
        def validate(self, *args): raise AssertionError('Old tasks are not active')
        async def generate(self, *args): raise AssertionError('Old tasks must not resume')
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': sid}
    for _ in range(2):
        restarted = LocalProjects(tmp_path)
        app = create_app(restarted, generation_provider=Provider())
        with TestClient(app, headers=headers) as client:
            routes = client.get('/openapi.json').json()['paths']
            assert not any(path.startswith(('/api/projects', '/api/data', '/api/sessions')) for path in routes)
            for path in [f'/api/projects/{pid}', '/api/projects', f'/api/projects/{pid}/canvas',
                         f'/api/projects/{pid}/workspace', f'/api/projects/{pid}/tasks/{task_id}/recover',
                         f'/api/projects/{pid}/tool-tasks', f'/api/projects/{pid}/image-selections',
                         f'/api/data/{pid}/conversation', f'/api/data/{pid}/chat', f'/api/sessions/{sid}']:
                for method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'):
                    assert client.request(method, path, json={}).status_code == 404, (method, path)
            assert client.get('/api/creation/projects').json()['projects'] == []
            response = client.post(f'/api/creation/projects/{pid}/open')
            assert response.status_code == 409 and response.json()['code'] == 'unsupported_format'
            assert client.get(f'/api/library/canvases/{pid}/sources').status_code == 409
            assert client.get('/api/model-configs').json()[0]['id'] == config['id']
        assert files(directory) == before
        assert (scratch / 'conversation.json').read_text() == '{"draft":"never delete"}'
        assert (local.state_dir / 'models.json').read_bytes() == credentials
        assert not (local.root / 'Do not replay').exists()
        with restarted.transaction() as db:
            assert db.execute('SELECT operation FROM renames WHERE id=?', (pid,)).fetchone()[0] == operation
            assert db.execute('SELECT id FROM projects').fetchone()[0] == pid
