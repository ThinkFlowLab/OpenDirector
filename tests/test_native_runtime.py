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
from uuid import uuid4

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
pytestmark = pytest.mark.merge

FAKE = '''import json, os, subprocess, sys
from pathlib import Path
prompt = sys.stdin.read()
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
skill = Path('plugin/skills/character-replacement/SKILL.md').read_text()
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
    entry = tmp_path / '.opendirector/skills/character-replacement/SKILL.md'
    common = dict(runtime='claude', project_id=uuid4(), session=str(uuid4()),
        conversation_id=uuid4(), directory=directory, config=None, selected_skills=[],
        skills=[{'name': 'character-replacement', 'filePath': str(entry)}])
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
        assert (workspaces[0] / 'plugin/skills/character-replacement/SKILL.md').read_text() == 'second skill version'
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
            assert config['skills']['paths'] == [str(work / '.agents/skills')]
            if runtime == 'default':
                assert config['agent']['title'] == {'disable': True}
            else:
                assert 'title' not in config['agent']


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
    if native.executable('default') is None:
        pytest.skip('Bundled OpenCode is not installed')
    if os.environ.get('OPENDIRECTOR_REAL_CLI_WORKER') != '1':
        result = subprocess.run([sys.executable, '-m', 'pytest', request.node.nodeid, '-s', '-q'],
            env={**os.environ, 'OPENDIRECTOR_REAL_CLI_WORKER': '1'},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=90)
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
    def timeout():
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
    watchdog = threading.Timer(10 if os.environ.get('OPENDIRECTOR_TEST_CLI_STALL') else 60, timeout)
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
            call = {'name':'skill','arguments':json.dumps({'name':'character-replacement'})}
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
        assert {item['name'] for item in catalog} == {'character-replacement'}
        assert all(set(item) == {'name', 'description', 'source'} for item in catalog)
        assert client.put(path + '/assistant/draft', json={'draft': 'Save a plan', 'skills': ['character-replacement'],
            'harnessModels': {'codex': 'test-model'}}).status_code == 200
        turn = {'id':str(uuid4()), 'modelId':config['id'], 'runtime':runtime,
            'text':'Use the skill and save a plan.', 'skills':['character-replacement']}
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
