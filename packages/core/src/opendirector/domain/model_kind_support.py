"""Decide whether a discovered model can serve a configured category.

Discovery lists whatever GET /models returns. Image, video and audio setup
should not offer models that this product already knows are chat-only or bound
to another category. Unknown names stay visible so a custom compatible service
is not emptied, but they are marked so the user can confirm before saving.
"""
from urllib.parse import urlsplit

from opendirector.domain.kling_models import KLING_MODELS
from opendirector.domain.minimax_models import MINIMAX_MODELS
from opendirector.domain.moss_image import MOSS_IMAGE_MODELS
from opendirector.domain.moss_speech import MOSS_SPEECH_MODELS
from opendirector.domain.projects import ProjectError

SUPPORTED = 'supported'
UNSUPPORTED = 'unsupported'
UNKNOWN = 'unknown'

MINIMAX_IMAGE_MODELS = frozenset({'MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'})
MINIMAX_VIDEO_MODELS = frozenset(MINIMAX_MODELS)
OPENAI_IMAGE_PREFIXES = ('dall-e', 'gpt-image', 'chatgpt-image')
KIND_LABELS = {
    'agent': '对话',
    'image': '图片生成',
    'video': '视频生成',
    'audio': '音频生成',
}
_MODALITY_TO_KIND = {
    'text': 'agent',
    'chat': 'agent',
    'completion': 'agent',
    'image': 'image',
    'image_generation': 'image',
    'video': 'video',
    'video_generation': 'video',
    'audio': 'audio',
    'speech': 'audio',
    'tts': 'audio',
    'music': 'audio',
}


def classify_service_models(kind, models, config=None):
    """Group /models records for a settings category, preserving catalog order."""
    visible, uncertain, unsupported = [], [], []
    seen = set()
    for item in models:
        model_id = item['id']
        if model_id in seen:
            continue
        seen.add(model_id)
        verdict = model_kind_support(kind, model_id, record=item, config=config)
        if verdict == UNSUPPORTED:
            unsupported.append(model_id)
            continue
        visible.append(model_id)
        if verdict == UNKNOWN:
            uncertain.append(model_id)
    return {'models': visible, 'uncertain': uncertain, 'unsupported': unsupported}


def model_kind_support(kind, model_id, *, record=None, config=None):
    """Return supported, unsupported, or unknown for one model in a category."""
    declared = _declared_kinds(record)
    if declared is not None:
        return SUPPORTED if kind in declared else UNSUPPORTED
    known = _known_kind(model_id, config)
    if known is not None:
        return SUPPORTED if known == kind else UNSUPPORTED
    return UNKNOWN


def reject_incompatible_models(kind, model_ids, config=None):
    """Refuse to persist a model that is known not to serve this category."""
    bad = [model_id for model_id in model_ids
           if model_kind_support(kind, model_id, config=config) == UNSUPPORTED]
    if not bad:
        return
    names = '、'.join(f'「{item}」' for item in bad)
    label = KIND_LABELS.get(kind, kind)
    raise ProjectError(f'{names}不支持{label}。请选择支持该能力的模型，或改用对应官方预设 / 手动添加。',
                       422, code='model_kind_unsupported')


def _known_kind(model_id, config):
    name = (model_id or '').strip()
    lowered = name.lower()
    if name in MINIMAX_IMAGE_MODELS:
        return 'image'
    if name in MINIMAX_VIDEO_MODELS or name in KLING_MODELS:
        return 'video'
    if name in MOSS_IMAGE_MODELS:
        return 'image'
    if name in MOSS_SPEECH_MODELS:
        return 'audio'
    if name.startswith('MiniMax-M') or lowered.startswith('minimax-m'):
        return 'agent'
    if lowered.startswith(OPENAI_IMAGE_PREFIXES):
        return 'image'
    if _openai_chat_model(lowered):
        return 'agent'
    host = urlsplit((config or {}).get('url') or '').hostname or ''
    if host in {'api.minimax.cn', 'api.minimax.io'} and name.startswith('MiniMax-'):
        return 'agent'
    return None


def _openai_chat_model(name):
    if name.startswith(('gpt-image', 'chatgpt-image', 'dall-e')):
        return False
    return name.startswith(('gpt-3', 'gpt-4', 'gpt-5', 'chatgpt-4', 'o1', 'o3', 'o4',
                            'text-davinci', 'davinci'))


def _declared_kinds(record):
    if not isinstance(record, dict):
        return None
    kinds = set()
    if record.get('videoCapabilities'):
        kinds.add('video')
    for values in (
        _architecture_outputs(record.get('architecture')),
        record.get('output_modalities'),
        record.get('output_modality'),
        _capability_outputs(record.get('capabilities')),
    ):
        kinds.update(_kinds_from_modalities(values))
    return kinds or None


def _architecture_outputs(architecture):
    if not isinstance(architecture, dict):
        return None
    return architecture.get('output_modalities') or architecture.get('output_modality')


def _capability_outputs(capabilities):
    if not isinstance(capabilities, dict):
        return None
    return [name for name, enabled in capabilities.items() if enabled]


def _kinds_from_modalities(values):
    if values is None:
        return set()
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple, set)):
        return set()
    kinds = set()
    for item in values:
        if not isinstance(item, str):
            continue
        kind = _MODALITY_TO_KIND.get(item.strip().lower())
        if kind:
            kinds.add(kind)
    return kinds
