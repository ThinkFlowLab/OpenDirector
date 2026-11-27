"""CLI entry points against the real API and persistent project store."""
import json
import re
from pathlib import Path
import shlex
import subprocess
import sys
from unittest.mock import Mock, call
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
import httpx
import pytest
import typer
from typer.testing import CliRunner

from opendirector import cli
from opendirector.domain.projects import ProjectError

from opendirector.application.voice_library import VoiceLibrary
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app


pytestmark = pytest.mark.cpu


def test_cli_preserves_the_font_error_code_and_english_diagnostic(tmp_path, monkeypatch):
    api = TestClient(create_app(LocalProjects(tmp_path)))
    original_client = httpx.Client
    def forward(request):
        response = api.request(request.method, request.url.path, headers=dict(request.headers), content=request.read())
        return httpx.Response(response.status_code, json=response.json())
    monkeypatch.setattr(cli.httpx, 'Client', lambda **kwargs:
        original_client(**kwargs, transport=httpx.MockTransport(forward)))
    client = cli.Client(None, 'http://localhost', None, None)
    try:
        with pytest.raises(ProjectError) as failure:
            client.request('POST', '/api/creation/fonts/inspect', content=b'not a font')
        assert failure.value.code == 'timeline_font_unsupported'
        assert str(failure.value) == 'Only static TTF and OTF fonts are supported.'
    finally:
        client.http.close()

@pytest.mark.parametrize('live', [False, True], ids=['http', 'agent'])
@pytest.mark.parametrize('options,expected', [
    ([], {}),
    (['--page-size', '150'], {'pageSize': 150}),
    (['--page-size', '45', '--after', 'opaque+/=', '--connection', 'scope'],
     {'pageSize': 45, 'after': 'opaque+/=', 'connectionId': 'scope'}),
])
def test_voice_list_forwards_pagination(live, options, expected, monkeypatch):
    model = str(uuid4())
    client = Mock(live=live, opened=False, operation_id=None)
    page = {'voices': [], 'connectionId': 'scope', 'nextCursor': 'next'}
    client.call.return_value = client.request.return_value = page
    monkeypatch.setattr(cli, 'Client', lambda *args: client)
    result = CliRunner().invoke(cli.app, ['voice', 'list', '--model', model, *options])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == page
    arguments = {'modelConfigId': model, **expected}
    if live:
        client.call.assert_called_once_with('voice_list', arguments, identity=None)
    else:
        client.request.assert_called_once_with('GET', '/api/voices', params=arguments)


@pytest.mark.parametrize('size', ['0', '151'])
def test_voice_list_cli_rejects_invalid_page_size(size, monkeypatch):
    client = Mock(live=False, opened=False)
    monkeypatch.setattr(cli, 'Client', lambda *args: client)
    result = CliRunner().invoke(cli.app, ['voice', 'list', '--model', str(uuid4()), '--page-size', size])
    assert result.exit_code == 2
    assert 'Invalid value' in plain_help(result.output)
    client.request.assert_not_called()


