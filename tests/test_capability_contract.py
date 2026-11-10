"""The capability contract translates (stage, route) pairs, and nothing else.

`tests/fixtures/omni-capabilities/` is the shared sample set: three tiers that
state what a deployment offering those pairs should be understood to provide.
The expected blocks are the reviewed oracle, not a copy of the mapping table, so
changing a mapping has to argue with them. They also stand on their own: with no
resolver at all, a case still says what the deployment offers.

The last group reads the discovery document this repository parses today
(`models[].stage_ids` with routes per operation profile), because that is the
input `requests_for()` will hand to this table.
"""
import json
from pathlib import Path
from typing import get_args

import pytest

from opendirector.domain.capabilities import Capability
from opendirector.domain.capability_contract import (ABSENT, AVAILABLE, ENDPOINT, MISSING, PARTIAL, PRESENT,
                                                     REASONS, STAGE_ROUTES, STAGE_ROUTE_MISMATCH, UNKNOWN, UNMAPPED,
                                                     UNMAPPED_STAGE, UNKNOWN_ROUTE, UNROUTED, UNROUTED_REASONS,
                                                     capabilities_for, classified_capabilities, declarations,
                                                     resolve, route_path)

FIXTURES = Path(__file__).parent / 'fixtures' / 'omni-capabilities'
# Upstream bodies may name models; credentials and raw provider responses never
# belong in a fixture, so their vocabulary is refused outright.
FORBIDDEN = ('apikey', 'api_key', 'authorization', 'bearer', 'secret', 'password', 'cookie', '://')


def raw_cases():
    paths = sorted(FIXTURES.glob('*.json'))
    assert {path.stem for path in paths} == {'full', 'partial', 'absent'}
    for path in paths:
        document = json.loads(path.read_text(encoding='utf-8'))
        assert document['upstreamEndpoint'] == ENDPOINT
        yield document, document['cases']


def fixture_cases():
    for document, cases in raw_cases():
        for case in cases:
            yield pytest.param(case['payload'], case['expected'], id=f"{document['tier']}-{case['id']}")


@pytest.mark.parametrize('payload, expected', list(fixture_cases()))
def test_declaration_resolves_to_the_reviewed_expectation(payload, expected):
    assert resolve(payload) == expected


def test_every_capability_id_is_routed_or_explained():
    """Adding a capability to the vocabulary without placing it here fails this."""
    assert set(classified_capabilities()) == set(get_args(Capability))


def test_a_capability_appears_once_in_the_vocabulary_order():
    vocabulary = classified_capabilities()
    assert len(vocabulary) == len(set(vocabulary))
    assert tuple(dict.fromkeys(vocabulary)) == vocabulary


def test_contract_pairs_and_routes_are_canonical():
    assert len(STAGE_ROUTES) == len({(stage, route) for stage, route, _ in STAGE_ROUTES})
    for stage, route, capabilities in STAGE_ROUTES:
        assert route_path(route) == route, (stage, route)
        assert route.startswith('/v1/'), (stage, route)
        assert stage == stage.strip().lower(), (stage, route)
        assert capabilities and all(isinstance(item, str) for item in capabilities), (stage, route)


def test_one_path_serves_two_stages_without_overwriting_each_other():
    """`/v1/audio/speech` is both speech and music; the pair decides, the path does not."""
    assert capabilities_for('tts', '/v1/audio/speech') == ('audio.speech',)
    assert capabilities_for('music', '/v1/audio/speech') == ('audio.music',)
    result = resolve({'stages': [{'name': 'tts', 'routes': ['/v1/audio/speech']},
                                 {'name': 'music', 'routes': ['/v1/audio/speech']}]})
    assert result['stages'] == {'music': AVAILABLE, 'tts': AVAILABLE}
    assert result['capabilities']['audio.speech'] == AVAILABLE
    assert result['capabilities']['audio.music'] == AVAILABLE


def test_a_shared_path_does_not_grant_the_other_stage():
    """A TTS-only deployment must not look like it can generate music."""
    result = resolve({'stages': [{'name': 'tts', 'routes': ['/v1/audio/speech']}]})
    assert result['capabilities']['audio.speech'] == AVAILABLE
    assert result['capabilities']['audio.music'] == MISSING
    assert result['unresolved'] == []


def test_transcription_serves_score_but_not_recognition():
    """`/v1/audio/transcriptions` is score under `score` and unmapped under `asr`."""
    assert capabilities_for('score', '/v1/audio/transcriptions') == ('audio.score',)
    assert capabilities_for('asr', '/v1/audio/transcriptions') == ()
    declared = resolve({'stages': [{'name': 'score', 'routes': ['/v1/audio/transcriptions']},
                                   {'name': 'asr', 'routes': ['/v1/audio/transcriptions']}]})
    assert declared['capabilities']['audio.score'] == AVAILABLE
    assert declared['stages'] == {'asr': UNMAPPED, 'score': AVAILABLE}
    assert declared['unresolved'] == [{'stage': 'asr', 'route': '/v1/audio/transcriptions',
                                       'reason': UNMAPPED_STAGE}]
    # Recognition alone proves nothing about the score adapter, and vice versa.
    recognition_only = resolve({'stages': [{'name': 'asr', 'routes': ['/v1/audio/transcriptions']}]})
    assert recognition_only['capabilities']['audio.score'] == MISSING


def test_an_absent_declaration_is_unknown_everywhere_and_never_missing():
    for payload in (None, {'object': 'omni.capabilities'}, {'stages': []}, {'stages': [{'routes': ['/v1/audio/speech']}]},
                    {'stages': 'not-a-list'}, {'models': []}):
        result = resolve(payload)
        assert result['endpoint'] == ABSENT
        assert result['stages'] == {}
        assert set(result['capabilities'].values()) == {UNKNOWN}
        assert MISSING not in result['capabilities'].values()


