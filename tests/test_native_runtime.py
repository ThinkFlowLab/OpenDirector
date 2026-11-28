import asyncio
from concurrent.futures import ThreadPoolExecutor
import faulthandler
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
import httpx
import pytest
from process_helpers import assert_process_exited, python_cli

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

# Includes subprocess/gateway integration; retain the dedicated mocked-model
# bundled CLI regression in Release checks independently of layer selection.
pytestmark = [pytest.mark.cpu, pytest.mark.merge]

FAKE = '''import json, os, subprocess, sys
from pathlib import Path
prompt = sys.stdin.read()
assert '3 to 5 distinct suggestions' in prompt, 'missing suggested reply count'
assert 'at most 80 characters per suggestion' in prompt, 'missing suggested reply length limit'
assert '[opendirector-replies]: #' in prompt.splitlines(), 'missing suggested reply marker'
assert 'Segment plan' not in prompt
if 'Continue plan' in prompt:
 assert ('Save a plan' in prompt) == (os.environ.get('TEST_MISSING_ROLLOUT') == '1')
 runtime = os.environ['TEST_RUNTIME']
 resume_args = {'codex': ['resume', 'test-native', '-'], 'claude': ['--resume', 'test-native']}
 assert sys.argv[2:] == ([] if os.environ.get('TEST_MISSING_ROLLOUT') == '1' else resume_args.get(runtime, ['--session', 'test-native']))
workspace_marker = Path('.continuation-test')
if 'Continue plan' in prompt:
 assert workspace_marker.read_text() == str(Path.cwd())
else:
 workspace_marker.write_text(str(Path.cwd()))
work = Path(prompt.split('Execution directory: ', 1)[1].split(chr(10), 1)[0])
assert list((work / '.agents/skills').glob('*/SKILL.md'))
subprocess.run([sys.executable, '-c', 'from pathlib import Path; Path("environment-check.txt").write_text("native execution works")'], cwd=work, check=True)
cli = [sys.executable, '-m', 'opendirector.cli']
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
    directory = tmp_path / '.opendirector/skills/od-native-runtime-test-skill'
    directory.mkdir(parents=True)
    (directory / 'SKILL.md').write_text('---\nname: od-native-runtime-test-skill\ndescription: Test replacement planning\n---\nCreate a 24-FPS constant-frame-rate working copy')


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
@pytest.mark.parametrize("missing_rollout", [False, True])
def test_native_events_real_cli_and_shared_write(tmp_path, monkeypatch, runtime, missing_rollout):
    missing_rollout = missing_rollout and runtime == "codex"
    monkeypatch.setattr(native, "codex_session_available", lambda _: not missing_rollout)
    monkeypatch.setenv("TEST_MISSING_ROLLOUT", "1" if missing_rollout else "0")
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
            'PWD':str(kwargs.get('native_directory') or work), **(kwargs.get('bridge_env') or {'OPENDIRECTOR_AGENT_SOCKET':socket})}
    monkeypatch.setattr(native, 'command', command)
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)
    async def fixture_skills(*args):
        entry = tmp_path / '.opendirector/skills/od-native-runtime-test-skill/SKILL.md'
        return [{'name': 'od-native-runtime-test-skill', 'description': 'Test', 'filePath': str(entry)}]
    monkeypatch.setattr('opendirector_api.agent.skills', fixture_skills)
    with TestClient(create_app(local), headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        path = project(client)
        turn = {'id':str(uuid4()),'runtime':runtime,'runtimeModel':'test-model','text':'Save a plan','skills':['od-native-runtime-test-skill']}
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
        if runtime in {'default', 'opencode'}:
            saved_session = next(local.root.rglob(f'{runtime}-sessions/*/session.json'))
            saved = json.loads(saved_session.read_text())
            assert saved['sessionId'] == 'test-native' and saved['directory'] == str(work)
        workspaces = list(local.root.rglob('agent-runs/*/work'))
        assert len(workspaces) == (1 if runtime in {'codex', 'claude'} else 2)
        assert all((directory / 'environment-check.txt').read_text() == 'native execution works' for directory in workspaces)



def test_claude_continuation_refreshes_skills_using_real_command(tmp_path, monkeypatch):
    script = python_cli(tmp_path / 'claude fixture', '''import json,sys
from pathlib import Path
prompt = sys.stdin.read()
marker = Path('first-turn.txt')
skill = Path('plugin/skills/od-native-runtime-test-skill/SKILL.md').read_text()
if marker.exists():
 assert sys.argv[sys.argv.index('--resume') + 1] == 'fixture-session'
 assert marker.read_text() == str(Path.cwd())
 assert 'second skill version' in skill
else:
 assert '--resume' not in sys.argv
 assert 'first skill version' in skill
 marker.write_text(str(Path.cwd()))
print(json.dumps({'type':'assistant','session_id':'fixture-session',
 'message':{'content':[{'type':'text','text':'completed'}]}}),flush=True)
