"""Business-service coverage via TestClient and an in-process agent bridge.

Real socket/HTTP coverage lives in test_canvas_text_cli_http.py.
"""
import asyncio
import json
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
import httpx
import pytest
from typer.testing import CliRunner

from opendirector import cli
from opendirector.agent.tools import AgentTools
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app


@pytest.fixture(params=['http', 'live'], ids=['http-testclient', 'live-bridge-only'])
def canvas_cli(request, tmp_path, monkeypatch):
    local = LocalProjects(tmp_path)
    projects = CreationProjects(local)
    project, turn = uuid4(), uuid4()
    projects.execute(parse_command(dict(type='project.create', projectId=project,
        commandId=uuid4(), payload=dict(name='Markdown CLI'))))
    api = TestClient(create_app(local))
    original = httpx.Client
    def forward(req):
        response = api.request(req.method, req.url.path, headers=dict(req.headers), content=req.read())
        return httpx.Response(response.status_code, headers=response.headers, content=response.content)
    monkeypatch.setattr(cli.httpx, 'Client', lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(forward)))
    session = str(uuid4())
    if request.param == 'live':
        projects.open(project, session)
        business = AgentTools(projects, None, ModelConfigs(tmp_path))
        monkeypatch.setenv('OPENDIRECTOR_AGENT_SOCKET', 'in-process-test')
        def call(self, name, arguments, *, identity=None):
            assert name != 'read', 'CLI source reads must not use the agent context budget'
            return asyncio.run(business.execute(project, turn, session, str(identity or uuid4()),
                name, arguments, roots=[], config=None, native_runtime='codex'))
        monkeypatch.setattr(cli.Client, 'call', call)
    else:
        monkeypatch.delenv('OPENDIRECTOR_AGENT_SOCKET', raising=False)
        monkeypatch.delenv('OPENDIRECTOR_AGENT_HOST', raising=False)
    runner = CliRunner()
    def invoke(args, *, content=None, status=0):
        result = runner.invoke(cli.app, ['--project', str(project), *args], input=content)
        assert result.exit_code == status, (result.output, result.exception)
        return json.loads(result.output)
    yield invoke, projects, project


def test_markdown_create_show_update_resize_replay_and_conflicts(canvas_cli, tmp_path):
    invoke, projects, project = canvas_cli
    text = '\ufeff# 中文 and English\r\n\r\n> **Quote**\r\n\r\n- item\r\n\r\n| A | B |\r\n| - | - |\r\n| x | y |\r\n\r\n```js\r\nconst x = "quotes `ticks`";\r\n```\r\n' + ('完整 source\n' * 9000)
    path = tmp_path / 'notes.md'
    path.write_bytes(text.encode('utf-8'))
    item_id, operation = str(uuid4()), str(uuid4())
    create = ['--operation-id', operation, 'canvas', 'text', 'create', '--file', str(path),
        '--x', '15', '--y', '-20', '--width', '480', '--height', '240', '--title', 'Notes', '--item-id', item_id]
    created = invoke(create)
    assert created['status'] == 'applied' and created['itemId'] == item_id
    assert invoke(create) == created
    assert len(projects.snapshot(project).assets) == 1
    shown = invoke(['canvas', 'text', 'show', '--id', item_id])
    assert shown['text'] == text and shown['revision'] == 1
    assert (shown['width'], shown['height']) == (480, 240)
    assert created['canvasItems'][0]['revision'] == shown['revision']
    replacement = text + '\n[OpenDirector](https://example.com)\n'
    update = ['--operation-id', str(uuid4()), 'canvas', 'text', 'update', '--id', item_id,
        '--file', '-', '--expected-version', shown['expectedVersion']]
    updated = invoke(update, content=replacement)
    assert updated['status'] == 'applied'
    assert invoke(update, content=replacement) == updated
    after = invoke(['canvas', 'text', 'show', '--id', item_id])
    assert after['text'] == replacement
    assert after['revision'] == updated['canvasItems'][0]['revision'] == 2
    rejected = invoke(['canvas', 'text', 'update', '--id', item_id, '--file', '-',
        '--expected-version', shown['expectedVersion']], content='stale text', status=1)
    assert rejected['status'] == 'rejected'
    assert rejected['issues'][0]['code'] == 'revision_conflict'
    resize = ['--operation-id', str(uuid4()), 'canvas', 'text', 'resize', '--id', item_id,
        '--width', '700', '--height', '180', '--expected-version', after['expectedVersion']]
    resized = invoke(resize)
    assert invoke(resize) == resized
    reopened = CreationProjects(LocalProjects(projects.local.repository)).snapshot(project)
    item = next(value for value in reopened.canvasItems if str(value.id) == item_id)
    assert (item.width, item.height, item.revision) == (700, 180, 3)
    assert invoke(['canvas', 'text', 'show', '--id', item_id])['text'] == replacement
    assert len(reopened.assets) == 2
    assert len(projects.snapshot(project).assets[-1].provenance.sources) == 1
    invoke(['canvas', 'update', '--item-id', item_id, '--locked', 'true',
        '--expected-version', f'canvas_item:{item_id}:3'])
    for verb in ['resize', 'update']:
        args = ['canvas', 'text', verb, '--id', item_id, '--expected-version', f'canvas_item:{item_id}:4']
        args += ['--width', '400', '--height', '200'] if verb == 'resize' else ['--file', '-']
        rejected = invoke(args, content='locked edit', status=1)
        assert rejected['status'] == 'rejected'
    assert invoke(['canvas', 'text', 'show', '--id', item_id])['text'] == replacement


