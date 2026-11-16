import asyncio
from contextlib import aclosing
import json
from pathlib import Path
import sys
from uuid import uuid4

import pytest
from process_helpers import python_cli
from fastapi.testclient import TestClient

from opendirector.agent import jiuwenswarm as jiuwen
from opendirector.agent.catalog import model_choices
from opendirector.agent.context import RunContext
from opendirector.agent.runtime import AgentRuntimes
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app


FAKE = r'''import json, os, shutil, subprocess, sys, time
from pathlib import Path
request = json.loads(sys.stdin.readline())
assert request['schema_version'] == '0.1'
seq = 0
sid = None
mode = os.environ.get('JIUWEN_TEST', 'success')
def emit(kind, **fields):
 global seq
 print(json.dumps(dict(schema_version='0.1', type=kind, sequence=seq,
  request_id=request['request_id'], session_id=sid, **fields)), flush=True)
 seq += 1
if sys.argv[1] == '--query-json':
 if mode == 'bad_json':
  print('invalid', flush=True)
  raise SystemExit()
 if mode == 'bad_sequence': seq = 2
 if mode == 'stderr': sys.stderr.write('x' * 262144)
 data = {'schema_version':'0.1','features':dict.fromkeys(['host_tools','cancel','run_skills','custom_agent'], True)} if request['operation'] == 'protocol.capabilities' else {'models':[{'selection_key':'local#0','display_name':'Local model','is_default':True}]}
 emit('query_result',operation=request['operation'],status='completed',exit_code=0,data=data,error=None)
 raise SystemExit()
assert sys.argv[1:] == ['--run-jsonl']
assert not {'mode', 'permissions', 'timeout_seconds'} & request.keys()
assert 'trusted_dirs' not in request['workspace']
state = Path(os.environ['JIUWENSWARM_DATA_DIR'])
assert sorted(p.name for p in (state/'agent/workspace/skills').iterdir()) == ['example']
assert 'private-test-key' in (Path(os.environ['JIUWENSWARM_CONFIG_DIR'])/'config.yaml').read_text()
assert 'private-test-key' not in json.dumps(request)
assert '*' not in request['agent']['tools']
assert 'skill_tool' in request['agent']['tools']
assert request['mcp'] == []
assert request['skills'] == ['example']
sid='native-session'
if 'Continue plan' in request['input']:
 assert request['session_id']==sid and 'Save plan' not in request['input']
else:
 assert 'session_id' not in request
workspace_marker = Path('.continuation-test')
if 'Continue plan' in request['input']:
 assert workspace_marker.read_text() == str(Path.cwd())
else:
 workspace_marker.write_text(str(Path.cwd()))
if mode == 'quota':
 emit('result',status='failed',exit_code=1,error={'code':'RUNTIME_ERROR','message':'HTTP 429: Token Plan quota exceeded (2056)'},output=None)
 raise SystemExit(1)
if mode == 'interaction':
 emit('event',event_type='interaction.requested',payload={'interaction_id':'ask-1','interaction':{'source':'ask_user','questions':[{'question':'Choose a source'}]}})
 sys.stdin.readline()
 raise SystemExit()
if mode == 'wait':
 emit('event',event_type='chat.delta',payload={'text':'Waiting'})
 control=json.loads(sys.stdin.readline())
 assert control['type']=='cancel'
 emit('result',status='cancelled',exit_code=130,error={'code':'CANCELLED'},output='Waiting')
 raise SystemExit(130)
assert request['host_tools'] == []
cli = shutil.which('opendirector')
assert cli and Path(cli).parent.samefile(Path.cwd() / '.opendirector-bin')
outcome = json.loads(subprocess.check_output([cli, 'asset', 'write-text', '--name', 'plan.md', '--text', 'Native plan'], text=True))
assert outcome['status'] == 'applied', outcome
emit('event',event_type='chat.tool_call',payload={'tool':{'call_id':'skill-1','name':'skill_tool','arguments':{'skill_name':'example'},'status':'started','result':None}})
emit('event',event_type='chat.tool_result',payload={'tool':{'call_id':'skill-1','name':'skill_tool','arguments':None,'status':'completed','result':'Skill body'}})
delta = '' if mode == 'final_only' else 'Saved.'
if mode in ('final_only', 'separate_final'):
 final = 'Final answer.'
elif mode == 'full_final':
 final = 'Saved.Final answer.'
else:
 final = 'Saved.'
if delta: emit('event',event_type='chat.delta',payload={'text':delta})
emit('event',event_type='chat.final',payload={'text':final})
if mode == 'partial': raise SystemExit()
output = final if final.startswith(delta) else delta + final
emit('result',status='completed',exit_code=0,error=None,output=output)
'''


@pytest.fixture
def cli(tmp_path, monkeypatch):
    binary = tmp_path / 'jiuwenswarm-process'
    binary = python_cli(binary, FAKE)
    binary.chmod(0o755)
    monkeypatch.setattr(jiuwen, 'executable', lambda: str(binary))
    state = tmp_path / 'native'
    (state / 'config').mkdir(parents=True)
    (state / 'config/config.yaml').write_text('private-test-key')
    monkeypatch.setenv('JIUWENSWARM_DATA_DIR', str(state))
    skill = tmp_path / 'example'
    skill.mkdir()
    (skill / 'SKILL.md').write_text('---\nname: example\ndescription: Test\n---\nRead resource.txt')
    (skill / 'resource.txt').write_text('Native skill resource')
    return skill


def test_catalog_cli_pipes(cli):
    assert asyncio.run(model_choices('jiuwenswarm')) == [
        {'id':'local#0', 'label':'Local model', 'efforts':[], 'isDefault':True}]


