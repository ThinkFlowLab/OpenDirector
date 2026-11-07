"""Capability adapters: the only place operations reach a model API.

Each adapter declares the capabilities it serves for a configuration and turns
capability requests (opendirector.domain.capabilities) into that API's calls.
Adding a model means adding or extending an adapter; operations stay unchanged.
"""

import asyncio
import base64
import json
import math
import re
from urllib.parse import quote, urlsplit

import httpx

from opendirector.domain.assets import MAX_ASSET_BYTES
from opendirector.domain.capabilities import (ChatRequest, CutoutRequest, DepthRequest, EditMask, ImageRequest, MediaResult, MusicRequest,
                                          ScoreRequest, Segment, SegmentRequest, SpeechRequest, TrackRequest, Tracks, VideoEditRequest,
                                          VideoRequest)
from opendirector.domain.input_rules import input_rules
from opendirector.domain.moss_image import validate_moss_image_prompt, validate_moss_image_size
from opendirector.domain.moss_speech import validate_moss_speech_input
from opendirector.domain.projects import ProjectError
from opendirector.integrations.generation_errors import checked, protocol_failure, provider_failure, transport_failure
from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, auth_headers, trust_environment
from opendirector.integrations.reference_inputs import data_uri, image_type
from opendirector.integrations.volcengine import VolcengineGeneration, bounded, endpoint
from opendirector.media import processing as media
from opendirector.media.async_work import blocking


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

def image_parts(images, field='image'):
    """Multipart parts for reference pictures.

    The type is detected from the bytes and drives both the declared Content-Type
    and the filename, because gpt-image validates what is declared: a JPEG sent
    as image/png is a request error, not a decode problem. One picture keeps the
    plain `image` part; several use the caller's field, `image[]` for OpenAI.
    """
    parts = []
    for index, data in enumerate(images, 1):
        mime = image_type(data) or 'image/png'
        extension = {'image/jpeg': 'jpg', 'image/webp': 'webp'}.get(mime, 'png')
        parts.append((field if len(images) > 1 else 'image', (f'image_{index}.{extension}', data, mime)))
    return parts


def _decoded(data):
    """Identify a returned picture by signature, never by the service's label."""
    if len(data) > MAX_ASSET_BYTES:
        raise ProjectError('生成图片超过 50 MB。', 413)
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return MediaResult(data, 'png')
    if data.startswith(b'\xff\xd8'):
        return MediaResult(data, 'jpg')
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return MediaResult(data, 'webp')
    raise protocol_failure('submit')


def _moss_result_url(value, stage):
    if not isinstance(value, str) or len(value) > 16384:
        raise protocol_failure(stage)
    url = urlsplit(value)
    if url.scheme not in {'http', 'https'} or not url.hostname or url.username or url.password:
        raise protocol_failure(stage)
    url.port
    return value


async def _download_moss_result(adapter, config, url):
    async def read():
        _moss_result_url(url, 'download')
        base, target = urlsplit(config['url']), urlsplit(url)
        headers = auth_headers(config) if (base.scheme, base.netloc) == (target.scheme, target.netloc) else {}
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=adapter.transport,
                trust_env=trust_environment(url, config=config), timeout=httpx.Timeout(240, connect=15),
                follow_redirects=False) as client:
            async with client.stream('GET', url, headers=headers) as response:
                return await bounded(response, stage='download', secrets=(config.get('apiKey', ''),))
    return await _call('download', read)


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
        return 'unsupported'

    async def video_status(self, config, external_id):
        """Observe an existing call, without submitting or downloading a result."""
        return 'unsupported'

    async def speech(self, config, request: SpeechRequest) -> MediaResult:
        raise ProjectError('所选模型不支持语音合成。', 409)

    async def music(self, config, request: MusicRequest) -> MediaResult:
        raise ProjectError('所选模型不支持音乐生成。', 409)

    async def score(self, config, request: ScoreRequest) -> str:
        raise ProjectError('所选模型不支持音乐扒谱。', 409)

    async def chat(self, config, request: ChatRequest) -> str:
        raise ProjectError('所选模型不支持对话。', 409)

    async def segment(self, config, request: SegmentRequest) -> list[Segment]:
        raise ProjectError('所选模型不支持图像分割。', 409)

    async def track(self, config, request: TrackRequest) -> Tracks:
        raise ProjectError('所选模型不支持视频抠像。', 409)

    async def depth(self, config, request: DepthRequest) -> MediaResult:
        raise ProjectError('所选模型不支持深度动作捕捉。', 409)


