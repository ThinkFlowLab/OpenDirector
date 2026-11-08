"""Model discovery, capability probes, and connection tests.

A saved credential is reused only for the address it belongs to. These
operations never write configuration.
"""
import asyncio
import time

from opendirector.domain.input_rules import input_rules
from opendirector.domain.model_connection import connection_fields, model_fields
from opendirector.domain.projects import ProjectError
from opendirector.integrations.chat_completions import ChatCompletions, chat_payload
from opendirector.integrations.model_capabilities import read_service_models, read_video_capabilities


_SAVED_KEY = '请填写该服务的 API Key；新地址不能复用原地址的密钥。'
AGENT_TEST_TIMEOUT_SECONDS = 30


def _draft(kind, url, model_id, api_key, connection_type, protocol, auth_mode, proxy_mode, **extra):
    return {**model_fields(url, model_id, api_key), 'kind': kind,
            **connection_fields(kind, connection_type, protocol, auth_mode, proxy_mode), **extra}


def _reuse_saved_key(config, existing, *, require_key):
    if not existing or existing['url'] != config['url'] or (require_key and not existing['apiKey']):
        raise ProjectError(_SAVED_KEY)
    config['apiKey'] = existing['apiKey']
    return config


class ModelCatalog:
    """Saved model configuration plus read-only service probes."""

    def __init__(self, configs, tester=None):
        self.configs = configs
        self.tester = tester or ChatCompletions()

    def list(self):
        return self.configs.list()

    def save(self, kind, url, model_id, api_key, config_id=None, **options):
        return self.configs.save(kind, url, model_id, api_key, config_id, **options)

    def save_many(self, kind, url, model_ids, api_key, config_id=None, **options):
        return self.configs.save_many(kind, url, model_ids, api_key, config_id, **options)

    def delete(self, config_id):
        self.configs.delete(config_id)

    def delete_service(self, config_id):
        self.configs.delete_service(config_id)

    async def _existing(self, config_id, kind, *, threaded):
        if not config_id:
            return None
        # Discovery and agent tests read the saved key off the event loop.
        # Capability lookup stays on the caller, as the previous handler did.
        if threaded:
            return await asyncio.to_thread(self.configs.resolve, config_id, kind)
        return self.configs.resolve(config_id, kind)

    async def _with_saved_key(self, config, config_id, kind, *, require_key, threaded):
        if config['authMode'] != 'bearer' or config['apiKey']:
            return config
        existing = await self._existing(config_id, kind, threaded=threaded)
        return _reuse_saved_key(config, existing, require_key=require_key)

    async def discover(self, kind, url, model_id, api_key, config_id=None, *, connection_type='api', protocol=None,
                       auth_mode=None, proxy_mode=None):
        config = _draft(kind, url, model_id or 'discovery', api_key, connection_type, protocol, auth_mode, proxy_mode)
        config = await self._with_saved_key(config, config_id, kind, require_key=True, threaded=True)
        models = await read_service_models(config)
        return list(dict.fromkeys(item['id'] for item in models))

    async def test_agent(self, url, model_id, api_key, config_id=None, *, connection_type='api', protocol=None,
                         auth_mode=None, proxy_mode=None, timeout=AGENT_TEST_TIMEOUT_SECONDS):
        config = _draft('agent', url, model_id, api_key, connection_type, protocol, auth_mode, proxy_mode)
        config = await self._with_saved_key(config, config_id, 'agent', require_key=True, threaded=True)
        payload = chat_payload(config, [{'role': 'user', 'content': 'Reply with OK only.'}], 'auto')
        payload['max_tokens'] = 1024
        started = time.monotonic()
        received = False
        try:
            async with asyncio.timeout(timeout):
                async for event in self.tester.stream(config, payload):
                    if event['type'] == 'delta' and event['text'].strip():
                        received = True
        except TimeoutError:
            raise ProjectError('测试超时（30 秒），请检查服务地址及模型状态。', 504) from None
        if not received:
            raise ProjectError('模型未返回正文，请检查 Chat Completions 兼容性。', 502)
        return round((time.monotonic() - started) * 1000)

    async def capabilities(self, kind, url, model_id, api_key, *, source='preset', config_id=None,
                           connection_type='api', protocol=None, auth_mode=None, proxy_mode=None, video_adapter=None):
        if kind != 'video':
            raise ProjectError('能力配置仅适用于视频模型。')
        config = _draft(kind, url, model_id, api_key, connection_type, protocol, auth_mode, proxy_mode,
                        videoAdapter=video_adapter or 'auto')
        if source == 'preset':
            return input_rules(config).get('videoCapabilities')
        config = await self._with_saved_key(config, config_id, 'video', require_key=False, threaded=False)
        return await read_video_capabilities(config)
