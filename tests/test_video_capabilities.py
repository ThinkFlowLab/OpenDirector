import asyncio
import json
from email.parser import BytesParser
from email.policy import default
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from opendirector.application.creation_generation import CreationGeneration
from generation_helpers import new_project, prepared
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.model_capabilities import read_video_capabilities
from opendirector.integrations.providers import GenerationProviders
from opendirector_api.main import create_app


CAPS = {'outputs': [
    {'resolution': '540P', 'durations': [3, 5], 'width': 960, 'height': 540},
    {'resolution': '720P', 'durations': [5, 7], 'width': 1280, 'height': 720}],
    'defaultResolution': '720P', 'defaultDuration': 7, 'dimensionStep': 2}


def model_payload(**changes):
    return {'kind': 'video', 'url': 'http://model.test/v1', 'modelId': 'custom-video',
            'connectionType': 'self_hosted', 'protocol': 'vllm_omni', 'authMode': 'bearer',
            'apiKey': 'test-secret', 'videoAdapter': 'standard', 'videoCapabilities': CAPS, **changes}


@pytest.fixture
def api(tmp_path):
    store = LocalProjects(tmp_path)
    with TestClient(create_app(store), headers={'X-OpenDirector-Request': '1'}) as client:
        yield client, store


def test_capabilities_survive_restart_and_blank_secret_update_and_omission(api):
    client, store = api
    saved = client.post('/api/model-configs', json=model_payload()).json()
    assert saved['inputRules']['profile'] == 'standard-video'
    assert saved['videoCapabilities'] == CAPS
    assert 'test-secret' not in json.dumps(saved)
    assert ModelConfigs(store.repository).list() == [saved]
    patch = model_payload(apiKey='')
    del patch['videoCapabilities']
    del patch['videoAdapter']
    updated = client.patch('/api/model-configs/' + saved['id'], json=patch).json()
    assert updated == saved
    assert ModelConfigs(store.repository).resolve(saved['id'], 'video')['apiKey'] == 'test-secret'
    reset = client.patch('/api/model-configs/' + saved['id'], json=model_payload(apiKey='', videoCapabilities=None)).json()
    assert reset['inputRules']['outputResolutions'] == []


@pytest.mark.parametrize('changes', [
    {'videoCapabilities': {**CAPS, 'defaultDuration': 6}},
    {'videoCapabilities': {**CAPS, 'outputs': [*CAPS['outputs'], CAPS['outputs'][0]]}},
    {'videoCapabilities': {**CAPS, 'outputs': [{'resolution': 'AUTO', 'durations': [5]}]}},
    {'videoCapabilities': {**CAPS, 'outputs': [{'resolution': '720P', 'durations': [7], 'width': 1280}]}},
    {'videoCapabilities': {**CAPS, 'outputs': [{'resolution': '720P', 'durations': [True]}]}},
    {'videoCapabilities': {**CAPS, 'outputs': [{'resolution': '720P', 'durations': [61]}]}},
    {'videoAdapter': 'fasth3', 'videoCapabilities': {**CAPS, 'dimensionStep': 32}},
    {'videoAdapter': 'fasth3', 'videoCapabilities': {**CAPS, 'outputs': [{'resolution': '480P', 'durations': [20]}], 'defaultResolution': 'auto', 'defaultDuration': 20}},
    {'kind': 'image'}, {'protocol': 'volcengine'},
])
def test_invalid_contracts_preserve_saved_configuration_and_hide_secrets(api, changes):
    client, store = api
    assert client.post('/api/model-configs', json=model_payload()).status_code == 200
    before = (store.state_dir / 'models.json').read_bytes()
    response = client.post('/api/model-configs', json=model_payload(**changes))
    assert response.status_code in {400, 422}
    assert 'test-secret' not in response.text
    assert (store.state_dir / 'models.json').read_bytes() == before


def test_legacy_alias_is_pinned_while_new_unknown_model_does_not_become_fasth3(tmp_path):
    configs = ModelConfigs(tmp_path)
    old = {'id': str(uuid4()), 'kind': 'video', 'url': 'http://model.test/v1', 'modelId': 'my-alias',
           'apiKey': '', 'connectionType': 'self_hosted', 'protocol': 'vllm_omni', 'authMode': 'none'}
    configs.path.write_text(json.dumps({'version': 1, 'models': [old]}))
    before = configs.path.read_bytes()
    loaded = configs.list()[0]
    assert loaded['videoAdapter'] == 'fasth3'
    assert loaded['inputRules']['profile'] == 'fasth3-omni'
    assert configs.path.read_bytes() == before
    new = configs.save('video', old['url'], old['modelId'], '', connection_type='self_hosted')
    assert new['inputRules']['profile'] == 'standard-video'
    assert new['inputRules']['outputResolutions'] == []