def test_voice_create_sends_private_fields_in_multipart_to_api(tmp_path, monkeypatch):
    model = ModelConfigs(tmp_path).save('audio', 'http://voice.test/v1', 'Drama3', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none')['id']
    recording = tmp_path / 'private-take.wav'
    recording.write_bytes(b'isolated recording bytes')
    created = {'voiceId': 'confirmed-voice'}
    create = Mock(return_value=created)
    monkeypatch.setattr(VoiceLibrary, 'create', create)
    monkeypatch.delenv('OPENDIRECTOR_AGENT_SOCKET', raising=False)
    monkeypatch.delenv('OPENDIRECTOR_AGENT_HOST', raising=False)
    api = TestClient(create_app(LocalProjects(tmp_path)), headers={'X-OpenDirector-Request': '1'})
    requests = []
    api.event_hooks['request'].append(requests.append)
    monkeypatch.setattr(cli.httpx, 'Client', lambda **kwargs: api)

    result = CliRunner().invoke(cli.app, ['voice', 'create', str(recording), '--model', model,
        '--connection', 'fixture-scope', '--name', 'Private name', '--consent', 'private-consent',
        '--ref-text', '私人文本 & words', '--speaker-description', 'Private description'])
    assert result.exit_code == 0, result.exception
    assert json.loads(result.output) == created
    request, = requests
    assert request.url.path == '/api/voices'
    assert request.url.params.multi_items() == [('modelConfigId', model)]
    assert request.headers['content-type'].startswith('multipart/form-data; boundary=')
    create.assert_called_once_with(model, recording.read_bytes(), filename=recording.name,
        name='Private name', consent='private-consent', connection_id='fixture-scope',
        ref_text='私人文本 & words', speaker_description='Private description')


def test_agent_voice_create_forwards_recording_path(tmp_path, monkeypatch):
    model = str(uuid4())
    recording = tmp_path / 'take.wav'
    recording.touch()
    client = Mock(live=True, opened=False, operation_id=None)
    client.call.return_value = {'voiceId': 'confirmed-voice'}
    monkeypatch.setattr(cli, 'Client', lambda *args: client)
    result = CliRunner().invoke(cli.app, ['voice', 'create', str(recording), '--model', model,
        '--connection', 'scope', '--name', 'Voice'])
    assert result.exit_code == 0, result.exception
    client.call.assert_called_once_with('voice_create', {'modelConfigId': model, 'connectionId': 'scope',
                                                       'name': 'Voice', 'path': str(recording.resolve())}, identity=None)
    client.request.assert_not_called()


def _mock_live_client(monkeypatch, **attrs):
    client = Mock(live=True, opened=False, operation_id=None, **attrs)

    def build(_project, _url, _session, operation_id):
        client.operation_id = operation_id
        return client

    monkeypatch.setattr(cli, 'Client', build)
    return client


def test_agent_voice_commands_forward_operation_id(tmp_path, monkeypatch):
    model = str(uuid4())
    op_id = uuid4()
    recording = tmp_path / 'take.wav'
    recording.write_bytes(b'audio')
    client = _mock_live_client(monkeypatch)
    client.call.return_value = {'voiceId': 'v-1', 'connectionId': 'scope'}
    runner = CliRunner()
    res_create = runner.invoke(cli.app, ['--operation-id', str(op_id), 'voice', 'create', str(recording),
                                         '--model', model, '--connection', 'scope', '--name', 'Voice'])
    assert res_create.exit_code == 0, res_create.output
    client.call.assert_called_once_with(
        'voice_create',
        {'modelConfigId': model, 'connectionId': 'scope', 'name': 'Voice', 'path': str(recording.resolve())},
        identity=op_id,
    )
    client.call.reset_mock()
    res_delete = runner.invoke(cli.app, ['--operation-id', str(op_id), 'voice', 'delete', 'v-1',
                                         '--model', model, '--connection', 'scope'])
    assert res_delete.exit_code == 0, res_delete.output
    client.call.assert_called_once_with(
        'voice_delete',
        {'modelConfigId': model, 'connectionId': 'scope', 'voiceId': 'v-1'},
        identity=op_id,
    )


def test_agent_reads_forward_operation_id(monkeypatch):
    op_id = uuid4()
    item_id = uuid4()
    job_id = uuid4()
    client = _mock_live_client(monkeypatch)
    client.call.return_value = []
    client.models.return_value = [{'id': str(uuid4()), 'modelId': 'm1', 'kind': 'video', 'url': 'http://x'}]
    client.query.side_effect = lambda kind, **kw: (
        {'id': str(item_id), 'kind': 'text', 'revision': 1, 'width': 320, 'height': 180, 'binding': {'role': 'empty'}}
        if kind == 'object.get' else {'job': {'id': str(job_id), 'status': 'running'}}
    )
    runner = CliRunner()
    assert runner.invoke(cli.app, ['--operation-id', str(op_id), 'model', 'availability']).exit_code == 0
    client.call.assert_called_once_with('model_availability', {'manual': False, 'refresh': False}, identity=op_id)
    assert runner.invoke(cli.app, ['--operation-id', str(op_id), 'model', 'list']).exit_code == 0
    client.models.assert_called_with(identity=op_id)
    assert runner.invoke(cli.app, ['--operation-id', str(op_id), 'canvas', 'text', 'show', '--id', str(item_id)]).exit_code == 0
    client.query.assert_called_with('object.get', identity=op_id, objectId=str(item_id))
    assert runner.invoke(cli.app, ['--operation-id', str(op_id), 'job', 'show', str(job_id)]).exit_code == 0
    client.query.assert_called_with('job.get', identity=op_id, objectId=str(job_id))


@pytest.mark.parametrize(('terminal', 'exit_code'), [('succeeded', 0), ('failed', 1)])
def test_agent_job_wait_uses_step_identity_only_for_successful_terminal_read(monkeypatch, terminal, exit_code):
    op_id, job_id = uuid4(), str(uuid4())
    client = _mock_live_client(monkeypatch)
    finished = {'jobs': [{'id': job_id, 'status': terminal}]}
    client.query.side_effect = [{'jobs': [{'id': job_id, 'status': 'running'}]}, finished]

    result = CliRunner().invoke(cli.app, ['--operation-id', str(op_id), 'job', 'wait', job_id])

    assert result.exit_code == exit_code, result.exception
    emitted = json.loads(result.output)
    assert emitted['jobs'] == finished['jobs']
    assert len(client.query.call_args_list) == 2
    assert all(item.args == ('job.status',) and item.kwargs['objectIds'] == [job_id] and item.kwargs['until'] == 'all'
               for item in client.query.call_args_list)
    if terminal == 'succeeded':
        client.call.assert_called_once_with(
            'query', {'type': 'job.status', 'objectIds': [job_id], 'waitSeconds': 0, 'until': 'all'}, identity=op_id,
        )
    else:
        client.call.assert_not_called()


@pytest.fixture
def cli_api(tmp_path, monkeypatch):
    original_client = httpx.Client
    with TestClient(create_app(LocalProjects(tmp_path)), headers={'X-OpenDirector-Request': '1'}) as api:
        def forward(request):
            response = api.request(request.method, request.url.path, headers=dict(request.headers), content=request.read())
            return httpx.Response(response.status_code, headers=response.headers, content=response.content)

        monkeypatch.setattr(cli.httpx, 'Client', lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(forward)))
        yield api


