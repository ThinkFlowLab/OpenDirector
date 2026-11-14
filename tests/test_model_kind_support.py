"""Filter discovered models by the category they can actually serve."""
import asyncio

from opendirector.application.model_catalog import ModelCatalog
from opendirector.domain.model_kind_support import (
    SUPPORTED, UNKNOWN, UNSUPPORTED, classify_service_models, model_kind_support,
    reject_incompatible_models,
)
from opendirector.domain.projects import ProjectError
import pytest


MINIMAX = 'https://api.minimax.cn/v1'


def test_minimax_chat_model_is_not_an_image_model():
    assert model_kind_support('image', 'MiniMax-M3.1-Flash', config={'url': MINIMAX}) == UNSUPPORTED
    assert model_kind_support('agent', 'MiniMax-M3.1-Flash', config={'url': MINIMAX}) == SUPPORTED
    assert model_kind_support('image', 'MiniMax-H3-Image', config={'url': MINIMAX}) == SUPPORTED
    assert model_kind_support('image', 'MiniMax-H3', config={'url': MINIMAX}) == UNSUPPORTED


def test_known_tables_and_openai_chat_models():
    assert model_kind_support('video', 'MiniMax-H3-Max') == SUPPORTED
    assert model_kind_support('image', 'MiniMax-H3-Max') == UNSUPPORTED
    assert model_kind_support('image', 'gpt-image-1') == SUPPORTED
    assert model_kind_support('image', 'gpt-4o') == UNSUPPORTED
    assert model_kind_support('agent', 'gpt-4o') == SUPPORTED
    assert model_kind_support('image', 'moss-image-sft-1.0') == SUPPORTED
    assert model_kind_support('image', 'moss-tts-1.5-flash') == UNSUPPORTED
    assert model_kind_support('audio', 'moss-tts-1.5-flash') == SUPPORTED


def test_unknown_names_stay_visible_and_declarations_win():
    assert model_kind_support('image', 'studio-xl') == UNKNOWN
    assert model_kind_support(
        'image', 'custom-sd',
        record={'id': 'custom-sd', 'architecture': {'output_modalities': ['image']}},
    ) == SUPPORTED
    assert model_kind_support(
        'image', 'vision-chat',
        record={'id': 'vision-chat', 'architecture': {'output_modalities': ['text']}},
    ) == UNSUPPORTED
    # Input-only vision is not image generation.
    assert model_kind_support(
        'image', 'gpt-like-vision',
        record={'id': 'gpt-like-vision', 'architecture': {'input_modalities': ['text', 'image']}},
    ) == UNKNOWN


def test_classify_filters_chat_models_from_an_image_catalog():
    result = classify_service_models('image', [
        {'id': 'MiniMax-M3.1-Flash'},
        {'id': 'MiniMax-H3-Image'},
        {'id': 'MiniMax-M3.1-Flash'},
        {'id': 'studio-xl'},
    ], {'url': MINIMAX, 'protocol': 'openai'})
    assert result == {
        'models': ['MiniMax-H3-Image', 'studio-xl'],
        'uncertain': ['studio-xl'],
        'unsupported': ['MiniMax-M3.1-Flash'],
    }


def test_reject_incompatible_models_names_the_model_and_category():
    with pytest.raises(ProjectError, match='MiniMax-M3.1-Flash') as caught:
        reject_incompatible_models('image', ['MiniMax-M3.1-Flash'], {'url': MINIMAX})
    assert caught.value.status == 422
    assert caught.value.code == 'model_kind_unsupported'
    assert '图片生成' in str(caught.value)
    reject_incompatible_models('image', ['MiniMax-H3-Image', 'studio-xl'], {'url': MINIMAX})


def test_discover_and_save_share_the_image_filter(tmp_path, monkeypatch):
    catalog = ModelCatalog.__new__(ModelCatalog)
    catalog.configs = None
    catalog.tester = None
    recorded = []

    async def models(config):
        recorded.append(config)
        return [{'id': 'MiniMax-M3.1-Flash'}, {'id': 'MiniMax-H3-Image'}]

    monkeypatch.setattr('opendirector.application.model_catalog.read_service_models', models)
    found = asyncio.run(catalog.discover(
        'image', MINIMAX, '', 'test-secret', protocol='openai', auth_mode='bearer'))
    assert found['models'] == ['MiniMax-H3-Image']
    assert found['unsupported'] == ['MiniMax-M3.1-Flash']
    assert recorded[0]['kind'] == 'image'

    with pytest.raises(ProjectError, match='MiniMax-M3.1-Flash') as caught:
        catalog.save('image', MINIMAX, 'MiniMax-M3.1-Flash', 'test-secret', protocol='openai')
    assert caught.value.code == 'model_kind_unsupported'
