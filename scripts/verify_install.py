"""Verify an installed distribution outside the checkout, without Node on PATH.

python scripts/verify_install.py --python /tmp/clean-venv/bin/python
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from uuid import uuid4

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--python', type=Path, required=True)
args = parser.parse_args()
# Preserve the venv entry path: resolve() would bypass pyvenv.cfg on POSIX.
python = args.python.absolute()
cli = python.parent / ('opendirector.exe' if os.name == 'nt' else 'opendirector')
with tempfile.TemporaryDirectory(prefix='opendirector-installed-') as temporary:
    env = {key: value for key, value in os.environ.items() if key not in ('PYTHONPATH', 'PYTHONHOME', 'OPENDIRECTOR_ROOT')}
    env['OPENDIRECTOR_ROOT'] = str(Path(temporary) / 'data')
    env['PATH'] = str(python.parent) + os.pathsep + os.defpath
    env['NO_PROXY'] = env['no_proxy'] = '127.0.0.1,localhost'
    subprocess.run([str(python), '-c',
        "from opendirector.installation import builtin_skills; from opendirector.agent.native import executable; "
        "import subprocess; assert any(builtin_skills().rglob('SKILL.md')); "
        "subprocess.run([executable('default'), '--version'], check=True)"],
        cwd=temporary, env=env, check=True)
    for command, expected in [(['vllm-omni'], 'verify'), (['vllm-omni', 'deploy'], '--download-backend'),
                              (['vllm-omni', 'verify'], '--audio-file')]:
        result = subprocess.run([str(cli), *command, '--help'], cwd=temporary, env=env,
                                capture_output=True, text=True, check=True)
        assert expected in result.stdout
    model_root = Path(temporary) / 'model-data'
    for profile in ('zimage-bf16', 'qwen3-tts-06b', 'qwen3-asr-06b'):
        result = subprocess.run([str(cli), 'vllm-omni', 'deploy', '--root', str(model_root),
                                 '--profile', profile, 'status'], cwd=temporary, env=env,
                                capture_output=True, text=True, check=True)
        assert json.loads(result.stdout)['status'] == 'stopped'
    assert not model_root.exists()
    # Exercise the packaged downloader in its standalone, model-environment form.
    subprocess.run([str(python), '-c',
        "import json, subprocess, sys; from pathlib import Path; "
        "from opendirector.vllm_omni.deploy import load_profile; "
        "from opendirector._fasth3 import download_models; "
        "p=load_profile('qwen3-tts-06b'); "
        "f=Path(sys.argv[1])/'manifest.json'; "
        "f.write_text(json.dumps([dict(repo=p['modelId'],sha=p['revision'],files=p['files'])])); "
        "subprocess.run([sys.executable,download_models.__file__,'--manifest',str(f),'--all-files','--plan'],check=True)", temporary],
        cwd=temporary, env=env, check=True, capture_output=True)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen([str(cli), 'serve', '--port', str(port)],
            cwd=temporary, env=env, stdout=log, stderr=log,
            start_new_session=os.name != 'nt')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        base = f'http://127.0.0.1:{port}'
        def request(path):
            with opener.open(urllib.request.Request(base + path, headers={'X-OpenDirector-Request': '1'}), timeout=3) as response:
                return response.read()
        try:
            for attempt in range(100):
                if process.poll() is not None:
                    raise RuntimeError('Installed serve process exited')
                try:
                    assert json.loads(request('/api/health')) == {'status': 'ok'}
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(.2)
            else:
                raise RuntimeError('Installed serve did not become healthy')
            html = request('/').decode()
            asset = re.search(r'(?:src|href)="(/assets/[^"]+)"', html)
            assert asset and request(asset[1]), 'Built web assets missing'
            identity = str(uuid4())
            command = [str(cli), '--url', base, '--project', identity]
            subprocess.run([*command, 'project', 'create', '--name', 'Installed smoke'], cwd=temporary, env=env, check=True, capture_output=True)
            result = subprocess.run([*command, 'project', 'show'], cwd=temporary, env=env, check=True, capture_output=True, text=True)
            assert json.loads(result.stdout)['project']['name'] == 'Installed smoke'
            print('PASS installed CLI, deployment profiles and downloader, OpenCode, skills, health, web assets and persisted project (no Node on PATH)')
        except BaseException:
            log.seek(0)
            print(log.read())
            raise
        finally:
            if process.poll() is None:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], check=False, capture_output=True)
                else:
                    os.killpg(process.pid, signal.SIGINT)
                process.wait(timeout=15)