def test_asset_write_text_distinguishes_literal_text_from_command_json(tmp_path, cli_api):
    runner = CliRunner()
    project = str(uuid4())
    assert runner.invoke(cli.app, ['--project', project, 'project', 'create', '--name', 'Merged write-text']).exit_code == 0

    prefix = ['--project', project, 'asset', 'write-text']
    md_stdin = runner.invoke(
        cli.app, [*prefix, '--name', 'outline.md', '--text-file', '-'],
        input='\ufeff# 分镜大纲\n\n- 第一镜\n',
    )
    assert md_stdin.exit_code == 0, md_stdin.output
    first_asset_id = json.loads(md_stdin.output)['assetId']
    snap = json.loads(runner.invoke(cli.app, ['--project', project, 'project', 'show']).output)
    first_asset = next(a for a in snap['assets'] if a['id'] == first_asset_id)
    assert first_asset['name'] == 'outline.md'

    for content in ['{"type":"storyboard","shots":[]}', '{"payload":{"text":"keep the complete document"}}']:
        result = runner.invoke(cli.app, [*prefix, '--text-file', '-'], input=content)
        assert result.exit_code == 0, result.output
        asset_id = json.loads(result.output)['assetId']
        response = cli_api.get(f'/api/creation/projects/{project}/assets/{asset_id}/content')
        assert response.content == content.encode('utf-8')
    malformed = runner.invoke(cli.app, [*prefix, '--file', '-'], input='{"payload":')
    assert malformed.exit_code == 1

    large_text = '分' * 180_000
    cmd_json = tmp_path / 'write_v2.json'
    cmd_json.write_text(json.dumps({
        'type': 'asset.writeText',
        'payload': {
            'name': 'outline-v2.md',
            'text': large_text,
            'previousAsset': {
                'assetId': first_asset['id'],
                'revision': first_asset['revision'],
                'fingerprint': first_asset['fingerprint'],
                'kind': 'text',
            },
        },
        'expectedVersions': [{'objectType': 'asset', 'id': first_asset['id'], 'revision': first_asset['revision']}],
    }), encoding='utf-8')
    assert cmd_json.stat().st_size > 1024 * 1024 > len(large_text.encode())
    v2_res = runner.invoke(cli.app, [*prefix, '--file', str(cmd_json)])
    assert v2_res.exit_code == 0, v2_res.output
    v2_receipt = json.loads(v2_res.output)
    assert v2_receipt['status'] == 'applied'
    response = cli_api.get(f'/api/creation/projects/{project}/assets/{v2_receipt["assetId"]}/content')
    assert response.content == large_text.encode('utf-8')


