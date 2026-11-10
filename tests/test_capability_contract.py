"""The capability contract translates upstream's (operation, profile) vocabulary.

`tests/fixtures/omni-capabilities/` is the shared sample set: three tiers built
from the response shape upstream actually publishes — `stages[]` as topology,
`models[].operations[<operation>].profiles[]` as the declaration, absent fields
instead of nulls. The expected blocks are the reviewed oracle, not a copy of the
mapping table, so changing a mapping has to argue with them.

The last group guards the failure this table exists to prevent: a route (or a
stage) that is read as if it named a capability. `/v1/audio/speech` carries
three profiles, `stages[].id` is opaque topology, and a registered endpoint
without an operation proves nothing — each of those gets its own regression
test below.
"""
import json
from pathlib import Path
from typing import get_args

import pytest

from opendirector.domain.capabilities import Capability
from opendirector.domain.capability_contract import (ABSENT, AVAILABLE, ENDPOINT, MISSING, NO_LOCAL_CAPABILITY,
                                                     OPERATION_MISMATCH, OPERATION_PROFILES, OPERATION_ROUTES,
                                                     OPERATIONS, PRESENT, REASONS, ROUTED_PATHS, ROUTE_MISMATCH,
                                                     UNKNOWN, UNKNOWN_PROFILE, UNKNOWN_ROUTE, UNMAPPED_STAGE, UNROUTED,
                                                     UNROUTED_REASONS, capabilities_for, classified_capabilities,
                                                     declarations, resolve, route_path)

FIXTURES = Path(__file__).parent / 'fixtures' / 'omni-capabilities'
# Upstream bodies may name models; credentials and raw provider responses never
# belong in a fixture, so their vocabulary is refused outright.
FORBIDDEN = ('apikey', 'api_key', 'authorization', 'bearer', 'secret', 'password', 'cookie', '://')

OBSERVED = '2026-11-10T00:00:00Z'
EXECUTION = {'state': 'unpaused', 'scope': 'worker', 'observed_at': OBSERVED}


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


def route(path, exposure='enabled', method='POST', transport='http'):
    return {'transport': transport, 'method': method, 'path': path, 'exposure': exposure}


def profile(profile_id, support='supported', paths=(), inputs=('text',), outputs=('text',), **extra):
    entry = {'id': profile_id, 'support': support, 'required_inputs': list(inputs), 'outputs': list(outputs),
             'routes': [route(path) for path in paths], 'reason_code': 'model_declared', 'constraints': {}}
    entry.update(extra)
    return entry


def operation(support='supported', exposure='enabled', profiles=(), **extra):
    entry = {'support': support, 'exposure': exposure, 'reason_code': 'model_declared',
             'profiles': list(profiles), 'execution': dict(EXECUTION)}
    entry.update(extra)
    return entry


def model(operations=None, model_id='model-a', stage_ids=('7',)):
    return {'id': model_id, 'stage_ids': list(stage_ids), 'operations': dict(operations or {})}


def body(operations=None, models=None, stages=None):
    return {'object': 'omni.capabilities', 'schema_version': 1, 'observed_at': OBSERVED,
            'stages': [{'id': '7', 'type': 'llm', 'depends_on': []}] if stages is None else stages,
            'models': list(models) if models is not None else [model(operations)],
            'routes': [route('/v1/chat/completions'), route('/v1/audio/speech')]}


def every_operation():
    """All six operations supported and enabled, every profile they publish."""
    return {operation_id: operation(profiles=[profile(profile_id, paths=OPERATION_ROUTES[operation_id])
                                              for owner, profile_id, _ in OPERATION_PROFILES
                                              if owner == operation_id])
            for operation_id in OPERATIONS}


def routes_of(operation_id, profile_id):
    return [path for owner, row_profile, _ in OPERATION_PROFILES
            if (owner, row_profile) == (operation_id, profile_id)
            for path in OPERATION_ROUTES[operation_id]]


