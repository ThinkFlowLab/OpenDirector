import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.agent import native
from opendirector.agent.skills import skills
from opendirector.agent.runtime import AgentRuntimes
from opendirector.agent.context import RunContext
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.chat_completions import ChatCompletions
from opendirector_api.main import create_app

FAKE = '''import json, os, subprocess, sys
from pathlib import Path
prompt = sys.stdin.read()
assert 'Segment plan' not in prompt
if 'Continue plan' in prompt:
 assert 'Save a plan' not in prompt
 runtime = os.environ['TEST_RUNTIME']
 resume_args = {'codex': ['resume', 'test-native', '-'], 'claude': ['--resume', 'test-native']}
 assert sys.argv[2:] == resume_args.get(runtime, ['--session', 'test-native'])
workspace_marker = Path('.continuation-test')
if 'Continue plan' in prompt:
 assert workspace_marker.read_text() == str(Path.cwd())
else:
 workspace_marker.write_text(str(Path.cwd()))
assert list(Path('.agents/skills').glob('*/SKILL.md'))
assert str(Path.cwd()) in prompt
subprocess.run(['sh', '-c', 'printf \"native execution works\" > environment-check.txt'], check=True)
cli = [sys.executable, os.environ['OD']]
def invoke(*arguments):
 response = subprocess.check_output([*cli, *arguments], text=True)
 return json.loads(response)
assert 'project' in subprocess.check_output([*cli, '--help'], text=True)
assert 'Asset ID' in subprocess.check_output([*cli, 'asset', 'write-text', '--help'], text=True) or 'name' in subprocess.check_output([*cli, 'asset', 'write-text', '--help'], text=True)
payload = '{"name":"native.md","text":"Native plan"}'
operation = '00000000-0000-0000-0000-000000000003'
result = invoke('--operation-id', operation, 'asset', 'write-text', '--name', 'native.md', '--text', 'Native plan')
assert result['status'] == 'applied', result
assert invoke('--operation-id', operation, 'asset', 'write-text', '--name', 'native.md', '--text', 'Native plan') == result
preview = invoke('query', 'asset.preview', '--object-id', '00000000-0000-0000-0000-000000000001')
assert preview['preview']['mimeType'] == 'image/webp', preview
runtime = os.environ['TEST_RUNTIME']
if runtime == 'codex':
 print(json.dumps({'type':'thread.started','thread_id':'test-native'}))
 print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Native saved.'}}))
elif runtime == 'claude':
 print(json.dumps({'type':'assistant','session_id':'test-native','message':{'content':[{'type':'text','text':'Native saved.'}]}}))
else:
 print(json.dumps({'type':'text','sessionID':'test-native','part':{'text':'Native saved.'}}))
'''


@pytest.fixture(autouse=True)
def example_skill(tmp_path):
    directory = tmp_path / '.opendirector/skills/character-replacement'
    directory.mkdir(parents=True)
    (directory / 'SKILL.md').write_text('---\nname: character-replacement\ndescription: Test replacement planning\n---\nCreate a 24-FPS constant-frame-rate working copy')


def project(client):
    pid = str(uuid4())
    path = f'/api/creation/projects/{pid}'
    assert client.post(path + '/commands', json={'type':'project.create', 'projectId':pid,
        'commandId':str(uuid4()), 'payload':{'name':'Native runtime'}}).status_code == 200
    assert client.post(path + '/open').status_code == 200
    return path




def test_cli_bridge_preserves_utf8_with_legacy_stdio_encoding():
    response = {'name': '场景𠮷'}
    with socket.socket() as listener, ThreadPoolExecutor() as pool:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        listener.settimeout(5)
        def respond():
            with listener.accept()[0] as connection, connection.makefile('rb') as stream:
                request = json.loads(stream.readline())
                assert request['arguments'] == {'type': 'asset.search', 'text': '场景𠮷'}
                assert 'token' not in request
                connection.sendall((json.dumps({'value': response}, ensure_ascii=False) + '\n').encode())
        server = pool.submit(respond)
        script = ('import json; from opendirector.cli import Client; '
                  'c=Client(None,"http://localhost:1",None,None); '
                  'print(json.dumps(c.query("asset.search",text="\u573a\u666f\U00020bb7"))); c.http.close()')
        result = subprocess.run([sys.executable, '-c', script], env={**os.environ,
            'PYTHONIOENCODING': 'cp936', 'OPENDIRECTOR_AGENT_HOST': '127.0.0.1',
            'OPENDIRECTOR_AGENT_PORT': str(listener.getsockname()[1])},
            capture_output=True, check=True, timeout=10)
        server.result()
        assert json.loads(result.stdout) == response


