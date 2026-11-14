import json
import os
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app


@pytest.fixture
def api(tmp_path):
    store = LocalProjects(tmp_path)
    headers = {"X-OpenDirector-Request": "1", "X-OpenDirector-Session": str(uuid4())}
    with TestClient(create_app(store), headers=headers) as client:
        yield client, store


def payload(kind="agent", **changes):
    return {"kind": kind, "url": "https://models.example/v1", "modelId": "demo-model", "apiKey": "test-secret", **changes}


def test_four_categories_survive_restart_without_exposing_secrets(api):
    client, store = api
    configs = []
    for kind in ("agent", "image", "video", "audio", "agent"):
        response = client.post("/api/model-configs", json=payload(kind))
        assert response.status_code == 200
        assert "test-secret" not in response.text
        assert set(response.json()) == {"id", "kind", "url", "modelId", "inputRules", "connectionType", "protocol", "authMode", "proxyMode", "videoAdapter", "videoCapabilities", "inputModalities"}
        configs.append(response.json())
    assert len({item["id"] for item in configs}) == 5
    assert client.get("/api/model-configs").json() == configs
    assert ModelConfigs(store.repository).list() == configs
    assert not store.root.exists()
    path = store.state_dir / "models.json"
    assert json.loads(path.read_text())["models"][0]["apiKey"] == "test-secret"
    if os.name == "posix":
        assert path.stat().st_mode & 0o777 == 0o600
        assert path.parent.stat().st_mode & 0o777 == 0o700


def test_edit_preserves_blank_key_and_stable_id_then_delete(api):
    client, store = api
    config = client.post("/api/model-configs", json=payload()).json()
    path = f"/api/model-configs/{config['id']}"
    response = client.patch(path, json=payload(modelId="edited", apiKey=""))
    assert response.status_code == 200
    assert response.json()["id"] == config["id"]
    assert response.json()["modelId"] == "edited"
    file = store.state_dir / "models.json"
    assert json.loads(file.read_text())["models"][0]["apiKey"] == "test-secret"
    assert client.patch(path, json=payload(apiKey="replacement-secret")).status_code == 200
    assert json.loads(file.read_text())["models"][0]["apiKey"] == "replacement-secret"
    before = file.read_bytes()
    assert client.patch(path, json=payload("image")).status_code == 400
    assert file.read_bytes() == before
    assert client.delete(path).status_code == 204
    assert client.get("/api/model-configs").json() == []
    assert client.patch(path, json=payload()).status_code == 404


def test_direct_proxy_mode_survives_restart_and_edits_without_changing_credentials(api):
    client, store = api
    config = client.post('/api/model-configs', json=payload('image', proxyMode='direct')).json()
    assert config['proxyMode'] == 'direct'
    path = f"/api/model-configs/{config['id']}"
    edited = client.patch(path, json=payload('image', modelId='updated-image', apiKey='')).json()
    assert edited['proxyMode'] == 'direct'
    saved = ModelConfigs(store.repository).resolve(config['id'], 'image')
    assert saved['proxyMode'] == 'direct' and saved['apiKey'] == 'test-secret'
    assert client.patch(path, json=payload('image', apiKey='', proxyMode='system')).json()['proxyMode'] == 'system'
    before = (store.state_dir / 'models.json').read_bytes()
    assert client.patch(path, json=payload('image', proxyMode='invalid')).status_code == 422
    assert (store.state_dir / 'models.json').read_bytes() == before


def test_batch_service_applies_and_preserves_proxy_mode_for_its_models(api):
    client, store = api
    data = {**payload('image', proxyMode='direct'), 'modelIds': ['image-a', 'image-b']}
    response = client.post('/api/model-configs/batch', json=data)
    assert response.status_code == 200
    configs = response.json()
    assert {config['proxyMode'] for config in configs} == {'direct'}
    data.pop('proxyMode')
    data.update(configId=configs[0]['id'], apiKey='')
    updated = client.post('/api/model-configs/batch', json=data)
    assert updated.status_code == 200
    assert {config['proxyMode'] for config in updated.json()} == {'direct'}
    assert all(config['proxyMode'] == 'direct' for config in ModelConfigs(store.repository).list())


