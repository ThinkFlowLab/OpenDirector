"""Opt-in installed dsh CLI with a local simulated model, never a paid endpoint."""
import json
import os
import shlex
import asyncio
from pathlib import Path
import re
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from process_helpers import native_user_directory, project_heartbeat

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.agent.owner_rights import native_owner_access
from opendirector_api.main import create_app

pytestmark = pytest.mark.nightly


@pytest.mark.skipif(os.getenv('DEEPSEEK_ENGINE_TEST') != '1', reason='requires installed dsh CLI')
def test_real_cli_native_skill_and_shared_project_write(tmp_path, monkeypatch):
    directory_permissions = native_user_directory(tmp_path)
    if directory_permissions is not None:
        assert directory_permissions['ownerRights'], directory_permissions
    calls, failures = [], []
    shell = 'pwsh' if os.name == 'nt' else 'bash'
    outside = tmp_path / 'outside-canary.txt'
    outside.write_text('outside unchanged', encoding='utf-8')
    outside_path = str(outside).replace("'", "''")
    denied_write = (
        "$ErrorActionPreference='Stop'; try { Set-Content -LiteralPath '" + outside_path +
        "' -Value 'BAD' -NoNewline; exit 9 } catch { "
        "if ($_.FullyQualifiedErrorId -notlike '*UnauthorizedAccess*') { throw }; "
        "Write-Output 'NATIVE_OUTSIDE_DENIED' }" if os.name == 'nt' else
        'if printf BAD > ' + shlex.quote(str(outside)) +
        '; then exit 9; else printf NATIVE_OUTSIDE_DENIED; fi')
    marker = ("Set-Content -LiteralPath 'native-check.txt' -Value 'native bash' -NoNewline" if os.name == 'nt'
        else "printf 'native bash' > native-check.txt")
    tool_prefix = 'fixture'
    steps = [('skill', {'name': 'example'}),
        (shell, {'command': marker, 'description':'Write a native execution marker'}),
        (shell, {'command': denied_write, 'description': 'Verify outside writes remain denied'}),
        (shell, {'command': 'opendirector project show', 'description': 'Read project'}),
        (shell, {'command': "opendirector asset write-text --name deepseek.md --text 'Real CLI, local model'", 'description': 'Register a plan'})]
    class Model(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            index=len(calls)
            calls.append(request)
            if index < len(steps):
                name, arguments=steps[index]
                names={tool['name'] for tool in request.get('tools',[])}
                if name not in names:
                    failures.append((name,sorted(names)))
                block={'type':'tool_use','id':f'{tool_prefix}-{index}','name':name,'input':{}}
                delta={'type':'input_json_delta','partial_json':json.dumps(arguments)}
                reason='tool_use'
            else:
                block={'type':'text','text':''}
                delta={'type':'text_delta','text':'Real CLI finished.'}
                reason='end_turn'
            events=[
                {'type':'message_start','message':{'id':f'message-{index}','type':'message','role':'assistant',
                    'model':'deepseek-v4-flash','content':[],'usage':{'input_tokens':10,'output_tokens':0}}},
                {'type':'content_block_start','index':0,'content_block':block},
                {'type':'content_block_delta','index':0,'delta':delta},
                {'type':'content_block_stop','index':0},
                {'type':'message_delta','delta':{'stop_reason':reason,'stop_sequence':None},'usage':{'output_tokens':5}},
                {'type':'message_stop'},
            ]
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream');self.end_headers()
            for event in events:
                self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n').encode())
            self.wfile.flush()
    server=ThreadingHTTPServer(('127.0.0.1',0),Model)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    monkeypatch.setenv('DSH_HOME',str(tmp_path/'dsh-home'))
    monkeypatch.setenv('DEEPSEEK_API_KEY','fixture-not-a-secret')
    monkeypatch.setenv('DEEPSEEK_BASE_URL',f'http://127.0.0.1:{server.server_port}')
    monkeypatch.setenv('NO_PROXY','localhost,127.0.0.1,::1')
    monkeypatch.setenv('no_proxy','localhost,127.0.0.1,::1')
    skill=tmp_path/'.opendirector/skills/example'
    skill.mkdir(parents=True)
    (skill/'SKILL.md').write_text('---\nname: example\ndescription: Fixture skill\n---\nNATIVE_DEEPSEEK_SKILL_MARKER')
    foreign=tmp_path/'dsh-home/skills/unapproved'
    foreign.mkdir(parents=True)
    (foreign/'SKILL.md').write_text('---\nname: unapproved\ndescription: UNAPPROVED_SKILL_MARKER\n---\nNot part of the project')
    local=LocalProjects(tmp_path)
    try:
        with TestClient(create_app(local),headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
            pid,turn=str(uuid4()),str(uuid4())
            path='/api/creation/projects/'+pid
            assert client.post(path+'/commands',json=dict(type='project.create',projectId=pid,commandId=str(uuid4()),payload={'name':'DeepSeek real CLI'})).status_code==200
            assert client.post(path+'/open').status_code==200
            response=client.post(path+'/assistant/turns',json=dict(id=turn,runtime='deepseek',text='Load the example skill and save a text asset.',skills=['example']))
            assert response.status_code == 200, response.text
            events=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            assert not failures, failures
            assert events[-1]['error'] is None, events[-1]
            assert events[-1]['conversation']['messages'][-1]['text']=='Real CLI finished.'
            assets=client.get(path).json()['assets']
            assert len(assets) == 1, (directory_permissions, events[-1]['conversation']['messages'][-1])
            assert assets[0]['provenance']['agentRuntime']=='deepseek'
            assert (local.root/'DeepSeek real CLI/agent-runs'/turn/'work/native-check.txt').read_text()=='native bash'
            assert outside.read_text(encoding='utf-8') == 'outside unchanged'
            denied = next(item for item in events[-1]['conversation']['messages'][-1]['tools']
                if item['id'] == 'deepseek:fixture-2')
            assert denied['status'] == 'complete' and not denied['resultTruncated']
            content = json.loads(denied['result'])
            assert len(content) == 1 and content[0]['type'] == 'content'
            assert content[0]['content']['type'] == 'text'
            assert content[0]['content']['text'].splitlines() == ['NATIVE_OUTSIDE_DENIED']
            assert 'NATIVE_DEEPSEEK_SKILL_MARKER' in json.dumps(calls[1]['messages'])
            assert 'UNAPPROVED_SKILL_MARKER' not in json.dumps(calls)
            # Resume the real engine in the same initialized, populated tree.
            work = local.root/'DeepSeek real CLI/agent-runs'/turn/'work'
            identity = work.stat().st_ino
            state_file = next(local.root.rglob('deepseek-sessions/*/session.json'))
            saved = json.loads(state_file.read_text(encoding='utf-8'))
            first_trace = work.parent.parent / f'{turn}.deepseek.jsonl'
            trace_bytes = first_trace.read_bytes()
            calls.clear(); tool_prefix = 'resume'
            append = ("Add-Content -LiteralPath 'native-check.txt' -Value ' resumed' -NoNewline"
                if os.name == 'nt' else "printf ' resumed' >> native-check.txt")
            steps[:] = [(shell, {'command': append, 'description': 'Edit a retained native execution file'}),
                (shell, {'command': denied_write, 'description': 'Keep outside writes denied on resume'}),
                (shell, {'command': "opendirector asset write-text --name resumed.md --text 'Resumed native engine'",
                    'description': 'Save through the resumed business CLI'})]
            with project_heartbeat(client, pid, client.headers['X-OpenDirector-Session']):
                resumed = client.post(path+'/assistant/turns', json=dict(id=str(uuid4()), runtime='deepseek',
                    text='Continue in the retained workspace and save another text asset.', skills=['example']))
            continued = [json.loads(line[6:]) for line in resumed.text.splitlines() if line.startswith('data: ')]
            assert not failures, failures
            assert continued[-1]['error'] is None, continued[-1]
            assert work.stat().st_ino == identity
            assert (work/'native-check.txt').read_text() == 'native bash resumed'
            assert first_trace.read_bytes() == trace_bytes
            assert outside.read_text(encoding='utf-8') == 'outside unchanged'
            restored = json.loads(state_file.read_text(encoding='utf-8'))
            assert restored['sessionId'] == saved['sessionId'] and restored['directory'] == str(work)
            resumed_assets = client.get(path).json()['assets']
            assert len(resumed_assets) == 2
            assert next(asset for asset in resumed_assets if asset['id'] == assets[0]['id']) == assets[0]
            denied_again = next(item for item in continued[-1]['conversation']['messages'][-1]['tools']
                if item['id'] == 'deepseek:resume-1')
            assert denied_again['status'] == 'complete' and not denied_again['resultTruncated']
            assert json.loads(denied_again['result'])[0]['content']['text'].splitlines() == ['NATIVE_OUTSIDE_DENIED']
            assert 'UNAPPROVED_SKILL_MARKER' not in json.dumps(calls)
    finally:
        server.shutdown();server.server_close();thread.join(timeout=5)


@pytest.mark.skipif(os.getenv('DEEPSEEK_ENGINE_TEST') != '1', reason='requires installed dsh CLI')
@pytest.mark.skipif(os.name != 'nt', reason='requires the native Windows ACL SDK')
def test_real_sdk_owner_rights_keep_capabilities_and_readonly_boundary(tmp_path):
    # Inspect an installed, trusted CLI shim; never run its text as a shell.
    shim = Path(shutil.which('dsh'))
    text = shim.read_text(encoding='utf-8') if shim.suffix.lower() in {'.cmd', '.bat'} else ''
    text = text.replace('%~dp0', str(shim.parent) + os.sep)
    quoted = [Path(value) for value in re.findall(r'"([A-Za-z]:[^"\r\n]+)"', text)]
    node = next((str(path) for path in quoted if path.name.lower() == 'node.exe' and path.is_file()),
                os.getenv('DEEPSEEK_TEST_NODE') or shutil.which('node'))
    entry = next((str(path) for path in quoted if path.suffix == '.js' and path.is_file()),
                 os.getenv('DEEPSEEK_TEST_ENTRY'))
    assert node and entry, 'Set DEEPSEEK_TEST_NODE / DEEPSEEK_TEST_ENTRY for an opaque dsh launcher'
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    (work / 'a').mkdir(mode=0o700); (work / 'b').mkdir(mode=0o700)
    outside = tmp_path / 'outside.txt'; outside.write_bytes(b'KEEP')
    inode = work.stat().st_ino
    async def check():
        async with native_owner_access(work):
            (work / 'b/keep.txt').write_bytes(b'KEEP')
            process = await asyncio.create_subprocess_exec(node,
                str(Path(__file__).parent / 'fixtures/dsh-owner-rights.mjs'), entry, str(work), str(outside),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), 90)
            finally:
                if process.returncode is None:
                    process.kill(); await process.wait()
            assert process.returncode == 0, (stdout.decode(errors='replace'), stderr.decode(errors='replace'))
            assert stderr == b''
            result = json.loads(stdout)
            assert result['inside'] == 'YES' and result['nested'] == 'CHILD'
            assert result['sibling'] == result['outside'] == 'KEEP'
        assert work.stat().st_ino == inode
        assert (work / 'b/keep.txt').read_bytes() == outside.read_bytes() == b'KEEP'
    asyncio.run(check())