@pytest.mark.parametrize('runtime', ['default', 'opencode', 'codex', 'claude'])
def test_native_events_real_cli_and_shared_write(tmp_path, monkeypatch, runtime):
    local = LocalProjects(tmp_path)
    config = ModelConfigs(tmp_path).save('agent','http://localhost:9999/v1','test','',auth_mode='none')
    script = tmp_path / 'fake_cli.py'
    script.write_text(FAKE)
    preview = tmp_path / 'preview.webp'
    preview.write_bytes(b'preview')
    monkeypatch.setattr(CreationAssets, 'preview', lambda self, project_id, asset_id, target:
        {'preview': {'path': str(preview), 'mimeType': 'image/webp'}})
    def command(kind, work, socket, token, model, model_url, catalog, **kwargs):
        return [sys.executable, str(script), "--"], {**os.environ, 'TEST_RUNTIME':kind,
            'OPENDIRECTOR_AGENT_SOCKET':socket,
            'OD':str(native.ROOT / 'scripts/opendirector.py')}
    monkeypatch.setattr(native, 'command', command)
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)
    async def fixture_skills(*args):
        entry = tmp_path / '.opendirector/skills/character-replacement/SKILL.md'
        return [{'name': 'character-replacement', 'description': 'Test', 'filePath': str(entry)}]
    monkeypatch.setattr('opendirector_api.agent.skills', fixture_skills)
    with TestClient(create_app(local), headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        path = project(client)
        turn = {'id':str(uuid4()),'runtime':runtime,'runtimeModel':'test-model','text':'Save a plan','skills':['character-replacement']}
        if runtime == 'default':
            turn['modelId'] = config['id']
        response = client.post(path + '/assistant/turns', json=turn)
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['error'] is None, events
        assert events[-1]['conversation']['messages'][-1]['text'] == 'Native saved.'
        snapshot = client.get(path).json()
        assert len(snapshot['assets']) == 1
        activity = next(tool for tool in events[-1]['conversation']['messages'][-1]['tools']
                        if tool['name'] == 'opendirector asset write-text')
        assert activity['arguments']['type'] == 'asset.writeText'
        assert json.loads(activity['result'])['status'] == 'applied'
        assert activity['resultTruncated'] is False
        provenance = snapshot['assets'][0]['provenance']
        assert provenance['agentRunId'] == turn['id']
        if runtime != 'default':
            assert provenance['agentRuntime'] == runtime
            assert provenance['modelSnapshot'] is None
        assert client.get(path + '/changes').json()['events'][-1]['source'] == 'agent'
        trace = next(local.root.rglob(f'*.{"opencode" if runtime == "default" else runtime}.jsonl')).read_text()
        assert 'test-native' in trace
        assert 'Native saved.' in trace
        work = next(local.root.rglob(f'agent-runs/{turn["id"]}/work'))
        assert work.is_dir()
        assert (work / 'environment-check.txt').read_text() == 'native execution works'
        response = client.post(path + '/assistant/turns', json={**turn, 'id': str(uuid4()), 'text': 'Continue plan'})
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['error'] is None, events



def test_native_commands_keep_auth_and_restrict_tools(tmp_path, monkeypatch):
    monkeypatch.setattr(native, "executable", lambda _: sys.executable)
    monkeypatch.setattr(native, 'codex_isolation_flags', lambda _: ('--ignore-user-config', '--ignore-rules', '--ephemeral'))
    for runtime in ('default', 'opencode', 'codex', 'claude'):
        work = tmp_path / runtime
        work.mkdir()
        args, env = native.command(runtime, work, '/tmp/test.sock', 'private-token', 'test-model', 'http://localhost:1', [])
        assert 'private-token' not in ' '.join(args) if runtime == 'opencode' else True
        if runtime == 'codex':
            assert '--ignore-user-config' in args
            assert 'features.shell_tool=true' in args
            assert args[args.index('--sandbox') + 1] == 'workspace-write'
            assert not any('mcp_servers.' in item for item in args)
            assert '--dangerously-bypass-approvals-and-sandbox' not in args
        elif runtime == 'claude':
            assert '--max-turns' not in args
            assert args[args.index('--tools') + 1] == 'Skill,Bash,Read'
            assert '--dangerously-skip-permissions' not in args
        else:
            config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
            assert 'steps' not in config['agent']['opendirector']
            assert config['permission']['*'] == 'deny'
            assert config['skills']['paths'] == [str(work / '.agents/skills')]


def test_codex_only_passes_supported_isolation_flags(tmp_path, monkeypatch):
    binary = str(tmp_path / 'codex')
    monkeypatch.setattr(native, 'executable', lambda _: binary)
    monkeypatch.setattr(native, '_CODEX_ISOLATION', {})
    monkeypatch.setattr(native.subprocess, 'run', lambda *args, **kwargs:
        SimpleNamespace(stdout=b'Options:\n      --ephemeral\n', stderr=b''))
    args, _ = native.command('codex', tmp_path, '', 'token', None, '', [])
    assert '--ephemeral' in args
    assert '--ignore-user-config' not in args
    assert '--ignore-rules' not in args


def test_codex_inherits_windows_system_proxy_without_overriding_explicit_proxy(monkeypatch):
    monkeypatch.setattr(native, 'sys', SimpleNamespace(platform='win32'))
    monkeypatch.setattr(native, 'getproxies', lambda: {'https': 'http://127.0.0.1:8001'})
    monkeypatch.delenv('HTTPS_PROXY', raising=False)
    monkeypatch.delenv('ALL_PROXY', raising=False)
    assert native.codex_environment()['HTTPS_PROXY'] == 'http://127.0.0.1:8001'
    assert 'HTTPS_PROXY' not in os.environ
    monkeypatch.setenv('HTTPS_PROXY', 'http://127.0.0.1:8002')
    assert native.codex_environment()['HTTPS_PROXY'] == 'http://127.0.0.1:8002'


def test_codex_reconnect_does_not_end_turn():
    assert native.text_events('codex', {'type': 'error', 'message': 'Reconnecting...'}) == []
    assert native.text_events('codex', {'type': 'item.completed', 'item': {
        'type': 'agent_message', 'text': 'Connected'}}) == [{'type': 'delta', 'text': 'Connected'}]
    with pytest.raises(ProjectError):
        native.text_events('codex', {'type': 'turn.failed'})


@pytest.mark.parametrize("runtime", ["default"])
@pytest.mark.parametrize("resume", [False, True])
def test_real_opencode_native_skill_and_gateway_write(tmp_path, runtime, resume):
    if native.executable('default') is None:
        pytest.skip('Bundled OpenCode is not installed')
    requests = []
    def model(request):
        payload = json.loads(request.content)
        if payload.get('tools'):
            requests.append(payload)
        assert request.headers['authorization'] == 'Bearer server-only-key'
        count = len(requests)
        if not payload.get('tools'):
            call = None
        elif count == 1:
            assert any(tool['function']['name'] == 'skill' for tool in payload['tools'])
            call = {'name':'skill','arguments':json.dumps({'name':'character-replacement'})}
        elif count == 2:
            assert 'Create a 24-FPS constant-frame-rate working copy' in json.dumps(payload['messages'])
            assert not any('opendirector_' in tool['function']['name'] for tool in payload['tools'])
            call = {'name': 'bash', 'arguments': json.dumps({
                'command': "opendirector asset write-text --name real-native.md --text 'Real OpenCode plan'",
                'description': 'Register the plan in the project'})}
        else:
            call = None
        delta = {'tool_calls':[{'index':0,'id':f'call-{count}','type':'function','function':call}]} if call else {'content':'OpenCode ready.'}
        chunk = {'id':f'completion-{count}','object':'chat.completion.chunk','created':1,'model':'test-model',
            'choices':[{'index':0,'delta':delta,'finish_reason':None}]}
        finish = {**chunk,'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls' if call else 'stop'}]}
        return httpx.Response(200,headers={'content-type':'text/event-stream'},content=(
            'data: '+json.dumps(chunk)+'\n\ndata: '+json.dumps(finish)+'\n\ndata: [DONE]\n\n').encode())
    local = LocalProjects(tmp_path)
    config = ModelConfigs(tmp_path).save('agent','http://test.invalid/v1','test-model','server-only-key')
    provider = ChatCompletions(httpx.MockTransport(model))
    with TestClient(create_app(local, chat_provider=provider), headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        path = project(client)
        catalog = client.get(path + '/assistant/skills').json()
        assert {item['name'] for item in catalog} == {'character-replacement'}
        assert all(set(item) == {'name', 'description', 'source'} for item in catalog)
        assert client.put(path + '/assistant/draft', json={'draft': 'Save a plan', 'skills': ['character-replacement'],
            'harnessModels': {'codex': 'test-model'}}).status_code == 200
        turn = {'id':str(uuid4()), 'modelId':config['id'], 'runtime':runtime,
            'text':'Use the skill and save a plan.', 'skills':['character-replacement']}
        response = client.post(path + '/assistant/turns', json=turn)
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['error'] is None, events
        assert events[-1]['conversation']['messages'][-1]['text'] == 'OpenCode ready.'
        assert client.get(path).json()['assets'][0]['name'] == 'real-native.md'
        assert len(requests) == 3
        saved = client.get(path + '/assistant').json()
        assert saved['skills'] == []
        assert saved['harnessModels'] == {'codex': 'test-model'}
        assert len(saved['messages']) == 2
        assert '已接受' in client.post(path + '/assistant/turns', json=turn).text
        assert len(client.get(path).json()['assets']) == 1
        assert len(requests) == 3
        assert 'server-only-key' not in next(local.root.rglob('*.opencode.jsonl')).read_text()
        if not resume:
            return
        response = client.post(path + '/assistant/turns', json={**turn, 'id': str(uuid4()), 'text': 'Continue the plan.'})
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['error'] is None, events
        assert len(requests) == 4
        messages = requests[-1]['messages']
        assert 'OpenCode ready.' in json.dumps(messages[:-1])
        assert 'Continue the plan.' in json.dumps(messages[-1])
        assert 'Use the skill and save a plan.' not in json.dumps(messages[-1])



@pytest.mark.parametrize('runtime', ['default', 'opencode', 'codex', 'claude'])
def test_cancel_native_process_group(tmp_path, monkeypatch, runtime):
    import signal
    async def check():
        script = tmp_path / 'wait.py'
        marker = tmp_path / 'pid.txt'
        script.write_text('import os,sys,time\nfrom pathlib import Path\nPath(sys.argv[1]).write_text(str(os.getpid()))\nsys.stdin.read()\ntime.sleep(60)\n')
        def command(*args, **kwargs):
            return [sys.executable, str(script), str(marker)], dict(os.environ)
        monkeypatch.setattr(native, 'command', command)
        local = LocalProjects(tmp_path)
        from opendirector.infrastructure.creation_projects import CreationProjects
        instance = AgentRuntimes(CreationProjects(local), None, ModelConfigs(tmp_path))
        async def consume():
            async for _ in instance.stream(RunContext(runtime=runtime, project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
                    runtime_model='test-model', directory=tmp_path, config={'modelId':'test', 'apiKey':'', 'url':'http://localhost/v1', 'protocol':'openai'}, messages=[{'role':'user','content':'wait'}], selected_skills=[])):
                pass
        task = asyncio.create_task(consume())
        async with asyncio.timeout(10):
            while not marker.exists():
                await asyncio.sleep(.02)
        pid = int(marker.read_text())
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    asyncio.run(check())


def test_rejects_removed_runtime_and_invalid_selection_before_acceptance(tmp_path):
    local = LocalProjects(tmp_path)
    config = ModelConfigs(tmp_path).save('agent','http://127.0.0.1:1/v1','test','',auth_mode='none')
    with TestClient(create_app(local), headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        path = project(client)
        turn = {'id':str(uuid4()), 'modelId':config['id'], 'text':'hello', 'runtime':'pi'}
        assert client.post(path + '/assistant/turns', json=turn).status_code == 422
        turn.update(runtime='default', skills=['missing'])
        assert client.post(path + '/assistant/turns', json=turn).status_code == 409
        turn.update(skills=[], assets=[str(uuid4())])
        assert client.post(path + '/assistant/turns', json=turn).status_code == 409
        assert client.get(path + '/assistant').json()['messages'] == []
        assert 'pi' not in [item['id'] for item in client.get(path + '/assistant/runtimes').json()]


def test_bundled_model_declares_configured_inputs_without_changing_cli_provider(tmp_path, monkeypatch):
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)
    _, env = native.command('default', tmp_path, '/tmp/socket', 'token', 'vision-agent',
        'http://127.0.0.1:1/v1', [], input_modalities=['text', 'image'])
    config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
    assert config['provider']['opendirector']['models']['vision-agent']['modalities'] == {
        'input': ['text', 'image'], 'output': ['text']}


def test_bundled_launch_reports_incomplete_install(tmp_path, monkeypatch):
    from opendirector.domain.projects import ProjectError
    from opendirector.infrastructure.creation_projects import CreationProjects

    binary = tmp_path / 'opencode.exe'
    binary.write_text('echo "postinstall was not run"\nexit 1\n')
    binary.chmod(0o755)
    monkeypatch.setattr(native, 'executable', lambda _: str(binary))
    instance = AgentRuntimes(CreationProjects(LocalProjects(tmp_path)), None, ModelConfigs(tmp_path))
    async def check():
        with pytest.raises(ProjectError, match='内置 Agent 依赖安装不完整') as caught:
            async for _ in instance.stream(RunContext(runtime='default', project_id=uuid4(),
                    turn_id=uuid4(), session=str(uuid4()), directory=tmp_path,
                    config={'modelId': 'test', 'apiKey': '', 'url': 'http://localhost/v1', 'protocol': 'openai'},
                    messages=[{'role': 'user', 'content': 'hello'}], selected_skills=[])):
                pass
        assert caught.value.code == 'agent_dependency_unavailable'
        assert caught.value.status == 503
    asyncio.run(check())