@pytest.mark.parametrize('payload, expected', list(fixture_cases()))
def test_declaration_resolves_to_the_reviewed_expectation(payload, expected):
    assert resolve(payload) == expected


# --- the table itself -----------------------------------------------------

def test_every_capability_id_is_routed_or_explained():
    """Adding a capability to the vocabulary without placing it here fails this."""
    placed = {capability for _, _, capabilities in OPERATION_PROFILES for capability in capabilities}
    assert set(classified_capabilities()) == set(get_args(Capability))
    assert not placed & set(UNROUTED), 'a capability is either routed or unrouted, never both'
    assert placed | set(UNROUTED) == set(get_args(Capability))


def test_a_capability_appears_once_in_the_vocabulary_order():
    vocabulary = classified_capabilities()
    assert len(vocabulary) == len(set(vocabulary))
    assert tuple(dict.fromkeys(vocabulary)) == vocabulary


def test_the_table_covers_the_twelve_published_profiles():
    pairs = [(operation_id, profile_id) for operation_id, profile_id, _ in OPERATION_PROFILES]
    assert len(pairs) == 12 == len(set(pairs))
    assert {operation_id for operation_id, _, _ in OPERATION_PROFILES} == set(OPERATIONS)
    per_operation = {operation_id: [profile_id for owner, profile_id, _ in OPERATION_PROFILES if owner == operation_id]
                     for operation_id in OPERATIONS}
    assert per_operation == {'chat': ['text_response', 'image_response', 'audio_response'],
                             'image_generation': ['text_to_image'],
                             'image_edit': ['image_to_image'],
                             'video_generation': ['text_to_video', 'image_to_video', 'video_to_video'],
                             'speech': ['text_to_speech', 'lyrics_to_music', 'caption_to_audio'],
                             'audio_generation': ['text_to_audio']}


def test_rows_and_routes_are_canonical():
    for operation_id, profile_id, capabilities in OPERATION_PROFILES:
        assert operation_id == operation_id.strip().lower(), (operation_id, profile_id)
        assert profile_id == profile_id.strip().lower(), (operation_id, profile_id)
        assert capabilities == tuple(capabilities), (operation_id, profile_id)
    for operation_id, paths in OPERATION_ROUTES.items():
        assert paths, operation_id
        for path in paths:
            assert route_path(path) == path, path
            assert path.startswith('/v1/'), path


def test_operation_routes_follow_upstream_ownership():
    assert set(OPERATION_ROUTES) == set(OPERATIONS)
    assert OPERATION_ROUTES['chat'] == ('/v1/chat/completions',)
    assert OPERATION_ROUTES['image_generation'] == ('/v1/images/generations',)
    assert OPERATION_ROUTES['image_edit'] == ('/v1/images/edits',)
    # The only operation with more than one route, including the websocket one.
    assert OPERATION_ROUTES['video_generation'] == ('/v1/videos', '/v1/videos/sync', '/v1/realtime/video')
    assert OPERATION_ROUTES['speech'] == ('/v1/audio/speech',)
    assert OPERATION_ROUTES['audio_generation'] == ('/v1/audio/generate',)
    assert {'/v1/videos/sync', '/v1/realtime/video'} <= ROUTED_PATHS


def test_unowned_endpoints_belong_to_no_operation():
    """Registered routes without an operation must not be readable as capabilities."""
    for path in ('/v1/images/segmentations', '/v1/videos/segmentations', '/v1/videos/depth',
                 '/v1/audio/transcriptions', '/v1/audio/speech/batch', '/v1/chat/completions/batch'):
        assert path not in ROUTED_PATHS, path


