"""Provider voice identity and model-specific registered-reference requirements."""
import hashlib
import json
import re
from urllib.parse import urlsplit, urlunsplit

from .minimax_speech import MINIMAX_SPEECH_MODELS, is_minimax_speech
from .moss_speech import is_moss_speech
from .zhipu_speech import is_zhipu_speech
from .projects import ProjectError

# Character limits and the corresponding error for each upload metadata field.
VOICE_CREATE_TEXT_LIMITS = {
    'refText': (100_000, 'voice_transcript_too_long'),
    'speakerDescription': (4_000, 'voice_description_too_long'),
}

VOICE_MESSAGES = {
    'voice_library_unsupported': '当前模型没有已确认支持的音色库，请选择受支持的语音模型。',
    'voice_model_unsupported': '当前模型版本不支持使用已上传音色，请选择支持音色克隆的 Base 模型或兼容的内置音色。',
    'voice_connection_changed': '音色所属服务或账户已变化，请重新打开音色库并选择音色。',
    'voice_reference_required': '当前模型需要已注册的参考音频，请上传录音并选择该音色；default 不能替代录音。',
    'voice_transcript_required': '当前模型需要录音的准确文本，请填写转写文本后重新创建音色。',
    'voice_transcript_too_long': '录音的转写文本不能超过 100,000 个字符。',
    'voice_description_too_long': '说话人描述不能超过 4,000 个字符。',
    'voice_not_found': '所选音色已不存在，请刷新音色库并重新选择。',
    'voice_delete_unsupported': '该音色不支持删除；只能删除服务支持的已上传音色。',
    'voice_consent_required': '请填写此音色的授权录音 ID。',
    'voice_name_invalid': '请填写有效音色名称（不能包含路径分隔符或控制字符）。',
    'voice_audio_invalid': '无法读取录音的实际音频，请检查文件格式和完整性。',
    'voice_format': '录音格式不受当前服务支持，请选择列表中的格式。',
    'voice_size': '录音文件超过当前服务的大小限制。',
    'voice_duration': '录音时长不符合当前服务要求，请裁剪后重试。',
    'voice_provider_protocol': '音色服务返回格式无效或分页未结束，请检查服务版本和接口。',
    'voice_provider_error': '音色服务请求失败，请检查服务配置和账户权限。',
    'voice_provider_timeout': '音色服务请求超时，请检查服务状态后重试。',
    'voice_name_taken': '该账户已有同名音色，请换一个名称。',
    'voice_provider_quota': '音色服务账户余额或资源包不足，请充值后重试。',
}


def voice_error(code, status=422):
    return ProjectError(VOICE_MESSAGES[code], status, code=code)


