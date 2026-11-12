"""Model discovery, capability probes, and agent connection tests."""
import asyncio
from uuid import uuid4

import pytest

from opendirector.application.model_catalog import ModelCatalog
from opendirector.application.preferences import Preferences
from opendirector.domain.input_rules import input_rules
from opendirector.domain.model_connection import connection_fields, model_fields
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.model_configs import ModelConfigs


class Store:
    def __init__(self, existing=None):
        self.existing = existing
        self.calls = []

    def resolve(self, config_id, kind, *, connection=None):
        self.calls.append((config_id, kind))
        if isinstance(self.existing, Exception):
            raise self.existing
        return self.existing


class Scripted:
    def __init__(self, events):
        self.events = events
        self.calls = []
        self.yielded = 0

    async def stream(self, config, payload):
        self.calls.append((config, payload))
        for event in self.events:
            self.yielded += 1
            yield event


class Silent:
    async def stream(self, config, payload):
        await asyncio.Event().wait()
        yield {'type': 'delta', 'text': 'OK'}


def _reader(result):
    calls = []

    async def read(config):
        calls.append(dict(config))
        return result

    return calls, read


def test_save_lists_public_config_and_delete_removes_it(tmp_path):
    catalog = ModelCatalog(ModelConfigs(tmp_path))
    saved = catalog.save('agent', 'https://models.example/v1', 'demo', 'test-secret')
    assert catalog.list()[0]['id'] == saved['id']
    assert 'test-secret' not in str(catalog.list())
    catalog.delete(saved['id'])
    assert catalog.list() == []


def test_discover_reuses_saved_key_for_the_same_address_and_does_not_write(tmp_path, monkeypatch):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('agent', 'https://models.example/v1', 'demo', 'test-secret')
    before = (tmp_path / '.opendirector' / 'models.json').read_bytes()
    calls, read = _reader([{'id': 'model-a'}, {'id': 'model-b'}, {'id': 'model-a'}])
    monkeypatch.setattr('opendirector.application.model_catalog.read_service_models', read)
    found = asyncio.run(ModelCatalog(configs).discover('agent', 'https://models.example/v1', '', '', saved['id']))
    assert found == ['model-a', 'model-b']
    assert calls[0]['apiKey'] == 'test-secret'
    assert calls[0]['modelId'] == 'discovery'
    assert (tmp_path / '.opendirector' / 'models.json').read_bytes() == before
    with pytest.raises(ProjectError, match='不能复用') as caught:
        asyncio.run(ModelCatalog(configs).discover('agent', 'https://other.example/v1', '', '', saved['id']))
    assert caught.value.status == 400
    assert len(calls) == 1


def test_discover_uses_typed_key_without_reading_saved_configuration(monkeypatch):
    calls, read = _reader([{'id': 'only'}])
    monkeypatch.setattr('opendirector.application.model_catalog.read_service_models', read)
    store = Store(AssertionError('saved configuration was read'))
    found = asyncio.run(ModelCatalog(store).discover(
        'agent', 'https://models.example/v1', 'draft', 'typed-secret', str(uuid4())))
    assert found == ['only']
    assert calls[0]['apiKey'] == 'typed-secret'
    assert store.calls == []


def test_discover_without_a_saved_key_does_not_probe(monkeypatch):
    calls, read = _reader([{'id': 'only'}])
    monkeypatch.setattr('opendirector.application.model_catalog.read_service_models', read)
    store = Store({'url': 'https://models.example/v1', 'apiKey': ''})
    with pytest.raises(ProjectError, match='不能复用'):
        asyncio.run(ModelCatalog(store).discover('agent', 'https://models.example/v1', '', '', 'config'))
    assert store.calls == [('config', 'agent')]
    assert calls == []
    with pytest.raises(ProjectError, match='不能复用'):
        asyncio.run(ModelCatalog(store).discover('agent', 'https://models.example/v1', '', '', None))
    assert store.calls == [('config', 'agent')]


