"""Ark Agent Plan documents one model set per modality; rules must cover it."""
import pytest

from opendirector.domain.input_rules import input_rules
from opendirector.domain.video_capabilities import seedance_20_variant, seedance_25_variant

pytestmark = pytest.mark.cpu

BASE = 'https://ark.cn-beijing.volces.com/api/plan/v3'


def config(kind, model):
    return {'kind': kind, 'modelId': model, 'url': BASE, 'apiKey': 'private', 'protocol': 'volcengine'}


@pytest.mark.parametrize('model', [
    'doubao-seedream-5.5',
    'doubao-seedream-5.0-pro',
    'doubao-seedream-5.0-flash',
])
def test_documented_image_models_share_the_seedream_contract(model):
    rules = input_rules(config('image', model))
    assert rules['profile'] == 'seedream-5.0-pro'
    assert rules['maxImages'] == 10


@pytest.mark.parametrize('model', [
    'doubao-seedance-2.5',
    'doubao-seedance-2-5-260628',
])
def test_seedance_25_reaches_thirty_seconds_with_the_full_reference_budget(model):
    rules = input_rules(config('video', model))
    assert rules['profile'] == 'seedance-2.5'
    assert rules['outputResolutions'] == ['480P', '720P', '1080P', '4K']
    assert [item['durations'] for item in rules['videoCapabilities']['outputs']][0][-1] == 30
    assert [item['durations'] for item in rules['videoCapabilities']['outputs']][0][0] == 4
    assert (rules['maxImages'], rules['maxVideos'], rules['maxAudios']) == (30, 10, 10)
    assert rules['videoModes'] == ['first_frame', 'reference']


@pytest.mark.parametrize('model', [
    'doubao-seedance-2.5-flash',
    'doubao-seedance-2-5-flash-261115',
])
def test_seedance_25_flash_is_capped_at_720p_and_smaller_references(model):
    rules = input_rules(config('video', model))
    assert rules['profile'] == 'seedance-2.5'
    assert rules['outputResolutions'] == ['480P', '720P']
    assert (rules['maxImages'], rules['maxVideos'], rules['maxAudios']) == (10, 5, 5)


@pytest.mark.parametrize('model,variant,last_second', [
    ('doubao-seedance-2.0', 'full', 15),
    ('doubao-seedance-2-0-fast-260128', 'fast', 15),
    ('doubao-seedance-2-0-mini-260615', 'mini', 15),
])
def test_seedance_20_keeps_its_fifteen_second_contract(model, variant, last_second):
    assert seedance_20_variant(model) == variant
    rules = input_rules(config('video', model))
    assert rules['profile'] == 'seedance-2.0'
    assert [item['durations'] for item in rules['videoCapabilities']['outputs']][0][-1] == last_second


def test_variant_parsers_do_not_confuse_the_two_families():
    assert seedance_25_variant('doubao-seedance-2.0') is None
    assert seedance_20_variant('doubao-seedance-2.5') is None
    assert seedance_25_variant('doubao-seedance-2.5') == 'full'
    assert seedance_25_variant('doubao-seedance-2.5-flash') == 'flash'


def test_voice_resource_id_needs_no_video_or_image_contract():
    rules = input_rules(config('audio', 'seed-tts-2.0'))
    assert rules['profile'] == 'tts'
    assert rules['allowedKinds'] == []
