"""Kling 4.0 submission routes sharing durable project jobs and result recovery."""
import asyncio
import base64
from io import BytesIO
import json
import re
from urllib.parse import urlsplit

import httpx
from PIL import Image, UnidentifiedImageError

from opendirector.domain.generation import GenerationError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.kling_models import kling_capabilities, kling_operation, kling_parameters, validate_kling_prompt
from opendirector.domain.projects import ProjectError
from opendirector.integrations.generation_errors import protocol_failure, provider_failure, transport_failure
from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, auth_headers, trust_environment
from opendirector.integrations.reference_inputs import image_type, references, reference_text, request_size
from opendirector.integrations.volcengine import _public_result_url, bounded
from opendirector.media.probe import require_ffprobe


class KlingVideoGeneration:
    def __init__(self, store, transport=None, poll_interval=3, retry_delays=(.5, 1)):
        self.store, self.transport, self.poll_interval = store, transport, poll_interval
        self.retry_delays = retry_delays

    def validate(self, kind, config):
        if kind != 'video':
            raise ProjectError('当前可灵协议不支持所选型号。', 422, code='kling_model')
        kling_capabilities(config['modelId'])
        require_ffprobe()

    def prepare_inputs(self, project_id, task, config, *, complete=True):
        self.validate(task['kind'], config)
        rules = input_rules(config)
        mode = task.get('videoMode', 'first_frame')
        source = {str(meta['id']): (blob, meta, kind) for blob, meta, kind in references(self.store, project_id, task['referenceIds'])}
        bindings = task.get('klingReferences') or task.get('referenceRoles') or [{'assetId': key, 'role': 'reference'} for key in source]
        images, manifest, tags, text_context, frames = [], [], {}, [], set()
        for binding in bindings:
            asset_id = binding['assetId']
            blob, meta, kind = source[asset_id]
            if kind == 'text':
                text_context.append(reference_text(blob))
                manifest.append(dict(assetId=asset_id, fingerprint=meta['fingerprint'], kind=kind, role='text', transmission='content'))
                continue
            if kind != 'image':
                raise ProjectError('可灵当前仅支持文本和图片参考。', 422, code='kling_image')
            mime = image_type(blob)
            try:
                with Image.open(BytesIO(blob)) as image:
                    width, height = image.size
                    image.verify()
            except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
                raise ProjectError('可灵图片需为有效的 PNG 或 JPEG，单张不超过 30 MB，边长至少 300 像素，宽高比为 0.4—2.5。',
                                   422, code='kling_image') from None
            if mime not in {'image/png', 'image/jpeg'} or len(blob) > rules['imageBytes'] or min(width, height) < 300 or not .4 <= width / height <= 2.5:
                raise ProjectError('可灵图片需为有效的 PNG 或 JPEG，单张不超过 30 MB，边长至少 300 像素，宽高比为 0.4—2.5。',
                                   422, code='kling_image')
            role = binding['role']
            if mode == 'first_frame':
                if binding.get('subjectRole') is not None:
                    raise ProjectError('可灵首尾帧需明确指定图片槽位，尾帧必须搭配首帧，每个槽位仅限一张图片。', 422, code='kling_frames')
                role = 'first_frame' if role == 'reference' and len([value for value in bindings if source[value['assetId']][2] == 'image']) == 1 else role
                if role not in rules['frameRoles'] or role in frames:
                    raise ProjectError('所选可灵型号不支持该帧槽位，或同一槽位包含多张图片。', 422, code='kling_frames')
                frames.add(role)
            elif mode == 'reference' and role == 'reference':
                role = 'refer_image'
            else:
                raise ProjectError('可灵当前支持首尾帧和图片参考模式。', 422, code='kling_mode')
            identity = f'image_{len(images) + 1}'
            tags[(binding.get('referenceId'), asset_id, binding.get('subjectRole'))] = identity
            tags.setdefault(asset_id, identity)
            images.append(dict(type=role, url=base64.b64encode(blob).decode('ascii'), id=identity))
            manifest.append(dict(assetId=asset_id, referenceId=binding.get('referenceId'), fingerprint=meta['fingerprint'],
                                 kind=kind, role=role, transmission='content'))
        if frames and 'first_frame' not in frames:
            raise ProjectError('可灵首尾帧需明确指定图片槽位，尾帧必须搭配首帧，每个槽位仅限一张图片。', 422, code='kling_frames')
        if len(images) > rules['maxImages']:
            raise ProjectError('可灵当前仅支持文本和图片参考。', 422, code='kling_image')
        operation = kling_operation(mode, bool(images))
        prompt_content = task.get('klingPromptContent', task.get('promptContent'))
        if prompt_content is not None:
            parts = []
            for part in prompt_content:
                if part['type'] == 'text':
                    parts.append(part['text'])
                else:
                    identity = tags.get((part.get('referenceId'), part['assetId'], part.get('subjectRole'))) or tags.get(part['assetId'])
                    parts.append('@' + identity if identity else part['name'])
            prompt = ''.join(parts)
        else:
            prompt = task['prompt']
        prompt += ''.join('\n' + text for text in text_context)
        if complete:
            validate_kling_prompt(prompt)
        if operation == 'frames':
            images.sort(key=lambda item: item['type'] == 'last_frame')
        prepared = dict(operation=operation, prompt=prompt, contents=[dict(type='prompt', text=prompt), *images], references=manifest)
        request_size(prepared['contents'], rules['requestBytes'] - 4096)
        return prepared

    def payload(self, config, task, prepared):
        parameters = task['parameters']
        intent = dict(videoMode=task.get('videoMode', 'first_frame'), durationSeconds=parameters.get('duration'),
                      resolution=parameters.get('resolution'), aspectRatio=parameters.get('ratio'))
        execution_config = {**config, 'videoCapabilities': None} if 'route' in parameters else config
        normalized = kling_parameters(execution_config, intent, prepared['operation'] != 'text')
        if any(key in parameters and parameters[key] != normalized[key] for key in ('operation', 'route', 'audio', 'generate_audio')):
            raise protocol_failure('prepare')
        settings = dict(duration=normalized['duration'], resolution=normalized['resolution'].lower())
        if prepared['operation'] != 'frames':
            settings['aspect_ratio'] = normalized['ratio']
        if prepared['operation'] == 'reference':
            settings['audio'] = 'native'
        content = {'prompt': prepared['prompt']} if prepared['operation'] == 'text' else {'contents': prepared['contents']}
        payload = {**content, 'settings': settings, 'options': {'external_task_id': task['id']}}
        request_size(payload, input_rules(config)['requestBytes'])
        return normalized['route'], payload

    async def _json(self, client, config, method, path, stage, **kwargs):
        secrets = (config.get('apiKey', ''),)
        try:
            async with client.stream(method, config['url'].rstrip('/') + path, headers=auth_headers(config), **kwargs) as response:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 1024 * 1024:
                        raise protocol_failure(stage)
                try:
                    value = json.loads(body)
                except (ValueError, UnicodeError):
                    if response.status_code >= 400:
                        raise provider_failure({}, stage=stage, http_status=response.status_code, headers=response.headers, secrets=secrets, provider='kling') from None
                    raise protocol_failure(stage) from None
                if not isinstance(value, dict):
                    raise protocol_failure(stage)
                if response.status_code == 200 and (not isinstance(value.get('code'), int) or isinstance(value.get('code'), bool)):
                    raise protocol_failure(stage)
                if response.status_code != 200 or value['code'] != 0:
                    raise provider_failure(value, stage=stage, http_status=response.status_code, headers=response.headers, secrets=secrets, provider='kling')
                return value, response.headers
        except httpx.TimeoutException:
            raise transport_failure(stage, timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure(stage) from None

    async def _query(self, client, config, external_id):
        for attempt in range(len(self.retry_delays) + 1):
            try:
                return await self._json(client, config, 'GET', '/tasks', 'poll', params={'task_ids': external_id})
            except GenerationError as failure:
                if failure.details.category not in {'temporary', 'rate_limit'} or attempt == len(self.retry_delays):
                    raise
                await asyncio.sleep(self.retry_delays[attempt])

    async def generate(self, config, task, submitted, *, result_ready=None):
        stage = 'submit'
        try:
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport,
                    trust_env=trust_environment(config['url'], config=config), timeout=httpx.Timeout(240, connect=15), follow_redirects=False) as client:
                external_id = task.get('externalTaskId')
                if not external_id:
                    prepared = await asyncio.to_thread(self.prepare_inputs, task['projectId'], task, config)
                    route, payload = self.payload(config, task, prepared)
                    value, _ = await self._json(client, config, 'POST', route, stage, json=payload)
                    remote = value['data']
                    external_id = remote['id']
                    if (not isinstance(external_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}', external_id)
                            or config.get('apiKey') and config['apiKey'] in external_id
                            or remote['status'] not in {'submitted', 'processing', 'succeeded', 'failed'}):
                        raise protocol_failure(stage)
                    await submitted(external_id)
                stage = 'poll'
                while True:
                    value, headers = await self._query(client, config, external_id)
                    if not isinstance(value['data'], list) or len(value['data']) != 1:
                        raise protocol_failure(stage)
                    remote = value['data'][0]
                    if remote['id'] != external_id:
                        raise protocol_failure(stage)
                    if remote['status'] == 'failed':
                        raise provider_failure({**remote, 'request_id': value.get('request_id')}, stage=stage,
                            headers=headers, http_status=200, secrets=(config.get('apiKey', ''),), provider='kling')
                    if remote['status'] == 'succeeded':
                        outputs = [output for output in remote['outputs'] if output.get('type') == 'video']
                        if len(outputs) != 1:
                            raise protocol_failure(stage)
                        url = outputs[0]['url']
                        self._result_url(url)
                        if result_ready:
                            await result_ready('mp4', url)
                        stage = 'download'
                        return await self.resume_result(config, 'mp4', url)
                    if remote['status'] not in {'submitted', 'processing'}:
                        raise protocol_failure(stage)
                    await asyncio.sleep(self.poll_interval)
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            raise protocol_failure(stage) from None

    @staticmethod
    def _result_url(url):
        if not isinstance(url, str) or len(url) > 16384:
            raise protocol_failure('download')
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise protocol_failure('download')
        parsed.port

    async def resume_result(self, config, suffix, url):
        try:
            self._result_url(url)
            pinned, headers, extensions = await _public_result_url(url)
            extensions['model_secrets'] = (config.get('apiKey', ''),)
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport,
                    trust_env=trust_environment(url, config=config), timeout=httpx.Timeout(240, connect=15), follow_redirects=False) as client:
                async with client.stream('GET', pinned, headers=headers, extensions=extensions) as response:
                    return suffix, await bounded(response, stage='download', secrets=(config.get('apiKey', ''),))
        except httpx.TimeoutException:
            raise transport_failure('download', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('download') from None
        except (ValueError, TypeError):
            raise protocol_failure('download') from None

    async def cancel(self, config, external_id):
        raise ProjectError('可灵远端取消接口尚未接通；任务可能继续执行并计费。', 409, code='kling_cancel')
