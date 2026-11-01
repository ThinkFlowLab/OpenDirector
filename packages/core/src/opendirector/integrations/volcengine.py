"""Ark Seedream/Seedance and Agent Plan HTTP TTS. Never change billing base URLs."""

import asyncio
import base64
import json
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx

from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, trust_environment

from opendirector.domain.assets import MAX_ASSET_BYTES
from opendirector.domain.projects import ProjectError
from opendirector.domain.generation import GenerationError
from opendirector.integrations.chat_completions import ChatCompletions, chat_payload
from opendirector.integrations.reference_inputs import generation_references, request_size
from opendirector.integrations.generation_errors import checked, protocol_failure, provider_failure, transport_failure
from opendirector.media.probe import require_ffprobe


def endpoint(base, suffix):
    return base.rstrip("/") if base.rstrip("/").endswith(suffix) else base.rstrip("/") + suffix


async def bounded(response, *, stage, secrets=(), limit=MAX_ASSET_BYTES):
    await checked(response, stage=stage, secrets=secrets)
    data = bytearray()
    async for chunk in response.aiter_bytes():
        data.extend(chunk)
        if len(data) > limit:
            raise ProjectError("生成结果超过 50 MB，无法保存到项目。", 413)
    return bytes(data)


class VolcengineGeneration:
    def __init__(self, store, transport=None, poll_interval=3, retry_delays=(0.5, 1.0)):
        self.store, self.transport, self.poll_interval = store, transport, poll_interval
        self.retry_delays = retry_delays

    async def _retry_read(self, operation):
        for attempt in range(len(self.retry_delays) + 1):
            try:
                return await operation()
            except GenerationError as failure:
                if failure.details.category not in {'temporary', 'rate_limit'}:
                    raise
                if attempt == len(self.retry_delays):
                    raise
            except httpx.HTTPError:
                if attempt == len(self.retry_delays):
                    raise
            await asyncio.sleep(self.retry_delays[attempt])

    async def resume_result(self, config, suffix, url):
        secrets = (config['apiKey'],) if config else ()
        try:
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(url, config=config), timeout=httpx.Timeout(240, connect=15)) as client:
                return suffix, await self._download(client, url, secrets=secrets)
        except httpx.TimeoutException:
            raise transport_failure('download', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('download') from None

    def validate(self, kind, config):
        if kind in {"video", "audio"}:
            require_ffprobe()
        if kind == "audio" and config["modelId"] not in {"doubao-seed-tts-2.0", "seed-tts-2.0"}:
            raise ProjectError("当前音频生成支持火山 Agent Plan 的 doubao-seed-tts-2.0。", 409)

    def prepare_inputs(self, project_id, node, config, *, complete=True):
        prepared = generation_references(self.store, {**node, 'projectId': project_id}, config, complete=complete)
        return {'profile': prepared['rules']['profile'], 'references': prepared['manifest']}

    async def _text(self, config, task):
        prepared = await asyncio.to_thread(generation_references, self.store, task, config)
        content = prepared['content']
        messages = [{"role": "system", "content": "你是 OpenDirector 创作助手。根据要求输出可直接保存的文本正文；不要声称调用了媒体工具。"},
                    {"role": "user", "content": content}]
        payload = chat_payload(config, messages, task["parameters"]["thinking"])
        payload["max_tokens"] = task["parameters"]["max_tokens"]
        parts, size = [], 0
        async for chunk in ChatCompletions(self.transport).stream(config, payload):
            if chunk["type"] == "delta":
                size += len(chunk["text"].encode("utf-8"))
                if size > 1024 * 1024:
                    raise ProjectError("生成文本超过 1 MB。")
                parts.append(chunk["text"])
        text = "".join(parts)
        if not text.strip():
            raise ProjectError("模型未生成文本。", 502)
        return "md", text.encode("utf-8")

    async def generate(self, config, task, submitted, *, result_ready=None):
        kind = task["kind"]
        if kind == "text":
            return await self._text(config, task)
        # Querying an accepted task must not depend on references still being
        # present locally; no input is sent again when externalTaskId exists.
        prepared = None if kind == 'video' and task.get('externalTaskId') else await asyncio.to_thread(generation_references, self.store, task, config)
        prompt, refs = (task['prompt'], []) if prepared is None else (prepared['prompt'], prepared['images'])
        headers = {"Authorization": f"Bearer {config['apiKey']}"}
        secrets = (config['apiKey'],)
        stage = 'submit'
        try:
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(config['url'], config=config), timeout=httpx.Timeout(240, connect=15), follow_redirects=False) as client:
                if kind == "image":
                    payload = {"model": config["modelId"], "prompt": prompt, **task["parameters"]}
                    if refs:
                        payload["image"] = refs if len(refs) > 1 else refs[0]
                    request_size(payload, prepared["rules"]["requestBytes"])
                    async with client.stream("POST", endpoint(config["url"], "/images/generations"), headers=headers, json=payload) as response:
                        value = json.loads(await bounded(response, stage=stage, secrets=secrets))
                    result = value["data"][0]
                    if result.get("b64_json"):
                        data = base64.b64decode(result["b64_json"], validate=True)
                        if len(data) > MAX_ASSET_BYTES:
                            raise ProjectError("生成图片超过 50 MB。", 413)
                    else:
                        stage = 'download'
                        if result_ready:
                            await result_ready('png', result['url'])
                        data = await self._download(client, result["url"], secrets=secrets)
                    return "png", data
                if kind == "video":
                    url = endpoint(config["url"], "/contents/generations/tasks")
                    external_id = task.get("externalTaskId")
                    if not external_id:
                        content = [{"type": "text", "text": prompt}]
                        role = 'reference_image' if task.get('videoMode') == 'reference' else 'first_frame'
                        content.extend({'type': 'image_url', 'image_url': {'url': image}, 'role': role} for image in refs)
                        content.extend({'type': 'audio_url', 'audio_url': {'url': audio}, 'role': 'reference_audio'} for audio in prepared['audios'])
                        payload = {'model': config['modelId'], 'content': content, **task['parameters']}
                        request_size(payload, prepared['rules']['requestBytes'])
                        async with client.stream("POST", url, headers=headers, json=payload) as response:
                            external_id = json.loads(await bounded(response, stage=stage, secrets=secrets))["id"]
                        if not isinstance(external_id, str) or not external_id or len(external_id) > 200:
                            raise protocol_failure(stage)
                        await submitted(external_id)
                    stage = 'poll'
                    while True:
                        async def query():
                            async with client.stream("GET", url + "/" + quote(external_id, safe=""), headers=headers) as response:
                                return json.loads(await bounded(response, stage='poll', secrets=secrets)), response.headers, response.status_code
                        value, response_headers, response_status = await self._retry_read(query)
                        if value.get("status") == "succeeded":
                            stage = 'download'
                            if result_ready:
                                await result_ready('mp4', value['content']['video_url'])
                            return "mp4", await self._download(client, value["content"]["video_url"], secrets=secrets)
                        if value.get("status") in {"failed", "cancelled", "expired"}:
                            raise provider_failure(value, stage=stage, headers=response_headers,
                                http_status=response_status, secrets=secrets)
                        if value.get("status") not in {"queued", "running", "submitted"}:
                            raise protocol_failure(stage)
                        await asyncio.sleep(self.poll_interval)
                if kind == "audio":
                    url = endpoint(config["url"], "/tts/unidirectional")
                    headers = {"X-Api-Key": config["apiKey"], "X-Api-Resource-Id": "seed-tts-2.0", "X-Api-Request-Id": str(uuid4())}
                    payload = {"req_params": {"text": prompt, **task["parameters"]}}
                    data, finished = bytearray(), False
                    async with client.stream("POST", url, headers=headers, json=payload) as response:
                        await checked(response, stage=stage, secrets=secrets)
                        async for line in response.aiter_lines():
                            if not line.strip():
                                continue
                            value = json.loads(line)
                            if value.get("code") == 20000000:
                                finished = True
                                break
                            if value.get("code", 0) != 0:
                                raise provider_failure(value, stage=stage, headers=response.headers,
                                    http_status=response.status_code, secrets=secrets)
                            if value.get("data"):
                                data.extend(base64.b64decode(value["data"], validate=True))
                            if len(data) > MAX_ASSET_BYTES:
                                raise ProjectError("合成音频超过 50 MB。", 413)
                    if not finished or not data:
                        raise protocol_failure(stage, message='语音结果未完整返回，未保存不完整音频。')
                    return "mp3", bytes(data)
        except httpx.TimeoutException:
            raise transport_failure(stage, timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure(stage) from None
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            raise protocol_failure(stage) from None

    async def _download(self, client, url, *, secrets=()):
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise protocol_failure('download')
        # CDN downloads never receive provider credentials.
        async def download():
            async with client.stream("GET", url, follow_redirects=True) as response:
                return await bounded(response, stage='download', secrets=secrets)
        return await self._retry_read(download)

    async def cancel(self, config, external_id):
        try:
            async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=self.transport, trust_env=trust_environment(config['url'], config=config), timeout=15) as client:
                async with client.stream('DELETE', endpoint(config["url"], "/contents/generations/tasks") + "/" + quote(external_id, safe=""), headers={"Authorization": f"Bearer {config['apiKey']}"}) as response:
                    await checked(response, stage='cancel', secrets=(config['apiKey'],))
        except httpx.TimeoutException:
            raise transport_failure('cancel', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('cancel') from None