def prepare(tmp_path, resolution='720P', seconds=7, *, explicit=True):
    project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    public = configs.save('video', 'http://model.test/v1', 'custom-video', 'test-secret',
        connection_type='self_hosted', auth_mode='bearer', video_adapter='standard', video_capabilities=CAPS)
    runner = CreationGeneration(project[0], configs)
    parameters = dict(videoMode='first_frame', **({} if explicit else {'aspectRatio': '16:9'}))
    if explicit: parameters.update(resolution=resolution, durationSeconds=seconds)
    task, _, config = prepared(runner, project, public, parameters=parameters, prompt='山间日出')
    return runner.store, task, config


@pytest.mark.parametrize('explicit', [True, False])
def test_custom_contract_reaches_generic_wire_without_fasth3_sampling_fields(tmp_path, explicit):
    store, task, config = prepare(tmp_path, explicit=explicit)
    assert task['parameters']['size'] == '1280x720'
    assert task['parameters']['duration'] == 7
    posts = []
    def handle(request):
        if request.method == 'POST':
            parts = BytesParser(policy=default).parsebytes(('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + request.content)
            fields = {part.get_param('name', header='content-disposition'): part.get_content() for part in parts.iter_parts()}
            assert fields['seconds'] == '7'
            assert fields['size'] == '1280x720'
            assert not {'extra_params', 'num_frames', 'fps', 'guidance_scale', 'num_inference_steps'} & fields.keys()
            posts.append(request)
            return httpx.Response(200, json={'id': 'one-job'})
        return httpx.Response(200, content=b'video') if request.url.path.endswith('/content') else httpx.Response(200, json={'id': 'one-job', 'status': 'completed'})
    async def run():
        async def submitted(value): assert value == 'one-job'
        provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
        assert await provider.generate(config, task, submitted) == ('mp4', b'video')
        assert await provider.generate(config, {**task, 'externalTaskId': 'one-job'}, submitted) == ('mp4', b'video')
    asyncio.run(run())
    assert len(posts) == 1


def test_invalid_duration_resolution_pair_never_accepts_a_task(tmp_path):
    with pytest.raises(ProjectError, match='时长与分辨率组合'):
        prepare(tmp_path, '540P', 7)
    assert not list(tmp_path.glob('projects/*/tasks/*.json'))


def test_explicit_automatic_resolution_does_not_apply_custom_default_size(tmp_path):
    _, task, _ = prepare(tmp_path, resolution='auto')
    assert task['parameters']['duration'] == 7
    assert 'size' not in task['parameters']
    assert 'resolution' not in task['parameters']


@pytest.mark.parametrize('declaration, accepted', [
    ({'id': 'custom-video', 'videoCapabilities': CAPS}, True),
    ({'id': 'custom-video'}, False),
    ({'id': 'other-video', 'videoCapabilities': CAPS}, False),
    ({'id': 'custom-video', 'videoCapabilities': {**CAPS, 'defaultDuration': 60}}, False),
])
def test_read_service_declaration_requires_exact_model_and_explicit_valid_schema(declaration, accepted):
    calls = []
    def handle(request):
        assert request.headers['authorization'] == 'Bearer test-secret'
        calls.append((request.method, request.url.path))
        return httpx.Response(200, json={'data': [declaration]})
    result = read_video_capabilities(model_payload(), httpx.MockTransport(handle))
    if accepted: assert asyncio.run(result) == CAPS
    else:
        with pytest.raises(ProjectError): asyncio.run(result)
    assert calls == [('GET', '/v1/models')]


def test_discovery_uses_saved_key_only_for_its_original_address_and_never_saves(api, monkeypatch):
    client, store = api
    saved = client.post('/api/model-configs', json=model_payload()).json()
    before = (store.state_dir / 'models.json').read_bytes()
    async def read(config):
        assert config['apiKey'] == 'test-secret'
        return CAPS
    monkeypatch.setattr('opendirector.application.model_catalog.read_video_capabilities', read)
    payload = {**model_payload(apiKey=''), 'configId': saved['id'], 'source': 'service'}
    response = client.post('/api/model-configs/capabilities', json=payload)
    assert response.status_code == 200 and response.json()['videoCapabilities'] == CAPS
    assert 'test-secret' not in response.text
    assert client.post('/api/model-configs/capabilities', json={**payload, 'url': 'http://different.test/v1'}).status_code == 400
    assert (store.state_dir / 'models.json').read_bytes() == before


def test_preset_preview_supports_aliased_fasth3_without_network_or_credentials(api):
    client, _ = api
    response = client.post('/api/model-configs/capabilities', json={**model_payload(apiKey='', videoAdapter='fasth3'), 'source': 'preset'})
    assert response.status_code == 200
    caps = response.json()['videoCapabilities']
    assert [item['resolution'] for item in caps['outputs']] == ['480P', '768P']
    assert caps['dimensionStep'] == 32
