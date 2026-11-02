"""Explicit adapter profiles, not model-name guesses or online capability probes."""
from urllib.parse import urlsplit
from typing import Literal
from opendirector.domain.video_capabilities import capability_fields

MAX_REFERENCES = 64  # Storage/structure guard; provider budgets are checked separately.
VideoMode = Literal['first_frame', 'reference', 'continuation']


def _adapter_rules(config):
    url = urlsplit(config['url'])
    host, path = url.hostname, url.path.rstrip('/')
    kind, model = config['kind'], config['modelId']
    rules = {'profile': 'compatible', 'allowedKinds': ['text', 'image'], 'maxImages': 8,
             'maxAudios': 0, 'imageBytes': 8 * 1024 * 1024, 'requestBytes': 48 * 1024 * 1024,
             'videoModes': ['first_frame'] if kind == 'video' else []}
    rules.update(maxVideos=0, videoBytes=50 * 1024 * 1024)
    if kind == 'vision' or config.get('protocol') == 'vllm_omni_segmentation':
        # Shared image segmentation / video tracking service, never a generator.
        rules.update(profile='vllm-omni-segmentation', allowedKinds=[], maxImages=0, videoModes=[])
        return rules
    adapter = config.get('videoAdapter', 'auto')
    name = model.rsplit('/', 1)[-1].lower()
    if adapter == 'auto':
        adapter = ('minimax_h3' if name in {'minimax-h3', 'minimax-h3-ref2va'} else
                   'fasth3' if name in {'fasth3', 'fasth3-omni'} or name.startswith('fasth3-omni-') else 'standard')
    if kind == 'video' and adapter == 'minimax_h3':
        # Self-hosted vLLM-Omni has no fixed host; the served model name selects it.
        # continuation continues one earlier H3 clip of the same server from its
        # cached latents: the source video is never uploaded, so maxVideos (video
        # references) stays zero.
        rules.update(profile='vllm-omni-h3', allowedKinds=['text', 'image', 'video', 'audio'], maxImages=9, maxAudios=3,
                     imageBytes=30 * 1024 * 1024, requestBytes=64 * 1024 * 1024, videoModes=['first_frame', 'reference', 'continuation'],
                     outputResolutions=['480P', '768P'])
        return rules
    if kind == 'video' and config.get('protocol') == 'vllm_omni' and adapter == 'fasth3':
        rules.update(profile='fasth3-omni', allowedKinds=['text', 'image', 'video', 'audio'],
                     maxImages=9, maxVideos=3, maxAudios=3, imageBytes=30 * 1024 * 1024,
                     requestBytes=160 * 1024 * 1024, videoModes=['reference'], outputResolutions=['480P', '768P'])
        return rules
    if kind == 'video' and config.get('protocol') == 'vllm_omni':
        rules.update(profile='standard-video', maxImages=1, videoModes=['first_frame'])
        return rules
    if kind == 'agent':
        rules.update(allowedKinds=['text', 'image', 'video', 'audio'], maxImages=MAX_REFERENCES, imageBytes=32 * 1024 * 1024)
        if host == 'api.deepseek.com' and path in {'', '/v1'} and model == 'deepseek-flash':
            rules['profile'] = 'deepseek-flash'
    elif host == 'ark.cn-beijing.volces.com' and path == '/api/plan/v3':
        if kind == 'image' and model in {'doubao-seedream-5.0-pro', 'doubao-seedream-5-0-pro'}:
            rules.update(profile='seedream-5.0-pro', maxImages=10, imageBytes=30 * 1024 * 1024, requestBytes=64 * 1024 * 1024)
        elif kind == 'video' and model == 'doubao-seedance-2.0':
            rules.update(profile='seedance-2.0', allowedKinds=['text', 'image', 'audio'], maxImages=9, maxAudios=3, imageBytes=30 * 1024 * 1024,
                         requestBytes=64 * 1024 * 1024, videoModes=['first_frame', 'reference'],
                         outputResolutions=['480P', '720P', '1080P', '4K'],
                         referenceImageResolutions=['480P', '720P', '4K'])
    if kind == 'image' and model.rsplit('/', 1)[-1].lower() in {'qwen-image-2.1', 'qwen-image-2.1-turbo'}:
        # Self-hosted vLLM-Omni Qwen-Image-2.1: text-to-image and instruction
        # editing in one model, conditioned on up to four reference images.
        rules.update(profile='vllm-omni-qwen-image', allowedKinds=['text', 'image'], maxImages=4,
                     imageBytes=30 * 1024 * 1024, requestBytes=64 * 1024 * 1024)
    if kind == 'image' and model.rsplit('/', 1)[-1].lower() == 'z-image-turbo':
        # Self-hosted vLLM-Omni text-to-image: it draws from the prompt alone, so
        # documents are inlined as text and reference images are not accepted.
        rules.update(profile='vllm-omni-image', allowedKinds=['text'], maxImages=0)
    if kind == 'audio':
        # vLLM-Omni music models (MiniMax Music 3, YuE2) share /audio/speech with
        # TTS but read a style caption and lyrics, so the protocol names the role.
        music = config.get('protocol') == 'vllm_omni_music'
        rules.update(profile='vllm-omni-music' if music else 'tts', allowedKinds=[], maxImages=0)
    return rules


def input_rules(config):
    rules = _adapter_rules(config)
    if config['kind'] == 'image' and rules['profile'] != 'vllm-omni-segmentation':
        from .image_output import image_outputs
        rules['imageOutputs'] = image_outputs(config, rules['profile'])
    return capability_fields(config, rules) if config['kind'] == 'video' else rules