def test_cli_project_write_replay_and_lock(tmp_path, monkeypatch):
    api = TestClient(create_app(LocalProjects(tmp_path)), headers={"X-OpenDirector-Request": "1"})
    original_client = httpx.Client
    fail_geometry_read = False

    def forward(request):
        if fail_geometry_read and request.url.path.endswith("/queries"):
            return httpx.Response(503, json={"detail": "Geometry query temporarily unavailable"})
        response = api.request(request.method, request.url.path, headers=dict(request.headers),
                               content=request.read())
        return httpx.Response(response.status_code, headers=response.headers, content=response.content)

    monkeypatch.setattr(cli.httpx, "Client", lambda **kwargs:
                        original_client(**kwargs, transport=httpx.MockTransport(forward)))
    runner = CliRunner()
    project, operation = uuid4(), uuid4()
    prefix = ["--project", str(project)]

    def invoke(arguments):
        result = runner.invoke(cli.app, prefix + arguments)
        assert result.exit_code == 0, result.output
        return json.loads(result.output)

    invoke(["project", "create", "--name", "CLI test"])
    command = ["--operation-id", str(operation), "asset", "write-text",
               "--name", "plan.txt", "--text", "Plan"]
    first = invoke(command)
    assert first["status"] == "applied"
    assert invoke(command) == first
    snapshot = invoke(["project", "show"])
    assert len(snapshot["assets"]) == 1
    asset = snapshot["assets"][0]
    shown = invoke(["canvas", "add-material", "--asset", asset["id"], "--x", "20", "--y", "40"])
    assert shown["status"] == "applied"
    assert shown["canvasItems"][0]["position"] == {"x": 20, "y": 40}
    assert shown["canvasItems"][0]["width"] == 352
    item = invoke(["project", "show"])["canvasItems"][0]
    assert item["binding"]["objectRef"]["assetId"] == asset["id"]

    file = tmp_path / "upload.txt"
    file.write_text("Imported text")
    import_operation = str(uuid4())
    imported = invoke(["--operation-id", import_operation, "asset", "import", str(file), "--kind", "text"])
    assert imported["status"] == "applied"
    assert invoke(["--operation-id", import_operation, "asset", "import", str(file), "--kind", "text"]) == imported
    assert len(invoke(["project", "show"])["assets"]) == 2

    model = ModelConfigs(tmp_path).save("video", "http://127.0.0.1:9999/v1",
        "FastVideo/FastVideo-FastH3-Omni-8-Step-V1", "",
        connection_type="self_hosted", protocol="vllm_omni", auth_mode="none", video_adapter="fasth3")
    found = invoke(["model", "list", "--kind", "video", "--search", "fasth3"])
    assert [entry["id"] for entry in found] == [model["id"]]
    assert invoke(["model", "show", model["modelId"]])["id"] == model["id"]
    assert invoke(["model", "show", model["id"]])["modelId"] == model["modelId"]
    created = invoke(["video", "create", "--model", model["modelId"], "--prompt", "A calm scene",
                      "--duration", "5", "--x", "450", "--y", "40", "--reference-item", item["id"]])
    spec = next(value for value in invoke(["project", "show"])["generationSpecs"]
                if value["id"] == created["specId"])
    assert spec["purpose"] == "generation" and spec["modelConfigId"] == model["id"]
    assert spec["parameters"]["durationSeconds"] == 5
    video = next(value for value in invoke(["project", "show"])["canvasItems"]
                 if value["id"] == created["itemId"])
    assert video["position"] == {"x": 450, "y": 40}
    assert created["canvasItems"][0]["position"] == video["position"]
    assert created["canvasItems"][0]["revision"] == video["revision"]
    submit = shlex.split(created["next"]["command"])
    assert submit[:3] == ["opendirector", "--project", str(project)]
    assert submit[3] == "--operation-id"
    assert submit[5:7] == ["generation", "submit"]
    assert f"generation_spec:{spec['id']}:{spec['revision']}" in submit
    assert "--expected-spec-revision" in submit
    references = invoke(["project", "show"])["references"]
    assert references[0]["source"]["id"] == item["id"]

    # Generic canvas commands and atomic batches use the same geometry receipt.
    moved = invoke(["canvas", "move", "--items",
        json.dumps([{"itemId": item["id"], "position": {"x": 60, "y": 80}}]),
        "--expected-version", f"canvas_item:{item['id']}:{item['revision']}"])
    geometry = moved["canvasItems"][0]
    assert geometry["position"] == {"x": 60, "y": 80}
    assert geometry["coordinateSpace"] == "canvas"
    unchanged = invoke(["canvas", "move", "--items",
        json.dumps([{"itemId": item["id"], "position": geometry["position"]}]),
        "--expected-version", f"canvas_item:{item['id']}:{geometry['revision']}"])
    assert unchanged["canvasItems"][0]["position"] == geometry["position"]
    batch = invoke(["creation", "batch", "--operations",
        json.dumps([{"type": "canvas.hide", "payload": {"itemId": item["id"]}}]),
        "--expected-version", f"canvas_item:{item['id']}:{unchanged['canvasItems'][0]['revision']}"])
    assert batch["canvasItems"][0]["visible"] is False
    assert batch["canvasItems"][0]["position"] == geometry["position"]

    fail_geometry_read = True
    readback_failed = invoke(["canvas", "add-material", "--asset", asset["id"], "--x", "900", "--y", "40"])
    assert readback_failed["status"] == "applied"
    assert "Geometry query temporarily unavailable" in readback_failed["geometryReadError"]
    fail_geometry_read = False
    assert any(value["id"] == readback_failed["itemId"]
               for value in invoke(["project", "show"])["canvasItems"])

    other_session = str(uuid4())
    assert api.post(f"/api/creation/projects/{project}/open",
                    headers={"X-OpenDirector-Session": other_session}).status_code == 200
    blocked = runner.invoke(cli.app, prefix + ["asset", "write-text", "--name", "blocked.txt", "--text", "Blocked"])
    # app exceptions are formatted by main in a real process. The lock remains authoritative.
    assert blocked.exit_code != 0
    assert len(invoke(["project", "show"])["assets"]) == 2


def test_cli_repeated_trash_reports_the_missing_project(cli_api):
    """An accepted trash stores no receipt, so the same commandId is a 404.

    The workspace maps that 404 to success. The CLI reports it: the id may
    simply be wrong, and there is no stored receipt to replay.
    """
    runner = CliRunner()
    project, operation = uuid4(), uuid4()
    prefix = ["--project", str(project)]

    def invoke(arguments):
        result = runner.invoke(cli.app, prefix + arguments)
        assert result.exit_code == 0, result.output
        return json.loads(result.output)

    invoke(["project", "create", "--name", "Trash once"])
    revision = invoke(["project", "show"])["project"]["revision"]
    command = ["--operation-id", str(operation), "project", "trash",
               "--expected-version", f"project:{project}:{revision}"]
    assert invoke(command)["status"] == "noop"
    repeated = runner.invoke(cli.app, prefix + command)
    # invoke() calls the Typer app directly, so the 404 leaves main()'s
    # formatter and surfaces as the request error. It is not a success.
    assert repeated.exit_code != 0
    assert repeated.exception is not None
    assert repeated.exception.status == 404
    assert repeated.exception.code == "not_found"


@pytest.fixture(params=[False, True], ids=['plain', 'color'])
def help_color(request, monkeypatch):
    monkeypatch.setenv('TERM', 'xterm-256color')
    if request.param:
        monkeypatch.delenv('NO_COLOR', raising=False)
        monkeypatch.setenv('FORCE_COLOR', '1')
    else:
        monkeypatch.delenv('FORCE_COLOR', raising=False)
        monkeypatch.setenv('NO_COLOR', '1')


