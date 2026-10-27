"""Explicit generation protocols for managed APIs and self-hosted services."""
import asyncio
import base64
import json
from urllib.parse import quote, urlsplit

import httpx

from museshow.integrations.http_settings import auth_headers, trust_environment

from museshow.domain.assets import MAX_ASSET_BYTES
from museshow.domain.input_rules import input_rules
from museshow.domain.projects import ProjectError
from museshow.integrations.reference_inputs import generation_references, references, image_type
from museshow.integrations.volcengine import VolcengineGeneration, bounded, endpoint
from museshow.integrations.generation_errors import checked, protocol_failure, provider_failure, transport_failure
from museshow.integrations.vllm_omni import VllmOmniGeneration
from museshow.integrations.vllm_omni_image import VllmOmniImageGeneration
from museshow.media.probe import require_ffprobe


class GenerationProviders(VolcengineGeneration):
    """Protocol adapters, plus dedicated adapters for vLLM-Omni MiniMax-H3 and Z-Image-Turbo profiles."""

    def __init__(self, store, transport=None, poll_interval=3, retry_delays=(0.5, 1.0)):
        super().__init__(store, transport, poll_interval, retry_delays)
        self.vllm_omni = VllmOmniGeneration(store, transport, poll_interval)
        self.vllm_omni_image = VllmOmniImageGeneration(store, transport, poll_interval)

    def _profile_adapter(self, config):
        profile = input_rules(config)['profile'] if config else None
        return {'vllm-omni-h3': self.vllm_omni, 'vllm-omni-image': self.vllm_omni_image}.get(profile)

    def prepare_inputs(self, project_id, node, config, *, complete=True):
        adapter = self._profile_adapter(config)
        if adapter:
            return adapter.prepare_inputs(project_id, node, config, complete=complete)
        return super().prepare_inputs(project_id, node, config, complete=complete)

    def validate(self, kind, config):
        adapter = self._profile_adapter(config)
        if adapter:
            return adapter.validate(kind, config)
        if config.get('protocol') in {None, 'volcengine'}:
            return super().validate(kind, config)
        if kind in {'video', 'audio'}:
            require_ffprobe()
        if kind == 'video' and config.get('protocol') != 'vllm_omni':
            raise ProjectError('视频模型请选择 vLLM-Omni 视频接口。')

    async def _json(self, client, method, url, config, **kwargs):
        async with client.stream(method, url, headers=auth_headers(config), **kwargs) as response:
            await checked(response, stage='poll' if method == 'GET' else 'submit', secrets=(config.get('apiKey', ''),))
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 1024 * 1024:
                    raise protocol_failure('poll' if method == 'GET' else 'submit')
            return json.loads(data)

    async def resume_result(self, config, suffix, url):
        adapter = self._profile_adapter(config)
        if adapter:
            return await adapter.resume_result(config, suffix, url)
        if not config or config.get('protocol') in {None, 'volcengine'}:
            return await super().resume_result(config, suffix, url)
        # Only send a service token back to that exact configured origin.
        base, target = urlsplit(config['url']), urlsplit(url)
        headers = auth_headers(config) if (base.scheme, base.netloc) == (target.scheme, target.netloc) else {}
        try:
            async with httpx.AsyncClient(transport=self.transport, trust_env=trust_environment(url), timeout=httpx.Timeout(240, connect=15)) as client:
                async with client.stream('GET', url, headers=headers, follow_redirects=False) as response:
                    return suffix, await bounded(response, stage='download', secrets=(config.get('apiKey', ''),))
        except httpx.TimeoutException:
            raise transport_failure('download', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('download') from None

    async def generate(self, config, task, submitted, *, result_ready=None):
        adapter = self._profile_adapter(config)
        if adapter and task['kind'] != 'text':
            return await adapter.generate(config, task, submitted, result_ready=result_ready)
        if config.get('protocol') in {None, 'volcengine'} or task['kind'] == 'text':
            return await super().generate(config, task, submitted, result_ready=result_ready)
        kind, stage = task['kind'], 'submit'
        secrets = (config.get('apiKey', ''),)
        try:
            async with httpx.AsyncClient(transport=self.transport, trust_env=trust_environment(config['url']), timeout=httpx.Timeout(240, connect=15), follow_redirects=False) as client:
                if kind == 'video':
                    url = endpoint(config['url'], '/videos')
                    external_id = task.get('externalTaskId')
                    if not external_id:
                        prepared = await asyncio.to_thread(generation_references, self.store, task, config)
                        files = []
                        for data, meta, source_kind in references(self.store, task['projectId'], task['referenceIds']):
                            if source_kind in {'image', 'video', 'audio'}:
                                files.append(('input_references', (meta['name'], data, image_type(data) if source_kind == 'image' else meta['type'])))
                        parameters = task['parameters']
                        form = {'model': config['modelId'], 'prompt': prepared['prompt'],
                                'seconds': str(parameters.get('seconds', '5')), 'size': parameters.get('size', '832x480'),
                                'num_inference_steps': '8', 'guidance_scale': '1', 'fps': '24',
                                'seed': str(parameters.get('seed', 1234)),
                                'extra_params': json.dumps({'task': 'ref2va', 'duration': float(parameters.get('duration', parameters.get('seconds', 5))), 'audio_flow_shift': 3})}
                        # Force multipart even for an empty reference list.
                        value = await self._json(client, 'POST', url, config, data=form, files=files or {'_multipart': (None, '1')})
                        external_id = value['id']
                        if not isinstance(external_id, str) or not external_id or len(external_id) > 200:
                            raise protocol_failure(stage)
                        await submitted(external_id)
                    stage = 'poll'
                    task_url = url + '/' + quote(external_id, safe='')
                    while True:
                        value = await self._retry_read(lambda: self._json(client, 'GET', task_url, config))
                        if value.get('status') == 'completed':
                            stage = 'download'
                            content_url = task_url + '/content'
                            if result_ready:
                                await result_ready('mp4', content_url)
                            return await self.resume_result(config, 'mp4', content_url)
                        if value.get('status') in {'failed', 'cancelled', 'expired'}:
                            raise provider_failure(value, stage='poll', secrets=secrets)
                        if value.get('status') not in {'queued', 'in_progress', 'running'}:
                            raise protocol_failure('poll')
                        await asyncio.sleep(self.poll_interval)
                if kind == 'audio':
                    # vLLM-Omni speech servers name their own speakers; "default" selects the model's.
                    voice = task['parameters'].get('voice') or ('default' if config.get('connectionType') == 'self_hosted' else 'alloy')
                    payload = {'model': config['modelId'], 'input': task['prompt'], 'voice': voice, 'response_format': 'mp3'}
                    async with client.stream('POST', endpoint(config['url'], '/audio/speech'), headers=auth_headers(config), json=payload) as response:
                        return 'mp3', await bounded(response, stage='submit', secrets=secrets)
                if kind == 'image':
                    prepared = await asyncio.to_thread(generation_references, self.store, task, config)
                    if prepared['images']:
                        files = [('image', (meta['name'], data, image_type(data)))
                                 for data, meta, source_kind in references(self.store, task['projectId'], task['referenceIds']) if source_kind == 'image']
                        async with client.stream('POST', endpoint(config['url'], '/images/edits'), headers=auth_headers(config),
                            data={'model': config['modelId'], 'prompt': prepared['prompt'], 'size': '1024x1024'}, files=files) as response:
                            value = json.loads(await bounded(response, stage=stage, secrets=secrets))
                    else:
                        async with client.stream('POST', endpoint(config['url'], '/images/generations'), headers=auth_headers(config),
                            json={'model': config['modelId'], 'prompt': prepared['prompt'], 'size': '1024x1024', 'n': 1}) as response:
                            value = json.loads(await bounded(response, stage=stage, secrets=secrets))
                    result = value['data'][0]
                    if result.get('b64_json'):
                        data = base64.b64decode(result['b64_json'], validate=True)
                        if len(data) > MAX_ASSET_BYTES:
                            raise ProjectError('生成图片超过 50 MB。', 413)
                        return 'png', data
                    if result_ready:
                        await result_ready('png', result['url'])
                    return await self.resume_result(config, 'png', result['url'])
        except httpx.TimeoutException:
            raise transport_failure(stage, timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure(stage) from None
        except (ValueError, KeyError, TypeError, IndexError, AttributeError):
            raise protocol_failure(stage) from None

    async def cancel(self, config, external_id):
        adapter = self._profile_adapter(config)
        if adapter:
            return await adapter.cancel(config, external_id)
        if config.get('protocol') != 'vllm_omni':
            return await super().cancel(config, external_id)
        try:
            async with httpx.AsyncClient(transport=self.transport, trust_env=trust_environment(config['url']), timeout=15) as client:
                async with client.stream('DELETE', endpoint(config['url'], '/videos') + '/' + quote(external_id, safe=''), headers=auth_headers(config)) as response:
                    await checked(response, stage='cancel', secrets=(config.get('apiKey', ''),))
        except httpx.TimeoutException:
            raise transport_failure('cancel', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('cancel') from None