class MossImages(ModelAdapter):
    capabilities = frozenset({'image.generate'})

    async def image(self, config, request: ImageRequest, *, result_ready=None, watermark=True) -> MediaResult:
        if request.image is not None or request.references:
            raise ProjectError('MOSS 图片生成不支持参考图片或图片编辑。', 422, code='moss_image_reference')
        validate_moss_image_prompt(request.prompt)
        validate_moss_image_size(request.width, request.height)
        payload = dict(model=config['modelId'], prompt=request.prompt, size=f'{request.width}x{request.height}',
                       n=1, response_format='url', prompt_enhance=False, output_watermark={'enabled': watermark})

        async def submit():
            async with _client(self, config, timeout=900) as client:
                async with client.stream('POST', endpoint(config['url'], '/images/generations'),
                                         headers=auth_headers(config), json=payload) as response:
                    value = json.loads(await bounded(response, stage='submit', secrets=(config.get('apiKey', ''),)))
            results = value['data']
            if not isinstance(results, list) or len(results) != 1:
                raise protocol_failure('submit')
            return _moss_result_url(results[0]['url'], 'submit')

        url = await _call('submit', submit)
        if result_ready:
            await result_ready('png', url)
        return MediaResult(await self.download(config, url), 'png')

    async def download(self, config, url):
        data = await _download_moss_result(self, config, url)
        if not data.startswith(b'\x89PNG\r\n\x1a\n'):
            raise protocol_failure('download')
        return data


class MossSpeech(ModelAdapter):
    capabilities = frozenset({'audio.speech'})

    async def speech(self, config, request: SpeechRequest, *, result_ready=None) -> MediaResult:
        validate_moss_speech_input(request.text, request.voice)
        payload = dict(model=config['modelId'], input=request.text, voice_id=request.voice,
                       response_format='mp3', delivery_method='url', stream=False)

        async def submit():
            secrets = (config.get('apiKey', ''),)
            async with _client(self, config) as client:
                async with client.stream('POST', endpoint(config['url'], '/audio/speech'),
                                         headers=auth_headers(config), json=payload) as response:
                    value = json.loads(await bounded(response, stage='submit', secrets=secrets))
            if value.get('error') or value.get('status', 'SUCCESS') != 'SUCCESS':
                raise provider_failure(value, stage='submit', http_status=200, secrets=secrets)
            if value.get('object', 'audio.speech') != 'audio.speech' or value.get('response_format', 'mp3') != 'mp3':
                raise protocol_failure('submit')
            return _moss_result_url(value['url'], 'submit')

        url = await _call('submit', submit)
        if result_ready:
            await result_ready('mp3', url)
        return MediaResult(await self.download(config, url), 'mp3')

    async def download(self, config, url):
        data = await _download_moss_result(self, config, url)
        mpeg_frame = len(data) >= 4 and data[0] == 0xff and data[1] & 0xe0 == 0xe0 and data[1] & 0x06
        if not data.startswith(b'ID3') and not mpeg_frame:
            raise protocol_failure('download')
        return data


class OpenAIImages(ModelAdapter):
    """OpenAI Images API: /images/generations and multipart /images/edits.

    vLLM-Omni serves the same routes and also honours `strength` and free sizes.
    `gpt-image` models always answer with base64 and reject `response_format`, so
    those configurations turn the flag off and send multiple references as
    repeated `image[]` parts.
    """

    capabilities = frozenset({'image.generate', 'image.edit'})
    OPENAI_SIZES = ((1024, 1024), (1536, 1024), (1024, 1536))

    def __init__(self, transport=None, poll_interval=3, *, free_size=False, max_edge=1536, grid=16, strength=False, max_images=1,
                 transparent=False, response_format=True, reference_field='image'):
        super().__init__(transport, poll_interval)
        self.free_size, self.max_edge, self.grid = free_size, max_edge, grid
        # img2img services honour strength; instruction editors ignore it.
        self.strength, self.max_images = strength, max_images
        # gpt-image omits `response_format`: it is documented base64 output only.
        self.response_format, self.reference_field = response_format, reference_field
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
                               'n': 1, **extra}
                    if self.response_format:
                        payload['response_format'] = 'b64_json'
                    async with client.stream('POST', endpoint(config['url'], '/images/generations'),
                                             headers=auth_headers(config), json=payload) as response:
                        value = json.loads(await bounded(response, stage='submit', secrets=secrets))
                else:
                    form = {'model': config['modelId'], 'prompt': request.prompt, 'size': f'{width}x{height}',
                            **{key: str(item) for key, item in extra.items()}}
                    if self.response_format:
                        form['response_format'] = 'b64_json'
                    if request.strength is not None and self.strength:
                        form['strength'] = f'{min(max(request.strength, 0.0), 1.0):.3f}'
                    files = image_parts(images, self.reference_field)
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

        return _decoded(await _call('submit', work))


