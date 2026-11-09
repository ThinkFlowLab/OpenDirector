#!/usr/bin/env python3
"""Hardware-aware, local vLLM-Omni deployment. JSON codes are localized by the calling Agent.

Run with Python 3.12. doctor/plan/status do not create directories or call a model.
Installation and downloads use uv and huggingface_hub, rather than another package manager
or download implementation. Project changes belong to OpenDirector's existing API/CLI.
"""
import argparse
from contextlib import contextmanager
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4


HERE = Path(__file__).resolve().parent
GIB = 1024 ** 3


class DeploymentError(Exception):
    def __init__(self, code, **facts):
        self.code, self.facts = code, facts
        super().__init__(code)


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + str(uuid4()) + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def capture(command, *, env=None, timeout=20):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, env=env)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def version(value):
    return tuple(int(part) for part in value.split('.'))


def gpu_facts():
    fields = 'index,name,uuid,memory.total,memory.free,driver_version,compute_cap'
    output = capture(['nvidia-smi', '--query-gpu=' + fields, '--format=csv,noheader,nounits'])
    if output is None:
        raise DeploymentError('gpu_probe_failed')
    result = []
    try:
        for row in csv.reader(io.StringIO(output), skipinitialspace=True):
            index, name, identity, total, free, driver, capability = (field.strip() for field in row)
            result.append(dict(index=int(index), name=name, uuid=identity, totalMiB=int(total),
                               freeMiB=int(free), driver=driver, computeCapability=capability))
    except (ValueError, TypeError):
        raise DeploymentError('gpu_probe_incomplete') from None
    if not result:
        raise DeploymentError('gpu_probe_failed')
    return result


def visible_gpus(gpus, mask):
    if mask is None:
        return gpus
    tokens = mask.split(',') if mask.strip() and mask != '-1' else []
    selected = []
    for token in tokens:
        matches = [gpu for gpu in gpus if token.strip() == str(gpu['index']) or
                   (token.strip().startswith('GPU-') and gpu['uuid'].startswith(token.strip()))]
        if len(matches) != 1:
            raise DeploymentError('gpu_visibility_unresolved')
        if matches[0] not in selected:
            selected.append(matches[0])
    return selected


def disk_free(path):
    path = Path(path).resolve()
    while not path.exists():
        path = path.parent
    return shutil.disk_usage(path).free


def memory_facts():
    values = {}
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            key, value = line.split(':', 1)
            if key in {'MemTotal', 'MemAvailable'}:
                values[key] = int(value.split()[0]) * 1024
        limit = Path('/sys/fs/cgroup/memory.max')
        current = Path('/sys/fs/cgroup/memory.current')
        if limit.is_file() and limit.read_text().strip() != 'max':
            values['cgroupAvailable'] = max(0, int(limit.read_text()) - int(current.read_text()))
    except (OSError, ValueError):
        pass
    return values


def inspect(root, python):
    gpus = gpu_facts()
    return dict(schemaVersion=1, root=str(Path(root).resolve()), system=platform.system(), architecture=platform.machine(),
                python=capture([python, '-c', 'import platform; print(platform.python_version())']),
                gpus=gpus, visibleGpuUuids=[gpu['uuid'] for gpu in visible_gpus(gpus, os.environ.get('CUDA_VISIBLE_DEVICES'))],
                memory=memory_facts(), diskFreeBytes=disk_free(root),
                sharedMemoryFreeBytes=disk_free('/dev/shm'),
                tools={name: shutil.which(name) for name in ('ffmpeg', 'ffprobe', 'nvcc')})


def load_profile(name):
    if name not in {path.stem for path in (HERE / 'profiles').glob('*.json')}:
        raise DeploymentError('unknown_profile', profile=name)
    return read_json(HERE / 'profiles' / (name + '.json'))


def profile_digest(profile):
    return hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest()


def remaining_disk(profile, root=None):
    remaining = profile['downloadBytes']
    environment_budget = profile['environmentBudgetGiB'] * GIB
    if root is not None:
        root = Path(root)
        snapshot = root / 'cache/huggingface/hub' / ('models--' + profile['modelId'].replace('/', '--')) / 'snapshots' / profile['revision']
        for item in profile['files']:
            path = snapshot / item['path']
            if path.is_file() and path.stat().st_size == item['size']:
                remaining -= item['size']
        record = root / 'environment.json'
        if record.is_file() and (root / 'omni-env/bin/python').is_file():
            installed = read_json(record)
            if installed.get('packages') == profile['packages']:
                # Keep room for outputs and temporary files even when the exact
                # recorded package combination and cached model already exist.
                environment_budget = 5 * GIB
    return remaining + environment_budget