@pytest.mark.parametrize(('mode', 'expected'), [('success', 'Saved.'), ('partial', 'Saved.'),
    ('final_only', 'Final answer.'), ('separate_final', 'Saved.Final answer.'),
    ('full_final', 'Saved.Final answer.')])
@pytest.mark.merge
def test_project_write_and_trace(cli, tmp_path, monkeypatch, mode, expected):
    monkeypatch.setenv('JIUWEN_TEST', mode)
    async def skills(*args):
        return [{'name':'example','description':'Test','filePath':str(cli/'SKILL.md'),'source':'project'}]
    monkeypatch.setattr('opendirector_api.agent.skills', skills)
    monkeypatch.setattr('opendirector_api.agent.runtime_available', lambda _: True)
    local = LocalProjects(tmp_path / 'project')
    with TestClient(create_app(local), headers={'X-OpenDirector-Request':'1', 'X-OpenDirector-Session':str(uuid4())}) as client:
        pid = str(uuid4())
        path = '/api/creation/projects/' + pid
        assert client.post(path+'/commands', json={'type':'project.create','projectId':pid,'commandId':str(uuid4()),'payload':{'name':'Jiuwen'}}).status_code == 200
        assert client.post(path+'/open').status_code == 200
        tid = str(uuid4())
        response=client.post(path+'/assistant/turns', json={'id':tid,'runtime':'jiuwenswarm','text':'Save plan','skills':['example']})
        assert response.status_code == 200
        events=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert (events[-1]['error'] is None) == (mode != 'partial'), events
        assert events[-1]['conversation']['messages'][-1]['status'] == ('interrupted' if mode == 'partial' else 'complete')
        message=events[-1]['conversation']['messages'][-1]
        assert message['text']==expected
        assert message['tools'][0]['status']=='complete'
        assert message['tools'][1]['name']=='skill_tool'
        assert message['tools'][1]['status']=='complete'
        asset=client.get(path).json()['assets'][0]
        assert asset['provenance']['agentRuntime']=='jiuwenswarm'
        assert asset['provenance']['agentRunId']==tid
        trace=next(local.root.rglob('*.jiuwenswarm.jsonl')).read_text()
        assert 'native-session' in trace
        assert 'private-test-key' not in trace
        assert not list(local.root.rglob('config.yaml'))
        if mode == 'success':
            response = client.post(path+'/assistant/turns', json={
                'id':str(uuid4()), 'runtime':'jiuwenswarm', 'text':'Continue plan', 'skills':['example']})
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            assert events[-1]['error'] is None, events



def test_cancel_collects_child(cli, tmp_path, monkeypatch):
    monkeypatch.setenv('JIUWEN_TEST','wait')
    run=RunContext(runtime='jiuwenswarm',project_id=uuid4(),turn_id=uuid4(),session='test',directory=tmp_path/'project',config=None,messages=[],selected_skills=['example'],skills=[{'name':'example','filePath':str(cli/'SKILL.md')}])
    async def cancel():
        runtimes=AgentRuntimes(None,None,None)
        async def consume():
            async with aclosing(runtimes.stream(run)) as stream:
                async for event in stream:
                    assert event['text']=='Waiting'
                    asyncio.current_task().cancel()
                    await asyncio.sleep(0)
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(consume(),10)
    asyncio.run(cancel())
    assert list(tmp_path.rglob('config.yaml')) == [tmp_path / 'native/config/config.yaml']
    trace = next(tmp_path.rglob('*.jiuwenswarm.jsonl')).read_text()
    assert '"status": "cancelled"' in trace


@pytest.mark.parametrize('mode', ['bad_json', 'bad_sequence'])
def test_query_rejects_invalid_protocol(cli, monkeypatch, mode):
    monkeypatch.setenv('JIUWEN_TEST', mode)
    with pytest.raises(ProjectError, match='查询失败'):
        asyncio.run(jiuwen.query('protocol.capabilities'))


def test_query_drains_stderr(cli, monkeypatch):
    monkeypatch.setenv('JIUWEN_TEST', 'stderr')
    assert asyncio.run(jiuwen.query('protocol.capabilities'))['schema_version'] == '0.1'


def test_interaction_is_recorded_without_approval(cli, tmp_path, monkeypatch):
    monkeypatch.setenv('JIUWEN_TEST', 'interaction')
    run = RunContext(runtime='jiuwenswarm', project_id=uuid4(), turn_id=uuid4(), session='test',
        directory=tmp_path/'project', config=None, messages=[], selected_skills=['example'],
        skills=[{'name':'example', 'filePath':str(cli/'SKILL.md')}])
    async def consume():
        runtimes = AgentRuntimes(None, None, None)
        with pytest.raises(ProjectError, match='用户交互'):
            async for _ in runtimes.stream(run):
                pass
    asyncio.run(consume())
    trace = next(tmp_path.rglob('*.jiuwenswarm.jsonl')).read_text()
    assert 'interaction.requested' in trace and 'Choose a source' in trace


def test_native_failure_reason_reaches_caller(cli, tmp_path, monkeypatch):
    monkeypatch.setenv('JIUWEN_TEST', 'quota')
    run = RunContext(runtime='jiuwenswarm', project_id=uuid4(), turn_id=uuid4(), session='test',
        directory=tmp_path/'project', config=None, messages=[], selected_skills=['example'],
        skills=[{'name':'example', 'filePath':str(cli/'SKILL.md')}])
    async def consume():
        runtimes = AgentRuntimes(None, None, None)
        async with aclosing(runtimes.stream(run)) as stream:
            async for _ in stream:
                pass
    with pytest.raises(ProjectError, match='HTTP 429: Token Plan quota exceeded'):
        asyncio.run(consume())
    assert '2056' in next(tmp_path.rglob('*.jiuwenswarm.jsonl')).read_text()
