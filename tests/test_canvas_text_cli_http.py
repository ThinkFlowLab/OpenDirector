"""Real CLI bridge and listening API coverage, separate from TestClient adapters."""
import asyncio
import json
import socket
import sys
import tempfile
from uuid import uuid4

import httpx
import pytest
import uvicorn

from opendirector import cli
from opendirector.agent import cli_transport
from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.localization import localized_error_for_language
from opendirector_api.main import create_app


pytestmark = pytest.mark.cpu


@pytest.mark.merge
@pytest.mark.parametrize('listening', [True, False], ids=['listening-api', 'closed-api'])
def test_live_cli_complete_source_uses_http_listener(tmp_path, monkeypatch, listening):
    for key in ('OPENDIRECTOR_AGENT_SOCKET', 'OPENDIRECTOR_AGENT_HOST', 'OPENDIRECTOR_AGENT_PORT'):
        monkeypatch.delenv(key, raising=False)

    async def check():
        local = LocalProjects(tmp_path)
        projects = CreationProjects(local)
        pid, session = uuid4(), str(uuid4())
        projects.execute(parse_command(dict(type='project.create', projectId=pid,
            commandId=uuid4(), payload=dict(name='Real HTTP Markdown CLI'))))
        projects.open(pid, session)
        with local.transaction() as db:
            directory, _, _ = projects._load(db, pid)
        run = RunContext(runtime='codex', project_id=pid, turn_id=uuid4(), session=session,
            directory=directory, config=None, messages=[], selected_skills=[])
        gateway = ToolGateway(AgentTools(projects, None, ModelConfigs(tmp_path)), run)
        app = create_app(local)
        content_requests = []

        with socket.socket() as listener, tempfile.TemporaryDirectory() as temporary:
            listener.bind(('127.0.0.1', 0))
            address = listener.getsockname()
            url = f'http://{address[0]}:{address[1]}'

            @app.middleware('http')
            async def count_source_reads(request, call_next):
                if request.url.path.endswith('/content'):
                    assert request.scope['server'] == address
                    content_requests.append(request.url.path)
                return await call_next(request)

            server = uvicorn.Server(uvicorn.Config(app, log_level='error', ws='none'))
            serving = asyncio.create_task(server.serve(sockets=[listener])) if listening else None
            if not listening:
                listener.close()
            try:
                if serving:
                    async with asyncio.timeout(10):
                        while not server.started:
                            if serving.done():
                                await serving
                                pytest.fail('API exited before listening')
                            await asyncio.sleep(0.01)
                async with cli_transport.turn_environment(tmp_path, gateway, asyncio.Queue(), temporary) as env:
                    env['OPENDIRECTOR_API_URL'] = url
                    env['OPENDIRECTOR_LANGUAGE'] = 'en-US'
                    env.pop('OPENDIRECTOR_SESSION', None)

                    async def invoke(*args, status=0):
                        projects.heartbeat(session, pid)
                        process = await asyncio.create_subprocess_exec(sys.executable, '-m', 'opendirector.cli',
                            '--project', str(pid), 'canvas', 'text', *args, env=env,
                            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                        try:
                            stdout, stderr = await asyncio.wait_for(process.communicate(), 10)
                        finally:
                            if process.returncode is None:
                                process.kill()
                                await process.wait()
                        assert process.returncode == status, (stdout, stderr)
                        return json.loads(stdout)

                    source = ('\ufeff# 第一节\r\nOriginal\r\n\r\n## Second\r\n' + '完整 source\r\n' * 6000
                              + '\r\n## Third\r\n```js\r\nconst x = "quotes `ticks`";\r\n```\r\n').encode('utf-8')
                    assert len(source) > 64 * 1024
                    path = tmp_path / 'source.md'
                    path.write_bytes(source)
                    created = await invoke('create', '--file', str(path), '--x', '15', '--y', '-20',
                        '--width', '480', '--height', '320')
                    item_id = created['itemId']
                    assert created['status'] == 'applied'
                    item, = projects.snapshot(pid).canvasItems
                    assert str(item.id) == item_id
                    assert (item.width, item.height, item.revision) == (480, 320, 1)
                    assert created['canvasItems'][0]['revision'] == 1
                    shown = await invoke('show', '--id', item_id, status=0 if listening else 1)
                    if not listening:
                        # Negative control: the bridge works, but a closed HTTP port cannot read source.
                        assert 'running API' in shown['error'] and url in shown['error']
                        assert shown['code'] == 'asset_text_api_unavailable'
                        assert not content_requests
                        return
                    assert shown['text'].encode('utf-8') == source
                    assert (shown['width'], shown['height'], shown['revision']) == (480, 320, 1)
                    revised = source.replace(b'Original', b'Revised', 1)
                    path.write_bytes(revised)
                    updated = await invoke('update', '--id', item_id, '--file', str(path),
                        '--expected-version', shown['expectedVersion'])
                    assert updated['status'] == 'applied' and updated['canvasItems'][0]['revision'] == 2
                    after = await invoke('show', '--id', item_id)
                    assert after['text'].encode('utf-8') == revised
                    assert (after['width'], after['height'], after['revision']) == (480, 320, 2)
                    reopened = CreationProjects(LocalProjects(tmp_path)).snapshot(pid)
                    item, = reopened.canvasItems
                    assert (item.width, item.height, item.revision) == (480, 320, 2)
                    assert len(content_requests) == 2
                    assert all(path.startswith(f'/api/creation/projects/{pid}/assets/') for path in content_requests)
                    names = {json.loads(identity)[0] for identity, _ in gateway.calls.values()}
                    assert names == {'execute_command', 'query'}
            finally:
                server.should_exit = True
                if serving:
                    await asyncio.wait_for(serving, 10)

    asyncio.run(check())


@pytest.mark.ready
@pytest.mark.parametrize('language,hint', [('en-US', 'running API'), ('zh-CN', '正在运行的 API')], ids=['en-US', 'zh-CN'])
def test_unreachable_source_read_has_localized_api_hint(language, hint, monkeypatch, capsys):
    monkeypatch.setenv('OPENDIRECTOR_LANGUAGE', language)
    with socket.socket() as closed:
        closed.bind(('127.0.0.1', 0))
        url = f'http://127.0.0.1:{closed.getsockname()[1]}'
        closed.close()
        client = cli.Client(uuid4(), url, None, None)
        try:
            with pytest.raises(ProjectError) as failure:
                cli.text_content(client, uuid4())
            assert failure.value.code == 'asset_text_api_unavailable'
            assert hint in str(failure.value) and url in str(failure.value)
            assert 'canvas text show' in str(failure.value)
            localized = localized_error_for_language(language, chinese=str(failure.value),
                status=failure.value.status, code=failure.value.code)
            assert hint in localized
            monkeypatch.setattr(cli, 'app', lambda **kwargs: cli.text_content(client, uuid4()))
            with pytest.raises(SystemExit) as exit:
                cli.main()
            assert exit.value.code == 1
            payload = json.loads(capsys.readouterr().out)
            assert payload['code'] == 'asset_text_api_unavailable'
            assert hint in payload['error'] and url in payload['error']
        finally:
            client.http.close()


@pytest.mark.ready
@pytest.mark.parametrize('body', [b'', b' \r\n', b'{"detail":"","code":"proxy_error"}'],
                         ids=['empty-body', 'whitespace-body', 'empty-detail'])
def test_empty_http_failure_has_status_and_url(body, monkeypatch, capsys):
    client = cli.Client(uuid4(), 'http://api.test', None, None)
    client.http.close()
    with httpx.Client(base_url='http://api.test', transport=httpx.MockTransport(
            lambda request: httpx.Response(502, content=body))) as client.http:
        monkeypatch.setattr(cli, 'app', lambda **kwargs: cli.text_content(client, uuid4()))
        with pytest.raises(SystemExit) as exit:
            cli.main()
        assert exit.value.code == 1
        payload = json.loads(capsys.readouterr().out)
        assert payload['error'].strip(), payload
        assert '502' in payload['error'] and 'http://api.test/' in payload['error']
        if body.startswith(b'{'):
            assert payload['code'] == 'proxy_error'