def test_music_is_a_speech_profile_on_the_speech_route():
    """There is no music operation: MiniMax Music3 declares `lyrics_to_music` under `speech`."""
    assert capabilities_for('speech', 'lyrics_to_music') == ('audio.music',)
    assert capabilities_for('audio_generation', 'lyrics_to_music') == ()
    assert 'music' not in OPERATIONS
    assert '/v1/audio/generate' not in OPERATION_ROUTES['speech']
    assert '/v1/audio/speech' not in OPERATION_ROUTES['audio_generation']
    assert '/v1/audio/music' not in ROUTED_PATHS and '/v1/audio/music/generations' not in ROUTED_PATHS


# --- the five regressions that keep coverage honest ----------------------

def test_real_shaped_body_resolves_non_empty_pairs():
    """A body in the published shape must produce pairs and capabilities, not silence."""
    payload = body(every_operation())
    pairs = declarations(payload)
    assert pairs and len(pairs) == 12
    assert set(pairs) == {(operation_id, profile_id) for operation_id, profile_id, _ in OPERATION_PROFILES}
    result = resolve(payload)
    assert result['endpoint'] == PRESENT
    for capability in ('text.chat', 'image.generate', 'image.edit', 'video.generate', 'audio.speech', 'audio.music'):
        assert result['capabilities'][capability] == AVAILABLE, capability
    assert result['topology'] == [{'id': '7', 'type': 'llm', 'depends_on': []}]


def test_route_alone_cannot_distinguish_speech_profiles():
    """`/v1/audio/speech` is one path and three contracts; only the profile decides."""
    speech_routes = OPERATION_ROUTES['speech']
    assert len(speech_routes) == 1
    resolved = {profile_id: capabilities_for('speech', profile_id)
                for profile_id in ('text_to_speech', 'lyrics_to_music', 'caption_to_audio')}
    assert resolved == {'text_to_speech': ('audio.speech',), 'lyrics_to_music': ('audio.music',),
                        'caption_to_audio': ()}
    assert len(set(resolved.values())) == 3
    # MOSS-SoundEffect serves `caption_to_audio` and reports `text_to_speech` unsupported
    # on the same path (upstream test_serving_capabilities.py:233,251).
    payload = body({'speech': operation(profiles=[
        profile('text_to_speech', 'unsupported', paths=speech_routes),
        profile('lyrics_to_music', 'unsupported', paths=speech_routes),
        profile('caption_to_audio', paths=speech_routes, inputs=('ambient_sound',), outputs=('audio',))])})
    result = resolve(payload)
    assert result['capabilities']['audio.speech'] == MISSING
    assert result['capabilities']['audio.music'] == MISSING
    assert result['unresolved'] == [{'operation': 'speech', 'profile': 'caption_to_audio', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY}]


def test_stage_ids_do_not_collapse_capabilities():
    """Every model gets the same `stage_ids`; the operations must still decide separately."""
    first = model({'chat': operation(profiles=[profile('text_response', paths=routes_of('chat', 'text_response'))]),
                   'image_generation': operation(exposure='disabled',
                                                 profiles=[profile('text_to_image',
                                                                   paths=routes_of('image_generation',
                                                                                   'text_to_image'))])},
                  model_id='model-a', stage_ids=('7', '42'))
    second = model({'chat': operation(support='unsupported',
                                      profiles=[profile('text_response', 'unsupported',
                                                        paths=routes_of('chat', 'text_response'))]),
                    'image_generation': operation(profiles=[profile('text_to_image',
                                                                    paths=routes_of('image_generation',
                                                                                    'text_to_image'))])},
                   model_id='model-b', stage_ids=('7', '42'))
    assert first['stage_ids'] == second['stage_ids']
    result = resolve(body(models=[first, second]))
    # chat comes from the model that serves it, image generation from the other one.
    assert result['capabilities']['text.chat'] == AVAILABLE
    assert result['capabilities']['image.generate'] == AVAILABLE
    # Opaque numeric stage ids are topology, so they never surface as failures.
    assert result['unresolved'] == []
    assert resolve(body(models=[second]))['capabilities']['text.chat'] == MISSING