def test_validation_and_save_failures_preserve_file_and_hide_request_values(api, monkeypatch):
    from opendirector.infrastructure import model_configs

    client, store = api
    config = client.post("/api/model-configs", json=payload()).json()
    path = store.state_dir / "models.json"
    before = path.read_bytes()
    for changes in ({"url": "file:///private"}, {"url": "https://user:test-secret@models.example"},
                    {"url": "https://models.example?key=test-secret"}, {"modelId": "  "},
                    {"apiKey": ""}, {"kind": "unknown"}, {"modelId": None}):
        response = client.post("/api/model-configs", json=payload(**changes))
        assert response.status_code in {400, 422}
        assert "test-secret" not in response.text
        assert path.read_bytes() == before

    def fail_write(*args):
        raise OSError("simulated disk failure")

    monkeypatch.setattr(model_configs, "write_json", fail_write)
    assert client.patch(f"/api/model-configs/{config['id']}", json=payload(modelId="unsaved")).status_code == 503
    assert path.read_bytes() == before
    assert client.delete(f"/api/model-configs/{config['id']}").status_code == 503
    assert client.get("/api/model-configs").json()[0]["modelId"] == "demo-model"


def test_corrupt_configuration_is_reported_without_overwriting(tmp_path):
    store = ModelConfigs(tmp_path)
    store.path.write_text('{"version":1,"models":[{"apiKey":"private"}]}')
    before = store.path.read_bytes()
    for operation in (store.list, lambda: store.save("agent", "https://example.com", "new", "new-secret")):
        with pytest.raises(ProjectError, match="原文件未覆盖") as failure:
            operation()
        assert "private" not in str(failure.value)
        assert store.path.read_bytes() == before


def test_model_config_routes_keep_local_request_protection(api):
    client, _ = api
    assert client.get("/api/model-configs", headers={"Origin": "https://untrusted.example"}).status_code == 403
    assert client.post("/api/model-configs", json=payload(), headers={"X-OpenDirector-Request": ""}).status_code == 403


@pytest.mark.parametrize('kind', ['image', 'video'])
def test_segmentation_protocol_serves_both_tools_without_generation(api, kind):
    from opendirector.domain.creation.models import ModelConfigPublic, ModelSnapshot
    from opendirector.integrations.model_adapters import capabilities_of
    from opendirector.integrations.providers import GenerationProviders
    client, store = api
    response = client.post('/api/model-configs', json=payload(kind, protocol='vllm_omni_segmentation', modelId='facebook/sam3'))
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved['inputRules']['profile'] == 'vllm-omni-segmentation'
    assert saved['inputRules']['allowedKinds'] == [] and saved['inputRules']['videoModes'] == []
    assert ModelConfigs(store.repository).list() == [saved]
    public = ModelConfigPublic.model_validate(saved)
    ModelSnapshot(modelConfigId=public.id, **public.model_dump(exclude={'id', 'providerId', 'authMode', 'videoCapabilities'}))
    private = ModelConfigs(store.repository).resolve(saved['id'], kind)
    assert capabilities_of(private) == {'image.segment', 'video.matting'}
    with pytest.raises(ProjectError, match='视觉分割模型'):
        GenerationProviders(store).validate(kind, private)
    catalog = client.get('/api/tools').json()
    assert catalog['selectionPreview']['available']
    for capability in ('image.segment', 'video.matting'):
        assert catalog['capabilities'][capability][0]['id'] == saved['id']
    assert not any(saved['id'] == model['id'] for model in catalog['capabilities'].get('image.generate', []))
    normal = 'openai' if kind == 'image' else 'vllm_omni'
    changed = client.patch(f"/api/model-configs/{saved['id']}", json=payload(kind, protocol=normal, apiKey=''))
    assert changed.status_code == 200, changed.text
    assert changed.json()['id'] == saved['id'] and changed.json()['protocol'] == normal
    assert ModelConfigs(store.repository).resolve(saved['id'], kind)['apiKey'] == 'test-secret'