def plain_help(value):
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', value)


def test_all_cli_business_commands_have_help(help_color):
    runner = CliRunner()
    for kind in cli.COMMANDS:
        namespace, action = kind.split(".", 1)
        result = runner.invoke(cli.app, [cli.kebab(namespace), cli.kebab(action), "--help"])
        assert result.exit_code == 0, (kind, result.output)
        assert "--file" in plain_help(result.output)


def test_parser_error_shows_specific_command_help(help_color):
    script = Path(__file__).resolve().parents[1] / "scripts/opendirector.py"
    result = subprocess.run([sys.executable, str(script), "video", "create", "--asset", "unknown"],
                            text=True, capture_output=True)
    assert result.returncode == 2
    assert "No such option: --asset" in result.stderr
    for option in ("--model", "--prompt", "--duration", "--first-frame", "--reference-item"):
        assert option in plain_help(result.stderr)


def test_source_launcher_handoff_preserves_spaced_unicode_arguments_and_exit_status(tmp_path):
    import os
    import shutil
    import venv
    root = tmp_path / 'checkout with spaces 中文'
    (root / 'scripts').mkdir(parents=True)
    script = root / 'scripts/opendirector.py'
    shutil.copyfile(Path(__file__).resolve().parents[1] / 'scripts/opendirector.py', script)
    package = root / 'packages/core/src/opendirector'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('')
    (package / 'cli.py').write_text(
        'import json,sys\ndef main():\n print(json.dumps(sys.argv[1:]))\n raise SystemExit(17)\n')
    venv.EnvBuilder(with_pip=False, symlinks=os.name != 'nt').create(root / '.venv')
    arguments = ['中文 𠮷 with spaces', 'quotes"and&symbols', '--help']
    result = subprocess.run([sys.executable, str(script), *arguments],
        env={**os.environ, 'PYTHONUTF8': '1'}, capture_output=True, text=True, timeout=20)
    assert result.returncode == 17, result.stderr
    assert json.loads(result.stdout) == arguments



def test_model_selector_requires_a_unique_exact_name():
    identity = str(uuid4())
    model = {"id": identity, "modelId": "Example-Lite", "kind": "video", "url": "http://localhost:9000"}
    other = {**model, "id": str(uuid4()), "url": "http://localhost:9001"}
    assert cli.select_model([model, other], identity.upper()) == model
    assert cli.select_model([model], "Example-Lite") == model
    with pytest.raises(cli.ProjectError, match="not found"):
        cli.select_model([model], "Example")
    with pytest.raises(cli.ProjectError, match="Multiple model configurations") as error:
        cli.select_model([model, other], "Example-Lite")
    assert identity in str(error.value) and other["id"] in str(error.value)


def test_accepted_cli_receipt_provides_wait_commands(monkeypatch):
    project = str(uuid4())
    jobs = [str(uuid4()), str(uuid4())]
    monkeypatch.setenv("OPENDIRECTOR_AGENT_SOCKET", "/test-only.sock")
    client = cli.Client(None, "http://localhost:18765", None, None)
    receipt = {"status": "accepted", "projectId": project, "jobIds": jobs, "changed": []}
    monkeypatch.setattr(client, "call", lambda *args, **kwargs: receipt)
    try:
        result = client.execute("generation.submit", {})
        commands = result["next"]["commands"]
        assert len(commands) == 1
        assert shlex.split(commands[0]) == ["opendirector", "--url", "http://localhost:18765",
            "--project", project, "job", "wait", *jobs, "--timeout", "60"]
        assert "next" not in receipt
    finally:
        client.http.close()


@pytest.mark.parametrize('adopted', [False, True])
def test_completed_job_inspection_reuses_registered_result(monkeypatch, tmp_path, adopted):
    from copy import deepcopy
    asset, result_id, spec_id, item_id = [str(uuid4()) for _ in range(4)]
    ref = {'assetId': asset, 'revision': 1, 'kind': 'video', 'fingerprint': 'sha256:' + 'a' * 64}
    job = {'status': 'succeeded', 'asset': ref}
    snapshot = {'assets': [{'id': asset}], 'results': [{'id': result_id, 'asset': ref}],
        'generationSpecs': [{'id': spec_id, 'currentResultId': result_id if adopted else None}],
        'canvasItems': [{'id': item_id, 'revision': 2, 'visible': True,
            'position': {'x': 400, 'y': 0}, 'width': 352, 'height': 352,
            'binding': {'role': 'generation', 'objectRef': {'id': spec_id}}}]}
    before = deepcopy(snapshot)
    monkeypatch.setenv('OPENDIRECTOR_AGENT_SOCKET', '/test-only.sock')
    client = cli.Client(None, 'http://localhost:18765', None, None)
    calls = []
    def call(name, arguments, **kwargs):
        calls.append(name)
        assert name == 'query'
        return job
    monkeypatch.setattr(client, 'call', call)
    monkeypatch.setattr(client, 'snapshot', lambda: snapshot)
    try:
        for _ in range(2):
            response = client.query('job.get', objectId=str(uuid4()))
            delivery = response['delivery']
            assert delivery['registered'] and delivery['asset'] == ref
            assert delivery['adopted'] == adopted
            assert [item['id'] for item in delivery['canvasItems']] == ([item_id] if adopted else [])
        assert snapshot == before
        assert calls == ['query', 'query']
        assert 'delivery' not in job
    finally:
        client.http.close()


