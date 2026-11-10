import asyncio
import sys

import pytest

from capabilities import requires_posix

from opendirector.agent import runtime
from process_helpers import python_cli


@pytest.mark.parametrize(('engine', 'output', 'exit_code', 'expected'), [
    ('codex', '', 0, 'ready'),
    ('codex', '', 1, 'needs_login'),
    ('claude', '{"loggedIn":true}', 0, 'ready'),
    ('claude', '{"loggedIn":false}', 1, 'needs_login'),
    ('claude', 'invalid output', 0, 'unknown'),
])
@requires_posix()
def test_login_readiness(tmp_path, monkeypatch, engine, output, exit_code, expected):
    cli = tmp_path / 'cli'
    cli = python_cli(cli, f'print({output!r})\nraise SystemExit({exit_code})\n')
    cli.chmod(0o755)
    monkeypatch.setattr(runtime.native, 'executable', lambda _: cli)
    assert asyncio.run(runtime.runtime_readiness(engine)) == expected


def test_missing_install(monkeypatch):
    monkeypatch.setattr(runtime.native, 'executable', lambda _: None)
    assert asyncio.run(runtime.runtime_readiness('codex')) == 'not_installed'


def test_catalog_probes_cli_and_bundled_separately(monkeypatch):
    calls = []

    async def probe(engine):
        calls.append(engine)
        return 'needs_login' if engine == 'claude' else 'ready'

    monkeypatch.setattr(runtime, 'runtime_readiness', probe)
    result = asyncio.run(runtime.configured_runtimes())
    assert calls == ['default', 'opencode', 'jiuwenswarm', 'deepseek', 'codex', 'claude']
    assert [item['status'] for item in result] == ['ready', 'ready', 'ready', 'ready', 'ready', 'needs_login']


def test_opencode_binary_sources(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime.native, 'ROOT', tmp_path)
    monkeypatch.setattr(runtime.native, 'BUNDLED', tmp_path / 'bundled')
    monkeypatch.setattr(runtime.native.shutil, 'which', lambda name: '/local/bin/' + name)
    assert runtime.native.executable('default') is None
    binary = tmp_path / 'node_modules/opencode-ai/bin/opencode.exe'
    binary.parent.mkdir(parents=True)
    binary.touch()
    assert runtime.native.executable('default') == str(binary)
    assert runtime.native.executable('opencode') == '/local/bin/opencode'