def plan(profile, facts, selector):
    checks = []
    def require(ok, code):
        if not ok:
            checks.append(code)
    require(facts['system'] == 'Linux' and facts['architecture'] == 'x86_64', 'unsupported_platform')
    require(bool(facts['python']) and facts['python'].startswith('3.12.'), 'python_312_required')
    candidates = [gpu for gpu in facts['gpus'] if gpu['uuid'] in facts['visibleGpuUuids'] and
                  selector in {str(gpu['index']), gpu['uuid']}]
    gpu = candidates[0] if len(candidates) == 1 else None
    require(gpu is not None, 'gpu_selection_required')
    if gpu:
        try:
            require(version(gpu['computeCapability']) >= version(profile['minComputeCapability']), 'unsupported_gpu_architecture')
            require(version(gpu['driver']) >= version(profile['minDriver']), 'driver_too_old')
        except (ValueError, TypeError):
            checks.append('gpu_probe_incomplete')
        if profile.get('computeCapabilities'):
            require(gpu['computeCapability'] in profile['computeCapabilities'], 'unsupported_gpu_architecture')
        require(gpu['freeMiB'] >= profile['gpuBudgetMiB'], 'insufficient_free_vram')
    required_disk = remaining_disk(profile, facts.get('root'))
    require(facts['diskFreeBytes'] >= required_disk, 'insufficient_disk_space')
    available_memory = facts['memory'].get('MemAvailable')
    if 'cgroupAvailable' in facts['memory']:
        available_memory = min(available_memory, facts['memory']['cgroupAvailable']) if available_memory is not None else facts['memory']['cgroupAvailable']
    require(available_memory is not None and available_memory >= profile['hostMemoryBudgetGiB'] * GIB, 'insufficient_host_memory')
    return dict(schemaVersion=1, status='blocked' if checks else 'eligible', blockers=checks,
                profile=profile['id'], profileSha256=profile_digest(profile), gpu=gpu,
                requiredDiskBytes=required_disk, qualification=profile['qualification'], facts=facts)


def environment(root, gpu=None, hf_endpoint=None):
    result = dict(os.environ)
    result.pop('PYTHONPATH', None)
    result.update(HF_HOME=str(root / 'cache/huggingface'),
                  UV_CACHE_DIR=str(root / 'cache/uv'), TMPDIR=str(root / 'cache/tmp'),
                  PYTHONNOUSERSITE='1', VLLM_WORKER_MULTIPROC_METHOD='spawn',
                  VIRTUAL_ENV=str(root / 'omni-env'),
                  PATH=str(root / 'omni-env/bin') + os.pathsep + result.get('PATH', ''))
    if hf_endpoint:
        result['HF_ENDPOINT'] = hf_endpoint
    if gpu:
        result['CUDA_VISIBLE_DEVICES'] = gpu['uuid']
    return result


def checked(command, *, env):
    result = subprocess.run(command, env=env, stdout=sys.stderr, stderr=sys.stderr)
    if result.returncode:
        raise DeploymentError('command_failed', executable=Path(command[0]).name, exitCode=result.returncode)


@contextmanager
def exclusive(path):
    import fcntl
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentError('deployment_busy') from None
        yield


def prepare(root):
    (root / 'cache/tmp').mkdir(parents=True, exist_ok=True)


def require_plan(args, profile):
    value = plan(profile, inspect(args.root, args.python), args.gpu)
    if value['blockers']:
        raise DeploymentError('preflight_failed', plan=value)
    return value


def install(args, profile):
    require_plan(args, profile)
    prepare(args.root)
    env = environment(args.root, hf_endpoint=args.hf_endpoint)
    python = str(args.root / 'omni-env/bin/python')
    with exclusive(args.root / 'environment.lock'):
        if not Path(python).exists():
            checked([args.python, '-m', 'venv', str(args.root / 'omni-env')], env=env)
        else:
            existing_version = capture([python, '-c', 'import sys; print(sys.version.split()[0])'])
            if not existing_version or not existing_version.startswith('3.12.'):
                raise DeploymentError('existing_environment_invalid')
        checked([python, '-m', 'pip', 'install', 'uv==0.13.7'], env=env)
        uv = str(args.root / 'omni-env/bin/uv')
        checked([uv, 'pip', 'install', '--python', python, '--torch-backend', 'cu130',
                 *profile['packages']], env=env)
        checked([uv, 'pip', 'check', '--python', python], env=env)
        cuda_env = environment(args.root, require_plan(args, profile)['gpu'], args.hf_endpoint)
        checked([python, '-c', 'import torch; assert torch.cuda.is_available(); '
                 'assert torch.cuda.device_count() == 1; '
                 'assert (torch.ones(1, device="cuda") + 1).item() == 2'], env=cuda_env)
        frozen = capture([uv, 'pip', 'freeze', '--python', python], env=env)
        if frozen is None:
            raise DeploymentError('environment_inspection_failed')
        (args.root / 'installed-requirements.txt').write_text(frozen + '\n')
        write_json(args.root / 'environment.json', dict(packages=profile['packages'],
                   requirementsSha256=hashlib.sha256(frozen.encode()).hexdigest()))
    return dict(status='installed', environment=str(args.root / 'omni-env'))