def test_unrouted_capabilities_are_unknown_not_missing():
    """An endpoint that no operation publishes cannot be judged, so it is never `missing`."""
    result = resolve(body(every_operation()))
    for capability, reason in UNROUTED.items():
        assert result['capabilities'][capability] == UNKNOWN, capability
        assert reason in UNROUTED_REASONS, capability
    assert {UNROUTED[capability] for capability in ('image.segment', 'video.matting', 'video.motion_capture')} == {
        'no_upstream_profile'}
    assert 'parameter_only' not in {UNROUTED[capability]
                                    for capability in ('image.segment', 'video.matting', 'video.motion_capture')}
    assert MISSING not in {result['capabilities'][capability] for capability in UNROUTED}


def test_absent_fields_are_unknown():
    """`response_model_exclude_none` drops fields; absence is not a refusal."""
    omitted = body({'chat': {'reason_code': 'request_contract_unverified',
                             'profiles': [{'id': 'text_response', 'routes': [route('/v1/chat/completions')]}]},
                    'speech': operation(profiles=[{'id': 'text_to_speech'}])})
    result = resolve(omitted)
    assert result['endpoint'] == PRESENT
    assert result['capabilities']['text.chat'] == UNKNOWN
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert MISSING not in result['capabilities'].values()
    # The same body that states `unsupported` is a refusal, and does become missing.
    stated = body({'chat': operation(support='unsupported',
                                     profiles=[profile('text_response', 'unsupported',
                                                       paths=['/v1/chat/completions'])])})
    assert resolve(stated)['capabilities']['text.chat'] == MISSING


# --- states ---------------------------------------------------------------

def test_an_absent_declaration_is_unknown_everywhere_and_never_missing():
    for payload in (None, {}, {'object': 'omni.capabilities', 'schema_version': 1},
                    {'models': []}, {'models': 'not-a-list'},
                    {'models': [{'id': 'm', 'stage_ids': ['7']}]},
                    {'stages': [{'id': '7', 'type': 'llm', 'depends_on': []}]}):
        result = resolve(payload)
        assert result['endpoint'] == ABSENT
        assert set(result['capabilities'].values()) == {UNKNOWN}
        assert MISSING not in result['capabilities'].values()
        assert result['unresolved'] == []


def test_a_topology_only_body_grants_nothing():
    """`stages[]` is display data; a stage that carries routes and a name is still ignored."""
    payload = body(models=[], stages=[{'id': '7', 'type': 'llm', 'depends_on': []},
                                      {'id': '42', 'type': 'diffusion', 'depends_on': ['7']},
                                      {'name': 'tts', 'routes': ['/v1/audio/speech']}])
    result = resolve(payload)
    assert result['topology'] == [{'id': '7', 'type': 'llm', 'depends_on': []},
                                  {'id': '42', 'type': 'diffusion', 'depends_on': ['7']}]
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert resolve(body(models=[], stages=[{'id': '99'}]))['topology'] == [
        {'id': '99', 'type': 'unknown', 'depends_on': []}]


def test_a_supported_but_disabled_operation_is_missing():
    result = resolve(body({'image_generation': operation(exposure='disabled',
                                                         profiles=[profile('text_to_image',
                                                                           paths=['/v1/images/generations'])])}))
    assert result['capabilities']['image.generate'] == MISSING
    assert result['unresolved'] == []


def test_an_unsupported_profile_is_missing_in_a_supported_operation():
    result = resolve(body({'speech': operation(profiles=[
        profile('text_to_speech', paths=['/v1/audio/speech']),
        profile('lyrics_to_music', 'unsupported', paths=['/v1/audio/speech'])])}))
    assert result['capabilities']['audio.speech'] == AVAILABLE
    assert result['capabilities']['audio.music'] == MISSING


