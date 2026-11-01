"""Self-hosted vLLM-Omni MiniMax-H3 video+audio through the async /v1/videos job API.

continuation continues an earlier H3 clip of the same server by its job ID: the
service guides the request with that clip's cached latent tail behind a hidden
overlap, so picture and sound carry across the cut. The request otherwise
describes only the clip it returns, whose length lands on 17-frame groups.
"""

import asyncio
import base64
import json
from urllib.parse import quote, urlsplit

import httpx

from opendirector.domain.generation import GenerationError, GenerationFailure
from opendirector.domain.projects import ProjectError
from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, auth_headers, trust_environment
from opendirector.integrations.generation_errors import checked, protocol_failure, provider_failure, transport_failure
from opendirector.integrations.reference_inputs import generation_references
from opendirector.integrations.volcengine import bounded, endpoint
from opendirector.media.probe import require_ffprobe

FPS = 24
RATIOS = {'16:9', '9:16', '1:1', '4:3', '3:4'}


def h3_frames(seconds):
    """Nearest H3 length on the 17n+5 frame grid, within 4-15 seconds."""
    steps = round((seconds * FPS - 5) / 17)
    return 17 * min(max(steps, 6), 20) + 5


def _upload(data_uri, name):
    header, payload = data_uri.split(',', 1)
    mime = header.removeprefix('data:').split(';', 1)[0]
    return name + '.' + mime.split('/')[1].replace('mpeg', 'mp3').replace('x-wav', 'wav'), base64.b64decode(payload), mime


def _missing_latents(value):
    error = value.get('error') if isinstance(value, dict) else None
    message = (error or {}).get('message') if isinstance(error, dict) else (value or {}).get('detail') if isinstance(value, dict) else None
    return isinstance(message, str) and ('continue_from' in message or 'cached latents' in message)


def _continuation_failure(stage):
    return GenerationError(GenerationFailure(category='reference', stage=stage,
        message='服务端已没有上一段视频的接续缓存（服务重启、缓存淘汰或任务不属于当前服务）。',
        suggestion='请重新生成上一段视频后再接续，或改用首帧/素材参考模式；当前输入已保留。'), 409)


