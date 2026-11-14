"""Deployment decisions and failure boundaries need neither a GPU nor model downloads."""
from types import SimpleNamespace

from PIL import Image
import pytest

from tools.vllm_omni import deploy, verify


@pytest.fixture
def profile():
    return deploy.load_profile('zimage-bf16')


def host(profile):
    gpu = dict(index=1, uuid='GPU-assigned', name='test GPU', totalMiB=100000,
               freeMiB=profile['gpuBudgetMiB'], driver=profile['minDriver'], computeCapability='12.0')
    return dict(system='Linux', architecture='x86_64', python='3.12.7', gpus=[gpu],
                visibleGpuUuids=[gpu['uuid']], memory={'MemAvailable': 128 * deploy.GIB},
                diskFreeBytes=profile['downloadBytes'] + profile['environmentBudgetGiB'] * deploy.GIB)


def test_doctor_is_read_only_before_root_exists(tmp_path, monkeypatch):
    root = tmp_path / 'not-created'
    monkeypatch.setattr(deploy, 'gpu_facts', lambda: host(deploy.load_profile('zimage-bf16'))['gpus'])
    monkeypatch.setattr(deploy, 'capture', lambda *a, **kw: '3.12.7')
    monkeypatch.delenv('CUDA_VISIBLE_DEVICES', raising=False)
    assert deploy.inspect(root, 'python')['diskFreeBytes'] > 0
    assert not root.exists()


def test_download_transport_uses_sdk_defaults_and_operator_settings(tmp_path, monkeypatch):
    monkeypatch.delenv('HF_HUB_DISABLE_XET', raising=False)
    assert 'HF_HUB_DISABLE_XET' not in deploy.environment(tmp_path)
    monkeypatch.setenv('HF_HUB_DISABLE_XET', '1')
    assert deploy.environment(tmp_path)['HF_HUB_DISABLE_XET'] == '1'


def test_private_cuda_linker_alias_preserves_conflicting_files(tmp_path):
    runtime = tmp_path / 'omni-env/lib/python3.12/site-packages/nvidia/cu13/lib/libcudart.so.13'
    runtime.parent.mkdir(parents=True)
    runtime.touch()
    deploy.prepare(tmp_path)
    alias = tmp_path / 'cache/cuda-linker/libcudart.so'
    assert alias.resolve() == runtime.resolve()
    alias.unlink()
    alias.write_bytes(b'operator-owned file')
    with pytest.raises(deploy.DeploymentError, match='cuda_linker_conflict'):
        deploy.prepare(tmp_path)
    assert alias.read_bytes() == b'operator-owned file'


def test_environment_receipt_digest_matches_the_written_requirements(tmp_path, profile, monkeypatch):
    import hashlib
    monkeypatch.setattr(deploy, 'require_plan', lambda *a: {'gpu': {'uuid': 'GPU-assigned'}})
    monkeypatch.setattr(deploy, 'checked', lambda *a, **k: None)
    monkeypatch.setattr(deploy, 'capture', lambda *a, **k: 'example==1.0')
    deploy.install(SimpleNamespace(root=tmp_path, python='python', hf_endpoint=None), profile)
    receipt = deploy.read_json(tmp_path / 'environment.json')
    requirements = (tmp_path / 'installed-requirements.txt').read_bytes()
    assert receipt['requirementsSha256'] == hashlib.sha256(requirements).hexdigest()


def test_selection_respects_assigned_devices(profile):
    facts = host(profile)
    facts['visibleGpuUuids'] = []
    assert deploy.plan(profile, facts, '1')['blockers'] == ['gpu_selection_required']
    with pytest.raises(deploy.DeploymentError, match='gpu_visibility_unresolved'):
        deploy.visible_gpus(facts['gpus'], 'GPU-unknown')
    assert deploy.visible_gpus(facts['gpus'], '-1') == []
    assert deploy.visible_gpus(facts['gpus'], 'GPU-assign') == facts['gpus']


def test_vram_is_not_summed_across_cards(profile):
    facts = host(profile)
    facts['gpus'][0]['freeMiB'] = profile['gpuBudgetMiB'] - 1
    facts['gpus'].append(dict(facts['gpus'][0], index=2, uuid='GPU-other', freeMiB=100000))
    assert deploy.plan(profile, facts, '1')['blockers'] == ['insufficient_free_vram']


