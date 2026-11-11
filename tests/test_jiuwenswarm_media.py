"""Real skill, native tools, FFmpeg, publication and reopen; scripted local LLM."""
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import base64
import re
import shutil
import subprocess
import sys
import threading
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from process_helpers import project_heartbeat

from opendirector.agent import jiuwenswarm as swarm
from opendirector_api.main import create_app
from opendirector.infrastructure.local_projects import LocalProjects


pytestmark = pytest.mark.skipif(os.getenv('JIUWENSWARM_ENGINE_TEST') != '1', reason='requires installed JiuwenSwarm and FFmpeg')

def native_shell_command(args):
    return subprocess.list2cmdline(args) if os.name == 'nt' else shlex.join(args)


SCRIPT = '''# MEDIA_SCRIPT_MARKER
import json, subprocess, sys
from pathlib import Path
settings = json.loads(Path(__file__).with_name('media.json').read_text())
source, output = Path(sys.argv[1]), Path(sys.argv[2])
subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(source), '-t', '1',
    '-vf', 'scale=64:48,fps=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', str(output / 'clip.mp4')], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(output / 'clip.mp4'),
    '-frames:v', '1', str(output / 'poster.png')], check=True)
print(settings['marker'], 'MEDIA_PROCESSING_FINISHED')
'''


def unpack(value):
    """Unwrap the actual tool message returned to the local model."""
    if isinstance(value, str):
        try:
            return unpack(json.loads(value))
        except ValueError:
            # Current native CLI wraps stdout in an execution transcript.
            # Only a complete, clean, successful transcript may yield a receipt.
            pattern = (r'Command: [^\r\n]+\r?\n\s*Stdout: ([\s\S]*?)'
                r'\r?\n\s*Stderr: \(empty\)\r?\n\s*Exit Code: 0\s*')
            match = re.fullmatch(pattern, value)
            if match:
                try:
                    return {'native_stdout': unpack(json.loads(match[1])), 'native_exit_code': 0}
                except ValueError:
                    pass
            return value
    if isinstance(value, list):
        return [unpack(item) for item in value]
    if isinstance(value, dict):
        return {key: unpack(item) for key, item in value.items()}
    return value


def find(value, predicate):
    if isinstance(value, dict):
        if predicate(value):
            return value
        children = value.values()
    elif isinstance(value, list):
        children = value
    else:
        return None
    return next((found for item in children if (found := find(item, predicate)) is not None), None)


