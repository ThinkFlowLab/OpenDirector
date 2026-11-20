"""Capability identities are disposable, credential-sensitive server observations."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import subprocess
import sys
import threading

import httpx
import pytest

from opendirector.application.model_availability import ModelAvailability, requests_for
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations import capability_probe
from opendirector.integrations.capability_probe import CapabilityProbe, identity
from test_model_availability import document


def saved_config(tmp_path):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('agent', 'http://models.test/v1', 'demo', 'synthetic-key-one',
                         connection_type='self_hosted', auth_mode='bearer')
    return configs, configs.resolve(saved['id'], 'agent')


def test_public_identity_cannot_verify_credentials_with_an_unkeyed_digest(tmp_path):
    configs, config = saved_config(tmp_path)
    public = ModelAvailability(configs).catalog()[0]
    keys = ('url', 'apiKey', 'authMode', 'connectionType', 'proxyMode', '_capability_namespace',
            'id', 'providerId', 'kind', 'modelId', 'protocol', 'videoAdapter', 'inputModalities',
            'videoCapabilities', 'capabilityAutoCheck')
    for guess in ('synthetic-key-zero', config['apiKey'], 'synthetic-key-two'):
        candidate = {key: public.get(key) for key in keys}
        candidate.update(apiKey=guess, serviceId=public.get('providerId') or public['id'])
        assert hashlib.sha256(json.dumps(candidate, sort_keys=True).encode()).hexdigest() != public['availability']['identity']
    assert 'apiKey' not in public
    assert config['apiKey'] not in json.dumps(public)


def test_identity_is_stable_within_a_process_but_changes_between_processes(tmp_path):
    _, config = saved_config(tmp_path)
    script = ('import json, sys; from opendirector.integrations.capability_probe import identity; '
              'config=json.load(sys.stdin); print(json.dumps([identity(config), identity(config), identity(config, service=True)]))')
    values = [json.loads(subprocess.run([sys.executable, '-c', script], input=json.dumps(config),
              text=True, capture_output=True, check=True, timeout=15).stdout) for _ in range(2)]
    assert values[0][0] == values[0][1]
    assert values[1][0] == values[1][1]
    assert values[0][0] != values[1][0]
    assert values[0][2] != values[1][2]


def test_credential_changes_separate_pending_queries_and_acceptance(tmp_path):
    configs, original = saved_config(tmp_path)
    started, finish = threading.Event(), threading.Event()
    calls = []

    def respond(request):
        calls.append(request.headers['authorization'])
        old = request.headers['authorization'] == 'Bearer synthetic-key-one'
        if old:
            started.set()
            assert finish.wait(3)
        return httpx.Response(200, json=document(support='unsupported' if old else 'supported'))

    probe = CapabilityProbe(transport=httpx.MockTransport(respond))
    availability = ModelAvailability(configs, probe)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(availability.prepare, original)
            assert started.wait(2)
            configs.save('agent', original['url'], 'demo', 'synthetic-key-two', original['id'],
                         connection_type='self_hosted', auth_mode='bearer')
            changed = configs.resolve(original['id'], 'agent')
            current = availability.prepare(changed)
            assert current != identity(original)
            assert identity(changed, service=True) != identity(original, service=True)
            finish.set()
            obsolete = pending.result(timeout=2)
        with pytest.raises(ProjectError) as failure:
            availability.require(changed, requests_for(changed)[0], obsolete)
        assert failure.value.code == 'capability_connection_changed'
        availability.require(changed, requests_for(changed)[0], current)
        assert availability.model(changed)['status'] == 'available'
        assert availability.model(original)['status'] == 'unavailable'
        assert calls == ['Bearer synthetic-key-one', 'Bearer synthetic-key-two']
    finally:
        finish.set()
        probe.close()


def test_restart_invalidates_observations_without_changing_saved_config(tmp_path, monkeypatch):
    configs, config = saved_config(tmp_path)
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=document())))
    availability = ModelAvailability(configs, probe)
    try:
        prepared = availability.prepare(config)
        saved = configs.resolve(config['id'], 'agent')
        monkeypatch.setattr(capability_probe, '_IDENTITY_KEY', b'new-process-test-key' * 2)
        assert availability.model(config)['status'] == 'unknown'
        with pytest.raises(ProjectError) as failure:
            availability.assert_identity(config, prepared)
        assert failure.value.code == 'capability_connection_changed'
        availability.require(config, requests_for(config)[0], availability.prepare(config))
        assert configs.resolve(config['id'], 'agent') == saved
    finally:
        probe.close()
