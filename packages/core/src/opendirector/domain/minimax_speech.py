"""Model identity and input rules for MiniMax synchronous speech synthesis (T2A v2)."""
from urllib.parse import urlsplit

from .projects import ProjectError

# https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
MINIMAX_SPEECH_MODELS = frozenset({
    'speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo',
    'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo',
})
# The synchronous API requires text shorter than 10,000 characters.
MINIMAX_SPEECH_TEXT_CHARACTERS = 9999


def is_minimax_speech(config):
    # Mainland preset only; international and other MiniMax hosts are outside this adapter's scope.
    url = urlsplit(config.get('url', ''))
    return (config.get('kind') == 'audio' and config.get('protocol') == 'openai'
            and config.get('connectionType', 'api') == 'api'
            and url.scheme == 'https' and url.hostname == 'api.minimax.cn' and url.port in {None, 443}
            and url.path.rstrip('/') == '/v1')


def validate_minimax_speech_input(text, voice):
    if not text.strip() or len(text) > MINIMAX_SPEECH_TEXT_CHARACTERS:
        raise ProjectError('请填写需要朗读的文本，且不超过 9,999 个字符。', 422, code='minimax_speech_text')
    # System voice IDs contain spaces and parentheses, and one ends with a
    # space ("Santa_Claus "), so the ID is sent exactly as listed.
    if not isinstance(voice, str) or not voice.strip() or len(voice) > 256 or not voice.isprintable():
        raise ProjectError('请从音色库选择 MiniMax 账户可用的音色。', 422, code='minimax_speech_voice')