@pytest.mark.parametrize('kind', ['image', 'video'])
@pytest.mark.parametrize('segmentation', [False, True])
def test_legacy_sam_configuration_can_be_edited_in_media_category(api, kind, segmentation):
    client, store = api
    legacy = client.post('/api/model-configs', json=payload('vision', protocol='vllm_omni', modelId='facebook/sam3')).json()
    assert client.get('/api/tools').json()['selectionPreview']['available']
    protocol = 'vllm_omni_segmentation' if segmentation else 'openai' if kind == 'image' else 'vllm_omni'
    changed = client.patch(f"/api/model-configs/{legacy['id']}", json=payload(kind,
        protocol=protocol, modelId=legacy['modelId'], apiKey=''))
    assert changed.status_code == 200, changed.text
    assert changed.json()['id'] == legacy['id'] and changed.json()['kind'] == kind
    assert ModelConfigs(store.repository).resolve(legacy['id'], kind)['apiKey'] == 'test-secret'


def test_segmentation_rejects_generation_specific_configuration_and_wrong_categories(api):
    client, store = api
    for kind in ('agent', 'audio'):
        assert client.post('/api/model-configs', json=payload(kind, protocol='vllm_omni_segmentation')).status_code == 400
    assert client.post('/api/model-configs', json=payload('video', protocol='vllm_omni_segmentation', videoAdapter='fasth3')).status_code == 400
    assert ModelConfigs(store.repository).list() == []


def test_depth_protocol_serves_depth_capture_without_generation(api):
    from opendirector.integrations.model_adapters import capabilities_of
    from opendirector.integrations.providers import GenerationProviders
    client, store = api
    response = client.post('/api/model-configs', json=payload('video', protocol='vllm_omni_depth',
                                                               modelId='depth-anything/Video-Depth-Anything-Small'))
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved['inputRules']['profile'] == 'vllm-omni-depth'
    assert saved['inputRules']['allowedKinds'] == [] and saved['inputRules']['videoModes'] == []
    private = ModelConfigs(store.repository).resolve(saved['id'], 'video')
    assert capabilities_of(private) == {'video.motion_capture'}
    with pytest.raises(ProjectError, match='视频深度模型'):
        GenerationProviders(store).validate('video', private)
    catalog = client.get('/api/tools').json()
    assert catalog['capabilities']['video.motion_capture'][0]['id'] == saved['id']
    assert 'video.generate' not in catalog['capabilities']
    for kind in ('agent', 'image', 'audio'):
        assert client.post('/api/model-configs', json=payload(kind, protocol='vllm_omni_depth')).status_code == 400
    assert client.post('/api/model-configs', json=payload('video', protocol='vllm_omni_depth', videoAdapter='fasth3')).status_code == 400
    assert ModelConfigs(store.repository).list() == [saved]


def test_score_protocol_transcribes_for_music_without_generating(api):
    from opendirector.integrations.model_adapters import capabilities_of
    from opendirector.integrations.providers import GenerationProviders
    client, store = api
    response = client.post('/api/model-configs', json=payload('audio', protocol='vllm_omni_score', modelId='m-a-p/SheetSage2'))
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved['inputRules']['profile'] == 'vllm-omni-score' and saved['inputRules']['allowedKinds'] == []
    private = ModelConfigs(store.repository).resolve(saved['id'], 'audio')
    assert capabilities_of(private) == {'audio.score'}
    with pytest.raises(ProjectError, match='扒谱模型'):
        GenerationProviders(store).validate('audio', private)
    for kind in ('agent', 'image', 'video'):
        assert client.post('/api/model-configs', json=payload(kind, protocol='vllm_omni_score')).status_code == 400
    # Only YuE2 follows a score, so only it accepts one reference recording.
    music = [client.post('/api/model-configs', json=payload('audio', protocol='vllm_omni_music', modelId=model)).json()['inputRules']
             for model in ('m-a-p/YuE2-3B', 'MiniMaxAI/MiniMax-Music3')]
    assert [(rules['allowedKinds'], rules['maxAudios']) for rules in music] == [(['audio'], 1), ([], 0)]


@pytest.mark.parametrize('kind', ['image', 'video'])
def test_generation_boundary_rejects_sam_before_creating_a_task(tmp_path, kind):
    from generation_helpers import new_project, prepared
    from opendirector.application.creation_generation import CreationGeneration
    project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    generation = CreationGeneration(project[0], configs)
    sam = configs.save(kind, 'http://fixture.invalid/v1', 'sam3', '',
        connection_type='self_hosted', protocol='vllm_omni_segmentation')
    with pytest.raises(ProjectError, match='视觉分割模型'):
        prepared(generation, project, sam)
    assert project[0].snapshot(project[1]).jobs == ()