def test_opencode_cli_and_default_use_separate_model_paths(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(runtime.native, 'executable', lambda name: '/bin/' + name)
    monkeypatch.setenv('XDG_CONFIG_HOME', '/existing/config')
    cli_args, cli_env = runtime.native.command('opencode', tmp_path, '/tmp/socket', 'turn-token', 'local/my-model', '', [])
    cli_config = json.loads(cli_env['OPENCODE_CONFIG_CONTENT'])
    assert cli_args[0] == '/bin/opencode'
    assert cli_args[-1] == 'local/my-model'
    assert cli_env['XDG_CONFIG_HOME'] == '/existing/config'
    assert 'provider' not in cli_config
    assert 'OPENDIRECTOR_MODEL_KEY' not in cli_env
    args, env = runtime.native.command('default', tmp_path, '/tmp/socket', 'turn-token', 'project-model', 'http://loopback', [])
    config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
    assert args[0] == '/bin/default'
    assert args[-1] == 'opendirector/project-model'
    assert env['XDG_CONFIG_HOME'] == str(tmp_path)
    assert config['provider']['opendirector']['options']['baseURL'] == 'http://loopback'
    assert runtime.runtime_spec('opencode').modelSource == 'cli'
    assert runtime.runtime_spec('default').modelSource == 'settings'


def test_runtime_catalog_can_skip_probes_and_check_one_harness(tmp_path, monkeypatch):
    from uuid import uuid4
    from fastapi.testclient import TestClient
    from opendirector_api.main import create_app
    from opendirector.infrastructure.local_projects import LocalProjects
    calls = []
    async def probe(engine):
        calls.append(engine)
        return 'ready'
    monkeypatch.setattr(runtime, 'runtime_readiness', probe)
    # One seam decides installation for every engine, so a single patch covers them.
    monkeypatch.setattr(runtime, 'installation', lambda _: '/installed/cli')
    pid = str(uuid4())
    path = f'/api/creation/projects/{pid}'
    with TestClient(create_app(LocalProjects(tmp_path)), headers={
        'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        assert client.post(path+'/commands', json={'type':'project.create','projectId':pid,
            'commandId':str(uuid4()),'payload':{'name':'Probes'}}).status_code == 200
        rows = client.get(path+'/assistant/runtimes?probe=false').json()
        assert not calls
        assert next(row for row in rows if row['id']=='opencode')['status']=='ready'
        assert next(row for row in rows if row['id']=='jiuwenswarm')['status']=='checking'
        response = client.get(path+'/assistant/runtimes/codex/status')
        assert response.status_code == 200
        assert response.json()['status']=='ready'
        assert calls == ['codex']


@pytest.mark.parametrize('content, expected', [
    ('echo "postinstall was not run"\nexit 1\n', 'unknown'),
    (f'#!{sys.executable}\nraise SystemExit(1)\n', 'unknown'),
    (f'#!{sys.executable}\nimport sys\nassert sys.argv[1:] == ["--version"]\nprint("1.19.5")\n', 'ready'),
])
@requires_posix()
def test_bundled_readiness_runs_binary(tmp_path, monkeypatch, content, expected):
    binary = tmp_path / 'opencode.exe'
    if content.startswith('#!'):
        binary = python_cli(binary, content)
    else:
        binary.write_text(content)
    binary.chmod(0o755)
    monkeypatch.setattr(runtime.native, 'executable', lambda _: str(binary))
    assert asyncio.run(runtime.runtime_readiness('default')) == expected


def test_skill_endpoint_reports_incomplete_bundled_install(tmp_path, monkeypatch):
    from uuid import uuid4
    from fastapi.testclient import TestClient
    from opendirector_api.main import create_app
    from opendirector.infrastructure.local_projects import LocalProjects

    binary = tmp_path / 'opencode.exe'
    binary.write_text('echo "postinstall was not run"\nexit 1\n')
    binary.chmod(0o755)
    monkeypatch.setattr('opendirector.agent.skills.executable', lambda _: str(binary))
    pid = str(uuid4())
    path = f'/api/creation/projects/{pid}'
    with TestClient(create_app(LocalProjects(tmp_path)), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        assert client.post(path + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': 'Incomplete install'}}).status_code == 200
        response = client.get(path + '/assistant/skills')
        assert response.status_code == 503
        assert response.json()['code'] == 'agent_dependency_unavailable'
        assert 'pip install' in response.json()['detail']
        english = client.get(path + '/assistant/skills', headers={'Accept-Language': 'en-US'})
        assert english.status_code == 503
        assert 'pip install' in english.json()['detail']
        assert 'Bundled Agent' in english.json()['detail']
        assert '磁盘空间' not in response.json()['detail']

def test_jiuwenswarm_readiness_uses_the_executable_installation_resolved(monkeypatch):
    """Only runtime.installation() is mocked: the resolved path must reach the CLI call."""
    from opendirector.agent import jiuwenswarm
    seen = []
    async def query(operation, *, binary=None):
        seen.append((operation, binary))
        return {'models': [{'selection_key': 'local/m', 'display_name': 'm', 'is_default': True}]}
    monkeypatch.setattr(runtime, 'installation', lambda _: '/resolved/jiuwenswarm')
    monkeypatch.setattr(jiuwenswarm, 'query', query)
    def path_lookup():
        raise AssertionError('readiness must not probe PATH again')
    monkeypatch.setattr(jiuwenswarm, 'executable', path_lookup)
    assert asyncio.run(runtime.runtime_readiness('jiuwenswarm')) == 'ready'
    assert seen == [('protocol.capabilities', '/resolved/jiuwenswarm'), ('model.list', '/resolved/jiuwenswarm')]