class ArkImageEdits(ModelAdapter):
    """Instruction edits through Ark's JSON generation endpoint with reference images."""

    capabilities = frozenset({'image.edit'})
    # Use the shared reference count limit across Ark's Seedream variants.
    max_images = 10

    async def image(self, config, request: ImageRequest) -> MediaResult:
        width, height = request.width, request.height
        if not 1 / 16 <= width / height <= 16:
            raise ProjectError('火山方舟图片编辑的输出宽高比须在 1:16 至 16:1 之间。', 422)
        # A 2K square's pixel count fits the explicit-size ranges of Seedream
        # 4.x and 5.x. Preserve the requested aspect ratio without naming a model.
        scale = 2048 / math.sqrt(width * height)
        width, height = round(width * scale), round(height * scale)
        width, height = min(width, 16 * height), min(height, 16 * width)
        images = [request.image, *request.references] if request.image is not None else list(request.references)
        if len(images) > self.max_images:
            raise ProjectError('火山方舟图片编辑最多接受 10 张参考图片。', 422)
        refs = []
        for image in images:
            mime = image_type(image)
            if not mime:
                raise ProjectError('参考图片格式无效。', 422)
            if len(image) > 30 * 1024 * 1024:
                raise ProjectError('火山方舟图片编辑的单张参考图片不能超过 30 MB。', 413)
            refs.append(data_uri(image, mime))
        ark = VolcengineGeneration(None, transport=self.transport)
        data = await ark.generate_image(
            config, request.prompt, {'size': f'{width}x{height}', 'response_format': 'b64_json'},
            refs, request_bytes=64 * 1024 * 1024,
        )
        suffix = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}.get(image_type(data))
        if not suffix:
            raise protocol_failure('submit')
        return MediaResult(data, suffix)


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
        source = await blocking(self._conformed, request.source, width, height)
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
                    body = await bounded(response, stage='cancel', secrets=(config.get('apiKey', ''),))
                    # A successful DELETE may only acknowledge the request.
                    value = json.loads(body) if body else {}
                    if not isinstance(value, dict) or value.get('id') != external_id:
                        return 'requested'
                    return {'cancelled': 'confirmed', 'completed': 'completed', 'failed': 'failed',
                            'expired': 'failed'}.get(value.get('status'), 'requested')
        return await _call('cancel', work)

    async def video_status(self, config, external_id):
        async def work():
            async with _client(self, config, timeout=15) as client:
                async with client.stream('GET', endpoint(config['url'], '/videos') + '/' + quote(external_id, safe=''),
                                         headers=auth_headers(config)) as response:
                    value = json.loads(await bounded(response, stage='poll', secrets=(config.get('apiKey', ''),)))
                    if not isinstance(value, dict) or value.get('id') != external_id:
                        return 'unknown'
                    return {'cancelled': 'cancelled', 'completed': 'succeeded', 'failed': 'failed',
                            'expired': 'failed', 'queued': 'running', 'running': 'running',
                            'in_progress': 'running'}.get(value.get('status'), 'unknown')
        return await _call('poll', work)


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


class VllmOmniMusic(ModelAdapter):
    """vLLM-Omni music models (MiniMax Music 3, YuE2) on /audio/speech.

    ``input`` carries the lyrics and ``instructions`` the style caption; both are
    required. ``max_new_tokens`` caps the length in audio frames at 25 per second.
    """

    capabilities = frozenset({'audio.music'})
    FRAMES_PER_SECOND = 25
    # Section tags without words: the models need non-empty lyrics, and an
    # arrangement with no sung text yields an instrumental piece.
    INSTRUMENTAL = '[intro]\n[verse]\n[chorus]\n[outro]'

    async def music(self, config, request: MusicRequest) -> MediaResult:
        payload = {'model': config['modelId'], 'input': request.lyrics.strip() or self.INSTRUMENTAL,
                   'instructions': request.style, 'response_format': 'mp3',
                   'max_new_tokens': round(request.max_seconds * self.FRAMES_PER_SECOND)}
        if request.score:
            # YuE2 renders the supplied score: cot=melody follows its melody, cot=full also its chords.
            payload['extra_params'] = {'cot': request.score_mode, 'abc': request.score}

        async def work():
            # A full song is delivered only once the whole piece is rendered.
            async with _client(self, config, timeout=1800) as client:
                async with client.stream('POST', endpoint(config['url'], '/audio/speech'), headers=auth_headers(config),
                                         json=payload) as response:
                    return await bounded(response, stage='submit', secrets=(config.get('apiKey', ''),))
        return MediaResult(await _call('submit', work), 'mp3')