def test_markdown_input_limits_and_empty_source(canvas_cli, tmp_path):
    invoke, projects, project = canvas_cli
    created = invoke(['canvas', 'text', 'create', '--file', '-', '--x', '0', '--y', '0'], content='')
    assert invoke(['canvas', 'text', 'show', '--id', created['itemId']])['text'] == ''
    # Byte limit matters for Chinese as well as the schema's character limit.
    for content in ['字' * 349526, 'a' * (1024 * 1024 + 1)]:
        with pytest.raises(ValueError, match='1 MiB'):
            path = tmp_path / 'large.md'
            path.write_text(content, encoding='utf-8')
            cli.markdown_file(path)
    path = tmp_path / 'bad.md'
    path.write_bytes(b'\xff\xfe')
    with pytest.raises(UnicodeDecodeError):
        cli.markdown_file(path)
    assert len(projects.snapshot(project).canvasItems) == 1


def test_text_help_explains_format_versions_units_and_examples():
    runner = CliRunner()
    for verb in ['', 'create', 'show', 'update', 'resize']:
        result = runner.invoke(cli.app, ['canvas', 'text', *([verb] if verb else []), '--help'])
        assert result.exit_code == 0, result.output
        if verb:
            assert 'Example:' in result.output
        else:
            assert all(word in result.output for word in ['UTF-8', 'Markdown', 'MiB', 'zoom', 'conflicts'])


def test_complete_source_read_is_bounded_and_preserves_http_errors():
    from opendirector.domain.projects import ProjectError
    from opendirector.ports.files import MAX_CREATION_TEXT_BYTES

    client = cli.Client(uuid4(), 'http://test', None, None)
    client.http.close()
    source = b'\xef\xbb\xbf# Heading\r\n' + b'a' * (MAX_CREATION_TEXT_BYTES - 14)
    assert len(source) == MAX_CREATION_TEXT_BYTES
    requested = []
    def respond(request):
        requested.append(request.url.path)
        return httpx.Response(200, content=source)
    with httpx.Client(base_url='http://test', transport=httpx.MockTransport(respond)) as client.http:
        asset = uuid4()
        assert cli.text_content(client, asset) == source.decode('utf-8')
        assert requested == [f'/api/creation/projects/{client.project}/assets/{asset}/content']
        source += b'!'
        with pytest.raises(ValueError, match='1 MiB'):
            cli.text_content(client, asset)
    with httpx.Client(base_url='http://test', transport=httpx.MockTransport(lambda request:
            httpx.Response(404, json={'detail': 'Missing text asset', 'code': 'asset_missing'}))) as client.http:
        with pytest.raises(ProjectError, match='Missing text asset') as error:
            cli.text_content(client, asset)
        assert error.value.status == 404 and error.value.code == 'asset_missing'