def test_discover_without_auth_does_not_read_a_saved_key(monkeypatch):
    calls, read = _reader([{'id': 'sam'}])
    monkeypatch.setattr('opendirector.application.model_catalog.read_service_models', read)
    store = Store(AssertionError('saved configuration was read'))
    found = asyncio.run(ModelCatalog(store).discover(
        'image', 'http://gpu.example/v1', 'sam', '', 'ignored', connection_type='self_hosted',
        protocol='vllm_omni_segmentation', auth_mode='none'))
    assert found == ['sam']
    assert calls[0]['apiKey'] == ''
    assert calls[0]['authMode'] == 'none'


def test_missing_saved_model_is_rejected_before_a_probe(tmp_path, monkeypatch):
    calls, read = _reader([{'id': 'only'}])
    monkeypatch.setattr('opendirector.application.model_catalog.read_service_models', read)
    with pytest.raises(ProjectError, match='所选模型不存在') as caught:
        asyncio.run(ModelCatalog(ModelConfigs(tmp_path)).discover(
            'agent', 'https://models.example/v1', '', '', str(uuid4())))
    assert caught.value.status == 409
    assert calls == []


def test_agent_test_reuses_key_and_requires_visible_text(tmp_path):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('agent', 'https://models.example/v1', 'demo', 'test-secret')
    before = (tmp_path / '.opendirector' / 'models.json').read_bytes()
    tester = Scripted([{'type': 'thinking'}, {'type': 'delta', 'text': ' \n'}, {'type': 'delta', 'text': 'OK'}])
    elapsed = asyncio.run(ModelCatalog(configs, tester).test_agent(
        'https://models.example/v1', 'draft-model', '', saved['id']))
    assert elapsed >= 0
    assert tester.yielded == 3
    config, payload = tester.calls[0]
    assert config['apiKey'] == 'test-secret'
    assert payload['model'] == 'draft-model'
    assert payload['max_tokens'] == 1024
    assert payload['stream'] is True
    assert (tmp_path / '.opendirector' / 'models.json').read_bytes() == before
    with pytest.raises(ProjectError, match='不能复用'):
        asyncio.run(ModelCatalog(configs, tester).test_agent(
            'https://other.example/v1', 'draft-model', '', saved['id']))
    assert len(tester.calls) == 1
    blank = Scripted([{'type': 'delta', 'text': '  '}])
    with pytest.raises(ProjectError, match='未返回正文') as caught:
        asyncio.run(ModelCatalog(configs, blank).test_agent('https://models.example/v1', 'demo', 'typed'))
    assert caught.value.status == 502


def test_agent_test_keeps_provider_payload_rules_and_times_out(tmp_path):
    tester = Scripted([{'type': 'delta', 'text': 'OK'}])
    asyncio.run(ModelCatalog(ModelConfigs(tmp_path), tester).test_agent(
        'https://api.deepseek.com/v1', 'deepseek-chat', 'typed'))
    assert tester.calls[0][1]['thinking'] == {'type': 'enabled'}
    assert tester.calls[0][1]['max_tokens'] == 1024
    with pytest.raises(ProjectError, match='测试超时') as caught:
        asyncio.run(asyncio.wait_for(ModelCatalog(ModelConfigs(tmp_path), Silent()).test_agent(
            'https://models.example/v1', 'demo', 'typed', timeout=0.05), timeout=1))
    assert caught.value.status == 504


def test_capability_preset_does_not_probe_or_require_a_key(monkeypatch):
    calls, read = _reader({'outputs': []})
    monkeypatch.setattr('opendirector.application.model_catalog.read_video_capabilities', read)
    store = Store(AssertionError('saved configuration was read'))
    result = asyncio.run(ModelCatalog(store).capabilities(
        'video', 'http://model.test/v1', 'custom-video', '', source='preset', connection_type='self_hosted',
        protocol='vllm_omni', auth_mode='bearer', video_adapter='fasth3'))
    config = {**model_fields('http://model.test/v1', 'custom-video', ''), 'kind': 'video',
              **connection_fields('video', 'self_hosted', 'vllm_omni', 'bearer', None), 'videoAdapter': 'fasth3'}
    assert result == input_rules(config).get('videoCapabilities')
    assert calls == []
    assert store.calls == []
    with pytest.raises(ProjectError, match='仅适用于视频'):
        asyncio.run(ModelCatalog(store).capabilities('image', 'not a url', 'x', '', source='service'))