def test_a_capability_no_profile_mentions_is_unknown_not_missing():
    result = resolve(body({'chat': operation(profiles=[profile('text_response', paths=['/v1/chat/completions'])])}))
    assert result['capabilities']['video.generate'] == UNKNOWN
    assert result['capabilities']['audio.music'] == UNKNOWN


# --- untranslatable declarations -----------------------------------------

def test_a_profile_declaring_another_operations_route_is_a_route_mismatch():
    payload = body({'video_generation': operation(profiles=[
        profile('text_to_video', paths=['/v1/images/edits']),
        profile('image_to_video', paths=['/v1/videos'])])})
    result = resolve(payload)
    # The coherent profile still counts; the broken one does not.
    assert result['capabilities']['video.generate'] == AVAILABLE
    assert result['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                     'route': '/v1/images/edits', 'reason': ROUTE_MISMATCH}]
    alone = resolve(body({'video_generation': operation(profiles=[profile('text_to_video',
                                                                         paths=['/v1/images/edits'])])}))
    assert alone['capabilities']['video.generate'] == UNKNOWN


def test_a_route_that_no_operation_owns_is_an_unknown_route():
    for path in ('/v1/videos/track', '/v1/images/segmentations'):
        result = resolve(body({'image_generation': operation(
            profiles=[profile('text_to_image', paths=[path])])}))
        assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                         'route': path, 'reason': UNKNOWN_ROUTE}], path
        assert result['capabilities']['image.generate'] == UNKNOWN
        assert result['capabilities']['image.segment'] == UNKNOWN


def test_a_profile_filed_under_the_wrong_operation_is_an_operation_mismatch():
    result = resolve(body({'audio_generation': operation(profiles=[
        profile('lyrics_to_music', paths=['/v1/audio/speech'])])}))
    assert result['unresolved'] == [{'operation': 'audio_generation', 'profile': 'lyrics_to_music',
                                     'route': None, 'reason': OPERATION_MISMATCH}]
    assert result['capabilities']['audio.music'] == UNKNOWN
    assert result['capabilities']['audio.speech'] == UNKNOWN


def test_unknown_operation_and_unknown_profile_stay_distinguishable():
    result = resolve(body({'speech': operation(profiles=[profile('speech_to_speech',
                                                                 paths=['/v1/audio/speech'])])}))
    assert result['unresolved'] == [{'operation': 'speech', 'profile': 'speech_to_speech',
                                     'route': None, 'reason': UNKNOWN_PROFILE}]
    wrong_operation = resolve(body({'asr': operation(profiles=[])}))
    assert wrong_operation['unresolved'] == [{'operation': 'asr', 'profile': None,
                                              'route': None, 'reason': UNMAPPED_STAGE}]


def test_asr_is_an_upstream_gap_not_a_missing_row():
    """Recognition has no upstream operation and no registered route; that is not our omission."""
    assert 'asr' not in OPERATIONS
    assert '/v1/audio/transcriptions' not in ROUTED_PATHS
    assert UNROUTED['audio.score'] == 'no_upstream_operation'
    result = resolve(body({'asr': operation(profiles=[profile('asr', paths=['/v1/audio/transcriptions'])])}))
    assert [item['reason'] for item in result['unresolved']] == [UNMAPPED_STAGE]
    assert result['capabilities']['audio.score'] == UNKNOWN


def test_a_supported_profile_without_a_local_capability_is_reported():
    result = resolve(body({'audio_generation': operation(profiles=[
        profile('text_to_audio', paths=['/v1/audio/generate'], inputs=('text',), outputs=('audio',))])}))
    assert result['unresolved'] == [{'operation': 'audio_generation', 'profile': 'text_to_audio',
                                     'route': None, 'reason': NO_LOCAL_CAPABILITY}]
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert MISSING not in result['capabilities'].values()


