"""Model identity and input rules for Zhipu BigModel GLM-TTS speech synthesis."""
import re
from urllib.parse import urlsplit

from .projects import ProjectError
from .rule_facts import SERVICE_VOICE_PATTERN


ZHIPU_SPEECH_MODELS = frozenset({'glm-tts'})
ZHIPU_CLONE_MODEL = 'glm-tts-clone'
ZHIPU_SPEECH_CHARACTERS = 1024
# The documented system voices. The account's OFFICIAL list also contains
# entries the synthesis endpoint rejects, so it is not used as a catalog.
ZHIPU_PRESET_VOICES = ('tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo')
ZHIPU_DEFAULT_VOICE = 'tongtong'
# The clone endpoint requires preview text; the preview is fixed product copy.
ZHIPU_CLONE_PREVIEW_TEXT = '你好，这是我的声音。Hello, this is my voice.'


def is_zhipu_api(config):
    url = urlsplit(config.get('url', ''))
    return (config.get('protocol') == 'openai' and config.get('connectionType', 'api') == 'api'
            and url.scheme == 'https' and url.hostname == 'open.bigmodel.cn' and url.port in {None, 443}
            and url.path.rstrip('/') == '/api/paas/v4')


def is_zhipu_speech(config):
    return config.get('kind') == 'audio' and is_zhipu_api(config) and config.get('modelId') in ZHIPU_SPEECH_MODELS


def validate_zhipu_speech_input(text, voice):
    if not isinstance(text, str) or not text.strip():
        raise ProjectError('请填写需要朗读的文本。', 422, code='zhipu_speech_text')
    if len(text) > ZHIPU_SPEECH_CHARACTERS:
        raise ProjectError(f'GLM-TTS 单次朗读文本不能超过 {ZHIPU_SPEECH_CHARACTERS} 个字符，请拆分后生成。', 422, code='zhipu_speech_text')
    if not isinstance(voice, str) or not re.fullmatch(SERVICE_VOICE_PATTERN, voice):
        raise ProjectError('请选择智谱账户可用的音色。', 422, code='zhipu_speech_voice')
