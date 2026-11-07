"""Provider voice-library capabilities and input validation.

The service connection owns the voice identity. Names or IDs from one
connection never become valid in another one, even when the text is equal.
"""
from __future__ import annotations

import re
from pathlib import PurePath
from uuid import UUID

from .moss_speech import is_moss_speech
from .projects import ProjectError

MAX_VOICE_BYTES = 10 * 1024 * 1024
VLLM_FORMATS = ('wav', 'mp3', 'flac', 'ogg', 'aac', 'webm', 'mp4')
MOSS_FORMATS = ('wav', 'mp3', 'm4a', 'flac')
_VOICE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
_TRANSCRIPT_MODELS = ('drama-3', 'drama3', 'cosyvoice3', 'cosyvoice-3')


def _field(config, key, default=None):
    return config.get(key, default) if isinstance(config, dict) else getattr(config, key, default)


def voice_provider(config) -> str | None:
    """Return the voice-library adapter that serves this model, if any."""
    if is_moss_speech(config):
        return 'moss'
    if (_field(config, 'kind') == 'audio' and _field(config, 'connectionType') == 'self_hosted'
            and _field(config, 'protocol') == 'openai'):
        return 'vllm-omni'
    return None


def requires_transcript(config) -> bool:
    name = str(_field(config, 'modelId', '')).rsplit('/', 1)[-1].lower()
    return any(token in name for token in _TRANSCRIPT_MODELS)


def voice_library_capabilities(config) -> dict | None:
    provider = voice_provider(config)
    if provider is None:
        return None
    vllm = provider == 'vllm-omni'
    return {
        'provider': provider,
        'canCreate': True,
        'canDelete': vllm,
        'requiresConsent': vllm,
        'requiresRefText': vllm and requires_transcript(config),
        'maxBytes': MAX_VOICE_BYTES,
        'maxDurationSeconds': None if vllm else 30,
        'formats': list(VLLM_FORMATS if vllm else MOSS_FORMATS),
        'pagination': 'cursor' if not vllm else 'none',
        'preview': False,
        'filterUnsupported': not vllm,
    }


def connection_id(config) -> str | None:
    """The connection a voice belongs to: provider group ID or the config ID."""
    if isinstance(config, dict):
        provider = config.get('providerId') or config['id']
    else:
        provider = config.providerId or config.id
    return str(provider)


def voice_matches(config, parameters) -> bool:
    """Whether stored voice metadata still identifies a usable voice here.

    `voiceConnectionId` pins the identity; provider and reference capability
    guard against a re-pointed connection whose voice set changed shape.
    """
    library = voice_library_capabilities(config)
    if not parameters.voice:
        return True
    if parameters.voiceConnectionId and parameters.voiceConnectionId != connection_id(config):
        return False
    if library is None:
        return True
    if parameters.voiceProvider and parameters.voiceProvider != library['provider']:
        return False
    if library['requiresRefText'] and parameters.voiceHasReference is False:
        return False
    return True


def voice_id(value: str) -> str:
    value = (value or '').strip()
    if not _VOICE_ID.fullmatch(value):
        raise ProjectError('音色标识格式无效。', 422, code='voice_library_voice_id')
    return value


def voice_file(filename: str, size: int, config) -> str:
    provider = voice_provider(config)
    if provider is None:
        raise ProjectError('所选模型不支持音色库。', 409, code='voice_library_unsupported')
    name = PurePath(filename or '').name
    suffix = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    formats = VLLM_FORMATS if provider == 'vllm-omni' else MOSS_FORMATS
    if not name or suffix not in formats:
        raise ProjectError('音色样本格式不受当前服务支持。', 422, code='voice_library_file_type')
    if not 0 < size <= MAX_VOICE_BYTES:
        raise ProjectError('音色样本需小于 10 MB。', 413, code='voice_library_file_size')
    return name


def voice_create_fields(config, *, name: str, consent: str | None, ref_text: str | None,
                        speaker_description: str | None) -> dict:
    provider = voice_provider(config)
    if provider is None:
        raise ProjectError('所选模型不支持音色库。', 409, code='voice_library_unsupported')
    name = (name or '').strip()
    consent = (consent or '').strip()
    ref_text = (ref_text or '').strip()
    speaker_description = (speaker_description or '').strip()
    if provider == 'vllm-omni' and not name:
        raise ProjectError('请填写音色名称。', 422, code='voice_library_name')
    if not _VOICE_ID.fullmatch(name):
        raise ProjectError('音色名称需为 1–64 个字母、数字、点、下划线或连字符。', 422, code='voice_library_name')
    if provider == 'vllm-omni' and not consent:
        raise ProjectError('请填写声音授权记录 ID。', 422, code='voice_library_consent')
    if len(consent) > 512 or len(ref_text) > 8000 or len(speaker_description) > 500:
        raise ProjectError('音色表单内容过长。', 422, code='voice_library_fields')
    if provider == 'vllm-omni' and requires_transcript(config) and not ref_text:
        raise ProjectError('当前模型要求填写录音原文。', 422, code='voice_library_transcript')
    return {'name': name, 'consent': consent, 'ref_text': ref_text,
            'speaker_description': speaker_description}
