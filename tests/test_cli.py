"""CLI entry points against the real API and persistent project store."""
import json
import re
from pathlib import Path
import shlex
import subprocess
import sys
from unittest.mock import Mock
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest
from typer.testing import CliRunner

from opendirector import cli
from opendirector.application.voice_library import VoiceLibrary
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app


@pytest.mark.parametrize('live', [False, True], ids=['http', 'agent'])
@pytest.mark.parametrize('options,expected', [
    ([], {}),
    (['--page-size', '150'], {'pageSize': 150}),
    (['--page-size', '45', '--after', 'opaque+/=', '--connection', 'scope'],
     {'pageSize': 45, 'after': 'opaque+/=', 'connectionId': 'scope'}),
])
def test_voice_list_forwards_pagination(live, options, expected, monkeypatch):
    model = str(uuid4())
    client = Mock(live=live, opened=False)
    page = {'voices': [], 'connectionId': 'scope', 'nextCursor': 'next'}
    client.call.return_value = client.request.return_value = page
    monkeypatch.setattr(cli, 'Client', lambda *args: client)
    result = CliRunner().invoke(cli.app, ['voice', 'list', '--model', model, *options])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == page
    arguments = {'modelConfigId': model, **expected}
    if live:
        client.call.assert_called_once_with('voice_list', arguments)
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
    client = Mock(live=True, opened=False)
    client.call.return_value = {'voiceId': 'confirmed-voice'}
    monkeypatch.setattr(cli, 'Client', lambda *args: client)
    result = CliRunner().invoke(cli.app, ['voice', 'create', str(recording), '--model', model,
        '--connection', 'scope', '--name', 'Voice'])
    assert result.exit_code == 0, result.exception
    client.call.assert_called_once_with('voice_create', {'modelConfigId': model, 'connectionId': 'scope',
                                                       'name': 'Voice', 'path': str(recording.resolve())})
    client.request.assert_not_called()


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


def test_cli_repeated_trash_reports_the_missing_project(tmp_path, monkeypatch):
    """An accepted trash stores no receipt, so the same commandId is a 404.

    The workspace maps that 404 to success. The CLI reports it: the id may
    simply be wrong, and there is no stored receipt to replay.
    """
    api = TestClient(create_app(LocalProjects(tmp_path)), headers={"X-OpenDirector-Request": "1"})
    original_client = httpx.Client

    def forward(request):
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
    assert "not_found" in str(repeated.exception)


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
        assert len(commands) == 2
        for job_id, command in zip(jobs, commands):
            assert shlex.split(command) == ["opendirector", "--url", "http://localhost:18765",
                "--project", project, "job", "wait", job_id, "--timeout", "60"]
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


def test_full_spec_file_update_preserves_fields_and_rejects_stale_version(tmp_path, monkeypatch):
    api = TestClient(create_app(LocalProjects(tmp_path)), headers={'X-OpenDirector-Request': '1'})
    original_client = httpx.Client
    def forward(request):
        response = api.request(request.method, request.url.path, headers=dict(request.headers), content=request.read())
        return httpx.Response(response.status_code, headers=response.headers, content=response.content)
    monkeypatch.setattr(cli.httpx, 'Client', lambda **kwargs:
        original_client(**kwargs, transport=httpx.MockTransport(forward)))
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
    assert 'not a spec ID' in result.output
    assert 'Replace the complete generation configuration' in ' '.join(result.output.split())
