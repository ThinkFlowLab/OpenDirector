"""Capability adapters: the only place operations reach a model API.

Each adapter declares the capabilities it serves for a configuration and turns
capability requests (opendirector.domain.capabilities) into that API's calls.
Adding a model means adding or extending an adapter; operations stay unchanged.
"""

import asyncio
import base64
import json
import re
from urllib.parse import quote, urlsplit

import httpx

from opendirector.domain.assets import MAX_ASSET_BYTES
from opendirector.domain.capabilities import (ChatRequest, CutoutRequest, EditMask, ImageRequest, MediaResult, Segment, SegmentRequest,
                                          SpeechRequest, TrackRequest, Tracks, VideoEditRequest, VideoRequest)
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.integrations.generation_errors import checked, protocol_failure, provider_failure, transport_failure
from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, auth_headers, trust_environment
from opendirector.integrations.volcengine import bounded, endpoint
from opendirector.media import processing as media


def _client(adapter, config, timeout=240):
    return httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=adapter.transport, trust_env=trust_environment(config['url'], config=config),
                             timeout=httpx.Timeout(timeout, connect=15), follow_redirects=False)


async def _call(stage, work):
    try:
        return await work()
    except httpx.TimeoutException:
        raise transport_failure(stage, timeout=True) from None
    except httpx.HTTPError:
        raise transport_failure(stage) from None
    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
        raise protocol_failure(stage) from None


class ModelAdapter:
    capabilities: frozenset[str] = frozenset()

    def __init__(self, transport=None, poll_interval=3):
        self.transport, self.poll_interval = transport, poll_interval

    async def image(self, config, request: ImageRequest) -> MediaResult:
        raise ProjectError('所选模型不支持图片生成。', 409)

    async def cutout(self, config, request: CutoutRequest) -> MediaResult:
        raise ProjectError('所选模型不支持主体抠图。', 409)

    async def video(self, config, request: VideoRequest, *, submitted=None) -> MediaResult:
        raise ProjectError('所选模型不支持视频生成。', 409)

    async def edit_video(self, config, request: VideoEditRequest, *, submitted=None) -> MediaResult:
        raise ProjectError('所选模型不支持视频局部重绘。', 409)

    async def cancel_video(self, config, external_id):
        return None

    async def speech(self, config, request: SpeechRequest) -> MediaResult:
        raise ProjectError('所选模型不支持语音合成。', 409)

    async def chat(self, config, request: ChatRequest) -> str:
        raise ProjectError('所选模型不支持对话。', 409)

    async def segment(self, config, request: SegmentRequest) -> list[Segment]:
        raise ProjectError('所选模型不支持图像分割。', 409)

    async def track(self, config, request: TrackRequest) -> Tracks:
        raise ProjectError('所选模型不支持视频抠像。', 409)