def test_an_unsupported_profile_without_a_local_capability_stays_quiet():
    result = resolve(body({'speech': operation(profiles=[
        profile('caption_to_audio', 'unsupported', paths=['/v1/audio/speech'])])}))
    assert result['unresolved'] == []


def test_two_models_repeating_one_declaration_are_reported_once():
    declaration = {'video_generation': operation(profiles=[profile('text_to_video', paths=['/v1/images/edits'])])}
    result = resolve(body(models=[model(declaration, 'model-a', ('7',)),
                                  model(declaration, 'model-b', ('7',))]))
    assert result['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                     'route': '/v1/images/edits', 'reason': ROUTE_MISMATCH}]


# --- shape and plumbing ---------------------------------------------------

def test_capabilities_are_reported_in_table_order():
    """Presentation reads this order; sorting here would make the table's order meaningless."""
    result = resolve(body({'speech': operation(profiles=[profile('lyrics_to_music', paths=['/v1/audio/speech'])]),
                           'chat': operation(profiles=[profile('text_response', paths=['/v1/chat/completions'])])}))
    assert list(result['capabilities']) == list(classified_capabilities())
    assert list(result['capabilities'])[:2] == ['text.chat', 'image.generate']


def test_declarations_keep_document_order_and_drop_repeats():
    operations = {'speech': operation(profiles=[profile('lyrics_to_music', paths=['/v1/audio/speech']),
                                                profile('text_to_speech', paths=['/v1/audio/speech'])]),
                  'chat': operation(profiles=[profile('text_response', paths=['/v1/chat/completions'])])}
    assert declarations(body(operations)) == [('speech', 'lyrics_to_music'), ('speech', 'text_to_speech'),
                                              ('chat', 'text_response')]
    twin = body(models=[model(operations, 'model-a', ('7',)), model(operations, 'model-b', ('7',))])
    assert declarations(twin) == declarations(body(operations))
    assert declarations({'models': [{'id': 'm', 'operations': {}}]}) is None


@pytest.mark.parametrize('spelling', ['audio/speech', '/audio/speech', '/v1/audio/speech/',
                                      {'path': '/v1/audio/speech?x=1'}])
def test_route_spellings_normalize_to_one_path(spelling):
    assert route_path(spelling) == '/v1/audio/speech'
    result = resolve(body({'speech': operation(profiles=[
        profile('text_to_speech', paths=[],
                routes=[spelling if isinstance(spelling, dict) else route(spelling)])])}))
    assert result['capabilities']['audio.speech'] == AVAILABLE
    assert result['unresolved'] == []


def test_results_use_only_the_contract_vocabulary():
    for _, cases in raw_cases():
        for case in cases:
            expected = case['expected']
            assert set(expected) == {'endpoint', 'topology', 'capabilities', 'unresolved'}
            assert expected['endpoint'] in {ABSENT, PRESENT}
            assert set(expected['capabilities']) == set(classified_capabilities())
            assert set(expected['capabilities'].values()) <= {AVAILABLE, MISSING, UNKNOWN}
            assert {item['reason'] for item in expected['unresolved']} <= REASONS
            assert {tuple(sorted(item)) for item in expected['unresolved']} <= {
                ('operation', 'profile', 'reason', 'route')}
            for stage in expected['topology']:
                assert set(stage) == {'id', 'type', 'depends_on'}


def test_fixtures_carry_no_credentials_or_provider_responses():
    for path in sorted(FIXTURES.glob('*.json')):
        text = path.read_text(encoding='utf-8').lower()
        assert not [word for word in FORBIDDEN if word in text], path.name


def test_model_names_and_other_provider_fields_never_reach_the_result():
    payload = body({'chat': operation(profiles=[profile('text_response', paths=['/v1/chat/completions'])])})
    payload['models'][0]['id'] = 'a-private-model-name'
    payload['models'][0]['extra'] = {'owner': 'someone'}
    assert 'a-private-model-name' not in json.dumps(resolve(payload), ensure_ascii=False)
