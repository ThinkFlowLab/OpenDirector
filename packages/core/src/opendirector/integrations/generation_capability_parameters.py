"""Project prepared generation values onto the fields sent by each adapter.

Preparation includes UI and recovery fields. Only values actually transmitted
may be checked against a service's request contract.
"""
from opendirector.domain.input_rules import input_rules
from opendirector.domain.rule_facts import MUSIC_SECONDS_INITIAL
from opendirector.domain.voices import effective_speech_voice


def generation_capability_parameters(config, kind, parameters, *, has_images=False):
    profile = input_rules(config)['profile']
    if kind == 'image':
        size = parameters.get('size', '')
        if profile == 'minimax-h3-image':
            from opendirector.integrations.model_adapters import MinimaxH3Images
            result = MinimaxH3Images.generation_parameters(size)
        elif profile in {'vllm-omni-image', 'vllm-omni-qwen-image'}:
            from opendirector.integrations.model_adapters import adapter_for
            from opendirector.integrations.vllm_omni_image import WIDTH, HEIGHT
            width, height = map(int, size.split('x')) if 'x' in size else (WIDTH, HEIGHT)
            width, height = adapter_for(config).size(width, height)
            result = dict(size=f'{width}x{height}', response_format='b64_json', output_format='png')
            if profile == 'vllm-omni-image':
                from opendirector.integrations.vllm_omni_image import SAMPLING_FIELDS
                result.update({key: parameters[key] for key in SAMPLING_FIELDS if key in parameters})
        else:
            # The generic OpenAI generation provider does not transmit its
            # internal response_format/output_format preparation defaults.
            result = dict(size=size if 'x' in size else '1024x1024')
            if profile == 'moss-image':
                result.update(response_format='url', prompt_enhance=False)
        if not has_images:
            result['n'] = 1
    elif kind == 'audio':
        result = dict(response_format='mp3')
        if config.get('protocol') == 'vllm_omni_music':
            from opendirector.integrations.model_adapters import VllmOmniMusic
            result['max_new_tokens'] = round(parameters.get('duration', MUSIC_SECONDS_INITIAL) * VllmOmniMusic.FRAMES_PER_SECOND)
            if parameters.get('seed') is not None:
                result['seed'] = parameters['seed']
        elif profile == 'moss-speech':
            result.update(voice_id=parameters.get('voice'), delivery_method='url', stream=False)
        else:
            result['voice'] = effective_speech_voice(config, parameters.get('voice'))
    elif kind == 'video':
        if profile == 'vllm-omni-h3':
            from opendirector.integrations.vllm_omni import FPS, h3_frames
            result = dict(fps=parameters.get('fps', FPS),
                          num_frames=parameters.get('num_frames', h3_frames(parameters.get('duration', 5))))
            if parameters.get('resolution') and parameters.get('size'):
                result['size'] = parameters['size']
        elif profile == 'fasth3-omni':
            result = dict(seconds=float(parameters.get('seconds', 5)), size=parameters.get('size', '832x480'),
                          num_inference_steps=8, guidance_scale=1, fps=24, seed=parameters.get('seed', 1234))
        else:
            result = {key: parameters[key] for key in ('size',) if key in parameters}
            if 'duration' in parameters:
                result['seconds'] = parameters['duration']
    else:
        result = {key: parameters[key] for key in ('max_tokens',) if key in parameters}
    size = result.get('size')
    if isinstance(size, str) and 'x' in size:
        try:
            result['width'], result['height'] = map(int, size.split('x'))
        except ValueError:
            pass
    return {key: value for key, value in result.items() if type(value) in {str, int, float, bool}}
