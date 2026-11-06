"""Drive real CLI pipes and the existing MCP gateway with an ACP fixture."""
import asyncio
from contextlib import aclosing
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.agent import deepseek
from opendirector.agent.context import RunContext
from opendirector.agent.runtime import AgentRuntimes
from opendirector.domain.projects import ProjectError
from opendirector_api.main import create_app
from opendirector.infrastructure.local_projects import LocalProjects

FAKE = r'''
import json, os, subprocess, sys
from pathlib import Path
assert sys.argv[1:3] == ['--profile','acp']
assert len(sys.argv) == 5 and sys.argv[3] == '--patch', sys.argv[1::2]
mode = os.getenv('DEEPSEEK_TEST', 'success')
sid = 'owned-session'
def write(record):
 print(json.dumps(dict(jsonrpc='2.0', **record)), flush=True)
def result(req, value): write(dict(id=req['id'], result=value))
def read(): return json.loads(sys.stdin.readline())
req=read(); assert req['method']=='initialize'
if mode == 'initialize_exit' and Path.cwd().name == 'work':
 print('ACP startup diagnostic', file=sys.stderr, flush=True)
 raise SystemExit(42)
result(req, dict(protocolVersion=0 if mode=='bad_version' else 1))
req=read(); assert req['method'] in {'session/new','session/resume'}
resumed=req['method']=='session/resume'
if resumed: assert req['params']['sessionId']==sid
workspace_marker = Path('.continuation-test')
if resumed:
 assert workspace_marker.read_text() == str(Path.cwd())
else:
 workspace_marker.write_text(str(Path.cwd()))
servers=req['params']['mcpServers']
assert Path(req['params']['cwd']).resolve() == Path.cwd(), req['params']['cwd']
model=dict(id='model',currentValue='route/default',options=[dict(group='route',options=[dict(value='route/default',name='Default model')])])
if mode=='efforts':
 model['options'][0]['options'].append(dict(value='route/other',name='Other model'))
reasoning=dict(id='reasoning_effort',options=[dict(value='low'),dict(value='high')])
result(req,dict(sessionId=sid,configOptions=[model]+([reasoning] if mode=='efforts' else [])))
for line in sys.stdin:
 req=json.loads(line)
 if req['method']=='session/set_config_option':
  assert req['params']['value'] in {'route/default','route/other'}
  model['currentValue']=req['params']['value']
  result(req, {'configOptions':[model]+([reasoning] if mode=='efforts' else [])})
 elif req['method']=='session/close':
  result(req,{}); break
 elif req['method']=='session/cancel':
  Path(os.environ['DEEPSEEK_CANCELLED']).write_text('cancelled') if 'DEEPSEEK_CANCELLED' in os.environ else None
 elif req['method']=='session/prompt':
  assert os.environ['PWD'] == str(Path.cwd())
  blocks=[block['text'] for block in req['params']['prompt']]
  if resumed:
   assert blocks[0].startswith('Execution directory:')
   assert not any('Conversation history' in block or 'You are OpenDirector' in block for block in blocks)
   assert 'Continue' in blocks[-1]
  else:
   assert blocks[0].startswith('You are OpenDirector') and str(Path.cwd()) in blocks[1]
   assert 'Continue' not in blocks[-1]
  text=blocks[-1]
  if mode!='wait':
   assert text.startswith('Current user request' + chr(10))
   assert 'Summarize the delivered result and material limitations.' in text
   assert 'User model preferences for this turn:' in text and 'selected-image' in text
  patch=json.loads(Path(sys.argv[sys.argv.index('--patch')+1]).read_text())
  assert next(row for row in patch if row['id']=='skill-filesystem')['config']['includeDefaultRoots'] is False
  if mode!='wait': assert list(Path('.agents/skills').glob('*/SKILL.md'))
  if mode=='wait':
   write(dict(method='session/update',params=dict(sessionId=sid,update=dict(sessionUpdate='agent_message_chunk',content=dict(type='text',text='Waiting')))))
   continue
  write(dict(method='session/update',params=dict(sessionId=sid,update=dict(sessionUpdate='agent_thought_chunk',content=dict(type='text',text='Test native thought')))))
  write(dict(method='session/update',params=dict(sessionId=sid,update=dict(sessionUpdate='plan',entries=[dict(content='Save the plan',priority='medium',status='in_progress')]))))
  if mode=='permission':
   write(dict(id='approval-1',method='session/request_permission',params=dict(sessionId=sid,options=[dict(optionId='allow',kind='allow_once'),dict(optionId='reject',kind='reject_once')])))
   answer=read()
   assert answer['result']['outcome']==dict(outcome='selected',optionId='reject')
  assert servers == []
  assert 'OPENDIRECTOR_AGENT_TOKEN' not in os.environ
  assert 'OPENDIRECTOR_AGENT_CONTEXT' not in os.environ
  context = json.loads(subprocess.check_output(['opendirector', 'project', 'show'], text=True))
  assert context['project']['id']
  outcome = json.loads(subprocess.check_output(['opendirector', 'asset', 'write-text', '--name', 'deepseek.md', '--text', 'CLI saved'], text=True))
  assert outcome['status'] == 'applied', outcome
  write(dict(method='session/update',params=dict(sessionId=sid,update=dict(sessionUpdate='tool_call',toolCallId='native-read',title='read',rawInput={'path':'file'},status='in_progress'))))
  write(dict(method='session/update',params=dict(sessionId=sid,update=dict(sessionUpdate='tool_call_update',toolCallId='native-read',status='completed',content=[]))))
  write(dict(method='session/update',params=dict(sessionId=sid,update=dict(sessionUpdate='plan',entries=[dict(content='Save the plan',priority='medium',status='completed')]))))
  write(dict(method='session/update',params=dict(sessionId=sid,update=dict(sessionUpdate='agent_message_chunk',content=dict(type='text',text='Saved.')))))
  result(req,dict(stopReason='max_tokens' if mode=='incomplete' else 'end_turn'))
'''


