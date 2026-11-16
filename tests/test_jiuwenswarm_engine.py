"""Opt-in real installed JiuwenSwarm; the LLM endpoint is a local protocol fixture."""
import json
import os
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.agent import jiuwenswarm as swarm
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app

pytestmark = pytest.mark.nightly


@pytest.mark.skipif(os.getenv('JIUWENSWARM_ENGINE_TEST') != '1', reason='requires installed JiuwenSwarm Process CLI')
def test_real_engine_shared_business_loop(tmp_path, monkeypatch):
    executable = swarm.executable()
    assert executable is not None
    # Use the executable itself so the machine-local wrapper cannot override
    # this fixture's config and data directories.
    binary = Path(executable).parent / 'venv/bin/jiuwenswarm-process' if Path(executable).name == 'run' else Path(executable)
    monkeypatch.setattr(swarm, 'executable', lambda: str(binary))
    monkeypatch.setenv('JIUWENSWARM_DATA_DIR', str(tmp_path / 'swarm-data'))
    monkeypatch.setenv('JIUWENSWARM_CONFIG_DIR', str(tmp_path / 'swarm-data/config'))
    requests = []
    steps = [
        ('bash', {'command': 'opendirector project show'}),
        ('bash', {'command': 'opendirector asset write-text --help'}),
        ('bash', {'command': 'opendirector asset write-text --name engine.md --text "Real engine, local model fixture"' if os.name == 'nt' else "opendirector asset write-text --name engine.md --text 'Real engine, local model fixture'"}),
    ]
    class Model(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            index = len(requests)
            requests.append(request)
            assert self.path == '/v1/chat/completions'
            if index < len(steps):
                name, arguments = steps[index]
                call = dict(index=0, id=f'engine-call-{index}', type='function', function=dict(name=name, arguments=json.dumps(arguments)))
                delta, reason = dict(role='assistant', tool_calls=[call]), 'tool_calls'
            else:
                delta, reason = dict(role='assistant', content='Engine finished.'), 'stop'
            response = dict(id=f'completion-{index}', object='chat.completion', created=1, model='fixture-model',
                choices=[dict(index=0, message=delta, finish_reason=reason)], usage=dict(prompt_tokens=10, completion_tokens=5, total_tokens=15))
            self.send_response(200)
            if request.get('stream'):
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                for chunk, finish in [(delta, None), ({}, reason)]:
                    event = dict(id=f'completion-{index}', object='chat.completion.chunk', created=1,
                        model='fixture-model', choices=[dict(index=0, delta=chunk, finish_reason=finish)])
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(response).encode())
            self.wfile.flush()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = tmp_path / 'swarm-data/config'
    config.mkdir(parents=True)
    (config / 'config.yaml').write_text(json.dumps({
        'preferred_language': 'en', 'progressive_tool_enabled': False,
        'rsi': {'enabled': False}, 'auto_recap': {'enabled': False},
        'models': {'defaults': [{'model_id': 'fixture', 'is_default': True,
            'model_client_config': {'api_base': f'http://127.0.0.1:{server.server_port}/v1',
                'api_key': 'fixture-not-a-secret', 'model_name': 'fixture-model', 'client_provider': 'OpenAI'},
            'model_config_obj': {}}]},
    }))
    try:
        local = LocalProjects(tmp_path / 'opendirector')
        with TestClient(create_app(local), headers={
            'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
            pid, turn = str(uuid4()), str(uuid4())
            root = '/api/creation/projects/' + pid
            created = client.post(root + '/commands', json=dict(type='project.create', projectId=pid,
                commandId=str(uuid4()), payload=dict(name='Real engine')))
            assert created.status_code == 200, created.text
            assert client.post(root + '/open').status_code == 200
            response = client.post(root + '/assistant/turns', json=dict(id=turn,
                runtime='jiuwenswarm', runtimeModel='fixture-model#0', text='Read the project, inspect the command schema, then save the text plan.'))
            stream = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            assert stream[-1]['error'] is None, stream[-1]
            assert stream[-1]['conversation']['messages'][-1]['text'] == 'Engine finished.'
            snapshot = client.get(root).json()
            assert len(snapshot['assets']) == 1
            assert snapshot['assets'][0]['provenance']['agentRuntime'] == 'jiuwenswarm'
            assert snapshot['assets'][0]['provenance']['agentRunId'] == turn
            assert (local.root / 'Real engine' / snapshot['assets'][0]['path']).read_text() == 'Real engine, local model fixture'
            assert len(requests) == 4
            assert requests[-1]['messages'][-1]['role'] == 'tool'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
