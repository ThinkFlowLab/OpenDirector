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
                  url='http://127.0.0.1:8091/v1', modelId=profile['modelId'])
    deploy.write_json(tmp_path / 'services' / profile['id'] / 'state.json', record)
    monkeypatch.setattr(deploy, 'owned', lambda _: True)
    monkeypatch.setattr(deploy, 'readiness', lambda *a: (_ for _ in ()).throw(deploy.DeploymentError('service_unreachable')))
    monkeypatch.setattr(deploy.subprocess, 'Popen', lambda *a, **k: pytest.fail('duplicate server'))
    with pytest.raises(deploy.DeploymentError, match='startup_pending'):
        deploy.start(SimpleNamespace(root=tmp_path, port=8091), profile)


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