def test_agent_model_test_uses_draft_without_saving(api, monkeypatch):
    from opendirector.integrations.chat_completions import ChatCompletions

    client, store = api
    saved = client.post('/api/model-configs', json=payload()).json()
    before = (store.state_dir / 'models.json').read_bytes()
    calls = []

    async def stream(self, config, request):
        calls.append((config, request))
        yield {'type': 'delta', 'text': 'OK'}

    monkeypatch.setattr(ChatCompletions, 'stream', stream)
    response = client.post('/api/model-configs/test-agent', json=payload(
        configId=saved['id'], apiKey='', modelId='draft-model'))
    assert response.status_code == 200
    assert response.json()['elapsedMs'] >= 0
    assert calls[0][0]['apiKey'] == 'test-secret'
    assert calls[0][1]['model'] == 'draft-model'
    assert calls[0][1]['stream'] is True
    assert 'test-secret' not in response.text
    assert (store.state_dir / 'models.json').read_bytes() == before
    response = client.post('/api/model-configs/test-agent', json=payload(
        configId=saved['id'], apiKey='', url='https://other.example/v1'))
    assert response.status_code == 400
    assert len(calls) == 1


def test_agent_model_test_requires_reply(api, monkeypatch):
    from opendirector.integrations.chat_completions import ChatCompletions

    client, _ = api

    async def stream(self, config, request):
        yield {'type': 'thinking'}

    monkeypatch.setattr(ChatCompletions, 'stream', stream)
    response = client.post('/api/model-configs/test-agent', json=payload())
    assert response.status_code == 502
    assert '未返回正文' in response.json()['detail']
    assert client.post('/api/model-configs/test-agent', json=payload(kind='image')).status_code == 422


def test_discover_models_without_model_id_and_preserve_key(api, monkeypatch):
    client, store = api
    saved = client.post('/api/model-configs', json=payload()).json()
    before = (store.state_dir / 'models.json').read_bytes()
    calls = []

    async def models(config):
        calls.append(config)
        return [{'id': 'model-a'}, {'id': 'model-b'}, {'id': 'model-a'}]

    monkeypatch.setattr('opendirector.application.model_catalog.read_service_models', models)
    response = client.post('/api/model-configs/discover', json=payload(
        modelId='', apiKey='', configId=saved['id']))
    assert response.status_code == 200
    assert response.json() == {'models': ['model-a', 'model-b'], 'uncertain': ['model-a', 'model-b'], 'unsupported': []}
    assert calls[0]['apiKey'] == 'test-secret'
    assert (store.state_dir / 'models.json').read_bytes() == before
    response = client.post('/api/model-configs/discover', json=payload(
        modelId='', apiKey='', configId=saved['id'], url='https://other.example/v1'))
    assert response.status_code == 400
    assert len(calls) == 1


def test_discover_and_save_filter_incompatible_image_models(api, monkeypatch):
    client, _ = api

    async def models(config):
        assert config['kind'] == 'image'
        return [{'id': 'MiniMax-M3.1-Flash'}, {'id': 'MiniMax-H3-Image'}, {'id': 'studio-xl'}]

    monkeypatch.setattr('opendirector.application.model_catalog.read_service_models', models)
    response = client.post('/api/model-configs/discover', json=payload(
        kind='image', url='https://api.minimax.cn/v1', modelId='', protocol='openai'))
    assert response.status_code == 200
    assert response.json() == {
        'models': ['MiniMax-H3-Image', 'studio-xl'],
        'uncertain': ['studio-xl'],
        'unsupported': ['MiniMax-M3.1-Flash'],
    }
    refused = client.post('/api/model-configs', json=payload(
        kind='image', url='https://api.minimax.cn/v1', modelId='MiniMax-M3.1-Flash', protocol='openai'))
    assert refused.status_code == 422
    assert refused.json()['code'] == 'model_kind_unsupported'
    assert 'MiniMax-M3.1-Flash' in refused.json()['detail']
    batch = client.post('/api/model-configs/batch', json=payload(
        kind='image', url='https://api.minimax.cn/v1', modelId='unused',
        modelIds=['MiniMax-M3.1-Flash', 'MiniMax-H3-Image'], protocol='openai'))
    assert batch.status_code == 422
    assert batch.json()['code'] == 'model_kind_unsupported'
    saved = client.post('/api/model-configs', json=payload(
        kind='image', url='https://api.minimax.cn/v1', modelId='MiniMax-H3-Image', protocol='openai'))
    assert saved.status_code == 200, saved.text