def download(args, profile):
    require_plan(args, profile)
    prepare(args.root)
    env = environment(args.root, hf_endpoint=args.hf_endpoint)
    # The SDK owns caching, locking, partial downloads and revision resolution.
    script = '''import json,sys
from huggingface_hub import snapshot_download
p=json.loads(sys.argv[1])
try:
    path=snapshot_download(p['modelId'],revision=p['revision'],allow_patterns=p['allowPatterns'],max_workers=4)
    print(json.dumps({'path':path}))
except Exception as error:
    print(json.dumps({'errorType':type(error).__name__,'httpStatus':getattr(getattr(error,'response',None),'status_code',None)}))
    sys.exit(1)
'''
    output = subprocess.run([str(args.root / 'omni-env/bin/python'), '-c', script, json.dumps(profile)],
                            env=env, capture_output=True, text=True)
    if output.returncode:
        # Do not put signed download URLs or raw provider errors in receipts.
        try:
            facts = json.loads(output.stdout)
        except ValueError:
            facts = {}
        raise DeploymentError('model_download_failed', **facts)
    snapshot = Path(json.loads(output.stdout)['path'])
    for item in profile['files']:
        path = snapshot / item['path']
        if not path.is_file() or path.stat().st_size != item['size']:
            raise DeploymentError('model_file_invalid', file=item['path'])
        if item.get('sha256'):
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != item['sha256']:
                raise DeploymentError('model_file_invalid', file=item['path'])
    record = dict(profileSha256=profile_digest(profile), revision=profile['revision'], path=str(snapshot))
    write_json(args.root / 'models' / (profile['id'] + '.json'), record)
    return dict(status='download_verified', **record)


def process_identity(pid):
    try:
        path = Path('/proc') / str(pid)
        fields = (path / 'stat').read_text().rsplit(') ', 1)[1].split()
        if path.stat().st_uid != os.getuid() or fields[0] == 'Z':
            return None
        return fields[19]
    except (OSError, IndexError):
        return None


def owned(record):
    return bool(record and process_identity(record['pid']) == record['processStart'] and
                record.get('processStart') is not None)


def request_json(url, payload=None, timeout=10):
    # These are explicit local service probes. Never inherit a proxy for loopback.
    request = Request(url, data=json.dumps(payload).encode() if payload is not None else None,
                      headers={'Content-Type': 'application/json'})
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=timeout) as response:
            data = response.read(128 * 1024 ** 2 + 1)
            if len(data) > 128 * 1024 ** 2:
                raise DeploymentError('response_too_large')
            return data
    except HTTPError as error:
        raise DeploymentError('service_http_error', httpStatus=error.code) from None
    except (URLError, TimeoutError, OSError):
        raise DeploymentError('service_unreachable') from None


def readiness(url, model):
    request_json(url.removesuffix('/v1') + '/health')
    try:
        data = json.loads(request_json(url + '/models'))
        models = data['data']
        if not isinstance(models, list) or any(not isinstance(item, dict) for item in models):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise DeploymentError('service_invalid_response') from None
    if model not in [item.get('id') for item in models]:
        raise DeploymentError('served_model_mismatch', modelId=model)


def deployment_config(root, profile):
    """Copy the installed upstream pipeline, changing only declared resource budgets."""
    if not profile.get('deployConfig'):
        return []
    target = root / 'services' / profile['id'] / 'deploy.yaml'
    script = '''import importlib.resources,json,pathlib,sys,yaml
p=json.loads(sys.argv[1])
source=importlib.resources.files('vllm_omni')/p['deployConfig']
config=yaml.safe_load(source.read_text())
for stage in config['stages']:
    stage.update(p.get('stageOverrides',{}))
pathlib.Path(sys.argv[2]).write_text(yaml.safe_dump(config,sort_keys=False))
'''
    checked([str(root / 'omni-env/bin/python'), '-c', script, json.dumps(profile), str(target)],
            env=environment(root))
    return ['--deploy-config', str(target)]