def test_capability_probe_reuses_key_only_for_the_same_address(tmp_path, monkeypatch):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('video', 'http://model.test/v1', 'custom-video', 'test-secret',
                         connection_type='self_hosted', protocol='vllm_omni', auth_mode='bearer',
                         video_adapter='standard')
    before = (tmp_path / '.opendirector' / 'models.json').read_bytes()
    calls, read = _reader({'outputs': []})
    monkeypatch.setattr('opendirector.application.model_catalog.read_video_capabilities', read)
    result = asyncio.run(ModelCatalog(configs).capabilities(
        'video', 'http://model.test/v1', 'custom-video', '', source='service', config_id=saved['id'],
        connection_type='self_hosted', protocol='vllm_omni', auth_mode='bearer', video_adapter='standard'))
    assert result == {'outputs': []}
    assert calls[0]['apiKey'] == 'test-secret'
    assert (tmp_path / '.opendirector' / 'models.json').read_bytes() == before
    with pytest.raises(ProjectError, match='不能复用'):
        asyncio.run(ModelCatalog(configs).capabilities(
            'video', 'http://different.test/v1', 'custom-video', '', source='service', config_id=saved['id'],
            connection_type='self_hosted', protocol='vllm_omni', auth_mode='bearer'))
    assert len(calls) == 1


def test_capability_probe_accepts_a_saved_blank_key_that_discovery_rejects(monkeypatch):
    calls, read = _reader({'outputs': []})
    monkeypatch.setattr('opendirector.application.model_catalog.read_video_capabilities', read)
    store = Store({'url': 'http://model.test/v1', 'apiKey': ''})
    result = asyncio.run(ModelCatalog(store).capabilities(
        'video', 'http://model.test/v1', 'custom-video', '', source='service', config_id='config',
        connection_type='self_hosted', protocol='vllm_omni', auth_mode='bearer'))
    assert result == {'outputs': []}
    assert calls[0]['apiKey'] == ''
    assert store.calls == [('config', 'video')]


def test_preferences_round_trip_through_the_settings_store(tmp_path):
    service = Preferences(tmp_path)
    assert service.get() == {'removeWatermark': True}
    assert service.update({'removeWatermark': False}) == {'removeWatermark': False}
    assert Preferences(tmp_path).get() == {'removeWatermark': False}


def test_bigmodel_probes_reuse_only_the_selected_saved_account(tmp_path, monkeypatch):
    configs = ModelConfigs(tmp_path)
    url = 'https://open.bigmodel.cn/api/paas/v4'
    first, second = [configs.save_many('image', url + '/', ['image'], key, protocol='openai')[0]
                     for key in ['fixture-first', 'fixture-second']]
    calls, read = _reader([{'id': 'glm-test'}])
    monkeypatch.setattr('opendirector.application.model_catalog.read_service_models', read)
    tester = Scripted([{'type': 'delta', 'text': 'OK'}])
    catalog = ModelCatalog(configs, tester)
    before = configs.path.read_bytes()
    assert asyncio.run(catalog.discover('audio', url, '', '', second['id'], protocol='openai')) == ['glm-test']
    asyncio.run(catalog.test_agent(url, 'glm-test', '', first['id'], protocol='openai'))
    assert calls[0]['apiKey'] == 'fixture-second'
    assert tester.calls[0][0]['apiKey'] == 'fixture-first'
    with pytest.raises(ProjectError):
        asyncio.run(catalog.discover('audio', url + '/elsewhere', '', '', second['id'], protocol='openai'))
    with pytest.raises(ProjectError):
        configs.resolve(first['id'], 'agent')
    assert len(calls) == 1
    assert configs.path.read_bytes() == before