def test_architecture_is_checked_before_install(profile, tmp_path, monkeypatch):
    # The existing FastH3 NVFP4 recipe requires SM120, independent of VRAM.
    profile = dict(profile, computeCapabilities=['12.0'])
    facts = host(profile)
    facts['gpus'][0]['computeCapability'] = '8.6'
    monkeypatch.setattr(deploy, 'inspect', lambda *a: facts)
    args = SimpleNamespace(root=tmp_path / 'unused', gpu='1', python='python')
    with pytest.raises(deploy.DeploymentError) as error:
        deploy.install(args, profile)
    assert error.value.facts['plan']['blockers'] == ['unsupported_gpu_architecture']
    assert not args.root.exists()


@pytest.mark.parametrize('change,expected', [
    (lambda f, p: f.update(diskFreeBytes=0), 'insufficient_disk_space'),
    (lambda f, p: f['memory'].update(cgroupAvailable=0), 'insufficient_host_memory'),
    (lambda f, p: f['gpus'][0].update(driver='570.0'), 'driver_too_old'),
    (lambda f, p: f.update(python='3.10.12'), 'python_312_required'),
])
def test_missing_resources_produce_actionable_codes(profile, change, expected):
    facts = host(profile)
    change(facts, profile)
    assert deploy.plan(profile, facts, '1')['blockers'] == [expected]


def test_eligible_is_distinct_from_qualification(profile):
    planned = deploy.plan(profile, host(profile), 'GPU-assigned')
    assert planned['status'] == 'eligible'
    assert planned['qualification'] == profile['qualification']


def test_image_smoke_request_is_an_output_declared_by_the_application(profile):
    from opendirector.domain.input_rules import input_rules
    from opendirector.domain.image_output import resolve_image_output
    config = dict(kind='image', modelId=profile['modelId'], protocol='openai', connectionType='self_hosted', url='http://localhost:8091/v1')
    rules = input_rules(config)
    size = profile['verification']['request']['size']
    assert resolve_image_output(config, rules, {'size': size}) == size


def test_storage_budget_reuses_cached_weights_and_installed_environment(tmp_path, profile):
    profile = dict(profile, downloadBytes=123, files=[dict(path='config.json', size=123)])
    snapshot = tmp_path / 'cache/huggingface/hub' / ('models--' + profile['modelId'].replace('/', '--')) / 'snapshots' / profile['revision']
    snapshot.mkdir(parents=True)
    (snapshot / 'config.json').write_bytes(b'x' * 123)
    python = tmp_path / 'omni-env/bin/python'
    python.parent.mkdir(parents=True)
    python.touch()
    deploy.write_json(tmp_path / 'environment.json', dict(packages=profile['packages']))
    assert deploy.remaining_disk(profile, tmp_path) == 5 * deploy.GIB


def test_range_manifest_opt_in_preserves_fasth3_selection():
    from tools.fasth3.download_models import selected_files
    manifest = [dict(repo='FastVideo/FastH3-NVFP4-VAE-Decoder', sha='pinned', files=[
        dict(path='fast-8L/config.json', size=1), dict(path='model.safetensors', size=2)])]
    assert [item['path'] for _, item in selected_files(manifest)] == ['fast-8L/config.json']
    assert [item['path'] for _, item in selected_files(manifest, all_files=True)] == ['fast-8L/config.json', 'model.safetensors']
    manifest[0]['files'] = [dict(path='../outside', size=1)]
    with pytest.raises(ValueError, match='Unsafe manifest path'):
        list(selected_files(manifest, all_files=True))


def test_wrong_model_is_not_readiness(monkeypatch):
    calls = []
    def respond(url):
        calls.append(url)
        return b'{}' if url.endswith('/health') else b'{"data":[{"id":"another-model"}]}'
    monkeypatch.setattr(deploy, 'request_json', respond)
    with pytest.raises(deploy.DeploymentError, match='served_model_mismatch'):
        deploy.readiness('http://127.0.0.1:8091/v1', 'expected')
    assert calls == ['http://127.0.0.1:8091/health', 'http://127.0.0.1:8091/v1/models']


def test_recycled_pid_never_stops_another_process(tmp_path, profile, monkeypatch):
    state = tmp_path / 'services' / profile['id'] / 'state.json'
    deploy.write_json(state, dict(pid=123, processStart='original'))
    monkeypatch.setattr(deploy, 'process_identity', lambda pid: 'recycled')
    monkeypatch.setattr(deploy.os, 'killpg', lambda *a: pytest.fail('unrelated process was signalled'))
    assert deploy.stop(SimpleNamespace(root=tmp_path), profile)['status'] == 'stopped'