def test_native_skill_media_publication_and_project_reopen(tmp_path, monkeypatch):
    assert shutil.which('ffmpeg') and shutil.which('ffprobe')
    executable = swarm.executable()
    assert executable is not None
    binary = Path(executable).parent / 'venv/bin/jiuwenswarm-process' if Path(executable).name == 'run' else Path(executable)
    monkeypatch.setattr(swarm, 'executable', lambda: str(binary))
    native_data = tmp_path / 'swarm-data'
    monkeypatch.setenv('JIUWENSWARM_DATA_DIR', str(native_data))
    monkeypatch.setenv('JIUWENSWARM_CONFIG_DIR', str(native_data / 'config'))
    local = LocalProjects(tmp_path / 'application')
    skill = local.repository / '.opendirector/skills/media-fixture'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('---\nname: media-fixture\ndescription: Test media processing\n---\nMEDIA_SKILL_MARKER\nRead media.json and process.py, then preserve the source and process it in the execution directory.')
    (skill / 'media.json').write_text(json.dumps({'marker':'MEDIA_RESOURCE_MARKER'}))
    (skill / 'process.py').write_text(SCRIPT)
    skill_hashes = {p.name: sha256(p.read_bytes()).hexdigest() for p in skill.iterdir()}
    source_file = tmp_path / 'source.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=12',
        '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source_file)], check=True)
    original_hash = sha256(source_file.read_bytes()).hexdigest()
    pid, turn, session = str(uuid4()), str(uuid4()), str(uuid4())
    root = '/api/creation/projects/' + pid
    directory = local.root / 'Media loop'
    work = directory / 'agent-runs' / turn / 'work'
    requests, failures, steps = [], [], []
    published = {}

    def reference(asset):
        return dict(assetId=asset['id'], revision=asset['revision'], fingerprint=asset['fingerprint'], kind=asset['kind'])

    def reply(request):
        index = len(requests) - 1
        if index:
            last = next(message for message in reversed(request['messages']) if message['role'] == 'tool')
            result = unpack(last['content'])
            detail = json.dumps(result)
            previous = steps[index - 1][0]
            if index == 1:
                assert 'MEDIA_SKILL_MARKER' in detail
            elif index == 2:
                assert 'MEDIA_RESOURCE_MARKER' in detail
            elif index == 3:
                assert 'MEDIA_SCRIPT_MARKER' in detail
            elif index == 5:
                assert 'INTENTIONAL_MEDIA_FAILURE' in detail
            elif index == 6:
                assert 'MEDIA_PROCESSING_FINISHED' in detail
            if previous == 'execute_command':
                receipt = find(result, lambda item: 'changed' in item and item.get('status') in {'applied', 'rejected'})
                assert receipt is not None and receipt['status'] == 'applied', result
            if previous == 'read_project':
                project = find(result, lambda item: isinstance(item.get('assets'), list) and 'canvasItems' in item)
                assert project is not None, result
                published.update({asset['name']: reference(asset) for asset in project['assets']})
        if index == len(steps):
            return None
        name, arguments = steps[index]
        arguments = arguments() if callable(arguments) else arguments
        if name == 'read_project':
            name, arguments = 'bash', {'command': 'opendirector project show'}
        elif name == 'command_schema':
            namespace, action = arguments['type'].split('.', 1)
            from opendirector.cli import kebab
            name, arguments = 'bash', {'command': f'opendirector {kebab(namespace)} {kebab(action)} --help'}
        elif name == 'execute_command':
            namespace, action = arguments['type'].split('.', 1)
            from opendirector.cli import kebab
            body = json.dumps(arguments)
            if os.name == 'nt':
                encoded = base64.b64encode(body.encode()).decode()
                stdin = native_shell_command([sys.executable, '-c',
                    f"import base64,sys; sys.stdout.buffer.write(base64.b64decode('{encoded}'))"])
            else:
                stdin = 'printf %s ' + shlex.quote(body)
            name, arguments = 'bash', {'command': stdin +
                f' | opendirector {kebab(namespace)} {kebab(action)} --file -'}
        names = {tool['function']['name'] for tool in request['tools']}
        assert name in names, (name, names)
        return name, arguments() if callable(arguments) else arguments

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            try:
                if request.get('tools'):
                    requests.append(request)
                    call = reply(request)
                else:
                    call = None
            except Exception as error:
                failures.append(repr(error))
                call = None
            index = len(requests)
            if call:
                name, arguments = call
                delta = dict(role='assistant', tool_calls=[dict(index=0, id=f'media-{index}', type='function',
                    function=dict(name=name, arguments=json.dumps(arguments)))])
                reason = 'tool_calls'
            else:
                delta, reason = dict(role='assistant', content='Media finished.'), 'stop'
            self.send_response(200)
            if request.get('stream'):
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                for chunk, finish in [(delta, None), ({}, reason)]:
                    response = dict(id=f'completion-{index}', object='chat.completion.chunk', created=1,
                        model='fixture-model', choices=[dict(index=0, delta=chunk, finish_reason=finish)])
                    self.wfile.write(('data: ' + json.dumps(response) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = dict(id=f'completion-{index}', object='chat.completion', created=1, model='fixture-model',
                    choices=[dict(index=0, message=delta, finish_reason=reason)], usage=dict(prompt_tokens=10, completion_tokens=5, total_tokens=15))
                self.wfile.write(json.dumps(response).encode())
            self.wfile.flush()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (native_data / 'config').mkdir(parents=True)
    (native_data / 'config/config.yaml').write_text(json.dumps({
        'preferred_language':'en', 'progressive_tool_enabled':False,
        'rsi':{'enabled':False}, 'auto_recap':{'enabled':False},
        'models':{'defaults':[{'model_id':'fixture', 'is_default':True,
            'model_client_config':{'api_base':f'http://127.0.0.1:{server.server_port}/v1',
                'api_key':'media-fixture-key', 'model_name':'fixture-model', 'client_provider':'OpenAI'}, 'model_config_obj':{}}]},
    }))
    headers = {'X-OpenDirector-Request':'1', 'X-OpenDirector-Session':session}
    try:
        with TestClient(create_app(local), headers=headers) as client:
            assert client.post(root + '/commands', json=dict(type='project.create', projectId=pid,
                commandId=str(uuid4()), payload={'name':'Media loop'})).status_code == 200
            assert client.post(root + '/open').status_code == 200
            handle = str(uuid4())
            upload = client.put(root + '/uploads/' + handle, content=source_file.read_bytes(), headers={'X-Asset-Name':'source.mp4'})
            assert upload.status_code == 200, upload.text
            imported = client.post(root + '/commands', json=dict(type='asset.import', projectId=pid,
                commandId=str(uuid4()), payload=dict(uploadHandle=handle, name='source.mp4', expectedKind='video')))
            assert imported.status_code == 200, imported.text
            source = client.get(root).json()['assets'][0]
            source_path = directory / source['path']
            catalog = client.get(root + '/assistant/skills').json()
            assert 'media-fixture' in {item['name'] for item in catalog}
            source_ref = reference(source)
            snapshot_skill = work / '.agents/skills/media-fixture'
            steps.extend([
                ('read_file', {'file_path':str(snapshot_skill / 'SKILL.md')}),
                ('read_file', {'file_path':str(snapshot_skill / 'media.json')}),
                ('read_file', {'file_path':str(snapshot_skill / 'process.py')}),
                ('bash', {'command':native_shell_command([sys.executable, '-c', 'from pathlib import Path; Path(' + repr(str(work / 'manifest.json')) + ').write_text(' + repr(json.dumps({'created_by':'native_bash'})) + ')'])}),
                ('bash', {'command':'echo INTENTIONAL_MEDIA_FAILURE & exit /b 7' if os.name == 'nt' else 'printf INTENTIONAL_MEDIA_FAILURE; exit 7'}),
                ('bash', {'command':native_shell_command([sys.executable, str(snapshot_skill / 'process.py'), str(source_path), str(work)])}),
                ('command_schema', {'type':'artifact.publish'}),
                ('execute_command', {'type':'artifact.publish', 'payload':{'path':'clip.mp4', 'name':'clip.mp4', 'expectedKind':'video', 'sources':[source_ref]}}),
                ('execute_command', {'type':'artifact.publish', 'payload':{'path':'poster.png', 'name':'poster.png', 'expectedKind':'image', 'sources':[source_ref]}}),
                ('read_project', {}),
                ('command_schema', {'type':'canvas.show'}),
                ('execute_command', lambda: {'type':'canvas.show', 'payload':{'item':{'id':str(uuid4()), 'projectId':pid,
                    'kind':'video', 'title':'Processed clip', 'position':{'x':0, 'y':0},
                    'binding':{'role':'material', 'objectRef':published['clip.mp4']}}}}),
                ('execute_command', lambda: {'type':'canvas.show', 'payload':{'item':{'id':str(uuid4()), 'projectId':pid,
                    'kind':'image', 'title':'Extracted frame', 'position':{'x':360, 'y':0},
                    'binding':{'role':'material', 'objectRef':published['poster.png']}}}}),
            ])
            with project_heartbeat(client, pid, session):
                response = client.post(root + '/assistant/turns', json=dict(id=turn, runtime='jiuwenswarm',
                    runtimeModel='fixture-model#0', skills=['media-fixture'], assets=[source['id']], text='Use the media skill to process and publish the clip and extracted frame.'))
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            assert not failures, failures
            assert events[-1]['error'] is None, events[-1]
            assert len(requests) == len(steps) + 1
            snapshot = client.get(root).json()
            assert len(snapshot['assets']) == 3 and len(snapshot['canvasItems']) == 2
            outputs = [asset for asset in snapshot['assets'] if asset['id'] != source['id']]
            for asset in outputs:
                assert asset['provenance']['agentRuntime'] == 'jiuwenswarm'
                assert asset['provenance']['agentRunId'] == turn
                assert asset['provenance']['sources'] == [source_ref]
                assert (directory / asset['path']).read_bytes() == (work / asset['name']).read_bytes()
            video = next(asset for asset in outputs if asset['kind'] == 'video')
            assert video['metadata']['width'] == 64 and video['metadata']['height'] == 48
            assert video['metadata']['frameRate'] == 24 and video['metadata']['durationSeconds'] == pytest.approx(1, abs=.05)
            probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(directory / video['path'])]))
            assert probe['streams'][0]['codec_name'] == 'h264'
            assert json.loads((work / 'manifest.json').read_text())['created_by'] == 'native_bash'
            assert sha256(source_path.read_bytes()).hexdigest() == original_hash
            assert {p.name:sha256(p.read_bytes()).hexdigest() for p in skill.iterdir()} == skill_hashes
            activities = events[-1]['conversation']['messages'][-1]['tools']
            assert {'read_file', 'bash'} <= {item['name'] for item in activities}
            assert any(item['name'] == 'bash' and item['status'] == 'failed' for item in activities)
            mutations = [item for item in activities
                if (item.get('arguments') or {}).get('type') in {'artifact.publish', 'canvas.show'}]
            assert [item['arguments']['type'] for item in mutations] == [
                'artifact.publish', 'artifact.publish', 'canvas.show', 'canvas.show']
            assert all(item['status'] == 'complete' for item in mutations)
            lookups = [item for item in activities if (item.get('arguments') or {}).get('type') == 'object.get']
            assert len(lookups) == 2
            assert {item['arguments']['objectId'] for item in lookups} == {item['id'] for item in snapshot['canvasItems']}
            assert all(item['arguments']['revision'] == 1 for item in lookups)
            assert client.delete('/api/creation/sessions/' + session).status_code == 200
        # New backend objects and a new edit session must recover persisted facts.
        with TestClient(create_app(LocalProjects(local.repository)), headers={**headers, 'X-OpenDirector-Session':str(uuid4())}) as reopened:
            restored = reopened.post(root + '/open').json()
            assert restored == snapshot
            saved = reopened.get(root + '/assistant').json()
            assert saved['messages'][-1]['text'] == 'Media finished.'
            for asset in outputs:
                media = reopened.get(root + '/assets/' + asset['id'] + '/content')
                assert media.status_code == 200 and media.content == (work / asset['name']).read_bytes()
            trace = (directory / 'agent-runs' / f'{turn}.jiuwenswarm.jsonl').read_text()
            assert 'media-fixture-key' not in trace
            assert 'MEDIA_PROCESSING_FINISHED' in trace
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