class OpenAIImages(ModelAdapter):
    """OpenAI Images API: /images/generations and multipart /images/edits.

    vLLM-Omni serves the same routes and also honours `strength` and free sizes.
    """

    capabilities = frozenset({'image.generate', 'image.edit'})
    OPENAI_SIZES = ((1024, 1024), (1536, 1024), (1024, 1536))

    def __init__(self, transport=None, poll_interval=3, *, free_size=False, max_edge=1536, grid=16, strength=False, max_images=1,
                 transparent=False):
        super().__init__(transport, poll_interval)
        self.free_size, self.max_edge, self.grid = free_size, max_edge, grid
        # img2img services honour strength; instruction editors ignore it.
        self.strength, self.max_images = strength, max_images
        # Models with an RGBA decoder can lift a subject onto transparency.
        self.capabilities = type(self).capabilities | ({'image.cutout'} if transparent else set())

    def size(self, width, height):
        """The nearest size this service renders; operations resample the result themselves."""
        if not self.free_size:
            ratio = width / height
            return min(self.OPENAI_SIZES, key=lambda item: abs(item[0] / item[1] - ratio))
        scale = min(1.0, self.max_edge / max(width, height))
        # Diffusion latents need both axes on the service's pixel grid.
        return tuple(max(256, int(round(value * scale / self.grid)) * self.grid) for value in (width, height))

    async def cutout(self, config, request: CutoutRequest) -> MediaResult:
        if 'image.cutout' not in self.capabilities:
            return await super().cutout(config, request)
        subject = request.subject or 'the main subject'
        # The model's documented RGBA prompt form; transparency comes from its alpha decoder.
        prompt = (f'This is an RGBA image with transparency. Extract {subject} from the photo, keeping its exact '
                  'appearance and edges. The image has alpha channel and the background is transparent.')
        return await self.image(config, ImageRequest(prompt=prompt, width=request.width, height=request.height, image=request.image),
                                extra={'background': 'transparent'})

    async def image(self, config, request: ImageRequest, *, extra=None) -> MediaResult:
        width, height = self.size(request.width, request.height)
        secrets = (config.get('apiKey', ''),)
        images = [*([request.image] if request.image is not None else []), *request.references][:self.max_images]
        extra = dict(extra or {})
        if self.free_size:
            extra['output_format'] = 'png'
            if request.seed is not None:
                extra['seed'] = request.seed

        async def work():
            async with _client(self, config) as client:
                if not images:
                    payload = {'model': config['modelId'], 'prompt': request.prompt, 'size': f'{width}x{height}',
                               'n': 1, 'response_format': 'b64_json', **extra}
                    async with client.stream('POST', endpoint(config['url'], '/images/generations'),
                                             headers=auth_headers(config), json=payload) as response:
                        value = json.loads(await bounded(response, stage='submit', secrets=secrets))
                else:
                    form = {'model': config['modelId'], 'prompt': request.prompt, 'size': f'{width}x{height}',
                            'response_format': 'b64_json', **{key: str(item) for key, item in extra.items()}}
                    if request.strength is not None and self.strength:
                        form['strength'] = f'{min(max(request.strength, 0.0), 1.0):.3f}'
                    files = [('image', (f'image_{index}.png', data, 'image/png')) for index, data in enumerate(images, 1)]
                    async with client.stream('POST', endpoint(config['url'], '/images/edits'), headers=auth_headers(config),
                                             data=form, files=files, extensions={'model_parameters': {'fields': form, 'file_count': len(files)}}) as response:
                        value = json.loads(await bounded(response, stage='submit', secrets=secrets))
                result = value['data'][0]
                if result.get('b64_json'):
                    return base64.b64decode(result['b64_json'], validate=True)
                # Download only from the configured service, never a third-party host.
                if urlsplit(result['url']).netloc != urlsplit(config['url']).netloc:
                    raise protocol_failure('download')
                async with client.stream('GET', result['url'], headers=auth_headers(config)) as response:
                    return await bounded(response, stage='download', secrets=secrets)

        data = await _call('submit', work)
        if len(data) > MAX_ASSET_BYTES:
            raise ProjectError('生成图片超过 50 MB。', 413)
        if data.startswith(b'\x89PNG\r\n\x1a\n'):
            return MediaResult(data, 'png')
        if data.startswith(b'\xff\xd8'):
            return MediaResult(data, 'jpg')
        if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            return MediaResult(data, 'webp')
        raise protocol_failure('submit')