def test_repeat_start_does_not_spawn_while_original_is_starting(tmp_path, profile, monkeypatch):
    record = dict(pid=123, processStart='same', profileSha256=deploy.profile_digest(profile),
                  url='http://127.0.0.1:8091/v1', modelId=profile['modelId'], gpuUuid='GPU-assigned')
    deploy.write_json(tmp_path / 'services' / profile['id'] / 'state.json', record)
    monkeypatch.setattr(deploy, 'owned', lambda _: True)
    monkeypatch.setattr(deploy, 'gpu_facts', lambda: host(profile)['gpus'])
    monkeypatch.delenv('CUDA_VISIBLE_DEVICES', raising=False)
    monkeypatch.setattr(deploy, 'readiness', lambda *a: (_ for _ in ()).throw(deploy.DeploymentError('service_unreachable')))
    monkeypatch.setattr(deploy.subprocess, 'Popen', lambda *a, **k: pytest.fail('duplicate server'))
    with pytest.raises(deploy.DeploymentError, match='startup_pending'):
        deploy.start(SimpleNamespace(root=tmp_path, port=8091, gpu='GPU-assigned'), profile)


@pytest.mark.parametrize('selector,mask,expected', [
    ('1', None, 'ready'),
    ('GPU-assigned', None, 'ready'),
    ('2', None, 'running_configuration_conflict'),
    ('GPU-other', None, 'running_configuration_conflict'),
    ('GPU-assigned', '2', 'running_configuration_conflict'),
    ('', None, 'running_configuration_conflict'),
])
def test_repeat_start_respects_selected_and_visible_gpu(tmp_path, profile, monkeypatch, selector, mask, expected):
    record = dict(pid=123, processStart='same', profileSha256=deploy.profile_digest(profile),
                  url='http://127.0.0.1:8091/v1', modelId=profile['modelId'], gpuUuid='GPU-assigned')
    deploy.write_json(tmp_path / 'services' / profile['id'] / 'state.json', record)
    assigned = host(profile)['gpus'][0]
    monkeypatch.setattr(deploy, 'gpu_facts', lambda: [assigned, dict(assigned, index=2, uuid='GPU-other')])
    monkeypatch.setattr(deploy, 'owned', lambda _: True)
    monkeypatch.setattr(deploy, 'status', lambda *args: {'status': 'ready', **record})
    monkeypatch.setattr(deploy.subprocess, 'Popen', lambda *a, **k: pytest.fail('duplicate server'))
    if mask is None:
        monkeypatch.delenv('CUDA_VISIBLE_DEVICES', raising=False)
    else:
        monkeypatch.setenv('CUDA_VISIBLE_DEVICES', mask)
    args = SimpleNamespace(root=tmp_path, port=8091, gpu=selector)
    if expected == 'ready':
        assert deploy.start(args, profile)['gpuUuid'] == record['gpuUuid']
    else:
        with pytest.raises(deploy.DeploymentError, match=expected):
            deploy.start(args, profile)


def test_unknown_generation_is_recorded_without_retry(tmp_path, profile, monkeypatch):
    calls = []
    monkeypatch.setattr(verify, 'readiness', lambda *a: None)
    def timeout(*a):
        calls.append(a)
        raise deploy.DeploymentError('service_unreachable')
    monkeypatch.setattr(verify, 'request_json', timeout)
    with pytest.raises(deploy.DeploymentError, match='inference_result_unknown') as error:
        verify.verify(tmp_path, profile, infer=True, url='http://127.0.0.1:8091/v1')
    assert len(calls) == 1
    record = deploy.read_json(error.value.facts['receipt'])
    assert record['status'] == 'submission_unknown'
    assert record['request']['model'] == profile['modelId']


def test_health_probe_does_not_generate_or_write(tmp_path, profile, monkeypatch):
    monkeypatch.setattr(verify, 'readiness', lambda *a: None)
    monkeypatch.setattr(verify, 'request_json', lambda *a: pytest.fail('generation during discovery'))
    assert verify.verify(tmp_path, profile, url='http://127.0.0.1:8091/v1')['status'] == 'service_ready'
    assert not list(tmp_path.iterdir())


def test_verification_before_start_is_a_structured_failure(tmp_path, profile):
    with pytest.raises(deploy.DeploymentError, match='service_not_started') as error:
        verify.verify(tmp_path, profile)
    assert error.value.facts['profile'] == profile['id']
    assert not list(tmp_path.iterdir())