def test_a_known_stage_with_another_stages_route_is_a_mismatch():
    result = resolve({'stages': [{'name': 'image', 'routes': ['/v1/videos']}]})
    assert result['stages'] == {'image': UNMAPPED}
    assert result['capabilities']['video.generate'] == MISSING
    assert result['unresolved'] == [{'stage': 'image', 'route': '/v1/videos', 'reason': STAGE_ROUTE_MISMATCH}]


def test_an_unknown_path_and_an_unknown_stage_stay_distinguishable():
    unknown_path = resolve({'stages': [{'name': 'video', 'routes': ['/v1/videos/track']}]})
    unknown_stage = resolve({'stages': [{'name': 'embedding', 'routes': ['/v1/videos']}]})
    assert unknown_path['unresolved'][0]['reason'] == UNKNOWN_ROUTE
    assert unknown_stage['unresolved'][0]['reason'] == UNMAPPED_STAGE


def test_capabilities_are_reported_in_table_order():
    """Presentation reads this order; sorting here would make the table's order meaningless."""
    result = resolve({'stages': [{'name': 'score', 'routes': ['/v1/audio/transcriptions']},
                                 {'name': 'text', 'routes': ['/v1/chat/completions']}]})
    assert list(result['capabilities']) == list(classified_capabilities())
    assert list(result['capabilities'])[:2] == ['text.chat', 'image.generate']


@pytest.mark.parametrize('route', ['audio/speech', '/audio/speech', '/v1/audio/speech/', {'path': '/v1/audio/speech?x=1'}])
def test_route_spellings_normalize_to_one_path(route):
    result = resolve({'stages': [{'name': 'tts', 'routes': [route]}]})
    assert result['stages'] == {'tts': AVAILABLE}
    assert result['capabilities']['audio.speech'] == AVAILABLE


def test_stage_states_report_partial_understanding():
    result = resolve({'stages': [{'name': 'video', 'routes': ['/v1/videos', '/v1/videos/track']}]})
    assert result['stages'] == {'video': PARTIAL}
    assert result['endpoint'] == PRESENT
    assert result['unresolved'] == [{'stage': 'video', 'route': '/v1/videos/track', 'reason': UNKNOWN_ROUTE}]


def test_a_route_cannot_speak_for_a_parameter_capability():
    """`video.first_frame` is a /v1/videos parameter, so it is never `missing`."""
    assert resolve({'stages': [{'name': 'video', 'routes': ['/v1/videos']}]})['capabilities']['video.first_frame'] == UNKNOWN


def test_unrouted_capabilities_state_why_they_are_unreachable():
    assert set(UNROUTED.values()) <= UNROUTED_REASONS


def test_model_names_and_other_provider_fields_never_reach_the_result():
    payload = {'stages': [{'name': 'tts', 'model': 'a-private-model-name', 'routes': ['/v1/audio/speech'],
                           'extra': {'owner': 'someone'}}]}
    assert 'a-private-model-name' not in json.dumps(resolve(payload), ensure_ascii=False)


def test_results_use_only_the_contract_vocabulary():
    for _, cases in raw_cases():
        for case in cases:
            expected = case['expected']
            assert set(expected['capabilities'].values()) <= {AVAILABLE, MISSING, UNKNOWN}
            assert set(expected['stages'].values()) <= {AVAILABLE, PARTIAL, UNMAPPED}
            assert {item['reason'] for item in expected['unresolved']} <= REASONS


def test_fixtures_carry_no_credentials_or_provider_responses():
    for path in sorted(FIXTURES.glob('*.json')):
        text = path.read_text(encoding='utf-8').lower()
        assert not [word for word in FORBIDDEN if word in text], path.name


def discovery_document(stage_ids, path='/v1/audio/speech', profile='text_to_speech'):
    """The body `integrations.capability_probe` parses today: stages per model, routes per profile."""
    return {'object': 'omni.capabilities', 'schema_version': 1, 'observed_at': '2026-11-10T00:00:00+00:00',
            'models': [{'id': 'demo', 'stage_ids': list(stage_ids), 'operations': {'speech': {
                'support': 'supported', 'exposure': 'enabled', 'profiles': [
                    {'id': profile, 'support': 'supported', 'routes': [{'method': 'POST', 'path': path}]}]}}}],
            'routes': [{'method': 'POST', 'path': path, 'exposure': 'enabled'}]}


def test_a_models_document_yields_the_same_pairs():
    assert declarations(discovery_document(['tts'])) == [('tts', '/v1/audio/speech')]
    assert resolve(discovery_document(['tts']))['capabilities']['audio.speech'] == AVAILABLE
    assert resolve(discovery_document(['music']))['capabilities']['audio.music'] == AVAILABLE


def test_an_opaque_stage_id_is_reported_instead_of_guessed():
    """A numeric `stage_ids` entry cannot be translated, and must not be read as a route match."""
    result = resolve(discovery_document(['0']))
    assert result['unresolved'] == [{'stage': '0', 'route': '/v1/audio/speech', 'reason': UNMAPPED_STAGE}]
    assert result['capabilities']['audio.speech'] == MISSING
    assert result['capabilities']['video.first_frame'] == UNKNOWN


def test_model_pairs_follow_document_order():
    pairs = declarations(discovery_document(['tts', 'music']))
    assert pairs == [('tts', '/v1/audio/speech'), ('music', '/v1/audio/speech')]
