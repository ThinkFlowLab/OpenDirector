"""Explicit generation protocols for managed APIs and self-hosted services."""
import asyncio
import base64
import json
from urllib.parse import quote, urlsplit

import httpx

from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, auth_headers, trust_environment

from opendirector.domain.assets import MAX_ASSET_BYTES
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.integrations.reference_inputs import generation_references, references, image_type
from opendirector.integrations.volcengine import VolcengineGeneration, bounded, endpoint
from opendirector.integrations.generation_errors import checked, protocol_failure, provider_failure, transport_failure
from opendirector.integrations.minimax_video import MinimaxVideoGeneration
from opendirector.integrations.vllm_omni import VllmOmniGeneration
from opendirector.integrations.vllm_omni_image import VllmOmniImageGeneration
from opendirector.integrations.model_adapters import OpenAISpeech, VllmOmniMusic, VllmOmniScore, image_parts
from opendirector.domain.capabilities import MusicRequest, ScoreRequest, SpeechRequest
from opendirector.media.probe import require_ffprobe


class GenerationProviders(VolcengineGeneration):
    """Protocol adapters, plus dedicated adapters for vLLM-Omni MiniMax-H3 and Z-Image-Turbo profiles."""

    def __init__(self, store, transport=None, poll_interval=3, retry_delays=(0.5, 1.0)):
        super().__init__(store, transport, poll_interval, retry_delays)
        self.minimax_video = MinimaxVideoGeneration(store, transport, poll_interval)
        self.vllm_omni = VllmOmniGeneration(store, transport, poll_interval)
        self.vllm_omni_image = VllmOmniImageGeneration(store, transport, poll_interval)

    def _profile_adapter(self, config):
        if config and config.get('protocol') == 'minimax_video_v2':
            return self.minimax_video
        profile = input_rules(config)['profile'] if config else None
        return {'vllm-omni-h3': self.vllm_omni, 'vllm-omni-image': self.vllm_omni_image,
                'vllm-omni-qwen-image': self.vllm_omni_image}.get(profile)

    def prepare_inputs(self, project_id, node, config, *, complete=True):
        adapter = self._profile_adapter(config)
        if adapter:
            return adapter.prepare_inputs(project_id, node, config, complete=complete)
        return super().prepare_inputs(project_id, node, config, complete=complete)

    def validate(self, kind, config):
        if input_rules(config)['profile'] == 'vllm-omni-segmentation':
            raise ProjectError('视觉分割模型仅用于选区、分割和抠像，请选择生成模型。')
        if input_rules(config)['profile'] == 'vllm-omni-depth':
            raise ProjectError('视频深度模型仅用于深度动作捕捉，请选择生成模型。')
        if input_rules(config)['profile'] == 'vllm-omni-score':
            raise ProjectError('扒谱模型仅用于参照音乐生成，请选择音乐生成模型。')
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
        if kwargs.get('files'):
            kwargs['extensions'] = {'model_parameters': {'fields': kwargs.get('data'), 'file_count': len(kwargs['files'])}}
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
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(url, config=config), timeout=httpx.Timeout(240, connect=15)) as client:
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
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(config['url'], config=config), timeout=httpx.Timeout(240, connect=15), follow_redirects=False) as client:
                if kind == 'video':
                    url = endpoint(config['url'], '/videos')
                    external_id = task.get('externalTaskId')
                    if not external_id:
                        prepared = await asyncio.to_thread(generation_references, self.store, task, config)
                        files = []
                        fast = input_rules(config)['profile'] == 'fasth3-omni'
                        for data, meta, source_kind in references(self.store, task['projectId'], task['referenceIds']):
                            if source_kind in {'image', 'video', 'audio'}:
                                files.append(('input_references' if fast else 'input_reference', (meta['name'], data, image_type(data) if source_kind == 'image' else meta['type'])))
                        parameters = task['parameters']
                        form = {'model': config['modelId'], 'prompt': prepared['prompt']}
                        if 'duration' in parameters: form['seconds'] = format(parameters['duration'], 'g')
                        if 'size' in parameters: form['size'] = parameters['size']
                        if fast:
                            form.update({
                                'seconds': str(parameters.get('seconds', '5')), 'size': parameters.get('size', '832x480'),
                                'num_inference_steps': '8', 'guidance_scale': '1', 'fps': '24',
                                'seed': str(parameters.get('seed', 1234)),
                                'extra_params': json.dumps({'task': 'ref2va', 'duration': float(parameters.get('duration', parameters.get('seconds', 5))), 'audio_flow_shift': 3})})
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
                            raise provider_failure(value, stage='poll', http_status=200, secrets=secrets)
                        if value.get('status') not in {'queued', 'in_progress', 'running'}:
                            raise protocol_failure('poll')
                        await asyncio.sleep(self.poll_interval)
                if kind == 'audio' and task['parameters'].get('creation_type') == 'music':
                    params = task['parameters']
                    score = ''
                    if params.get('score_model'):
                        score = await self._score(task, params)
                    result = await VllmOmniMusic(self.transport).music(config, MusicRequest(
                        task['prompt'], params.get('lyrics', ''), params['duration'], score=score,
                        score_mode=params.get('score_mode', 'melody')))
                    return result.suffix, result.data
                if kind == 'audio':
                    result = await OpenAISpeech(self.transport).speech(config, SpeechRequest(task['prompt'], task['parameters'].get('voice')))
                    return result.suffix, result.data
                if kind == 'image':
                    prepared = await asyncio.to_thread(generation_references, self.store, task, config)
                    size = task['parameters'].get('size', '')
                    # Older canvas tasks use a provider label; unified tasks
                    # already freeze the dimensions resolved by this adapter.
                    size = size if 'x' in size else '1024x1024'
                    fields = {'model': config['modelId'], 'prompt': prepared['prompt'], 'size': size}
                    if prepared['images']:
                        # Same construction as the capability adapter: leave both the
                        # field name and the declared type to one helper, so a JPEG is
                        # never labelled image/png. gpt-image reads several references
                        # as repeated `image[]` parts; one keeps the plain field.
                        field = 'image[]' if input_rules(config)['profile'] == 'openai-gpt-image' else 'image'
                        images = [data for data, meta, source_kind in references(self.store, task['projectId'], task['referenceIds'])
                                  if source_kind == 'image']
                        files = image_parts(images, field)
                        async with client.stream('POST', endpoint(config['url'], '/images/edits'), headers=auth_headers(config),
                            data=fields, files=files,
                            extensions={'model_parameters': {'fields': fields, 'file_count': len(files)}}) as response:
                            value = json.loads(await bounded(response, stage=stage, secrets=secrets))
                    else:
                        async with client.stream('POST', endpoint(config['url'], '/images/generations'), headers=auth_headers(config),
                            json={**fields, 'n': 1}) as response:
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

    async def _score(self, task, params):
        """Transcribe the job's one reference recording with the transcription model it froze."""
        config = await asyncio.to_thread(self.store.frozen_model, params['score_model'])
        loaded = await asyncio.to_thread(lambda: list(references(self.store, task['projectId'], task['referenceIds'])))
        data, meta = next((data, meta) for data, meta, source_kind in loaded if source_kind == 'audio')
        return await VllmOmniScore(self.transport).score(config, ScoreRequest(
            data, meta['name'], melody_only=params['score_mode'] == 'melody'))

    async def cancel(self, config, external_id):
        adapter = self._profile_adapter(config)
        if adapter:
            return await adapter.cancel(config, external_id)
        if config.get('protocol') != 'vllm_omni':
            return await super().cancel(config, external_id)
        try:
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(config['url'], config=config), timeout=15) as client:
                async with client.stream('DELETE', endpoint(config['url'], '/videos') + '/' + quote(external_id, safe=''), headers=auth_headers(config)) as response:
                    await checked(response, stage='cancel', secrets=(config.get('apiKey', ''),))
        except httpx.TimeoutException:
            raise transport_failure('cancel', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('cancel') from None