def test_read_service_models_protocol():
    import asyncio
    import httpx
    from opendirector.integrations.model_capabilities import read_service_models

    config = payload(authMode='bearer')

    def respond(request):
        assert request.url.path == '/v1/models'
        assert request.headers['Authorization'] == 'Bearer test-secret'
        return httpx.Response(200, json={'data': [{'id': 'model-a'}]})

    assert asyncio.run(read_service_models(config, httpx.MockTransport(respond))) == [{'id': 'model-a'}]
    with pytest.raises(ProjectError):
        asyncio.run(read_service_models(config, httpx.MockTransport(
            lambda request: httpx.Response(200, json={'data': [{'id': 123}]}))))


def test_shared_service_batch_persists_one_credential_and_stable_models(api):
    client, store = api
    response = client.post('/api/model-configs/batch', json=payload(modelIds=['one', 'two']))
    assert response.status_code == 200, response.text
    saved = response.json()
    assert len({item['providerId'] for item in saved}) == 1
    assert 'test-secret' not in response.text
    path = store.state_dir / 'models.json'
    raw = json.loads(path.read_text())
    assert len(raw['services']) == 1
    assert all('apiKey' not in item and 'url' not in item for item in raw['models'])
    assert path.read_text().count('test-secret') == 1
    configs = ModelConfigs(store.repository)
    assert configs.resolve(saved[1]['id'], 'agent')['apiKey'] == 'test-secret'
    updated = client.post('/api/model-configs/batch', json=payload(
        configId=saved[0]['id'], modelIds=['one', 'two', 'three'], apiKey='rotated'))
    assert updated.status_code == 200, updated.text
    assert [item['id'] for item in updated.json()[:2]] == [item['id'] for item in saved]
    assert configs.resolve(saved[1]['id'], 'agent')['apiKey'] == 'rotated'
    response = client.post('/api/model-configs/batch', json=payload(
        configId=saved[0]['id'], modelIds=['two'], apiKey=''))
    assert response.status_code == 200
    assert response.json()[0]['id'] == saved[1]['id']
    assert len(configs.list()) == 1
    client.delete('/api/model-configs/' + saved[1]['id'])
    assert json.loads(path.read_text())['services'] == {}


def test_shared_service_batch_is_atomic_and_preserves_legacy_identity(api):
    client, store = api
    saved = client.post('/api/model-configs', json=payload(modelId='one')).json()
    path = store.state_dir / 'models.json'
    before = path.read_bytes()
    response = client.post('/api/model-configs/batch', json=payload(
        configId=saved['id'], modelIds=['one', ''], apiKey=''))
    assert response.status_code == 400
    assert path.read_bytes() == before
    response = client.post('/api/model-configs/batch', json=payload(
        configId=saved['id'], modelIds=['one', 'two'], apiKey=''))
    assert response.status_code == 200, response.text
    assert response.json()[0]['id'] == saved['id']
    before = path.read_bytes()
    response = client.post('/api/model-configs/batch', json=payload(
        configId=saved['id'], modelIds=['one'], apiKey='', url='https://other.example/v1'))
    assert response.status_code == 400
    assert path.read_bytes() == before


def test_delete_service_removes_group_atomically(api):
    client, store = api
    saved = client.post('/api/model-configs/batch', json=payload(modelIds=['one', 'two'])).json()
    other = client.post('/api/model-configs', json=payload(modelId='other')).json()
    response = client.delete('/api/model-services/' + saved[0]['id'])
    assert response.status_code == 204
    assert client.get('/api/model-configs').json() == [other]
    assert json.loads((store.state_dir / 'models.json').read_text())['services'] == {}