def test_spec_uuid_override_reports_json_help_without_executing(monkeypatch, tmp_path):
    monkeypatch.setattr(cli.Client, 'execute', lambda *args, **kwargs: pytest.fail('Invalid input reached execution'))
    file = tmp_path / 'update.json'
    file.write_text(json.dumps({'type': 'generationSpec.update', 'payload': {'spec': {'id': str(uuid4())}}}))
    result = CliRunner().invoke(cli.app, ['generation-spec', 'update', '--file', str(file), '--spec', str(uuid4())])
    assert result.exit_code != 0
    message = str(result.exception)
    assert '--spec needs a complete JSON object' in message
    assert 'payload.spec.id' in message and 'omit --spec' in message


def test_partial_spec_update_reports_missing_fields_before_execution(monkeypatch):
    monkeypatch.setattr(cli.Client, 'execute', lambda *args, **kwargs: pytest.fail('Partial spec reached execution'))
    spec = {'id': str(uuid4()), 'projectId': str(uuid4()), 'revision': 1, 'kind': 'video',
            'parameters': {'aspectRatio': '1:1'}}
    result = CliRunner().invoke(cli.app, ['generation-spec', 'update', '--spec', json.dumps(spec)])
    assert result.exit_code != 0
    message = str(result.exception)
    for field in ('purpose', 'modelConfigId', 'prompt', 'promptContent', 'currentResultId'):
        assert 'payload.spec.' + field in message
    assert 'query object.get' in message and 'current expected version' in message


def test_asset_query_error_suggests_existing_queries(monkeypatch):
    monkeypatch.setattr(cli.Client, 'query', lambda *args, **kwargs: pytest.fail('Invalid query reached execution'))
    result = CliRunner().invoke(cli.app, ['query', 'asset', '--object-id', str(uuid4())])
    assert result.exit_code != 0
    assert 'query object.get' in str(result.exception)
    assert 'query asset.preview' in str(result.exception)


def test_full_spec_file_update_preserves_fields_and_rejects_stale_version(tmp_path, cli_api):
    runner = CliRunner()
    project, identity = str(uuid4()), str(uuid4())
    def invoke(args):
        return runner.invoke(cli.app, ['--project', project, *args])
    assert invoke(['project', 'create', '--name', 'Full spec update']).exit_code == 0
    spec = {'id': identity, 'projectId': project, 'revision': 1, 'kind': 'video', 'purpose': 'generation',
            'modelConfigId': None, 'prompt': 'Keep this prompt', 'promptContent': None,
            'currentResultId': None, 'parameters': {'durationSeconds': 5.0, 'resolution': '768P'}}
    result = invoke(['generation-spec', 'create', '--spec', json.dumps(spec)])
    assert result.exit_code == 0, result.output or str(result.exception)
    before = json.loads(invoke(['project', 'show']).output)['generationSpecs'][0]
    full = {**before, 'parameters': {**before['parameters'], 'aspectRatio': '1:1'}}
    file = tmp_path / 'update.json'
    file.write_text(json.dumps({'type': 'generationSpec.update', 'payload': {'spec': full},
        'expectedVersions': [{'objectType': 'generation_spec', 'id': identity, 'revision': before['revision']}]}))
    result = invoke(['generation-spec', 'update', '--file', str(file)])
    assert result.exit_code == 0, result.output or str(result.exception)
    after = json.loads(invoke(['project', 'show']).output)['generationSpecs'][0]
    assert after['prompt'] == before['prompt'] and after['modelConfigId'] == before['modelConfigId']
    assert after['parameters']['durationSeconds'] == 5.0 and after['parameters']['aspectRatio'] == '1:1'
    stale = invoke(['generation-spec', 'update', '--file', str(file)])
    assert stale.exit_code != 0
    assert json.loads(invoke(['project', 'show']).output)['generationSpecs'][0] == after


def test_spec_update_help_explains_replacement_and_json():
    result = CliRunner().invoke(cli.app, ['generation-spec', 'update', '--help'], terminal_width=200)
    assert result.exit_code == 0
    assert re.search(r'not a(?:\s|│)*spec ID', plain_help(result.output))
    assert 'Replace the complete generation configuration' in ' '.join(plain_help(result.output).split())


def test_timeline_default_font_is_offline_and_does_not_open_a_project(monkeypatch, tmp_path):
    from hashlib import sha256
    from opendirector import installation
    monkeypatch.setenv('OPENDIRECTOR_ROOT', str(tmp_path / 'unused'))
    def forbidden(*args, **kwargs):
        raise AssertionError('Read-only font discovery must not call the API')
    monkeypatch.setattr(cli.Client, 'request', forbidden)
    monkeypatch.setattr(cli.Client, 'call', forbidden)
    result = CliRunner().invoke(cli.app, ['timeline', 'default-font'])
    assert result.exit_code == 0, result.output
    value = json.loads(result.output)
    path = Path(value['path'])
    assert path == installation.default_timeline_font()
    assert value['version'] == '2.004'
    assert value['fingerprint'] == 'sha256:' + sha256(path.read_bytes()).hexdigest()
    assert not (tmp_path / 'unused').exists()