def test_real_png_decoding_rejects_corruption(tmp_path):
    import sys
    path = tmp_path / 'image.png'
    Image.new('RGB', (32, 24), 'red').save(path)
    assert verify.media_facts(path, 'image', sys.executable)['width'] == 32
    path.write_bytes(path.read_bytes()[:35])
    with pytest.raises(deploy.DeploymentError, match='invalid_image_output'):
        verify.media_facts(path, 'image', sys.executable)


def test_png_with_valid_checksums_still_requires_decodable_pixels(tmp_path):
    import struct
    import sys
    import zlib
    path = tmp_path / 'image.png'
    Image.new('RGB', (32, 24), 'red').save(path)
    source = path.read_bytes()
    chunks, offset = [source[:8]], 8
    while offset < len(source):
        size = struct.unpack('>I', source[offset:offset + 4])[0]
        tag = source[offset + 4:offset + 8]
        body = source[offset + 8:offset + 8 + size]
        if tag == b'IDAT':
            body = b'not a zlib stream'
        chunks.append(struct.pack('>I', len(body)) + tag + body + struct.pack('>I', zlib.crc32(tag + body)))
        offset += size + 12
    path.write_bytes(b''.join(chunks))
    with Image.open(path) as image:
        image.verify()  # Header/chunk validation alone accepts this invalid PNG.
    with pytest.raises(deploy.DeploymentError, match='invalid_image_output'):
        verify.media_facts(path, 'image', sys.executable)


@pytest.mark.parametrize('name,omni', [('qwen3-asr-06b', False), ('zimage-bf16', True)])
def test_start_uses_the_models_upstream_engine(tmp_path, name, omni, monkeypatch):
    profile = deploy.load_profile(name)
    deploy.write_json(tmp_path / 'models' / (name + '.json'),
                      dict(profileSha256=deploy.profile_digest(profile), path='/verified-snapshot'))
    monkeypatch.setattr(deploy, 'require_plan', lambda *a: {'gpu': {'uuid': 'GPU-assigned'}})
    monkeypatch.setattr(deploy, 'process_identity', lambda *a: 'owned')
    commands = []
    def spawn(command, **kwargs):
        commands.append(command)
        return SimpleNamespace(pid=123)
    monkeypatch.setattr(deploy.subprocess, 'Popen', spawn)
    with pytest.raises(deploy.DeploymentError, match='startup_pending'):
        deploy.start(SimpleNamespace(root=tmp_path, port=0, hf_endpoint=None, timeout=0), profile)
    assert ('--omni' in commands[0]) is omni
    assert commands[0][1:3] == ['serve', '/verified-snapshot']


def test_asr_health_does_not_require_audio_or_write(tmp_path, monkeypatch):
    monkeypatch.setattr(verify, 'readiness', lambda *a: None)
    profile = deploy.load_profile('qwen3-asr-06b')
    assert verify.verify(tmp_path, profile, url='http://localhost/v1')['status'] == 'service_ready'
    with pytest.raises(deploy.DeploymentError, match='audio_input_required'):
        verify.verify(tmp_path, profile, url='http://localhost/v1', infer=True)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('output', [b'{}', b'{"text":" "}', b'{"text":[]}', b'not json'])
def test_asr_rejects_invalid_transcripts(tmp_path, output, monkeypatch):
    monkeypatch.setattr(verify, 'readiness', lambda *a: None)
    monkeypatch.setattr(verify, 'media_facts', lambda *a: {'durationSeconds': 1})
    monkeypatch.setattr(verify, 'request_transcription', lambda *a: output)
    source = tmp_path / 'source.mp3'
    source.write_bytes(b'audio')
    with pytest.raises(deploy.DeploymentError, match='invalid_provider_output') as error:
        verify.verify(tmp_path, deploy.load_profile('qwen3-asr-06b'), url='http://localhost/v1',
                      infer=True, audio_file=source)
    assert deploy.read_json(error.value.facts['receipt'])['status'] == 'failed'


