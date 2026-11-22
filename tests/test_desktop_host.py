import asyncio
import json
import os
import subprocess
import sys

from fastapi.testclient import TestClient
import pytest

from opendirector_api.desktop import DesktopAuthentication, Initialize
from opendirector_api.main import create_app
from opendirector.infrastructure.local_projects import LocalProjects


def test_desktop_auth_protects_api_and_static_without_changing_browser_mode(tmp_path):
    app = create_app(LocalProjects(tmp_path))
    app.add_middleware(DesktopAuthentication, token='a' * 64)
    with TestClient(app) as client:
        for path in ['/', '/api/health', '/api/creation/projects']:
            assert client.get(path, headers={'X-OpenDirector-Request': '1'}).status_code == 403
        assert client.get('/api/health', headers=[(b'x-opendirector-desktop', b'\xff')]).status_code == 403
        for language, expected in [('en-US', 'Reopen'), ('zh-CN', '重新打开')]:
            assert expected in client.get('/api/health', headers={'Accept-Language': language}).json()['detail']
        headers = {'X-OpenDirector-Desktop': 'a' * 64, 'X-OpenDirector-Request': '1'}
        assert client.get('/api/health', headers=headers).json() == {'status': 'ok'}
        assert client.get('/api/creation/projects', headers=headers).status_code == 200
    with TestClient(create_app(LocalProjects(tmp_path))) as client:
        assert client.get('/api/health', headers={'X-OpenDirector-Request': '1'}).status_code == 200


def test_desktop_initialize_rejects_wrong_version_and_short_credentials():
    for value in [dict(type='initialize', version=2, token='a' * 64), dict(type='initialize', version=1, token='short')]:
        with pytest.raises(ValueError):
            Initialize.model_validate(value)


def test_desktop_rejects_bad_parent_handshake_without_starting(tmp_path):
    process = subprocess.run([sys.executable, '-m', 'opendirector_api.desktop'],
        input='{"type":"initialize","version":1,"token":"short"}\n',
        capture_output=True, text=True, timeout=20, env={**os.environ, 'OPENDIRECTOR_ROOT': str(tmp_path)})
    assert process.returncode == 1
    assert json.loads(process.stdout)['type'] == 'fatal'
    assert not list(tmp_path.iterdir())


def test_desktop_auth_rejects_websocket_without_accepting_it():
    events = []

    async def application(scope, receive, send):
        pytest.fail('Unauthenticated WebSocket reached the application')

    async def receive():
        return {'type': 'websocket.connect'}

    async def send(event):
        events.append(event)

    asyncio.run(DesktopAuthentication(application, token='a' * 64)(
        {'type': 'websocket', 'headers': []}, receive, send))
    assert events == [{'type': 'websocket.close', 'code': 1008}]