def voice_library_capabilities(config):
    if config.get('kind') != 'audio' or config.get('protocol') != 'openai':
        return None
    name = config.get('modelId', '').rsplit('/', 1)[-1].lower().replace('_', '-')
    moss, minimax = is_moss_speech(config), is_minimax_speech(config)
    if minimax and config.get('modelId') not in MINIMAX_SPEECH_MODELS:
        return None
    if is_zhipu_speech(config):
        return _scoped(config, 'zhipu', dict(
            requiresTranscript=False, acceptsTranscript=True, requiresReferenceAudio=False, supportsUploadedVoices=True,
            referenceEmbeddingDimension=None, canDelete=True, maxBytes=10 * 1024 * 1024,
            formats=['wav', 'mp3'], minSeconds=3, maxSeconds=30))
    cosyvoice = name.startswith(('cosyvoice3', 'fun-cosyvoice3'))
    fish_speech = name.startswith('fish-speech') or name in {'s2-pro', 'drama-3', 'drama-3-int4'}
    # Explicit served-model families; an arbitrary compatible endpoint is not
    # evidence that the server implements the vLLM voice registry.
    known = cosyvoice or fish_speech or name.startswith(('moss-tts', 'qwen3-tts', 'fishaudio',
                             'index-tts', 'indextts', 'omnivoice', 'higgs-audio', 'glm-tts', 'ming-', 'drama3'))
    if not moss and not minimax and not (config.get('connectionType') == 'self_hosted' and known):
        return None
    provider = 'moss' if moss else 'minimax' if minimax else 'vllm_omni'
    if minimax:
        # Read-only system voices. MiniMax cloning and voice design are not adapted.
        return _scoped(config, provider, dict(requiresTranscript=False, acceptsTranscript=False,
                    requiresReferenceAudio=False, supportsUploadedVoices=False, referenceEmbeddingDimension=None,
                    canDelete=False, maxBytes=10 * 1024 * 1024, formats=[], minSeconds=None, maxSeconds=None))
    # Upstream vllm_omni/entrypoints/openai/tts_adapters/moss_tts.py:
    # validate() requires reference audio for standard/realtime/local/Nano.
    # Local-Transformer ref_text is optional continuation conditioning; Drama3
    # requires the registered transcript under issue #205's adapter contract.
    registered_transcript = 'drama3' in name or name.startswith('glm-tts')
    # Fish Speech (including Drama 3) and Higgs v2 accept plain speech, but
    # require a transcript alongside a registered recording. Higgs v3 accepts
    # both plain speech and a recording without its transcript.
    transcript = not moss and (registered_transcript or cosyvoice or fish_speech or name.startswith('higgs-audio-v2'))
    reference = not moss and (registered_transcript or cosyvoice or name.startswith((
        'moss-tts', 'indextts2', 'indextts-2', 'index-tts2', 'index-tts-2', 'omnivoice', 'fishaudio',
    )))
    # qwen3_tts.py validates stored voices as Base tasks before checking the
    # checkpoint variant; CustomVoice/VoiceDesign weights reject those tasks.
    uploaded = not (name.startswith('qwen3-tts') and re.search(r'(?:^|[-.])(?:custom[-.]?voice|voice[-.]?design)$', name))
    qwen_base = name.startswith('qwen3-tts') and name.endswith('-base')
    dimension = (1024 if '0.6b' in name else 2048 if '1.7b' in name else None) if qwen_base else None
    reference = reference or qwen_base
    # vLLM registrations carry ref_text whenever the caller has one.
    return _scoped(config, provider, dict(requiresTranscript=transcript, acceptsTranscript=not moss,
                requiresReferenceAudio=reference, supportsUploadedVoices=uploaded,
                referenceEmbeddingDimension=dimension, canDelete=not moss, maxBytes=10 * 1024 * 1024,
                formats=['wav', 'mp3', 'm4a', 'flac'] if moss else ['wav', 'mp3', 'flac', 'ogg', 'aac', 'webm', 'm4a', 'mp4'],
                minSeconds=None if moss else 1, maxSeconds=30))


def _scoped(config, provider, capabilities):
    parsed = urlsplit(config['url'])
    host = parsed.hostname.lower()
    if ':' in host: host = '[' + host + ']'
    port = parsed.port
    if port and (parsed.scheme, port) not in {('https', 443), ('http', 80)}: host += ':' + str(port)
    endpoint = urlunsplit((parsed.scheme.lower(), host, parsed.path.rstrip('/'), '', ''))
    account = hashlib.sha256((config.get('apiKey', '') if config.get('authMode') != 'none' else '').encode()).hexdigest()
    identity = [provider, config.get('providerId') or config.get('id'), endpoint, config.get('authMode', 'none'), account]
    connection = hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()
    return dict(provider=provider, connectionId=connection, **capabilities)


def valid_voice_name(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= 200 and not re.search(r'[/\\\x00-\x1f\x7f]', value)


def voice_incompatibility(capabilities, has_audio, ref_text, *, uploaded=False, embedding_dim=None):
    if uploaded and not capabilities['supportsUploadedVoices']:
        return 'voice_model_unsupported'
    embedding = uploaded and not has_audio and embedding_dim is not None and embedding_dim == capabilities['referenceEmbeddingDimension']
    if uploaded and not has_audio and embedding_dim is not None and not embedding:
        return 'voice_model_unsupported'
    if uploaded and not has_audio and not embedding and not capabilities['requiresReferenceAudio']:
        return 'voice_model_unsupported'
    if capabilities['requiresReferenceAudio'] and not has_audio and not embedding:
        return 'voice_reference_required'
    if uploaded and capabilities['requiresTranscript'] and not (ref_text or '').strip():
        return 'voice_transcript_required'
    return None
