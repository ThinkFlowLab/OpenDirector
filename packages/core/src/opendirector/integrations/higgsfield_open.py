"""MAGI-2 uploads and asynchronous jobs through Higgsfield Open."""
import asyncio
import hashlib
from io import BytesIO
import json
import re
from urllib.parse import urlsplit

import httpx
from PIL import Image, UnidentifiedImageError

from opendirector.domain.higgsfield import (
    BASE, MODEL, IMAGE_TYPES, operation, parameters, validate_model,
)
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.domain.references import project_content
from opendirector.integrations.generation_errors import checked, protocol_failure, provider_failure, transport_failure
from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, public_target, trust_environment
from opendirector.integrations.reference_inputs import image_type, references, reference_text
from opendirector.integrations.volcengine import VolcengineGeneration
from opendirector.media.probe import require_ffprobe


def _credentials(config):
    key = config.get('apiKey', '')
    parts = key.split(':')
    if len(parts) != 2 or any(not part or any(char.isspace() for char in part) for part in parts):
        raise ProjectError('请填写 Higgsfield Open 的 KEY_ID:KEY_SECRET。', 422, code='higgsfield_key')
    return key, *parts


def _https_url(url, stage):
    if not isinstance(url, str) or len(url) > 16384:
        raise protocol_failure(stage)
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise protocol_failure(stage)
    parsed.port
    return url


def _task_urls(value, secrets, stage):
    external_id = value.get('request_id')
    if (not isinstance(external_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}', external_id)
            or any(secret and secret in external_id for secret in secrets)):
        raise protocol_failure(stage)
    result = {'request_id': external_id}
    for key in ('status_url', 'cancel_url'):
        url = _https_url(value.get(key), stage)
        if urlsplit(url).netloc != urlsplit(BASE).netloc:
            raise protocol_failure(stage)
        result[key] = url
    return result