def test_batch_edit_legacy_segmentation_preserves_identity(api):
    client, _ = api
    saved = client.post('/api/model-configs', json=payload('vision', protocol='vllm_omni', modelId='facebook/sam3')).json()
    response = client.post('/api/model-configs/batch', json=payload(
        'image', protocol='vllm_omni_segmentation', configId=saved['id'],
        modelIds=['facebook/sam3', 'other-segmentation'], apiKey=''))
    assert response.status_code == 200, response.text
    assert response.json()[0]['id'] == saved['id']
    assert len(client.get('/api/model-configs').json()) == 2


def test_agent_image_input_persists_through_batch_edits_and_restart(api):
    client, store = api
    saved = client.post('/api/model-configs/batch', json=payload(modelIds=['vision-agent'],
        inputModalities=['text', 'image'])).json()[0]
    assert saved['inputModalities'] == ['text', 'image']
    resolved = ModelConfigs(store.repository).resolve(saved['id'], 'agent')
    assert resolved['inputModalities'] == ['text', 'image']
    unchanged = client.patch('/api/model-configs/' + saved['id'], json=payload(modelId='vision-agent', apiKey=''))
    assert unchanged.status_code == 200
    assert unchanged.json()['inputModalities'] == ['text', 'image']
    disabled = client.post('/api/model-configs/batch', json=payload(configId=saved['id'],
        modelIds=['vision-agent'], apiKey='', inputModalities=['text']))
    assert disabled.status_code == 200
    assert disabled.json()[0]['inputModalities'] == ['text']


@pytest.mark.parametrize('modalities', [[], ['image'], ['text', 'text'], ['text', 'video']])
def test_invalid_agent_input_modalities_do_not_write(api, modalities):
    client, store = api
    response = client.post('/api/model-configs', json=payload(inputModalities=modalities))
    assert response.status_code in {400, 422}
    assert ModelConfigs(store.repository).list() == []


def test_media_generation_model_cannot_declare_agent_modalities(api):
    client, _ = api
    response = client.post('/api/model-configs', json=payload(kind='image', inputModalities=['text', 'image']))
    assert response.status_code == 400


def test_batch_model_options_are_independent_and_survive_connection_edits(api):
    client, store = api
    request = payload(protocol='openai', modelIds=['text-model', 'vision-model'], modelOptions={
        'text-model': {'inputModalities': ['text']},
        'vision-model': {'inputModalities': ['text', 'image']}})
    response = client.post('/api/model-configs/batch', json=request)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert [item['inputModalities'] for item in saved] == [['text'], ['text', 'image']]
    assert saved[0]['providerId'] == saved[1]['providerId']
    refreshed = client.post('/api/model-configs/batch', json={**request, 'configId': saved[0]['id'], 'apiKey': '', 'modelOptions': {}, 'modelIds': ['text-model', 'vision-model', 'new-model']})
    assert refreshed.status_code == 200, refreshed.text
    assert [item['inputModalities'] for item in refreshed.json()][:2] == [['text'], ['text', 'image']]
    assert [item['id'] for item in refreshed.json()][:2] == [item['id'] for item in saved]
    assert ModelConfigs(store.repository).list() == refreshed.json()
    before = client.get('/api/model-configs').json()
    failed = client.post('/api/model-configs/batch', json={**request, 'configId': saved[0]['id'], 'modelOptions': {'not-selected': {'inputModalities': ['text']}}})
    assert failed.status_code == 400
    assert client.get('/api/model-configs').json() == before


def test_batch_video_cards_keep_distinct_adapter_and_output_settings(api):
    client, _ = api
    caps = {'outputs': [{'resolution': '540P', 'durations': [5], 'width': 960, 'height': 540}], 'defaultResolution': '540P', 'defaultDuration': 5}
    response = client.post('/api/model-configs/batch', json=payload('video', protocol='vllm_omni', modelIds=['custom', 'MiniMax-H3'], modelOptions={
        'custom': {'videoAdapter': 'standard', 'videoCapabilities': caps},
        'MiniMax-H3': {'videoAdapter': 'minimax_h3', 'videoCapabilities': None}}))
    assert response.status_code == 200, response.text
    first, second = response.json()
    assert first['videoCapabilities']['outputs'][0]['resolution'] == '540P'
    assert second['videoCapabilities'] is None and second['inputRules']['profile'] == 'vllm-omni-h3'