def test_asr_uploads_exact_snapshot_and_keeps_reference_out_of_request(tmp_path, monkeypatch):
    import hashlib
    import json
    from email.parser import BytesParser
    from email.policy import default
    monkeypatch.setattr(verify, 'readiness', lambda *a: None)
    monkeypatch.setattr(verify, 'media_facts', lambda *a: {'durationSeconds': 1})
    source = tmp_path / 'source.MP3'
    source.write_bytes(b'exact audio\x00\xff')
    calls = []
    def request(url, body, content_type, timeout):
        message = BytesParser(policy=default).parsebytes(('Content-Type: ' + content_type + '\r\n\r\n').encode() + body)
        fields = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True)
                  for part in message.iter_parts()}
        calls.append(fields)
        return json.dumps({'text': '你好，Hello!'}).encode()
    monkeypatch.setattr(verify, 'request_bytes', request)
    result = verify.verify(tmp_path, deploy.load_profile('qwen3-asr-06b'), url='http://localhost/v1',
                           infer=True, audio_file=source, expected_text='你好 hello')
    assert len(calls) == 1
    assert calls[0]['file'] == source.read_bytes()
    assert calls[0]['model'] == b'Qwen/Qwen3-ASR-0.6B'
    assert set(calls[0]) == {'file', 'model', 'response_format', 'temperature'}
    assert result['input']['artifactSha256'] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert result['textComparison']['characterErrorRate'] == 0
    assert result['creativeReview'] == 'pending'


def test_asr_unknown_submission_is_not_retried(tmp_path, monkeypatch):
    monkeypatch.setattr(verify, 'readiness', lambda *a: None)
    monkeypatch.setattr(verify, 'media_facts', lambda *a: {'durationSeconds': 1})
    source = tmp_path / 'source.wav'
    source.write_bytes(b'audio')
    calls = []
    def timeout(*args):
        calls.append(args)
        raise deploy.DeploymentError('service_unreachable')
    monkeypatch.setattr(verify, 'request_transcription', timeout)
    with pytest.raises(deploy.DeploymentError, match='inference_result_unknown') as error:
        verify.verify(tmp_path, deploy.load_profile('qwen3-asr-06b'), url='http://localhost/v1',
                      infer=True, audio_file=source)
    assert len(calls) == 1
    assert deploy.read_json(error.value.facts['receipt'])['status'] == 'submission_unknown'


def test_invalid_asr_audio_fails_before_sampling_or_submission(tmp_path, monkeypatch):
    profile = deploy.load_profile('qwen3-asr-06b')
    deploy.write_json(tmp_path / 'services' / profile['id'] / 'state.json', dict(url='http://localhost/v1', gpuUuid='GPU-assigned'))
    source = tmp_path / 'source.wav'
    source.write_bytes(b'corrupt')
    monkeypatch.setattr(verify, 'readiness', lambda *a: None)
    def reject(*args):
        raise deploy.DeploymentError('invalid_audio_output')
    monkeypatch.setattr(verify, 'media_facts', reject)
    monkeypatch.setattr(verify, 'request_transcription', lambda *a: pytest.fail('submitted invalid input'))
    with pytest.raises(deploy.DeploymentError, match='invalid_audio_output') as error:
        verify.verify(tmp_path, profile, infer=True, audio_file=source)
    assert deploy.read_json(error.value.facts['receipt'])['status'] == 'failed'


@pytest.mark.parametrize('actual,expected,distance', [('abc', 'ab', 1), ('ab', 'abc', 1), ('axc', 'abc', 1), ('你好 HELLO!', '你好，ｈｅｌｌｏ', 0)])
def test_transcript_comparison_reports_insertions_deletions_and_substitutions(actual, expected, distance):
    assert verify.compare_text(actual, expected)['editDistance'] == distance


@pytest.mark.parametrize('live_listener', [False, True])
def test_port_preflight_allows_time_wait_but_preserves_live_listener(tmp_path, profile, monkeypatch, live_listener):
    import socket
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        listener.listen()
        if not live_listener:
            with socket.create_connection(('127.0.0.1', port)) as client:
                accepted, _ = listener.accept()
                accepted.close()  # Active close puts the server address in TIME_WAIT.
                assert client.recv(1) == b''
            listener.close()
        deploy.write_json(tmp_path / 'models' / (profile['id'] + '.json'),
                          dict(profileSha256=deploy.profile_digest(profile), path='/verified-snapshot'))
        monkeypatch.setattr(deploy, 'require_plan', lambda *a: {'gpu': {'uuid': 'GPU-assigned'}})
        monkeypatch.setattr(deploy, 'process_identity', lambda *a: 'owned')
        monkeypatch.setattr(deploy.subprocess, 'Popen', lambda *a, **k: SimpleNamespace(pid=123))
        expected = 'port_in_use' if live_listener else 'startup_pending'
        with pytest.raises(deploy.DeploymentError, match=expected):
            deploy.start(SimpleNamespace(root=tmp_path, port=port, hf_endpoint=None, timeout=0), profile)
