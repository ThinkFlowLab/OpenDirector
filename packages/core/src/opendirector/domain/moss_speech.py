"""Model identity and input rules for MOSS Open Platform speech synthesis."""
import re
from urllib.parse import urlsplit

from .projects import ProjectError


MOSS_SPEECH_MODEL = 'moss-tts-1.5-flash'


def is_moss_speech(config):
    url = urlsplit(config.get('url', ''))
    return (config.get('kind') == 'audio' and config.get('protocol') == 'openai'
            and url.scheme == 'https' and url.hostname == 'api.mosi.cn' and url.port in {None, 443}
            and url.path.rstrip('/') == '/v1' and config.get('modelId') == MOSS_SPEECH_MODEL)


def validate_moss_speech_input(text, voice):
    if not text.strip():
        raise ProjectError('请填写需要朗读的文本。', 422, code='moss_speech_text')
    if not isinstance(voice, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', voice):
        raise ProjectError('请填写 MOSS 账户可用的音色 ID。', 422, code='moss_speech_voice')
