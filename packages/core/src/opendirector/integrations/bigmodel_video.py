"""BigModel asynchronous video jobs, with durable IDs and project-local frames."""
import asyncio
from io import BytesIO
import json
import re
from urllib.parse import quote, urlsplit

import httpx
from PIL import Image, UnidentifiedImageError

from opendirector.domain.bigmodel_video import COGVIDEO_SIZES, cogvideo_capabilities
from opendirector.domain.projects import ProjectError
from opendirector.integrations.generation_errors import checked, protocol_failure, provider_failure, transport_failure
from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, auth_headers, trust_environment
from opendirector.integrations.reference_inputs import data_uri, image_type, references, reference_text, request_size
from opendirector.integrations.volcengine import VolcengineGeneration, bounded
from opendirector.media.probe import require_ffprobe


class BigModelVideoGeneration(VolcengineGeneration):
    def validate(self, kind, config):
        if kind != 'video':
            raise ProjectError('智谱视频协议仅支持 CogVideoX-3。', 422, code='bigmodel_video_model')
        cogvideo_capabilities(config['modelId'])
        require_ffprobe()

    def prepare_inputs(self, project_id, task, config, *, complete=True):
        self.validate(task['kind'], config)
        if task.get('videoMode', 'first_frame') != 'first_frame':
            raise ProjectError('CogVideoX-3 支持文生视频、单图和首尾帧生成，不支持多图参考或视频续写。',
                               422, code='bigmodel_video_frames')
        source = {str(meta['id']): (blob, meta, kind) for blob, meta, kind in references(self.store, project_id, task['referenceIds'])}
        bindings = task.get('referenceRoles') or [{'assetId': key, 'role': 'reference'} for key in source]
        image_count = sum(source[item['assetId']][2] == 'image' for item in bindings)
        frames, manifest, context = {}, [], []
        for binding in bindings:
            key = binding['assetId']
            blob, meta, kind = source[key]
            if kind == 'text':
                context.append(reference_text(blob))
                manifest.append(dict(assetId=key, fingerprint=meta['fingerprint'], kind=kind, role='text', transmission='content'))
                continue
            mime = image_type(blob) if kind == 'image' else None
            try:
                if mime not in {'image/png', 'image/jpeg'} or len(blob) > 5 * 1024 * 1024:
                    raise ValueError('image format or size')
                with Image.open(BytesIO(blob)) as image:
                    image.verify()
                with Image.open(BytesIO(blob)) as image:
                    image.load()
            except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
                raise ProjectError('CogVideoX-3 参考图片须为有效的 PNG 或 JPEG，单张不超过 5 MB。',
                                   422, code='bigmodel_video_image') from None
            role = binding['role']
            if role == 'reference' and image_count == 1:
                role = 'first_frame'
            if role not in {'first_frame', 'last_frame'} or role in frames:
                raise ProjectError('每个帧槽位只能使用一张图片，尾帧必须搭配首帧；两张图请明确首尾顺序。',
                                   422, code='bigmodel_video_frames')
            frames[role] = data_uri(blob, mime)
            manifest.append(dict(assetId=key, fingerprint=meta['fingerprint'], kind=kind, role=role, transmission='content'))
        if frames and 'first_frame' not in frames:
            raise ProjectError('每个帧槽位只能使用一张图片，尾帧必须搭配首帧；两张图请明确首尾顺序。',
                               422, code='bigmodel_video_frames')
        content = task.get('promptContent')
        prompt = task['prompt'] if content is None else ''.join(part['text'] if part['type'] == 'text' else part['name'] for part in content)
        prompt += ''.join('\n' + text for text in context)
        if len(prompt) > 512 or complete and not prompt.strip() and not frames:
            raise ProjectError('CogVideoX-3 提示词最多 512 字符；提示词和参考图片不能同时为空。',
                               422, code='bigmodel_video_prompt')
        images = [frames[role] for role in ('first_frame', 'last_frame') if role in frames]
        request_size({'prompt': prompt, 'image_url': images}, 16 * 1024 * 1024 - 4096)
        return dict(profile='bigmodel-cogvideox-3', prompt=prompt, images=images, references=manifest)

    def payload(self, config, task, prepared):
        params = task['parameters']
        size, duration = params.get('size', '1920x1080'), params.get('duration', 5)
        fps, quality = params.get('fps', 30), params.get('quality', 'speed')
        audio, watermark = params.get('generate_audio', True), params.get('watermark', True)
        if (size not in COGVIDEO_SIZES or isinstance(duration, bool) or duration not in (5, 10)
                or isinstance(fps, bool) or fps not in (30, 60) or quality not in {'speed', 'quality'}
                or not isinstance(audio, bool) or not isinstance(watermark, bool)):
            raise ProjectError('请选择 CogVideoX-3 支持的像素尺寸和 5 或 10 秒时长。', 422, code='bigmodel_video_output')
        payload = dict(model=config['modelId'], prompt=prepared['prompt'], size=size, duration=int(duration),
                       fps=fps, quality=quality, with_audio=audio, watermark_enabled=watermark, request_id=task['id'])
        if prepared['images']:
            payload['image_url'] = prepared['images'][0] if len(prepared['images']) == 1 else prepared['images']
        request_size(payload, 16 * 1024 * 1024)
        return payload

    async def _json(self, client, config, method, suffix, stage, **kwargs):
        try:
            async with client.stream(method, config['url'].rstrip('/') + suffix, headers=auth_headers(config), **kwargs) as response:
                await checked(response, stage=stage, secrets=(config.get('apiKey', ''),))
                value = json.loads(await bounded(response, stage=stage, secrets=(config.get('apiKey', ''),), limit=1024 * 1024))
                if not isinstance(value, dict):
                    raise protocol_failure(stage)
                if value.get('error'):
                    raise provider_failure(value, stage=stage, http_status=response.status_code,
                                           secrets=(config.get('apiKey', ''),))
                return value
        except httpx.TimeoutException:
            raise transport_failure(stage, timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure(stage) from None
        except (ValueError, TypeError):
            raise protocol_failure(stage) from None

    @staticmethod
    def _task_id(value, config, stage):
        if (not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}', value)
                or config.get('apiKey') and config['apiKey'] in value):
            raise protocol_failure(stage)
        return value

    async def generate(self, config, task, submitted, *, result_ready=None):
        stage = 'submit'
        try:
            self.validate(task['kind'], config)
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport,
                    trust_env=trust_environment(config['url'], config=config), timeout=httpx.Timeout(240, connect=15), follow_redirects=False) as client:
                external_id = task.get('externalTaskId')
                if not external_id:
                    prepared = await asyncio.to_thread(self.prepare_inputs, task['projectId'], task, config)
                    value = await self._json(client, config, 'POST', '/videos/generations', stage,
                                             json=self.payload(config, task, prepared))
                    external_id = self._task_id(value.get('id'), config, stage)
                    await submitted(external_id)
                stage = 'poll'
                self._task_id(external_id, config, stage)
                while True:
                    value = await self._retry_read(lambda: self._json(client, config, 'GET',
                        '/async-result/' + quote(external_id, safe=''), stage))
                    if value.get('id', external_id) != external_id or value.get('model', config['modelId']) != config['modelId']:
                        raise protocol_failure(stage)
                    if value.get('task_status') == 'FAIL':
                        raise provider_failure({**value, 'status': 'failed'}, stage=stage, http_status=200,
                                               secrets=(config.get('apiKey', ''),), expected_task_id=external_id)
                    if value.get('task_status') == 'SUCCESS':
                        outputs = value['video_result']
                        if not isinstance(outputs, list) or len(outputs) != 1:
                            raise protocol_failure(stage)
                        url = outputs[0]['url']
                        self._result_url(url, config)
                        if result_ready:
                            await result_ready('mp4', url)
                        stage = 'download'
                        return await self.resume_result(config, 'mp4', url)
                    if value.get('task_status') != 'PROCESSING':
                        raise protocol_failure(stage)
                    await asyncio.sleep(self.poll_interval)
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            raise protocol_failure(stage) from None

    @staticmethod
    def _result_url(url, config):
        if not isinstance(url, str) or len(url) > 16384 or config.get('apiKey') and config['apiKey'] in url:
            raise protocol_failure('download')
        target = urlsplit(url)
        if target.scheme != 'https' or not target.hostname or target.username or target.password:
            raise protocol_failure('download')
        target.port

    async def resume_result(self, config, suffix, url):
        try:
            self._result_url(url, config)
        except (ValueError, TypeError):
            raise protocol_failure('download') from None
        return await super().resume_result(config, suffix, url, public_only=True)

    async def cancel(self, config, external_id):
        raise ProjectError('智谱视频远端取消接口尚未接通；任务可能继续执行并计费。', 409, code='bigmodel_video_cancel')