def start(args, profile):
    service = args.root / 'services' / profile['id']
    with exclusive(service / 'operation.lock'):
        state_path = service / 'state.json'
        record = read_json(state_path) if state_path.exists() else None
        if owned(record):
            if (record['profileSha256'] != profile_digest(profile) or
                    record['url'] != f'http://127.0.0.1:{args.port}/v1'):
                raise DeploymentError('running_configuration_conflict')
            existing = status(args, profile)
            if existing['status'] != 'ready':
                raise DeploymentError('startup_pending', **record)
            return existing
        preflight = require_plan(args, profile)
        model_path = args.root / 'models' / (profile['id'] + '.json')
        if not model_path.is_file():
            raise DeploymentError('model_download_required')
        model = read_json(model_path)
        if model['profileSha256'] != profile_digest(profile):
            raise DeploymentError('profile_changed_verify_download')
        # Binding is also attempted by the child; a race cannot turn somebody else's
        # listener into successful startup because the owned child must remain alive.
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', args.port))
            except OSError:
                raise DeploymentError('port_in_use', port=args.port) from None
        env = environment(args.root, preflight['gpu'], args.hf_endpoint)
        env.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
        command = [str(args.root / 'omni-env/bin/vllm'), 'serve', model['path'], '--omni',
                   '--served-model-name', profile['modelId'], '--host', '127.0.0.1', '--port', str(args.port),
                   *deployment_config(args.root, profile), *profile.get('serveArgs', [])]
        prepare(args.root)
        with (service / 'server.log').open('ab') as log:
            child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        record = dict(pid=child.pid, processStart=process_identity(child.pid), gpuUuid=preflight['gpu']['uuid'],
                      profileSha256=profile_digest(profile), url=f'http://127.0.0.1:{args.port}/v1',
                      modelId=profile['modelId'], log=str(service / 'server.log'))
        write_json(state_path, record)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise DeploymentError('server_exited', exitCode=child.returncode, log=record['log'])
        try:
            readiness(record['url'], profile['modelId'])
            if child.poll() is None:
                return dict(status='ready', **record)
        except DeploymentError:
            pass
        time.sleep(1)
    raise DeploymentError('startup_pending', **record)


def status(args, profile):
    path = args.root / 'services' / profile['id'] / 'state.json'
    record = read_json(path) if path.is_file() else None
    if not owned(record):
        return dict(status='stopped', scope='model_service')
    try:
        readiness(record['url'], record['modelId'])
        return dict(status='ready', scope='model_service', **record)
    except DeploymentError as error:
        return dict(status='starting_or_unhealthy', scope='model_service', reason=error.code, **record)


def stop(args, profile):
    service = args.root / 'services' / profile['id']
    if not service.exists():
        return dict(status='stopped')
    with exclusive(service / 'operation.lock'):
        path = service / 'state.json'
        record = read_json(path) if path.is_file() else None
        if not owned(record):
            return dict(status='stopped')
        if os.getpgid(record['pid']) != record['pid']:
            raise DeploymentError('process_ownership_unresolved')
        os.killpg(record['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 30
        while owned(record) and time.monotonic() < deadline:
            time.sleep(0.2)
        if owned(record):
            raise DeploymentError('shutdown_pending', pid=record['pid'])
    return dict(status='stopped')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--profile', default='zimage-bf16')
    parser.add_argument('--gpu', default='', help='Explicit physical index or full GPU UUID within the assigned CUDA visibility.')
    parser.add_argument('--python', default=sys.executable, help='Python 3.12 interpreter for the isolated model environment.')
    parser.add_argument('--hf-endpoint', help='Optional user-selected Hugging Face mirror, scoped to this deployment.')
    parser.add_argument('--port', type=int, default=8091)
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('command', choices=['doctor', 'plan', 'install', 'download', 'start', 'status', 'stop'])
    args = parser.parse_args()
    args.root = args.root.resolve()
    try:
        if args.command == 'doctor':
            result = inspect(args.root, args.python)
        else:
            profile = load_profile(args.profile)
            if args.command == 'plan':
                result = plan(profile, inspect(args.root, args.python), args.gpu)
            else:
                result = globals()[args.command](args, profile)
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get('status') == 'blocked' else 0
    except DeploymentError as error:
        print(json.dumps(dict(status='failed', code=error.code, **error.facts), ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