class HiggsfieldOpenGeneration(VolcengineGeneration):
    def validate(self, kind, config):
        validate_model({**config, 'kind': kind})
        _credentials(config)
        require_ffprobe()

    def prepare_inputs(self, project_id, task, config, *, complete=True):
        self.validate(task['kind'], config)
        rules = input_rules(config)
        mode = task.get('videoMode', 'first_frame')
        bindings = task.get('referenceRoles') or []
        media, manifest, texts, frames = [], [], [], set()
        totals = {'video': 0, 'audio': 0}
        for blob, meta, kind in references(self.store, project_id, task['referenceIds']):
            asset_id = str(meta['id'])
            frozen = (task.get('inputSnapshot') or {}).get('references', {}).get(asset_id)
            if frozen and frozen != meta['fingerprint']:
                raise ProjectError('参考素材已变化，请重新核对后提交。', 409, code='higgsfield_reference_changed')
            roles = [value['role'] for value in bindings if str(value['assetId']) == asset_id] or ['reference']
            if kind == 'text':
                texts.append(reference_text(blob))
            elif kind == 'image':
                mime = image_type(blob)
                try:
                    with Image.open(BytesIO(blob)) as image:
                        image.verify()
                except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
                    raise ProjectError('图片需为有效的 JPEG、PNG、WebP 或 GIF，单张小于 30 MB。', 422, code='higgsfield_image') from None
                if mime not in IMAGE_TYPES or len(blob) > rules['imageBytes']:
                    raise ProjectError('图片需为有效的 JPEG、PNG、WebP 或 GIF，单张小于 30 MB。', 422, code='higgsfield_image')
                media.append(dict(assetId=asset_id, fingerprint=meta['fingerprint'], kind=kind, mimeType=mime, roles=roles))
            elif kind in totals:
                mime = meta['type']
                if mime != ('video/mp4' if kind == 'video' else 'audio/wav'):
                    raise ProjectError('参考视频需为 MP4，音频需为 WAV。MOV 请先转换为 MP4，MP3 请先转换为 WAV。', 422, code='higgsfield_format')
                if len(blob) > rules['videoBytes' if kind == 'video' else 'audioBytes']:
                    raise ProjectError('参考视频单个不能超过 200 MB，音频单个不能超过 15 MB。', 422, code='higgsfield_media_size')
                duration = meta.get('durationMs')
                if duration is None or not 2000 <= duration <= 30000:
                    raise ProjectError('参考视频和音频每段须为 2–30 秒，同类素材总时长不能超过 30 秒。', 422, code='higgsfield_duration')
                totals[kind] += duration
                media.append(dict(assetId=asset_id, fingerprint=meta['fingerprint'], kind=kind, mimeType=mime, roles=roles))
            else:
                raise ProjectError('MAGI-2 支持文本、图片、MP4 视频和 WAV 音频参考。', 422, code='higgsfield_format')
            manifest.append(dict(assetId=asset_id, fingerprint=meta['fingerprint'], kind=kind, transmission='content'))
        if any(total > 30000 for total in totals.values()):
            raise ProjectError('参考视频和音频每段须为 2–30 秒，同类素材总时长不能超过 30 秒。', 422, code='higgsfield_duration')
        for kind, limit in (('image', 10), ('video', 5), ('audio', 5)):
            if sum(item['kind'] == kind for item in media) > limit:
                raise ProjectError('MAGI-2 最多支持 10 张图片、5 段视频和 5 段音频参考。', 422, code='higgsfield_reference_count')
        route = operation(mode, any(item['kind'] == 'image' for item in media))
        if mode == 'first_frame':
            for item in media:
                roles = item['roles']
                if roles == ['reference'] and len(media) == 1:
                    roles = item['roles'] = ['first_frame']
                if (item['kind'] != 'image' or len(set(roles)) != len(roles)
                        or any(role not in {'first_frame', 'last_frame'} or role in frames for role in roles)):
                    raise ProjectError('每个首尾帧槽位只能使用一张图片，尾帧需要搭配首帧。', 422, code='higgsfield_frames')
                frames.update(roles)
            if frames and 'first_frame' not in frames:
                raise ProjectError('每个首尾帧槽位只能使用一张图片，尾帧需要搭配首帧。', 422, code='higgsfield_frames')
        elif not media or any(role != 'reference' for item in media for role in item['roles']):
            raise ProjectError('参考模式需要至少一张图片、一段视频或一段音频，请检查素材角色。', 422, code='higgsfield_references')
        prompt = project_content(task['promptContent'])[0] if task.get('promptContent') is not None else task['prompt']
        prompt = prompt + ''.join('\n' + text for text in texts) if prompt.strip() else '\n'.join(texts)
        if complete and (len(prompt) > 15000 or not prompt.strip() and route == 'text-to-video'):
            raise ProjectError('MAGI-2 提示词最多 15,000 字；纯文本生成需要填写提示词。', 422, code='higgsfield_prompt')
        return dict(operation=route, prompt=prompt, media=media, references=manifest)

    def payload(self, config, task, prepared, urls):
        frozen = task['parameters']
        intent = dict(durationSeconds=frozen.get('duration'), resolution=frozen.get('resolution', 'auto'),
                      aspectRatio=frozen.get('ratio'), generateAudio=frozen.get('generate_audio', True))
        normalized = parameters({**config, 'videoCapabilities': None}, intent, task.get('videoMode', 'first_frame'),
                                any(item['kind'] == 'image' for item in prepared['media']))
        if normalized['operation'] != prepared['operation'] or any(key in frozen and frozen[key] != value for key, value in normalized.items()):
            raise protocol_failure('prepare')
        body = dict(duration=normalized['duration'], resolution='1080p', aspect_ratio=normalized['ratio'],
                    generate_audio=normalized['generate_audio'])
        if prepared['prompt'].strip():
            body['prompt'] = prepared['prompt']
        for item in prepared['media']:
            url = urls[item['assetId']]
            if normalized['operation'] == 'image-to-video':
                for role in item['roles']:
                    body['image_url' if role == 'first_frame' else 'end_image_url'] = url
            else:
                body.setdefault(item['kind'] + '_urls', []).append(url)
        return f"/{MODEL}/{normalized['operation']}", body

    async def _json(self, client, config, method, url, stage, *, idempotency_key=None, **kwargs):
        secrets = _credentials(config)
        headers = {'Authorization': f'Key {secrets[0]}'}
        if idempotency_key:
            headers['Idempotency-Key'] = idempotency_key
        async with client.stream(method, url, headers=headers, extensions={'model_secrets': secrets}, **kwargs) as response:
            await checked(response, stage=stage, secrets=secrets)
            if stage == 'cancel':
                if response.status_code != 202:
                    raise protocol_failure(stage)
                return None
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 1024 * 1024:
                    raise protocol_failure(stage)
            value = json.loads(data)
            if not isinstance(value, dict):
                raise protocol_failure(stage)
            return value

    async def _upload(self, client, config, item, data):
        value = await self._json(client, config, 'POST', BASE + '/files/generate-upload-url', 'prepare',
                                 json={'content_type': item['mimeType']})
        public_url = _https_url(value['public_url'], 'prepare')
        upload_url = _https_url(value['upload_url'], 'prepare')
        pinned, host_headers, extensions = await public_target(upload_url, schemes=('https',),
            unsafe=lambda: protocol_failure('prepare'), unresolved=lambda: transport_failure('prepare'))
        headers = httpx.Headers(value.get('upload_headers') or {})
        if any(key in headers for key in ('authorization', 'proxy-authorization', 'cookie', 'host', 'connection', 'transfer-encoding')):
            raise protocol_failure('prepare')
        headers.update(host_headers)
        headers.setdefault('Content-Type', item['mimeType'])
        extensions['model_secrets'] = _credentials(config)
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=False,
                                    timeout=httpx.Timeout(240, connect=15), follow_redirects=False) as storage:
            async with storage.stream('PUT', pinned, headers=headers, extensions=extensions, content=data) as response:
                await checked(response, stage='prepare', secrets=_credentials(config))
        return public_url

    async def generate(self, config, task, submitted, *, result_ready=None, recovery_cache=None):
        self.validate(task['kind'], config)
        if recovery_cache is None:
            raise protocol_failure('prepare')
        stage = 'prepare'
        try:
            record = await asyncio.to_thread(recovery_cache.submission)
            expected_path = f"/{MODEL}/{task['parameters']['operation']}"
            if record is None:
                if task.get('externalTaskId'):
                    raise protocol_failure('poll')
                record = dict(key=task['id'], path=expected_path, payload=None)
                await asyncio.to_thread(recovery_cache.save_submission, record)
            if (record.get('key') != task['id'] or record.get('path') != expected_path
                    or record.get('payload') is not None and not isinstance(record['payload'], dict)):
                raise protocol_failure(stage)
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport,
                    trust_env=trust_environment(BASE, config=config), timeout=httpx.Timeout(240, connect=15), follow_redirects=False) as client:
                remote = record.get('remote')
                if remote is None:
                    if task.get('externalTaskId'):
                        raise protocol_failure('poll')
                    if record['payload'] is None:
                        prepared = await asyncio.to_thread(self.prepare_inputs, task['projectId'], task, config)
                        urls = {}
                        for item in prepared['media']:
                            data, meta, _ = await asyncio.to_thread(next, references(self.store, task['projectId'], [item['assetId']]))
                            if meta['fingerprint'] != item['fingerprint']:
                                raise ProjectError('参考素材已变化，请重新核对后提交。', 409, code='higgsfield_reference_changed')
                            urls[item['assetId']] = await self._upload(client, config, item, data)
                        path, body = self.payload(config, task, prepared, urls)
                        if path != record['path']:
                            raise protocol_failure(stage)
                        record['payload'] = body
                        record['credential'] = hashlib.sha256(_credentials(config)[1].encode()).hexdigest()
                        # Freeze exact URLs, order and omitted fields before the billable POST.
                        await asyncio.to_thread(recovery_cache.save_submission, record)
                    if record.get('credential') != hashlib.sha256(_credentials(config)[1].encode()).hexdigest():
                        # Idempotency is account-scoped. A different key ID could
                        # belong to another account and charge for a second job.
                        raise protocol_failure('prepare', message='原请求的 Higgsfield API Key ID 已变化，请恢复原连接后再恢复任务。')
                    stage = 'submit'
                    value = await self._json(client, config, 'POST', BASE + record['path'], stage,
                                             json=record['payload'], idempotency_key=record['key'])
                    remote = _task_urls(value, _credentials(config), stage)
                    record['remote'] = remote
                    await asyncio.to_thread(recovery_cache.save_submission, record)
                remote = _task_urls(remote, _credentials(config), 'poll')
                if task.get('externalTaskId') and task['externalTaskId'] != remote['request_id']:
                    raise protocol_failure('poll')
                await submitted(remote['request_id'])
                stage = 'poll'
                while True:
                    value = await self._retry_read(lambda: self._json(client, config, 'GET', remote['status_url'], stage))
                    if value.get('request_id') != remote['request_id']:
                        raise protocol_failure(stage)
                    status = value.get('status')
                    if status == 'completed':
                        url = _https_url(value['video']['url'], 'download')
                        if result_ready:
                            await result_ready('mp4', url)
                        stage = 'download'
                        return await self.resume_result(config, 'mp4', url)
                    if status in {'failed', 'nsfw', 'canceled', 'cancelled'}:
                        failure = {**value, 'status': 'cancelled' if status in {'canceled', 'cancelled'} else 'failed'}
                        if status == 'nsfw':
                            failure['error'] = {'code': 'moderation_blocked'}
                        raise provider_failure(failure, stage=stage, http_status=200, secrets=_credentials(config))
                    if status not in {'queued', 'in_progress'}:
                        raise protocol_failure(stage)
                    await asyncio.sleep(self.poll_interval)
        except httpx.TimeoutException:
            raise transport_failure(stage, timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure(stage) from None
        except (ValueError, TypeError, KeyError, AttributeError):
            raise protocol_failure(stage) from None

    async def resume_result(self, config, suffix, url):
        try:
            _https_url(url, 'download')
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport,
                    trust_env=trust_environment(url, config=config), timeout=httpx.Timeout(240, connect=15)) as client:
                return suffix, await self._download(client, url, secrets=_credentials(config), public_only=True)
        except httpx.TimeoutException:
            raise transport_failure('download', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('download') from None
        except (ValueError, TypeError):
            raise protocol_failure('download') from None

    async def cancel(self, config, external_id, *, recovery_cache=None):
        try:
            record = await asyncio.to_thread(recovery_cache.submission) if recovery_cache else None
            remote = _task_urls((record or {}).get('remote') or {}, _credentials(config), 'cancel')
            if remote['request_id'] != external_id:
                raise protocol_failure('cancel')
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport,
                    trust_env=trust_environment(BASE, config=config), timeout=15, follow_redirects=False) as client:
                await self._json(client, config, 'POST', remote['cancel_url'], 'cancel')
        except httpx.TimeoutException:
            raise transport_failure('cancel', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('cancel') from None
        except (ValueError, TypeError, KeyError, AttributeError):
            raise protocol_failure('cancel') from None
