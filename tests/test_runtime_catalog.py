import asyncio
import json
import sys

import pytest
from process_helpers import python_cli

from opendirector.agent import catalog
from opendirector.domain.projects import ProjectError


@pytest.mark.parametrize('engine', ['codex', 'claude'])
def test_native_model_catalog(tmp_path, monkeypatch, engine):
    script = tmp_path / 'cli'
    script = python_cli(script, f'''#!{sys.executable}
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'initialize':
        response = {{'id': request['id'], 'result': {{}}}}
    elif request.get('method') == 'initialized':
        continue
    elif request.get('method') == 'config/read':
        response = {{'id': request['id'], 'result': {{'config': {{}}}}}}
    elif request.get('method') == 'model/list':
        response = {{'id': request['id'], 'result': {{'data': [{{'model':'native-model', 'displayName':'Native Model', 'supportedReasoningEfforts':[{{'reasoningEffort':'high'}}]}}], 'nextCursor':None}}}}
    else:
        assert request['request'] == {{'subtype':'initialize'}}
        response = {{'type':'control_response', 'response':{{'subtype':'success','request_id':request['request_id'],'response':{{'models':[{{'value':'native-model','displayName':'Native Model'}},{{'value':'disabled','disabled':True}}]}}}}}}
    print(json.dumps(response), flush=True)
''')
    script.chmod(0o755)
    monkeypatch.setattr(catalog, 'executable', lambda _: str(script))
    result = asyncio.run(catalog.model_choices(engine))
    assert result == [{'id': 'native-model', 'label': 'Native Model', 'efforts': ['high'] if engine == 'codex' else []}]


def test_uninstalled_catalog(monkeypatch):
    monkeypatch.setattr(catalog, 'executable', lambda _: None)
    with pytest.raises(ProjectError, match='尚未安装'):
        asyncio.run(catalog.model_choices('codex'))


def test_opencode_native_catalog(tmp_path, monkeypatch):
    script = tmp_path / 'opencode'
    script = python_cli(script, f'#!{sys.executable}\nimport sys\nif sys.argv[1:] == ["debug", "config"]: print("{{}}")\nelse: print("local/my-model\\nopencode/free-model")\n')
    script.chmod(0o755)
    monkeypatch.setattr(catalog, 'executable', lambda _: str(script))
    assert asyncio.run(catalog.model_choices('opencode')) == [
        {'id': 'local/my-model', 'label': 'local/my-model', 'efforts': []},
        {'id': 'opencode/free-model', 'label': 'opencode/free-model', 'efforts': []}]


@pytest.mark.parametrize('engine', ['codex', 'claude'])
def test_catalog_marks_the_configured_default(tmp_path, monkeypatch, engine):
    script = tmp_path / 'cli'
    script = python_cli(script, f'''#!{sys.executable}
import sys,json
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize': result={{}}
    elif request.get('method') == 'initialized': continue
    elif request.get('method') == 'config/read': result={{'config':{{'model':'configured-model'}}}}
    elif request.get('method') == 'model/list': result={{'data':[
      {{'model':'built-in','displayName':'Built in','isDefault':True}},
      {{'model':'configured-model','displayName':'Configured'}}]}}
    else:
        print(json.dumps({{'type':'control_response','response':{{'subtype':'success','request_id':request['request_id'],
          'response':{{'models':[{{'value':'default','resolvedModel':'configured-model','displayName':'Default'}}]}}}}}}),flush=True)
        continue
    print(json.dumps({{'id':request['id'],'result':result}}),flush=True)
''')
    script.chmod(0o755)
    monkeypatch.setattr(catalog, 'executable', lambda _: str(script))
    rows = asyncio.run(catalog.model_choices(engine))
    defaults = [item for item in rows if item.get('isDefault')]
    assert len(defaults) == 1
    assert defaults[0]['label'] == ('Configured' if engine == 'codex' else 'configured-model')


def test_opencode_default_prefers_config_over_recent(tmp_path, monkeypatch):
    script = tmp_path / 'cli'
    script = python_cli(script, f'''#!{sys.executable}
import sys,json
print(json.dumps({{'model':'local/configured'}}) if sys.argv[1:]==['debug','config'] else 'local/recent\\nlocal/configured')
''')
    script.chmod(0o755)
    monkeypatch.setattr(catalog, 'executable', lambda _: str(script))
    monkeypatch.setenv('XDG_STATE_HOME', str(tmp_path))
    state = tmp_path / 'opencode'
    state.mkdir()
    (state / 'model.json').write_text(json.dumps({'recent':[{'providerID':'local','modelID':'recent'}]}))
    assert [item['id'] for item in asyncio.run(catalog.model_choices('opencode')) if item.get('isDefault')] == ['local/configured']


def test_codex_default_is_forwarded_to_isolated_launch(tmp_path, monkeypatch):
    from uuid import uuid4
    from opendirector.agent.context import RunContext
    from opendirector.agent.runtime import AgentRuntimes
    async def models(engine):
        return [{'id': 'configured-model', 'isDefault': True}]
    monkeypatch.setattr(catalog, 'model_choices', models)
    runtimes = AgentRuntimes(None, None, None)
    seen = []
    async def stream(run, gateway):
        seen.append(run.runtime_model)
        yield {'type': 'delta', 'text': 'ok'}
    runtimes.adapter.stream = stream
    run = RunContext(runtime='codex', project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
        directory=tmp_path, config=None, messages=[], selected_skills=[])
    async def consume():
        return [event async for event in runtimes.stream(run)]
    asyncio.run(consume())
    assert seen == ['configured-model']
    assert run.runtime_model is None


@pytest.mark.parametrize('configured_providers, expected', [
    ([], 'native/ranked-model'), (['local'], 'local/local-default')])
def test_opencode_fallback_uses_native_provider_defaults(tmp_path, monkeypatch, configured_providers, expected):
    script = tmp_path / 'cli'
    script = python_cli(script, f'''#!{sys.executable}
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
if sys.argv[1] == 'models':
    print('native/alphabetical-first\\nnative/ranked-model\\nlocal/local-default')
elif sys.argv[1:3] == ['debug', 'config']:
    print(json.dumps({{'provider':dict.fromkeys({configured_providers!r}, {{}})}}))
else:
    assert sys.argv[1:] == ['serve','--pure','--hostname','127.0.0.1','--port','0']
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == '/config/providers'
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({{'providers':[{{'id':'native'}},{{'id':'local'}}],
                'default':{{'native':'ranked-model','local':'local-default'}}}}).encode())
        def log_message(self, *args): pass
    server=HTTPServer(('127.0.0.1',0),Handler)
    print('opencode server listening on http://127.0.0.1:'+str(server.server_port),flush=True)
    server.serve_forever()
''')
    script.chmod(0o755)
    monkeypatch.setattr(catalog, 'executable', lambda _: str(script))
    monkeypatch.setenv('XDG_STATE_HOME', str(tmp_path))
    state = tmp_path / 'opencode'
    state.mkdir()
    (state / 'model.json').write_text(json.dumps({'recent':[
        {'providerID':'removed','modelID':'stale-model'}]}))
    rows = asyncio.run(catalog.model_choices('opencode'))
    assert [row['id'] for row in rows if row.get('isDefault')] == [expected]