class VllmOmniScore(ModelAdapter):
    """SheetSage2 transcription (vLLM-Omni tools/sheetsage2_serve.py) on /audio/transcriptions.

    The recording goes up as a multipart file and ``text`` comes back as an ABC
    score; ``melody_only`` drops the chords.
    """

    capabilities = frozenset({'audio.score'})

    async def score(self, config, request: ScoreRequest) -> str:
        fields = {'model': config['modelId'], 'response_format': 'json', 'melody_only': 'true' if request.melody_only else 'false'}

        async def work():
            # A four-minute song takes about 10 s on one H200, but the service runs one request at a time.
            async with _client(self, config, timeout=1800) as client:
                async with client.stream('POST', endpoint(config['url'], '/audio/transcriptions'), headers=auth_headers(config),
                                         data=fields, files={'file': (request.filename, request.audio)},
                                         extensions={'model_parameters': {'fields': fields, 'file_count': 1}}) as response:
                    value = json.loads(await bounded(response, stage='submit', secrets=(config.get('apiKey', ''),)))
            score = value['text']
            if not isinstance(score, str) or not score.strip():
                raise ValueError('empty score')
            return score
        return await _call('submit', work)


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


class VllmOmniDepth(ModelAdapter):
    """vLLM-Omni Video Depth Anything: /videos/depth estimates temporally consistent per-frame depth.

    The clip is sent at the size it should come back at. Relative checkpoints
    render inverse depth (near is bright); metric ones render meters (far is
    bright) and are re-mapped to inverse depth, so every result reads the same way.
    """

    capabilities = frozenset({'video.motion_capture'})

    async def depth(self, config, request: DepthRequest) -> MediaResult:
        form = {'model': config['modelId'], 'max_res': '-1', 'colormap': 'grayscale'}

        async def work():
            # Depth runs in 32-frame windows; a 26-second 720P clip took about 30 s on one H200 (Small).
            async with _client(self, config, timeout=1800) as client:
                async with client.stream('POST', endpoint(config['url'], '/videos/depth'), headers=auth_headers(config),
                                         data=form, files=[('video', ('clip.mp4', request.video, 'video/mp4'))],
                                         extensions={'model_parameters': {'fields': form, 'file_count': 1}}) as response:
                    # Base64 inflates the MP4 by a third.
                    value = json.loads(await bounded(response, stage='submit', secrets=(config.get('apiKey', ''),),
                                                     limit=MAX_ASSET_BYTES * 4 // 3 + 64 * 1024))
            meters = (float(value['depth_min']), float(value['depth_max'])) if value['metric'] is True else None
            return base64.b64decode(value['video'], validate=True), meters
        data, meters = await _call('submit', work)
        if meters:
            data = await blocking(self._inverse, data, *meters)
        return MediaResult(data, 'mp4')

    @staticmethod
    def _inverse(data, near, far):
        with media.Workspace() as work:
            return media.disparity(work.write('meters.mp4', data), work.path / 'inverse.mp4', near=near, far=far)


def adapter_for(config, transport=None, poll_interval=3) -> ModelAdapter | None:
    """The adapter serving a configuration, chosen from its explicit profile and protocol."""
    kind, protocol = config['kind'], config.get('protocol')
    profile = input_rules(config)['profile']
    if profile == 'vllm-omni-segmentation':
        return VllmOmniSegmentation(transport, poll_interval)
    if profile == 'vllm-omni-depth':
        return VllmOmniDepth(transport, poll_interval)
    if profile == 'vllm-omni-score':
        return VllmOmniScore(transport, poll_interval)
    if kind == 'agent':
        return OpenAIChat(transport, poll_interval)
    if profile == 'moss-image':
        return MossImages(transport, poll_interval)
    if profile == 'moss-speech':
        return MossSpeech(transport, poll_interval)
    if kind == 'image' and profile == 'vllm-omni-image':
        return OpenAIImages(transport, poll_interval, free_size=True, strength=True)
    if kind == 'image' and profile == 'vllm-omni-qwen-image':
        return OpenAIImages(transport, poll_interval, free_size=True, max_edge=2048, grid=32, max_images=4, transparent=True)
    if kind == 'image' and protocol == 'volcengine':
        return ArkImageEdits(transport, poll_interval)
    if kind == 'image' and profile == 'openai-gpt-image':
        # gpt-image: base64 answers only, 16 reference images, documented sizes.
        # No subject cutout: its edits redraw and move the subject, so a returned
        # alpha does not line up with the source pixels, and gpt-image-2 rejects
        # transparent backgrounds outright.
        return OpenAIImages(transport, poll_interval, max_images=16,
                            response_format=False, reference_field='image[]')
    if kind == 'image' and protocol == 'openai':
        return OpenAIImages(transport, poll_interval)
    if kind == 'video' and profile == 'vllm-omni-h3':
        return VllmOmniVideo(transport, poll_interval)
    if kind == 'audio' and profile == 'vllm-omni-music':
        return VllmOmniMusic(transport, poll_interval)
    if kind == 'audio' and protocol in {'openai', 'vllm_omni'}:
        return OpenAISpeech(transport, poll_interval)
    return None


def capabilities_of(config) -> frozenset[str]:
    adapter = adapter_for(config)
    return adapter.capabilities if adapter else frozenset()