@pytest.fixture
def cli(tmp_path, monkeypatch):
    binary = tmp_path / 'dsh'
    binary.write_text(f'#!{sys.executable}\n' + FAKE)
    binary.chmod(0o755)
    monkeypatch.setenv('PATH', str(tmp_path) + os.pathsep + os.environ['PATH'])
    skill = tmp_path / '.opendirector/skills/example'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('---\nname: example\ndescription: Test\n---\nTest skill')
    async def fixture_skills(*args):
        return [{'name': 'example', 'description': 'Test', 'filePath': str(skill / 'SKILL.md')}]
    monkeypatch.setattr('opendirector_api.agent.skills', fixture_skills)
    return binary


def test_catalog_from_acp_config(cli):
    assert asyncio.run(deepseek.model_choices()) == [dict(id='route/default',label='Default model',efforts=[],isDefault=True)]


@pytest.mark.parametrize('mode', ['success', 'incomplete', 'permission'])
def test_acp_shared_write_and_native_trace(cli, tmp_path, monkeypatch, mode):
    monkeypatch.setenv('DEEPSEEK_TEST', mode)
    local = LocalProjects(tmp_path)
    with TestClient(create_app(local), headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        pid, turn = str(uuid4()), str(uuid4())
        path = '/api/creation/projects/' + pid
        assert client.post(path+'/commands',json=dict(type='project.create',projectId=pid,commandId=str(uuid4()),payload={'name':'DeepSeek'})).status_code == 200
        assert client.post(path+'/open').status_code == 200
        response = client.post(path+'/assistant/turns',json=dict(id=turn,runtime='deepseek',runtimeModel='route/default',text='Save',skills=['example'],modelSelections={'image':'selected-image'}))
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert (events[-1]['error'] is None) == (mode != 'incomplete'), events
        message = events[-1]['conversation']['messages'][-1]
        assert message['text'] == 'Saved.'
        assert {'type': 'thinking'} in events
        assert 'Test native thought' not in response.text
        assert message['plan'] == [{'content': 'Save the plan', 'status': 'completed'}]
        assert client.get(path + '/assistant').json()['messages'][-1]['plan'] == message['plan']
        assert any(tool['name']=='opendirector asset write-text' and tool['status']=='complete' for tool in message['tools'])
        assert any(tool['name']=='read' and tool['status']=='complete' for tool in message['tools'])
        assert not list(local.root.rglob('.opendirector-bin/context.json'))
        snapshot=client.get(path).json()
        assert snapshot['assets'][0]['provenance']['agentRuntime']=='deepseek'
        trace=next(local.root.rglob('*.deepseek.jsonl')).read_text()
        assert 'owned-session' in trace and 'session/update' in trace
        assert 'OPENDIRECTOR_AGENT_TOKEN' not in trace
        if mode == 'success':
            response = client.post(path+'/assistant/turns', json=dict(
                id=str(uuid4()), runtime='deepseek', runtimeModel='route/default', text='Continue',
                skills=['example'], modelSelections={'image': 'selected-image'}))
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            assert events[-1]['error'] is None, events



def test_cancel_acp_before_collecting_child(cli, tmp_path, monkeypatch):
    monkeypatch.setenv('DEEPSEEK_TEST','wait')
    cancelled=tmp_path/'cancelled'
    monkeypatch.setenv('DEEPSEEK_CANCELLED',str(cancelled))
    run=RunContext(runtime='deepseek',project_id=uuid4(),turn_id=uuid4(),session='test',directory=tmp_path,
        config=None,messages=[],selected_skills=[],skills=[])
    async def consume():
        runtimes=AgentRuntimes(None,None,None)
        async with aclosing(runtimes.stream(run)) as stream:
            async for event in stream:
                assert event['text']=='Waiting'
                break
    async def check():
        await asyncio.wait_for(consume(),10)
    asyncio.run(check())
    assert cancelled.read_text()=='cancelled'


def test_rejects_incompatible_acp_version(cli, monkeypatch):
    monkeypatch.setenv('DEEPSEEK_TEST', 'bad_version')
    with pytest.raises(ProjectError, match='ACP v1'):
        asyncio.run(deepseek.model_choices())


def test_native_desktop_model_overlay_is_private_and_respects_acp_overrides(tmp_path, monkeypatch):
    home = tmp_path / 'home'
    desktop = home / 'profiles/desktop/cordis.patch.yml'
    desktop.parent.mkdir(parents=True)
    native = [{'id':'llm-pi-ai','config':{'providers':[{'id':'kimi-coding'}]}},
        {'id':'agent-default-model','config':{'provider':'deepseek-official','model':'deepseek-flash'}},
        {'id':'ui-theme','config':{'preference':'dark'}}]
    desktop.write_text(json.dumps(native))
    acp = home / 'profiles/acp/cordis.patch.yml'
    acp.parent.mkdir(parents=True)
    acp.write_text('[]')
    private = tmp_path / 'private'
    private.mkdir()
    monkeypatch.setenv('DSH_HOME', str(home))
    monkeypatch.setattr(deepseek.shutil,'which',lambda _: '/installed/dsh')
    args = deepseek.arguments(private)
    patch = json.loads(Path(args[-1]).read_text())
    assert patch[:2] == [native[0], {'id':'acp','config':{'provider':'deepseek-official','model':'deepseek-flash'}}]
    assert all(row['id'] != 'ui-theme' for row in patch)
    assert json.loads(desktop.read_text()) == native
    acp.write_text(json.dumps([{'id':'llm-pi-ai','config':{}},{'id':'acp','config':{'provider':'other','model':'custom'}}]))
    args = deepseek.arguments(private)
    assert [row['id'] for row in json.loads(Path(args[-1]).read_text())] == ['skill-filesystem']


def test_selected_model_efforts_keep_native_default_identity(cli, monkeypatch):
    monkeypatch.setenv('DEEPSEEK_TEST', 'efforts')
    rows = asyncio.run(deepseek.model_choices('route/other'))
    assert rows[0]['isDefault'] is True and rows[0]['efforts'] == []
    assert rows[1]['isDefault'] is False and rows[1]['efforts'] == ['low', 'high']


def test_initialize_exit_records_stderr(cli, tmp_path, monkeypatch):
    monkeypatch.setenv('DEEPSEEK_TEST', 'initialize_exit')
    local = LocalProjects(tmp_path)
    with TestClient(create_app(local), headers={'X-OpenDirector-Request': '1',
            'X-OpenDirector-Session': str(uuid4())}) as client:
        pid, turn = str(uuid4()), str(uuid4())
        path = '/api/creation/projects/' + pid
        assert client.post(path + '/commands', json=dict(type='project.create', projectId=pid,
            commandId=str(uuid4()), payload={'name': 'DeepSeek exit'})).status_code == 200
        assert client.post(path + '/open').status_code == 200
        response = client.post(path + '/assistant/turns', json=dict(id=turn, runtime='deepseek', runtimeModel='route/default', text='Hello'))
        assert response.status_code == 200, response.text
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['error']
        trace = next(local.root.rglob(f'{turn}.deepseek.jsonl'))
        diagnostics = [json.loads(line).get('native', {}) for line in trace.read_text().splitlines()]
        assert any(item.get('exitCode') == 42 and 'ACP startup diagnostic' in item.get('stderr', '')
                   for item in diagnostics)