class VllmOmniVideo(ModelAdapter):
    """vLLM-Omni MiniMax-H3 async /videos jobs: text- and first-frame-to-video, and latent-mask
    editing that redraws masked picture/sound of a source clip, all with audio."""

    capabilities = frozenset({'video.generate', 'video.first_frame', 'video.edit'})
    FPS = 24
    RATIOS = {'21:9': 21 / 9, '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1.0, '3:4': 3 / 4, '9:16': 9 / 16}
    MAX_PIXELS = 768 * 1344
    MAX_SECONDS = 15

    @classmethod
    def frames(cls, seconds):
        """Nearest H3 length on the 17n+5 frame grid, within 4-15 seconds."""
        steps = round((seconds * cls.FPS - 5) / 17)
        return 17 * min(max(steps, 6), 20) + 5

    @classmethod
    def canvas(cls, width, height):
        """The largest 32-pixel-grid canvas of this aspect within H3's pixel budget."""
        scale = min(1.0, (cls.MAX_PIXELS / (width * height)) ** 0.5)
        return max(256, int(width * scale) // 32 * 32), max(256, int(height * scale) // 32 * 32)

    @classmethod
    def ratio(cls, width, height):
        return min(cls.RATIOS, key=lambda name: abs(cls.RATIOS[name] - width / height))

    @classmethod
    def picture_mask(cls, mask: EditMask | None, frames: int):
        if mask is None:
            return 0.0
        region = [[min(max(value, 0.0), 1.0) * mask.level for value in row] for row in (mask.region or ((1.0,),))]
        if mask.start is None and mask.end is None:
            return region if mask.region else mask.level
        start, end = (mask.start or 0) * cls.FPS, (mask.end if mask.end is not None else frames) * cls.FPS
        idle = [[0.0] * len(region[0]) for _ in region]
        # Frame-space [T, h, w]: the service area-resizes h, w and pools frames onto latents.
        return [region if start <= index < end else idle for index in range(frames)]

    @classmethod
    def sound_mask(cls, mask: EditMask | None, frames: int):
        if mask is None:
            return 0.0
        if mask.start is None and mask.end is None:
            return mask.level
        steps = round(frames * 5 / 3)  # 40 audio latents per second at 24 fps.
        seconds = frames / cls.FPS
        start, end = mask.start or 0, mask.end if mask.end is not None else seconds
        return [mask.level if start <= index * seconds / steps < end else 0.0 for index in range(steps)]

    async def _job(self, config, fields, files, submitted):
        headers, secrets = auth_headers(config), (config.get('apiKey', ''),)
        base = endpoint(config['url'], '/videos')
        stage = 'submit'
        try:
            async with _client(self, config) as client:
                parts = [(name, (None, value)) for name, value in fields.items()] + files
                async with client.stream('POST', base, headers=headers, files=parts, extensions={'model_parameters': {'fields': fields, 'file_count': len(files)}}) as response:
                    external_id = json.loads(await bounded(response, stage=stage, secrets=secrets))['id']
                if not isinstance(external_id, str) or not external_id or len(external_id) > 200:
                    raise protocol_failure(stage)
                if submitted:
                    await submitted(external_id)
                stage = 'poll'
                url = base + '/' + quote(external_id, safe='')
                while True:
                    async with client.stream('GET', url, headers=headers) as response:
                        value = json.loads(await bounded(response, stage=stage, secrets=secrets))
                    status = value.get('status')
                    if status == 'completed':
                        stage = 'download'
                        async with client.stream('GET', url + '/content', headers=headers) as response:
                            return MediaResult(await bounded(response, stage=stage, secrets=secrets), 'mp4')
                    if status in {'failed', 'cancelled', 'expired'}:
                        raise provider_failure(value, stage=stage, secrets=secrets)
                    if status not in {'queued', 'in_progress', 'running'}:
                        raise protocol_failure(stage)
                    await asyncio.sleep(self.poll_interval)
        except httpx.TimeoutException:
            raise transport_failure(stage, timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure(stage) from None
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            raise protocol_failure(stage) from None

    def _fields(self, config, prompt, frames, seed=None, avoid=''):
        fields = {'model': config['modelId'], 'prompt': prompt, 'fps': str(self.FPS), 'num_frames': str(frames)}
        if seed is not None:
            fields['seed'] = str(seed)
        if avoid:
            fields['negative_prompt'] = avoid
        return fields

    async def video(self, config, request: VideoRequest, *, submitted=None) -> MediaResult:
        fields = self._fields(config, request.prompt, self.frames(request.seconds), request.seed, request.avoid)
        files = []
        if request.first_frame is not None:
            extra = {'task': 'fl2va'}
            files.append(('input_reference', ('first_frame.png', request.first_frame, 'image/png')))
        else:
            extra = {'task': 't2va', 'aspect_ratio': request.aspect_ratio if request.aspect_ratio in self.RATIOS else '16:9'}
        fields['extra_params'] = json.dumps(extra)
        return await self._job(config, fields, files, submitted)

    @classmethod
    def _conformed(cls, data, width, height):
        with media.Workspace() as work:
            return media.conform(work.write('in.mp4', data), work.path / 'out.mp4', width=width, height=height, fps=cls.FPS).read_bytes()

    async def edit_video(self, config, request: VideoEditRequest, *, submitted=None) -> MediaResult:
        if not 4 <= request.seconds <= self.MAX_SECONDS + 0.05:
            raise ProjectError(f'单次视频局部重绘需要 4–{self.MAX_SECONDS} 秒的片段。', 422)
        frames = self.frames(request.seconds)
        width, height = self.canvas(request.width, request.height)
        source = await asyncio.to_thread(self._conformed, request.source, width, height)
        fields = self._fields(config, request.prompt, frames, avoid=request.avoid)
        fields.update(size=f'{width}x{height}',
                      extra_params=json.dumps({'task': 't2va', 'aspect_ratio': self.ratio(width, height), 'duration': frames / self.FPS}))
        files = [('source_video', ('source.mp4', source, 'video/mp4')),
                 ('video_noise_mask', ('video-mask.json', json.dumps(self.picture_mask(request.picture, frames)).encode(), 'application/json')),
                 ('audio_noise_mask', ('audio-mask.json', json.dumps(self.sound_mask(request.sound, frames)).encode(), 'application/json'))]
        return await self._job(config, fields, files, submitted)

    async def cancel_video(self, config, external_id):
        async def work():
            async with _client(self, config, timeout=15) as client:
                async with client.stream('DELETE', endpoint(config['url'], '/videos') + '/' + quote(external_id, safe=''),
                                         headers=auth_headers(config)) as response:
                    await checked(response, stage='cancel', secrets=(config.get('apiKey', ''),))
        await _call('cancel', work)


class OpenAISpeech(ModelAdapter):
    """OpenAI-compatible /audio/speech (also served by vLLM-Omni TTS)."""

    capabilities = frozenset({'audio.speech'})

    async def speech(self, config, request: SpeechRequest) -> MediaResult:
        # Self-hosted speech servers name their own speakers; "default" selects the model's.
        voice = request.voice or ('default' if config.get('connectionType') == 'self_hosted' else 'alloy')
        payload = {'model': config['modelId'], 'input': request.text, 'voice': voice, 'response_format': 'mp3'}

        async def work():
            async with _client(self, config) as client:
                async with client.stream('POST', endpoint(config['url'], '/audio/speech'), headers=auth_headers(config),
                                         json=payload) as response:
                    return await bounded(response, stage='submit', secrets=(config.get('apiKey', ''),))
        return MediaResult(await _call('submit', work), 'mp3')


class OpenAIChat(ModelAdapter):
    """Non-streaming Chat Completions for short operation-internal requests."""

    capabilities = frozenset({'text.chat'})
    THINKING = re.compile(r'<think>.*?</think>', re.S)

    async def chat(self, config, request: ChatRequest) -> str:
        payload = {'model': config['modelId'], 'messages': list(request.messages), 'max_tokens': request.max_tokens, 'stream': False}

        async def work():
            async with _client(self, config, timeout=120) as client:
                async with client.stream('POST', endpoint(config['url'], '/chat/completions'), headers=auth_headers(config),
                                         json=payload) as response:
                    value = json.loads(await bounded(response, stage='submit', secrets=(config.get('apiKey', ''),)))
            return value['choices'][0]['message']['content'] or ''
        return self.THINKING.sub('', await _call('submit', work)).strip()


class VllmOmniSegmentation(ModelAdapter):
    """vLLM-Omni SAM 3: /images/segmentations for one image, /videos/segmentations to track through a clip.

    Concepts are short English noun phrases; masks come back at the source resolution.
    """

    capabilities = frozenset({'image.segment', 'video.matting'})
    MAX_FRAMES = 2048  # The service's per-request limit.

    async def segment(self, config, request: SegmentRequest) -> list[Segment]:
        form = {'model': config['modelId'], 'prompt': request.concept, 'mask_format': 'png'}
        if request.boxes:
            form['boxes'] = json.dumps([[round(float(value), 1) for value in box] for box in request.boxes])

        async def work():
            async with _client(self, config) as client:
                async with client.stream('POST', endpoint(config['url'], '/images/segmentations'), headers=auth_headers(config),
                                         data=form, files=[('image', ('image.png', request.image, 'image/png'))],
                                         extensions={'model_parameters': {'fields': form, 'file_count': 1}}) as response:
                    value = json.loads(await bounded(response, stage='submit', secrets=(config.get('apiKey', ''),)))
            return [Segment(base64.b64decode(item['mask'], validate=True), tuple(float(v) for v in item['box']), float(item['score']))
                    for item in value['data']]
        return await _call('submit', work)

    async def track(self, config, request: TrackRequest) -> Tracks:
        concepts = list(dict.fromkeys(item for item in request.concepts if item))
        form = {'model': config['modelId'], 'prompt': concepts[0], 'prompts': json.dumps(concepts[1:])}

        async def work():
            # Tracking costs grow with the number of objects; long clips take minutes.
            async with _client(self, config, timeout=3600) as client:
                async with client.stream('POST', endpoint(config['url'], '/videos/segmentations'), headers=auth_headers(config),
                                         data=form, files=[('video', ('clip.mp4', request.video, 'video/mp4'))],
                                         extensions={'model_parameters': {'fields': form, 'file_count': 1}}) as response:
                    value = json.loads(await bounded(response, stage='submit', secrets=(config.get('apiKey', ''),),
                                                     limit=512 * 1024 * 1024))
            frames = tuple(tuple(tuple(int(count) for count in item['mask']['counts']) for item in frame['instances'])
                           for frame in value['frames'])
            return Tracks(int(value['width']), int(value['height']), float(value['fps'] or 24), frames)
        return await _call('submit', work)


def adapter_for(config, transport=None, poll_interval=3) -> ModelAdapter | None:
    """The adapter serving a configuration, chosen from its explicit profile and protocol."""
    kind, protocol = config['kind'], config.get('protocol')
    profile = input_rules(config)['profile']
    if profile == 'vllm-omni-segmentation':
        return VllmOmniSegmentation(transport, poll_interval)
    if kind == 'agent':
        return OpenAIChat(transport, poll_interval)
    if kind == 'image' and profile == 'vllm-omni-image':
        return OpenAIImages(transport, poll_interval, free_size=True, strength=True)
    if kind == 'image' and profile == 'vllm-omni-qwen-image':
        return OpenAIImages(transport, poll_interval, free_size=True, max_edge=2048, grid=32, max_images=4, transparent=True)
    if kind == 'image' and protocol == 'openai':
        return OpenAIImages(transport, poll_interval)
    if kind == 'video' and profile == 'vllm-omni-h3':
        return VllmOmniVideo(transport, poll_interval)
    if kind == 'audio' and protocol in {'openai', 'vllm_omni'}:
        return OpenAISpeech(transport, poll_interval)
    return None


def capabilities_of(config) -> frozenset[str]:
    adapter = adapter_for(config)
    return adapter.capabilities if adapter else frozenset()