def wait_context(monkeypatch, states):
    """Record every server call job wait makes."""
    from types import SimpleNamespace
    calls = []
    states = list(states)

    def query(kind, **arguments):
        calls.append((kind, arguments))
        return states.pop(0) if len(states) > 1 else states[0]
    return SimpleNamespace(command_path="job wait", obj=SimpleNamespace(command="", query=query)), calls


TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}


def test_job_wait_covers_every_job_in_one_call_per_window(monkeypatch, capsys):
    jobs = [str(uuid4()), str(uuid4())]
    context, calls = wait_context(monkeypatch, [
        {"jobs": [{"id": jobs[0], "status": "running"}, {"id": jobs[1], "status": "queued"}]},
        {"jobs": [{"id": jobs[0], "status": "succeeded"}, {"id": jobs[1], "status": "succeeded"}]},
    ])
    cli.job_wait(context, [UUID(job) for job in jobs], False, 300)
    assert [kind for kind, _ in calls] == ["job.status", "job.status"]
    assert calls[0][1]["objectIds"] == jobs
    assert calls[0][1]["until"] == "all"
    assert calls[0][1]["waitSeconds"] == cli.WAIT_WINDOW
    emitted = json.loads(capsys.readouterr().out)
    assert emitted["completed"] == 2 and emitted["failed"] == 0


def test_job_wait_all_waits_for_unfinished_jobs_without_naming_ids(monkeypatch, capsys):
    job = str(uuid4())
    context, calls = wait_context(monkeypatch, [{"jobs": [{"id": job, "status": "succeeded"}]}])
    cli.job_wait(context, None, True, 30)
    assert calls[0][1]["objectIds"] == []
    assert json.loads(capsys.readouterr().out)["completed"] == 1


def test_job_wait_reports_a_failure_that_settles_while_it_waits(monkeypatch, capsys):
    jobs = [str(uuid4()), str(uuid4())]
    context, calls = wait_context(monkeypatch, [
        {"jobs": [{"id": jobs[0], "status": "running"}, {"id": jobs[1], "status": "running"}]},
        {"jobs": [{"id": jobs[0], "status": "succeeded"},
                  {"id": jobs[1], "status": "failed", "errorDetails": {"category": "provider"}}]},
    ])
    with pytest.raises(typer.Exit) as error:
        cli.job_wait(context, [UUID(job) for job in jobs], False, 300)
    assert error.value.exit_code == 1
    assert calls[1][1]["objectIds"] == jobs
    emitted = json.loads(capsys.readouterr().out)
    assert emitted["completed"] == 1 and emitted["failed"] == 1
    assert emitted["jobs"][1]["errorDetails"] == {"category": "provider"}
    assert "errorDetails" in emitted["note"]


def test_job_wait_says_so_when_nothing_is_running(monkeypatch, capsys):
    context, calls = wait_context(monkeypatch, [{"jobs": []}])
    cli.job_wait(context, None, True, 30)
    assert calls[0][1]["objectIds"] == []
    emitted = json.loads(capsys.readouterr().out)
    assert emitted["jobs"] == [] and emitted["completed"] == 0 and emitted["failed"] == 0
    assert "still running" in emitted["note"]


def test_a_wait_window_fits_the_agent_socket_timeout():
    """One wait window plus its snapshot read must answer before the read times out."""
    assert cli.WAIT_WINDOW + 60 <= cli.SOCKET_TIMEOUT
    assert cli.WAIT_WINDOW > 0


def test_job_wait_reports_failure_and_timeout_with_distinct_exit_codes(monkeypatch, capsys):
    job = str(uuid4())
    failed, _ = wait_context(monkeypatch, [{"jobs": [{"id": job, "status": "failed"}]}])
    with pytest.raises(typer.Exit) as error:
        cli.job_wait(failed, [UUID(job)], False, 30)
    assert error.value.exit_code == 1
    assert json.loads(capsys.readouterr().out)["failed"] == 1
    running, _ = wait_context(monkeypatch, [{"jobs": [{"id": job, "status": "running"}]}])
    with pytest.raises(typer.Exit) as error:
        cli.job_wait(running, [UUID(job)], False, 0)
    assert error.value.exit_code == 2
    assert json.loads(capsys.readouterr().out)["timeout"] is True