class VllmOmniGeneration:
    def __init__(self, store, transport=None, poll_interval=3):
        self.store, self.transport, self.poll_interval = store, transport, poll_interval

    def validate(self, kind, config):
        if kind != 'video':
            raise ProjectError('vLLM-Omni MiniMax-H3 只用于视频生成。', 409)
        require_ffprobe()

    def prepare_inputs(self, project_id, node, config, *, complete=True):
        prepared = generation_references(self.store, {**node, 'projectId': project_id}, config, complete=complete)
        return {'profile': prepared['rules']['profile'], 'references': prepared['manifest']}

    def form(self, config, task, prepared):
        mode = task.get('videoMode', 'first_frame')
        seconds = task['parameters'].get('duration', 5)
        ratio = task['parameters'].get('ratio')
        fields = {'model': config['modelId'], 'prompt': prepared['prompt'], 'fps': str(FPS), 'num_frames': str(h3_frames(seconds))}
        if task['parameters'].get('resolution') and task['parameters'].get('size'):
            fields['size'] = task['parameters']['size']
        files, extra = [], {}
        if mode == 'continuation':
            # T2VA follows the cached tail closely; attached images or audio
            # make it a Ref2VA continuation, whose cut can be less seamless.
            references = prepared['images'] or prepared['audios']
            extra.update(task='ref2va' if references else 't2va', continue_from=prepared['continueFrom'])
            width, height = prepared['continueSize'] or (None, None)
            if width and height:
                fields['size'] = f'{width}x{height}'
        else:
            if mode == 'reference':
                extra['task'] = 'ref2va'
            elif prepared['images']:
                extra['task'] = 'fl2va'
                files.append(('input_reference', _upload(prepared['images'][0], 'first_frame')))
                prepared = {**prepared, 'images': []}
            else:
                extra['task'] = 't2va'
                # An explicit size already fixes the frame; sending a conflicting
                # aspect_ratio would contradict it.
                if 'size' not in fields:
                    extra['aspect_ratio'] = ratio if ratio in RATIOS else '16:9'
        files.extend(('input_references', _upload(image, f'image_{index}')) for index, image in enumerate(prepared['images'], 1))
        files.extend(('input_references', _upload(audio, f'audio_{index}')) for index, audio in enumerate(prepared['audios'], 1))
        fields['extra_params'] = json.dumps(extra)
        return fields, files

    async def generate(self, config, task, submitted, *, result_ready=None):
        headers = auth_headers(config)
        secrets = (config.get('apiKey', ''),)
        base = endpoint(config['url'], '/videos')
        stage = 'submit'
        try:
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(config['url'], config=config), timeout=httpx.Timeout(240, connect=15),
                                         follow_redirects=False) as client:
                external_id = task.get('externalTaskId')
                if not external_id:
                    prepared = await asyncio.to_thread(generation_references, self.store, task, config)
                    fields, files = self.form(config, task, prepared)
                    # Always multipart, as the API documents, even without uploads.
                    parts = [(name, (None, value)) for name, value in fields.items()] + files
                    async with client.stream('POST', base, headers=headers, files=parts, extensions={'model_parameters': {'fields': fields, 'file_count': len(files)}}) as response:
                        if response.status_code == 400 and task.get('videoMode') == 'continuation':
                            value = json.loads(await response.aread())
                            raise _continuation_failure(stage) if _missing_latents(value) else provider_failure(
                                value, stage=stage, headers=response.headers, http_status=400, secrets=secrets)
                        external_id = json.loads(await bounded(response, stage=stage, secrets=secrets))['id']
                    if not isinstance(external_id, str) or not external_id or len(external_id) > 200:
                        raise protocol_failure(stage)
                    await submitted(external_id)
                stage = 'poll'
                url = base + '/' + quote(external_id, safe='')
                while True:
                    async with client.stream('GET', url, headers=headers) as response:
                        value = json.loads(await bounded(response, stage=stage, secrets=secrets))
                    status = value.get('status')
                    if status == 'completed':
                        stage = 'download'
                        if result_ready:
                            await result_ready('mp4', url + '/content')
                        return 'mp4', await self._download(client, config, url + '/content')
                    if status in {'failed', 'cancelled', 'expired'}:
                        if status == 'failed' and _missing_latents(value):
                            raise _continuation_failure(stage)
                        raise provider_failure(value, stage=stage, http_status=response.status_code, secrets=secrets)
                    if status not in {'queued', 'in_progress'}:
                        raise protocol_failure(stage)
                    await asyncio.sleep(self.poll_interval)
        except httpx.TimeoutException:
            raise transport_failure(stage, timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure(stage) from None
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            raise protocol_failure(stage) from None

    async def _download(self, client, config, url):
        # Results come from the configured service itself, never a third-party host.
        if urlsplit(url).netloc != urlsplit(config['url']).netloc:
            raise protocol_failure('download')
        async with client.stream('GET', url, headers=auth_headers(config)) as response:
            return await bounded(response, stage='download', secrets=(config.get('apiKey', ''),))

    async def resume_result(self, config, suffix, url):
        try:
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(config['url'], config=config), timeout=httpx.Timeout(240, connect=15)) as client:
                return suffix, await self._download(client, config, url)
        except httpx.TimeoutException:
            raise transport_failure('download', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('download') from None

    async def cancel(self, config, external_id):
        try:
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(config['url'], config=config), timeout=15) as client:
                async with client.stream('DELETE', endpoint(config['url'], '/videos') + '/' + quote(external_id, safe=''),
                                         headers=auth_headers(config)) as response:
                    await checked(response, stage='cancel', secrets=(config.get('apiKey', ''),))
        except httpx.TimeoutException:
            raise transport_failure('cancel', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('cancel') from None