''')
    monkeypatch.setattr(native, 'executable', lambda _: str(script))
    directory = tmp_path / 'project'; directory.mkdir()
    entry = tmp_path / '.opendirector/skills/od-native-runtime-test-skill/SKILL.md'
    common = dict(runtime='claude', project_id=uuid4(), session=str(uuid4()),
        conversation_id=uuid4(), directory=directory, config=None, selected_skills=[],
        skills=[{'name': 'od-native-runtime-test-skill', 'filePath': str(entry)}])
    async def closed(): pass
    async def exercise():
        records = []
        messages = []
        for version in ['first', 'second']:
            entry.write_text(version + ' skill version', encoding='utf-8')
            messages.append({'role': 'user', 'content': version})
            run = RunContext(**common, turn_id=uuid4(), messages=list(messages))
            gateway = SimpleNamespace(close=closed)
            events = [event async for event in native.NativeRuntime().stream(run, gateway)]
            assert events == [{'type': 'delta', 'text': 'completed'}]
            records.append(json.loads((run.native_session_path() / 'session.json').read_text()))
            messages.append({'role': 'assistant', 'content': 'completed'})
        assert records[0]['sessionId'] == records[1]['sessionId'] == 'fixture-session'
        assert records[0]['directory'] == records[1]['directory']
        workspaces = list(directory.glob('agent-runs/*/work'))
        assert len(workspaces) == 1
        assert (workspaces[0] / 'plugin/skills/od-native-runtime-test-skill/SKILL.md').read_text() == 'second skill version'
    asyncio.run(exercise())


def test_claude_skill_alias_refuses_to_replace_a_real_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)
    occupied = tmp_path / 'plugin/skills'; occupied.mkdir(parents=True)
    sentinel = occupied / 'keep.txt'; sentinel.write_text('keep')
    with pytest.raises(FileExistsError):
        native.command('claude', tmp_path, 'socket', 'token', None, '', [])
    assert sentinel.read_text() == 'keep'


def test_native_commands_keep_auth_and_restrict_tools(tmp_path, monkeypatch):
    monkeypatch.setattr(native, "executable", lambda _: sys.executable)
    monkeypatch.setattr(native, 'codex_isolation_flags', lambda _: ('--ignore-user-config', '--ignore-rules'))
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
            assert config['permission']['read'] == 'allow'
            assert config['skills']['paths'] == [str(work / '.agents/skills')]
            if runtime == 'default':
                assert config['agent']['title'] == {'disable': True}
            else:
                assert 'title' not in config['agent']


def test_codex_windows_launch_uses_standalone_sandbox_and_keeps_project_bridge(tmp_path, monkeypatch):
    monkeypatch.setattr(native.sys, 'platform', 'win32')
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)
    monkeypatch.setattr(native, 'codex_isolation_flags', lambda _: ())
    monkeypatch.setenv('CODEX_WINDOWS_REGISTERED_CORE', '1')
    monkeypatch.setenv('CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY', 'DesktopRegistration')
    monkeypatch.setenv('HTTPS_PROXY', 'http://127.0.0.1:1080')
    bridge = {'OPENDIRECTOR_AGENT_HOST': '127.0.0.1', 'OPENDIRECTOR_AGENT_PORT': '8001'}

    args, env = native.command('codex', tmp_path, '', 'token', None, '', [], bridge_env=bridge)

    assert 'CODEX_WINDOWS_REGISTERED_CORE' not in env
    assert 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY' not in env
    assert os.environ['CODEX_WINDOWS_REGISTERED_CORE'] == '1'
    assert env['HTTPS_PROXY'] == 'http://127.0.0.1:1080'
    assert all(env[key] == value for key, value in bridge.items())
    assert Path(env['PATH'].split(os.pathsep)[0]) == tmp_path / '.opendirector-bin'
    assert args[args.index('--sandbox') + 1] == 'workspace-write'
    assert 'windows.sandbox="elevated"' in args


def test_codex_only_passes_supported_isolation_flags(tmp_path, monkeypatch):
    binary = str(tmp_path / 'codex')
    monkeypatch.setattr(native, 'executable', lambda _: binary)
    monkeypatch.setattr(native, '_CODEX_ISOLATION', {})
    monkeypatch.setattr(native.subprocess, 'run', lambda *args, **kwargs:
        SimpleNamespace(stdout=b'Options:\n      --ephemeral\n      --ignore-user-config\n      --ignore-rules\n', stderr=b''))
    args, _ = native.command('codex', tmp_path, '', 'token', None, '', [])
    assert '--ephemeral' not in args
    assert '--ignore-user-config' in args
    assert '--ignore-rules' in args


def test_codex_inherits_windows_system_proxy_without_overriding_explicit_proxy(monkeypatch):
    monkeypatch.setattr(native, 'sys', SimpleNamespace(platform='win32'))
    monkeypatch.setattr(native, 'getproxies', lambda: {'https': 'http://127.0.0.1:8001'})
    monkeypatch.delenv('HTTPS_PROXY', raising=False)
    monkeypatch.delenv('ALL_PROXY', raising=False)
    assert native.codex_environment()['HTTPS_PROXY'] == 'http://127.0.0.1:8001'
    assert 'HTTPS_PROXY' not in os.environ
    monkeypatch.setenv('HTTPS_PROXY', 'http://127.0.0.1:8002')
    assert native.codex_environment()['HTTPS_PROXY'] == 'http://127.0.0.1:8002'


@pytest.mark.parametrize('platform', ['win32', 'linux', 'darwin'])
def test_codex_isolation_preserves_windows_workspace_sandbox(tmp_path, monkeypatch, platform):
    monkeypatch.setattr(native, 'sys', SimpleNamespace(platform=platform))
    monkeypatch.setattr(native, 'executable', lambda _: 'codex')
    monkeypatch.setattr(native, 'codex_isolation_flags', lambda _: ('--ignore-user-config', '--ignore-rules'))
    args, _ = native.command('codex', tmp_path, '', '', None, '', [])
    assert ('windows.sandbox="elevated"' in args) == (platform == 'win32')
    assert args[args.index('--sandbox') + 1] == 'workspace-write'
    assert '--dangerously-bypass-approvals-and-sandbox' not in args


def test_codex_reconnect_does_not_end_turn():
    assert native.text_events('codex', {'type': 'error', 'message': 'Reconnecting...'}) == []
    assert native.text_events('codex', {'type': 'item.completed', 'item': {
        'type': 'agent_message', 'text': 'Connected'}}) == [{'type': 'delta', 'text': 'Connected'}]
    with pytest.raises(ProjectError):
        native.text_events('codex', {'type': 'turn.failed'})


@pytest.mark.parametrize('identities', [['unexpected'], ['original', 'unexpected']])
def test_opencode_resume_rejects_unexpected_or_changing_session_ids(tmp_path, monkeypatch, identities):
    from opendirector.infrastructure.creation_projects import CreationProjects
    run = RunContext(runtime='opencode', project_id=uuid4(), turn_id=uuid4(),
        session=str(uuid4()), conversation_id=uuid4(), runtime_model='test-model',
        directory=tmp_path, config=None, selected_skills=[],
        messages=[{'role': 'user', 'content': 'first'}, {'role': 'assistant', 'content': 'answer'},
                  {'role': 'user', 'content': 'continue'}])
    saved = run.native_session_path() / 'session.json'
    saved.parent.mkdir(parents=True)
    engine_directory = tmp_path / 'agent-runs' / str(uuid4()) / 'work'
    engine_directory.mkdir(parents=True)
    previous = dict(sessionId='original', messages=2, directory=str(engine_directory),
                    selection=dict(model='test-model', thinking='auto'))
    saved.write_text(json.dumps(previous))
    source = 'import json; ' + '; '.join('print(' + repr(json.dumps(dict(
        type='text', sessionID=identity, part=dict(text='output')))) + ')' for identity in identities)
    monkeypatch.setattr(native, 'command', lambda *args, **kwargs:
        ([sys.executable, '-c', source], dict(os.environ)))
    instance = AgentRuntimes(CreationProjects(LocalProjects(tmp_path)), None, ModelConfigs(tmp_path))
    async def consume():
        with pytest.raises(ProjectError, match='会话 ID'):
            async for _ in instance.stream(run):
                pass
    asyncio.run(consume())
    assert json.loads(saved.read_text()) == previous


@pytest.fixture
def real_opencode_worker(tmp_path, monkeypatch, request):
    """Bound real CLI cases in isolated workers and clean up owned processes."""
    if os.environ.get('OPENDIRECTOR_REAL_CLI') != '1':
        pytest.skip('Set OPENDIRECTOR_REAL_CLI=1 to run the bundled CLI integration')
    assert native.executable('default') is not None, 'Bundled OpenCode is not installed'
    timeout = 105 if 'windows_unicode_pipeline' in request.node.name else 60
    if os.environ.get('OPENDIRECTOR_REAL_CLI_WORKER') != '1':
        result = subprocess.run([sys.executable, '-m', 'pytest', request.node.nodeid, '-s', '-q'],
            env={**os.environ, 'OPENDIRECTOR_REAL_CLI_WORKER': '1'},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding="utf-8", errors="replace", timeout=timeout + 30)
        assert result.returncode == 0, result.stdout
        return False

    for name in ('XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'):
        monkeypatch.setenv(name, str(tmp_path / name.lower()))
    from opendirector.agent.process import _signal_tree
    processes = []
    spawn = asyncio.create_subprocess_exec
    async def tracked_spawn(*args, **kwargs):
        process = await spawn(*args, **kwargs)
        processes.append((process, kwargs.get('start_new_session', False)))
        if os.environ.get('OPENDIRECTOR_TEST_CLI_STALL') and 'run' in args:
            Path(os.environ['OPENDIRECTOR_TEST_CLI_STALL']).write_text(str(process.pid))
            await asyncio.Event().wait()
        return process
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', tracked_spawn)
    def timed_out():
        print('Real OpenCode integration timed out; thread stacks:', file=sys.stderr, flush=True)
        faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
        for process, group in reversed(processes):
            if process.returncode is None:
                try:
                    if group:
                        _signal_tree(process, force=True)
                    else:
                        process.kill()
                except OSError as error:
                    print(f'Could not stop CLI process {process.pid}: {error}', file=sys.stderr, flush=True)
        os._exit(1)
    watchdog = threading.Timer(10 if os.environ.get('OPENDIRECTOR_TEST_CLI_STALL') else timeout, timed_out)
    watchdog.daemon = True
    watchdog.start()
    request.addfinalizer(watchdog.cancel)
    return True


@pytest.mark.parametrize('reasoning', [False, True], ids=['plain', 'thinking'])
def test_real_opencode_default_hello_saves_direct_reply(tmp_path, monkeypatch, real_opencode_worker, reasoning):
    if not real_opencode_worker:
        return
    requests = []
    reply = 'Hello! How can I help?'

    class GreetingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            deltas = [{'role': 'assistant', 'content': ''}]
            if reasoning:
                deltas.append({'reasoning_content': 'A greeting needs no project tools.'})
            deltas.extend([{'content': 'Hello! '}, {'content': 'How can I help?'}])
            for delta in [*deltas, {}]:
                chunk = {'id': 'hello', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'test-model', 'choices': [{'index': 0, 'delta': delta,
                        'finish_reason': None if delta else 'stop'}]}
                frame = ('data: ' + json.dumps(chunk) + '\n\n').encode()
                for index in range(0, len(frame), 7):
                    yield frame[index:index + 7]
                await asyncio.sleep(.01)
            yield b'data: [DONE]\n\n'

    def model(request):
        # Count every provider call, including title generation and retries.
        requests.append(json.loads(request.content))
        assert request.headers['authorization'] == 'Bearer server-only-key'
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=GreetingStream())

    async def no_skills(*args):
        return []
    monkeypatch.setattr('opendirector_api.agent.skills', no_skills)
    local = LocalProjects(tmp_path)
    config = ModelConfigs(tmp_path).save('agent', 'http://test.invalid/v1', 'test-model', 'server-only-key')
    provider = ChatCompletions(httpx.MockTransport(model))
    with TestClient(create_app(local, chat_provider=provider), headers={
            'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        path = project(client)
        assert client.get(path + '/assistant').json()['messages'] == []
        turn = {'id': str(uuid4()), 'runtime': 'default', 'modelId': config['id'], 'text': 'hello'}
        response = client.post(path + '/assistant/turns', json=turn)
        assert response.status_code == 200
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['type'] == 'end' and events[-1]['error'] is None, events
        assert ''.join(event['text'] for event in events if event['type'] == 'delta') == reply
        assert not any(event['type'] == 'tool' for event in events)
        assert len(requests) == 1
        # Keep the production tool surface available: the test must not achieve
        # zero calls by disabling tools or forcing tool_choice=none.
        assert requests[0]['tool_choice'] == 'auto'
        assert any(tool['function']['name'] == 'bash' for tool in requests[0]['tools'])
        saved = client.get(path + '/assistant').json()
        assert len(saved['messages']) == 2
        assert saved['messages'][0]['text'] == 'hello'
        summaries = client.get(path + '/assistant/conversations').json()['items']
        assert len(summaries) == 1 and summaries[0]['title'] == 'hello'
        assistant = saved['messages'][-1]
        assert assistant['text'] == reply and assistant['status'] == 'complete'
        assert assistant.get('tools', []) == []
        disk = json.loads(next(local.root.rglob('conversation.json')).read_text(encoding='utf-8'))
        assert disk['messages'] == saved['messages']
        snapshot = client.get(path).json()
        assert snapshot['assets'] == [] and snapshot['jobs'] == []
        trace = next(local.root.rglob(f"{turn['id']}.opencode.jsonl"))
        native_events = [json.loads(line).get('native', {}) for line in trace.read_text(encoding='utf-8').splitlines()]
        assert not any(event.get('type') == 'tool_use' for event in native_events)
        assert sum(event.get('type') == 'step_finish' for event in native_events) == 1
        model_trace = next(local.root.rglob(f"{turn['id']}.model.jsonl"))
        model_events = [json.loads(line) for line in model_trace.read_text(encoding='utf-8').splitlines()]
        assert sum(event['event'] == 'model.request' for event in model_events) == 1
        assert sum(event['event'] == 'model.completed' for event in model_events) == 1
        # Replaying an accepted turn must not submit another provider request.
        assert '已接受' in client.post(path + '/assistant/turns', json=turn).text
        assert len(requests) == 1
        assert client.get(path + '/assistant').json()['messages'] == saved['messages']


@pytest.mark.parametrize("runtime", ["default"])
@pytest.mark.parametrize("resume", [False, True])
def test_real_opencode_native_skill_and_gateway_write(tmp_path, runtime, resume, monkeypatch, real_opencode_worker):
    if not real_opencode_worker:
        return
    requests = []
    write_receipts = []
    def model(request):
        payload = json.loads(request.content)
        if payload.get('tools'):
            requests.append(payload)
        assert request.headers['authorization'] == 'Bearer server-only-key'
        count = len(requests)
        print(f'stage: model request {count} (tools={bool(payload.get("tools"))})', flush=True)
        if not payload.get('tools'):
            call = None
        elif count == 1:
            assert any(tool['function']['name'] == 'skill' for tool in payload['tools'])
            call = {'name':'skill','arguments':json.dumps({'name':'od-native-runtime-test-skill'})}
        elif count == 2:
            assert 'Create a 24-FPS constant-frame-rate working copy' in json.dumps(payload['messages'])
            assert not any('opendirector_' in tool['function']['name'] for tool in payload['tools'])
            call = {'name': 'bash', 'arguments': json.dumps({
                'command': "opendirector asset write-text --name real-native.md --text 'Real OpenCode plan'",
                'description': 'Register the plan in the project'})}
        else:
            if count == 3:
                receipt = json.loads(next(message['content'] for message in payload['messages']
                    if message.get('role') == 'tool' and message.get('tool_call_id') == 'call-2'))
                assert receipt['status'] == 'applied'
                write_receipts.append(receipt)
            call = None
        delta = {'tool_calls':[{'index':0,'id':f'call-{count}','type':'function','function':call}]} if call else {'content':'OpenCode ready.'}
        chunk = {'id':f'completion-{count}','object':'chat.completion.chunk','created':1,'model':'test-model',
            'choices':[{'index':0,'delta':delta,'finish_reason':None}]}
        finish = {**chunk,'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls' if call else 'stop'}]}
        reasoning = {**chunk, 'choices': [{'index': 0,
            'delta': {'reasoning_content': 'Check the request.'}, 'finish_reason': None}]}
        return httpx.Response(200,headers={'content-type':'text/event-stream'},content=(
            'data: '+json.dumps(reasoning)+'\n\ndata: '+json.dumps(chunk)+'\n\ndata: '+json.dumps(finish)+'\n\ndata: [DONE]\n\n').encode())
    local = LocalProjects(tmp_path)
    config = ModelConfigs(tmp_path).save('agent','http://test.invalid/v1','test-model','server-only-key')
    provider = ChatCompletions(httpx.MockTransport(model))
    with TestClient(create_app(local, chat_provider=provider), headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        path = project(client)
        print('stage: discover skills', flush=True)
        catalog = client.get(path + '/assistant/skills').json()
        assert 'od-native-runtime-test-skill' in {item['name'] for item in catalog}
        assert all(set(item) == {'name', 'description', 'source'} for item in catalog)
        assert client.put(path + '/assistant/draft', json={'draft': 'Save a plan', 'skills': ['od-native-runtime-test-skill'],
            'harnessModels': {'codex': 'test-model'}}).status_code == 200
        turn = {'id':str(uuid4()), 'modelId':config['id'], 'runtime':runtime,
            'text':'Use the skill and save a plan.', 'skills':['od-native-runtime-test-skill']}
        print('stage: fresh turn', flush=True)
        response = client.post(path + '/assistant/turns', json=turn)
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['error'] is None, events
        assert events[-1]['conversation']['messages'][-1]['text'] == 'OpenCode ready.'
        assets = client.get(path).json()['assets']
        assert len(assets) == 1 and assets[0]['name'] == 'real-native.md'
        assert len(write_receipts) == 1
        assert assets[0]['id'] == write_receipts[0]['assetId']
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
        print('stage: resumed turn', flush=True)
        response = client.post(path + '/assistant/turns', json={**turn, 'id': str(uuid4()), 'text': 'Continue the plan.'})
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['error'] is None, events
        assert len(requests) == 4
        messages = requests[-1]['messages']
        assert 'OpenCode ready.' in json.dumps(messages[:-1])
        assert 'Continue the plan.' in json.dumps(messages[-1])
        assert 'Use the skill and save a plan.' not in json.dumps(messages[-1])
        # A new turn retains the native session and its complete transcript.
        traces = list(local.root.rglob('*.opencode.jsonl'))
        ids = [{json.loads(line)['native']['sessionID']
                for line in trace.read_text(encoding='utf-8').splitlines()
                if json.loads(line).get('native', {}).get('sessionID')} for trace in traces]
        assert len(ids) == 2 and all(len(value) == 1 for value in ids)
        assert ids[0] == ids[1]


@pytest.mark.skipif(os.name != 'nt' or os.environ.get('OPENDIRECTOR_REAL_WINDOWS_PIPELINE') != '1',
    reason='Set OPENDIRECTOR_REAL_WINDOWS_PIPELINE=1 to qualify OpenCode on Windows PowerShell 5.1')
@pytest.mark.parametrize('runtime', ['default', 'opencode'])
def test_real_opencode_windows_unicode_pipeline(tmp_path, monkeypatch, real_opencode_worker, runtime, request):
    if not real_opencode_worker:
        return
    from opendirector.agent.windows_powershell import system_powershell
    from opendirector.infrastructure.creation_projects import CreationProjects

    monkeypatch.setenv('SHELL', str(system_powershell()))
    monkeypatch.delenv('PSModulePath', raising=False)
    monkeypatch.setenv('PSExecutionPolicyPreference', 'Restricted')
    monkeypatch.setenv('PYTHONUTF8', '0')
    monkeypatch.delenv('PYTHONIOENCODING', raising=False)
    local = LocalProjects(tmp_path)
    configs = ModelConfigs(tmp_path)
    config = configs.save('agent', 'http://test.invalid/v1', 'test-model', 'server-only-key')
    image = configs.save('image', 'http://test.invalid/v1', 'test-image', '', auth_mode='none')
    prompts = ('第一镜：窗边的猫\n第二镜：𠮷 🐈? "推近"', '窗边的猫说：\'再来一次\'\n𠮷 🐈?')
    expected_nodes = {}
    expected_assets = {}
    sessions = []
    tool_commands = []
    requests = []

    def pipeline(payload, command):
        body = json.dumps({'payload': payload}, ensure_ascii=False).replace("'", "''")
        return f"'{body}' | opendirector {command} --file -"

    def model(request):
        payload = json.loads(request.content)
        if not payload.get('tools'):
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=(
                'data: {"id":"title","choices":[{"index":0,"delta":{"content":"Storyboard"},"finish_reason":"stop"}]}\n\n'
                'data: [DONE]\n\n'))
        messages = payload['messages']
        index = len(requests)
        requests.append(messages)
        if index % 2 == 0:
            content = messages[-1]['content']
            assert 'Use opendirector for project changes.\n' in content
            assert 'OutputEncoding' not in json.dumps(messages)
            work = content.split('Execution directory: ', 1)[1].splitlines()[0]
            command = tool_commands[index // 2]
            delta = {'tool_calls': [{'index': 0, 'id': f'write-{index}', 'type': 'function',
                'function': {'name': 'bash', 'arguments': json.dumps({
                    'command': command, 'workdir': work, 'description': 'Save a Chinese storyboard'})}}]}
        else:
            delta = {'content': 'Saved.'}
        chunk = {'id': f'completion-{index}', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'test-model'}
        frames = [dict(chunk, choices=[{'index': 0, 'delta': delta, 'finish_reason': None}]),
                  dict(chunk, choices=[{'index': 0, 'delta': {}, 'finish_reason': 'stop' if index % 2 else 'tool_calls'}])]
        return httpx.Response(200, headers={'content-type': 'text/event-stream'},
            content=''.join(f'data: {json.dumps(frame)}\n\n' for frame in frames) + 'data: [DONE]\n\n')

    setup = (
        "$ErrorActionPreference = 'Stop'\n"
        "if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Expected 5.1' }\n"
        "if ($env:PSExecutionPolicyPreference -ne 'Restricted') { throw 'Expected Restricted' }\n"
        "if ($env:PYTHONUTF8 -ne '0' -or (Test-Path Env:PYTHONIOENCODING)) { throw 'Expected legacy Python defaults' }\n"
        "[IO.File]::WriteAllText((Join-Path $PWD.Path 'policy-probe.ps1'), 'exit 19')\n"
        "try { & .\\policy-probe.ps1; throw 'Expected scripts to be blocked' } "
        "catch [System.Management.Automation.PSSecurityException] {}\n"
        "$launcher = (Get-Command opendirector).Source\n"
        "if ($launcher -ne (Join-Path $PWD.Path '.opendirector-bin\\opendirector.cmd')) { throw 'Wrong launcher' }\n"
        "Write-Output \"PS 5.1 Restricted $launcher\"\n"
        "opendirector --help\n"
        "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n"
        "$ErrorActionPreference = 'Continue'\n"
        "opendirector asset write-text --unknown-option 2>$null\n"
        "if ($LASTEXITCODE -ne 2) { throw 'Wrong CLI exit code' }\n"
        "$ErrorActionPreference = 'Stop'\n"
    )
    if runtime == 'opencode':
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        if native.executable('opencode') is None:
            pytest.skip('External OpenCode is not installed')

        class FixtureProvider(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                response = model(httpx.Request('POST', 'http://localhost/v1/chat/completions', content=body))
                self.send_response(response.status_code)
                self.send_header('Content-Type', response.headers['content-type'])
                self.send_header('Content-Length', str(len(response.content)))
                self.end_headers()
                self.wfile.write(response.content)

        server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureProvider)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop_fixture():
            server.shutdown()
            server.server_close()
            thread.join()

        request.addfinalizer(stop_fixture)
        settings = tmp_path / 'config'
        monkeypatch.setenv('XDG_CONFIG_HOME', str(settings))
        opencode_config = settings / 'opencode' / 'opencode.json'
        opencode_config.parent.mkdir(parents=True)
        opencode_config.write_text(json.dumps({
            'shell': str(system_powershell()),
            'small_model': 'fixture/test-model',
            'provider': {'fixture': {'npm': '@ai-sdk/openai-compatible', 'name': 'Test provider',
                'options': {'baseURL': f'http://127.0.0.1:{server.server_port}/v1', 'apiKey': 'test-key'},
                'models': {'test-model': {'name': 'Test model'}}}},
        }), encoding='utf-8')

    provider = ChatCompletions(httpx.MockTransport(model))
    with TestClient(create_app(local, chat_provider=provider), headers={
            'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        path = project(client)
        pid = path.rsplit('/', 1)[-1]
        for index, prompt in enumerate(prompts):
            spec_id, item_id = str(uuid4()), str(uuid4())
            title = f'窗边的小猫 🐈 {index + 1}'
            name = f'分镜 {index + 1}.md'
            node = {
                'spec': {'id': spec_id, 'projectId': pid, 'kind': 'image', 'purpose': 'generation',
                         'modelConfigId': image['id'], 'prompt': prompt, 'parameters': {'size': '1024x1024'}},
                'item': {'id': item_id, 'projectId': pid, 'kind': 'image', 'title': title,
                         'position': {'x': 0, 'y': 0}, 'width': 512, 'height': 512,
                         'binding': {'role': 'generation', 'objectRef': {'id': spec_id}}},
            }
            expected_nodes[item_id] = (title, prompt)
            expected_assets[name] = prompt.encode()
            tool_commands.append(
                ('using namespace System.Text\n' if index else '') + setup
                + pipeline(node, 'canvas create-generation') + '\n'
                + "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n"
                + pipeline({'name': name, 'text': prompt}, 'asset write-text') + '\n'
                + "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n"
                + "Write-Output 'CLI project snapshot:'\n"
                + 'opendirector project show')
            turn = {'id': str(uuid4()), 'runtime': runtime, 'modelId': config['id'],
                    **({'runtimeModel': 'fixture/test-model'} if runtime == 'opencode' else {}),
                    'text': f'保存第 {index + 1} 个分镜，暂时不用出图。'}
            response = client.post(path + '/assistant/turns', json=turn)
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            assert response.status_code == 200 and events[-1]['error'] is None, events
            trace = next(local.root.rglob(f"{turn['id']}.opencode.jsonl"))
            event, = [native_event for line in trace.read_text(encoding='utf-8').splitlines()
                      if (native_event := json.loads(line).get('native', {})).get('type') == 'tool_use']
            sessions.append(event['sessionID'])
            shell_call = event['part']
            assert shell_call['state']['input']['command'] == tool_commands[index]
            assert shell_call['state']['metadata']['exit'] == 0, shell_call
            output = shell_call['state'].get('output', '')
            assert 'PS 5.1 Restricted' in output and 'opendirector.cmd' in output and 'Usage:' in output, shell_call
            assert output.count('"status": "applied"') == 2, shell_call
            _, marker, raw_snapshot = output.partition('CLI project snapshot:')
            assert marker, shell_call
            reported = json.loads(raw_snapshot)
            item = next(item for item in reported['canvasItems'] if item['id'] == item_id)
            spec = next(spec for spec in reported['generationSpecs'] if spec['id'] == item['binding']['objectRef']['id'])
            assert (item['title'], spec['prompt']) == (title, prompt)

    assert len(requests) == len(prompts) * 2
    assert len(set(sessions)) == 1
    snapshot = CreationProjects(LocalProjects(tmp_path)).snapshot(UUID(pid))
    prompts_by_id = {str(spec.id): spec.prompt for spec in snapshot.generationSpecs}
    nodes = {str(item.id): (item.title, prompts_by_id[str(item.binding.objectRef.id)])
             for item in snapshot.canvasItems}
    directory = next(local.root.rglob('project.json')).parent
    assets = {asset.name: (directory / asset.path).read_bytes() for asset in snapshot.assets}
    assert not snapshot.jobs
    assert (nodes, assets) == (expected_nodes, expected_assets)


def test_real_opencode_watchdog_cleans_up_stalled_cli(tmp_path):
    if os.environ.get('OPENDIRECTOR_REAL_CLI') != '1':
        pytest.skip('Set OPENDIRECTOR_REAL_CLI=1 to run the bundled CLI integration')
    if native.executable('default') is None:
        pytest.skip('Bundled OpenCode is not installed')
    marker = tmp_path / 'pid'
    case = f'{__file__}::test_real_opencode_native_skill_and_gateway_write[False-default]'
    result = subprocess.run([sys.executable, '-m', 'pytest', case, '-s', '-q'],
        env={**os.environ, 'OPENDIRECTOR_REAL_CLI_WORKER': '1', 'OPENDIRECTOR_TEST_CLI_STALL': str(marker)},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=25)
    assert result.returncode != 0
    assert 'stage: fresh turn' in result.stdout
    assert 'Real OpenCode integration timed out; thread stacks:' in result.stdout
    pid = int(marker.read_text())
    if sys.platform == 'linux':
        # A killed process can briefly remain as a zombie until it is reaped.
        for _ in range(100):
            stat = Path(f'/proc/{pid}/stat')
            if not stat.exists() or stat.read_text().split(') ')[1].startswith('Z'):
                break
            time.sleep(.05)
        else:
            pytest.fail(f'OpenCode process {pid} survived the watchdog')



@pytest.mark.parametrize('runtime', ['default', 'opencode', 'codex', 'claude'])
def test_cancel_native_process_group(tmp_path, monkeypatch, runtime):
    import signal
    async def check():
        script = tmp_path / 'wait.py'
        marker = tmp_path / 'pid.txt'
        child_marker = marker.with_suffix('.child')
        script.write_text('import os,sys,time,subprocess\nfrom pathlib import Path\n'
            'subprocess.Popen([sys.executable, "-c", '
            '"import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)", '
            'str(Path(sys.argv[1]).with_suffix(".child"))])\n'
            'Path(sys.argv[1]).write_text(str(os.getpid()))\nsys.stdin.read()\ntime.sleep(60)\n')
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
            while not marker.exists() or not child_marker.exists():
                await asyncio.sleep(.02)
        pid = int(marker.read_text())
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert_process_exited(pid)
        assert_process_exited(int(child_marker.read_text()))
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


def test_codex_resume_requires_a_persisted_rollout(tmp_path, monkeypatch):
    monkeypatch.setenv('CODEX_HOME', str(tmp_path))
    session = '01a1b721-ec28-7f33-85a6-0cf1355f6627'
    assert not native.codex_session_available(session)
    rollout = tmp_path / 'sessions' / '2026' / f'rollout-{session}.jsonl'
    rollout.parent.mkdir(parents=True)
    rollout.write_text('{}\n')
    assert native.codex_session_available(session)

RETRYING_CLI = r"""
import json, os, sys, time, urllib.error, urllib.request
from pathlib import Path
sys.stdin.read()
config = json.loads(os.environ['OPENCODE_CONFIG_CONTENT'])
base = config['provider']['opendirector']['options']['baseURL']
key = os.environ['OPENDIRECTOR_MODEL_KEY']
count = Path(os.environ['REQUEST_COUNT'])
payload = json.dumps({'messages': [{'role': 'user', 'content': 'hello'}], 'stream': True}).encode()
for attempt in range(6):
    count.write_text(str(attempt + 1))
    request = urllib.request.Request(
        base + '/chat/completions', data=payload,
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
        method='POST')
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
        print(json.dumps({'type': 'text', 'sessionID': 'timeout-session', 'part': {'text': 'should not appear'}}))
        raise SystemExit(0)
    except Exception:
        if attempt < 5:
            time.sleep(2)
time.sleep(300)
"""


def test_unanswered_model_timeout_ends_the_turn_without_silent_retries(tmp_path, monkeypatch):
    """A first-byte timeout must end the live turn instead of letting the harness retry."""
    monkeypatch.setenv('OPENDIRECTOR_MODEL_READ_TIMEOUT', '0.3')
    count = tmp_path / 'requests.txt'
    count.write_text('0')
    monkeypatch.setenv('REQUEST_COUNT', str(count))
    script = tmp_path / 'retrying_cli.py'
    script.write_text(RETRYING_CLI)
    real_command = native.command

    def command(kind, work, socket, token, model, model_url, catalog, **kwargs):
        _, env = real_command(kind, work, socket, token, model, model_url, catalog, **kwargs)
        return [sys.executable, str(script)], env

    monkeypatch.setattr(native, 'command', command)
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)
    async def no_skills(*args):
        return []
    monkeypatch.setattr('opendirector_api.agent.skills', no_skills)

    server = socket.socket(); server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', 0)); server.listen()
    stop = threading.Event()
    # Accept connections but never reply, so the gateway read timeout can fire.
    def serve():
        try:
            while not stop.is_set():
                try:
                    server.settimeout(0.2)
                    connection, _ = server.accept()
                except TimeoutError:
                    continue
                except OSError:
                    break
                try:
                    while not stop.is_set():
                        time.sleep(0.05)
                finally:
                    connection.close()
        except Exception:
            pass
    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        port = server.getsockname()[1]
        local = LocalProjects(tmp_path)
        config = ModelConfigs(tmp_path).save(
            'agent', f'http://127.0.0.1:{port}', 'slow-model', 'server-only-key', auth_mode='none')
        started = time.monotonic()
        with TestClient(create_app(local), headers={
                'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4()),
                'Accept-Language': 'en-US'}) as client:
            path = project(client)
            turn = {'id': str(uuid4()), 'runtime': 'default', 'modelId': config['id'], 'text': 'hello'}
            response = client.post(path + '/assistant/turns', json=turn)
            elapsed = time.monotonic() - started
            assert response.status_code == 200
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            assert events, response.text
            ending = events[-1]
            assert ending['type'] == 'end', events
            assert ending['error']
            assert 'did not respond in time' in ending['error']
            conversation = ending['conversation']
            assert conversation['messages'][-1]['status'] == 'interrupted'
            assert conversation['messages'][-1]['text'] == ''
            saved = client.get(path + '/assistant').json()
            assert saved['messages'][-1]['status'] == 'interrupted'
        assert elapsed < 8
        assert int(count.read_text() or '0') == 1
    finally:
        stop.set()
        server.close()