def test_project_show_summary_keeps_every_identity_without_record_bodies(monkeypatch, capsys):
    from types import SimpleNamespace
    def asset(index):
        return {"id": str(uuid4()), "revision": 1, "kind": "image", "name": f"asset-{index}",
                "metadata": {"width": 2048, "height": 2048, "durationSeconds": None},
                "fingerprint": "sha256:" + "a" * 64, "provenance": {"prompt": "x" * 4096}, "source": {"path": "/tmp/asset.png"}}
    snapshot = {"project": {"id": str(uuid4()), "name": "Demo", "revision": 7},
                "assets": [asset(index) for index in range(40)],
                "canvasItems": [{"id": str(uuid4()), "revision": 2, "kind": "image", "visible": True,
                                 "position": {"x": 0, "y": 0}, "width": 352, "height": 198,
                                 "binding": {"role": "generation", "objectRef": {"id": str(uuid4())}}}],
                "generationSpecs": [{"id": str(uuid4()), "revision": 3, "purpose": "generation",
                                     "modelConfigId": str(uuid4()), "currentResultId": None}],
                "jobs": [{"id": str(uuid4()), "revision": 2, "status": "succeeded", "phase": "complete"}],
                "results": [{"id": str(uuid4()), "jobId": str(uuid4()), "asset": {"assetId": str(uuid4())}}],
                "references": [], "editorDocuments": []}
    context = SimpleNamespace(command_path="project show", obj=SimpleNamespace(command="", snapshot=lambda: snapshot))
    cli.project_show(context, True)
    summary = json.loads(capsys.readouterr().out)
    assert len(summary["assets"]) == 40 and summary["assets"][0]["width"] == 2048
    assert summary["project"]["revision"] == 7
    assert summary["counts"]["assets"] == 40
    assert "fingerprint" not in summary["assets"][0] and "provenance" not in summary["assets"][0]
    assert len(json.dumps(summary)) * 4 < len(json.dumps(snapshot))


def test_project_show_summary_keeps_reference_and_editor_identities(monkeypatch, capsys):
    """reference.update and editor.save take these IDs, so the summary must carry them."""
    from types import SimpleNamespace
    reference, document = str(uuid4()), str(uuid4())
    snapshot = {"project": {"id": str(uuid4()), "name": "Demo", "revision": 7},
                "references": [{"id": reference, "revision": 4, "targetSpecId": str(uuid4()),
                                 "binding": "pinned", "role": "first_frame", "order": 2, "active": True,
                                 "source": {"assetId": str(uuid4()), "fingerprint": "sha256:" + "b" * 64}}],
                "editorDocuments": [{"id": document, "revision": 9, "kind": "timeline", "title": "Main",
                                      "data": {"tracks": [1, 2, 3]}}]}
    context = SimpleNamespace(command_path="project show", obj=SimpleNamespace(command="", snapshot=lambda: snapshot))
    cli.project_show(context, True)
    summary = json.loads(capsys.readouterr().out)
    assert summary["references"] == [{"id": reference, "revision": 4, "targetSpecId": snapshot["references"][0]["targetSpecId"],
                                      "binding": "pinned", "role": "first_frame", "order": 2, "active": True}]
    assert summary["editorDocuments"] == [{"id": document, "revision": 9, "kind": "timeline", "title": "Main"}]
    assert summary["counts"]["references"] == 1 and summary["counts"]["editorDocuments"] == 1


def test_capabilities_lists_commands_and_query_types_once(help_color):
    result = CliRunner().invoke(cli.app, ["capabilities", "--compact"])
    assert result.exit_code == 0, result.output
    digest = json.loads(result.output)
    kinds = {entry["type"]: entry for entry in digest["commands"] if entry.get("type")}
    assert {"generation.submit", "canvas.createGeneration", "generationSpec.update", "job.cancel"} <= set(kinds)
    assert all(entry["summary"] and entry["command"].strip() == entry["command"] for entry in digest["commands"])
    assert kinds["canvas.show"]["required"] == ["item"]
    assert kinds["generation.submit"]["required"] == ["expectedSpecRevision", "specId"]
    assert "fields" not in kinds["generation.submit"]
    assert {"job.status", "job.get", "canvas.status"} <= set(digest["queries"])
    assert digest["wait"] == "opendirector job wait --all"
    assert "opendirector --help" not in result.output


def test_capabilities_names_commands_that_have_no_command_model(help_color):
    """Discovery must cover the parser, not only commands built from a model."""
    result = CliRunner().invoke(cli.app, ["capabilities", "--compact"])
    assert result.exit_code == 0, result.output
    listed = {entry["command"]: entry for entry in json.loads(result.output)["commands"]}
    assert {"job wait", "job show", "project show", "query", "model list", "model show",
            "model availability", "asset import", "video create", "canvas add-material",
            "canvas text create", "timeline import", "timeline export", "timeline default-font",
            "voice list", "voice create", "voice delete"} <= set(listed)
    assert listed["canvas add-material"]["required"] == ["asset", "x", "y"]
    assert listed["job show"]["required"] == ["job_id"]
    assert "options" not in listed["job show"]
    detailed = json.loads(CliRunner().invoke(cli.app, ["capabilities"]).output)["commands"]
    assert "--asset-id" not in [option.split()[-1] for entry in detailed for option in entry.get("options", ())]
    assert "--object-id" in [option for entry in detailed for option in entry.get("options", ())]


def test_command_file_without_payload_envelope_fails_locally_without_executing(monkeypatch):
    monkeypatch.setattr(cli.Client, "execute", lambda *args, **kwargs: pytest.fail("Unwrapped --file reached execution"))
    result = CliRunner().invoke(
        cli.app,
        ["--operation-id", str(uuid4()), "canvas", "create-generation", "--file", "-"],
        input=json.dumps({"spec": {"id": str(uuid4())}, "item": {"id": str(uuid4())}}),
    )
    assert result.exit_code != 0
    assert "Unexpected top-level field(s) in --file: item, spec" in str(result.exception)
    assert '"payload"' in str(result.exception)
