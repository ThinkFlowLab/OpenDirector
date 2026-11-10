"""The capability contract translates upstream's (operation, profile) vocabulary.

`tests/fixtures/omni-capabilities/` is the shared sample set: three tiers built
from the response shape upstream actually publishes — `stages[]` as topology,
`models[].operations[<operation>].profiles[]` as the declaration, and only
optional fields ever absent. `test_fixtures_are_schema_valid` checks the
structural invariants of that shape (`protocol/capabilities.py:16-79`), so a
fixture that upstream's own pydantic model would reject cannot be frozen into
the oracle. The expected blocks are the reviewed oracle, not a copy of the
mapping table, so changing a mapping has to argue with them.

Shapes upstream can never publish — an `asr` operation key, a profile filed under
the wrong operation, a missing required `support` — are built inline in the
tests that defend against malformed input, never in a fixture, so the fixtures
stay an honest sample of real bodies.

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
from opendirector.domain.capability_contract import (ABSENT, AVAILABLE, EMPTY, ENDPOINT, MALFORMED_ROUTE, MISSING,
                                                     MISSING_REASONS, NO_LOCAL_CAPABILITY, NO_ROUTE_DECLARED,
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

# The vocabulary in contract order: routed ids in table order, then the unrouted
# ids in declaration order. Written out instead of derived, so a reordering of
# the tables is a visible decision rather than a silent presentation change.
VOCABULARY_ORDER = ['text.chat', 'image.generate', 'image.edit', 'video.generate', 'audio.speech', 'audio.music',
                    'image.segment', 'video.matting', 'video.motion_capture', 'audio.score', 'video.first_frame',
                    'video.edit', 'image.cutout', 'audio.separate']

# Every capability id that no upstream profile can express, with its reason.
UNROUTED_EXPECTED = {
    'image.segment': 'no_upstream_profile',
    'video.matting': 'no_upstream_profile',
    'video.motion_capture': 'no_upstream_profile',
    'audio.score': 'no_upstream_operation',
    'video.first_frame': 'parameter_only',
    'video.edit': 'parameter_only',
    'image.cutout': 'parameter_only',
    'audio.separate': 'no_local_adapter',
}


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


def table_routes(operation_id):
    """The operation's owned routes as declarations, straight from the table."""
    return [route(path, method=method, transport=transport)
            for transport, method, path in OPERATION_ROUTES[operation_id]]


def table_paths(operation_id):
    return [path for _, _, path in OPERATION_ROUTES[operation_id]]


def profile(profile_id, support='supported', paths=(), inputs=('text',), outputs=('text',), routes=None, **extra):
    entry = {'id': profile_id, 'support': support, 'required_inputs': list(inputs), 'outputs': list(outputs),
             'routes': [route(path) for path in paths] if routes is None else list(routes),
             'reason_code': 'model_declared', 'constraints': {}}
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
    return {operation_id: operation(profiles=[profile(profile_id, routes=table_routes(operation_id))
                                              for owner, profile_id, _ in OPERATION_PROFILES
                                              if owner == operation_id])
            for operation_id in OPERATIONS}


@pytest.mark.parametrize('payload, expected', list(fixture_cases()))
def test_declaration_resolves_to_the_reviewed_expectation(payload, expected):
    assert resolve(payload) == expected


# --- the table itself -----------------------------------------------------

def test_every_capability_id_is_routed_or_explained():
    """Adding a capability to the vocabulary without placing it here fails this.

    This is also the invariant that keeps an unrouted id out of `resolve()`: no
    row of `OPERATION_PROFILES` maps to an id in `UNROUTED`, so an unrouted id
    can never collect evidence and is `unknown` by "no evidence", not by a
    special case.
    """
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
    for operation_id, routes in OPERATION_ROUTES.items():
        assert routes, operation_id
        for transport, method, path in routes:
            assert transport in {'http', 'websocket'}, (operation_id, transport)
            assert method and method == method.upper(), (operation_id, method)
            assert route_path(path) == path, path
            assert path.startswith('/v1/'), path


def test_operation_routes_follow_upstream_ownership():
    assert set(OPERATION_ROUTES) == set(OPERATIONS)
    assert OPERATION_ROUTES['chat'] == (('http', 'POST', '/v1/chat/completions'),)
    assert OPERATION_ROUTES['image_generation'] == (('http', 'POST', '/v1/images/generations'),)
    assert OPERATION_ROUTES['image_edit'] == (('http', 'POST', '/v1/images/edits'),)
    # The only operation with more than one route, including the websocket one.
    assert OPERATION_ROUTES['video_generation'] == (('http', 'POST', '/v1/videos'),
                                                    ('http', 'POST', '/v1/videos/sync'),
                                                    ('websocket', 'WEBSOCKET', '/v1/realtime/video'))
    assert OPERATION_ROUTES['speech'] == (('http', 'POST', '/v1/audio/speech'),)
    assert OPERATION_ROUTES['audio_generation'] == (('http', 'POST', '/v1/audio/generate'),)
    # `WEBSOCKET` is a method literal, not a transport of its own: exactly one
    # route carries it, and only video generation owns that route.
    assert [operation_id for operation_id, routes in OPERATION_ROUTES.items()
            if any(method == 'WEBSOCKET' for _, method, _ in routes)] == ['video_generation']


def test_unowned_endpoints_are_not_in_the_route_table():
    """Registered routes without an operation must not be readable as capabilities."""
    unowned = ('/v1/images/segmentations', '/v1/videos/segmentations', '/v1/videos/depth',
               '/v1/audio/transcriptions', '/v1/audio/speech/batch', '/v1/chat/completions/batch')
    for path in unowned:
        assert path not in ROUTED_PATHS, path
    # Publishing them in the body's top-level `routes[]` still grants nothing.
    payload = body(models=[])
    payload['routes'] = [route(path) for path in unowned]
    result = resolve(payload)
    for capability in ('image.segment', 'video.matting', 'video.motion_capture', 'audio.score'):
        assert result['capabilities'][capability] == UNKNOWN, capability


def test_music_is_a_speech_profile_on_the_speech_route():
    """There is no music operation: MiniMax Music3 declares `lyrics_to_music` under `speech`."""
    assert capabilities_for('speech', 'lyrics_to_music') == ('audio.music',)
    assert capabilities_for('audio_generation', 'lyrics_to_music') == ()
    assert 'music' not in OPERATIONS
    assert '/v1/audio/generate' not in table_paths('speech')
    assert '/v1/audio/speech' not in table_paths('audio_generation')
    assert '/v1/audio/music' not in ROUTED_PATHS and '/v1/audio/music/generations' not in ROUTED_PATHS


# --- the five regressions that keep coverage honest ----------------------

def test_real_shaped_body_resolves_non_empty_pairs():
    """A body in the published shape must produce pairs and capabilities, not silence."""
    payload = body(every_operation())
    pairs = declarations(payload)
    assert pairs and len(pairs) == 12
    # Literal on purpose: recomputing this from `OPERATION_PROFILES` would only
    # prove the table echoes itself.
    assert set(pairs) == {('chat', 'text_response'), ('chat', 'image_response'), ('chat', 'audio_response'),
                          ('image_generation', 'text_to_image'), ('image_edit', 'image_to_image'),
                          ('video_generation', 'text_to_video'), ('video_generation', 'image_to_video'),
                          ('video_generation', 'video_to_video'), ('speech', 'text_to_speech'),
                          ('speech', 'lyrics_to_music'), ('speech', 'caption_to_audio'),
                          ('audio_generation', 'text_to_audio')}
    result = resolve(payload)
    assert result['endpoint'] == PRESENT
    for capability in ('text.chat', 'image.generate', 'image.edit', 'video.generate', 'audio.speech', 'audio.music'):
        assert result['capabilities'][capability] == AVAILABLE, capability
    assert result['topology'] == [{'id': '7', 'type': 'llm', 'depends_on': []}]
    # `not_declared_locally`: the chat profiles whose output is not text carry no
    # id here, so they are reported instead of being folded into `text.chat`.
    assert result['unresolved'] == [{'operation': 'chat', 'profile': 'audio_response', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY},
                                    {'operation': 'chat', 'profile': 'image_response', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY},
                                    {'operation': 'speech', 'profile': 'caption_to_audio', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY}]


def test_route_alone_cannot_distinguish_speech_profiles():
    """`/v1/audio/speech` is one path and three contracts; only the profile decides."""
    speech_routes = table_paths('speech')
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
    first = model({'chat': operation(profiles=[profile('text_response', paths=table_paths('chat'))]),
                   'image_generation': operation(exposure='disabled',
                                                 profiles=[profile('text_to_image',
                                                                   paths=table_paths('image_generation'))])},
                  model_id='model-a', stage_ids=('7', '42'))
    second = model({'chat': operation(support='unsupported',
                                      profiles=[profile('text_response', 'unsupported',
                                                        paths=table_paths('chat'))]),
                    'image_generation': operation(profiles=[profile('text_to_image',
                                                                    paths=table_paths('image_generation'))])},
                   model_id='model-b', stage_ids=('7', '42'))
    assert first['stage_ids'] == second['stage_ids']
    result = resolve(body(models=[first, second]))
    # chat comes from the model that serves it, image generation from the other one.
    assert result['capabilities']['text.chat'] == AVAILABLE
    assert result['capabilities']['image.generate'] == AVAILABLE
    # Opaque numeric stage ids are topology, so they never surface as failures.
    assert result['unresolved'] == []
    assert resolve(body(models=[second]))['capabilities']['text.chat'] == MISSING


def test_capabilities_without_an_upstream_profile_are_unknown_not_missing():
    """An endpoint that no operation publishes cannot be judged, so it is never `missing`."""
    assert UNROUTED == UNROUTED_EXPECTED
    assert set(UNROUTED.values()) <= UNROUTED_REASONS
    result = resolve(body(every_operation()))
    assert {capability: result['capabilities'][capability] for capability in UNROUTED} == {
        capability: UNKNOWN for capability in UNROUTED}
    assert not set(UNROUTED) & set(result['reasons'])


# --- states ---------------------------------------------------------------

def test_an_unanswered_endpoint_is_absent_and_unknown():
    """No body, no model list: the service did not answer, so nothing is claimed."""
    for payload in (None, {}, {'object': 'omni.capabilities', 'schema_version': 1},
                    {'models': 'not-a-list'}, {'stages': [{'id': '7', 'type': 'llm', 'depends_on': []}]}):
        result = resolve(payload)
        assert result['endpoint'] == ABSENT, payload
        assert set(result['capabilities'].values()) == {UNKNOWN}
        assert result['reasons'] == {}
        assert result['unresolved'] == []


def test_an_endpoint_that_answered_without_declaring_is_empty():
    """A model list with no operation is an answer, and a different one from silence."""
    for payload in ({'models': []}, {'models': [{'id': 'm', 'stage_ids': ['7']}]},
                    {'models': [{'id': 'm', 'operations': {}}]}):
        result = resolve(payload)
        assert result['endpoint'] == EMPTY, payload
        assert set(result['capabilities'].values()) == {UNKNOWN}
        assert result['unresolved'] == []
    assert resolve(None)['endpoint'] != resolve({'models': []})['endpoint']


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


def test_an_unanswered_operation_field_is_unknown_not_supported():
    """Defensive: an operation that states neither enum. Upstream always states both."""
    payload = body({'chat': {'reason_code': 'request_contract_unverified',
                             'profiles': [profile('text_response', paths=table_paths('chat'))]}})
    result = resolve(payload)
    assert result['endpoint'] == PRESENT
    assert result['capabilities']['text.chat'] == UNKNOWN
    assert MISSING not in result['capabilities'].values()


def test_an_operation_value_that_is_not_a_body_records_unknown():
    """Defensive: `{"chat": null}` answers nothing about chat, so its rows stay unknown."""
    for payload in (body({'chat': None}), body({'speech': 'not-a-body'})):
        result = resolve(payload)
        assert result['endpoint'] == PRESENT, payload
        assert set(result['capabilities'].values()) == {UNKNOWN}
        assert result['unresolved'] == []


def test_a_profile_without_support_is_unknown_even_when_its_operation_is_supported():
    """Defensive: `support` is required upstream, so only a malformed body omits it.

    The operation says `supported`/`enabled` and the route is the right one, so
    the only thing standing between this profile and `available` is its own
    missing `support`. Treating an absent field as consent would make this
    `available`.
    """
    entry = profile('text_response', paths=table_paths('chat'))
    del entry['support']
    result = resolve(body({'chat': operation(profiles=[entry])}))
    assert result['endpoint'] == PRESENT
    assert result['capabilities']['text.chat'] == UNKNOWN
    assert result['capabilities']['text.chat'] != AVAILABLE
    assert MISSING not in result['capabilities'].values()
    # The same body that states `unsupported` is a refusal, and does become missing.
    stated = body({'chat': operation(profiles=[profile('text_response', 'unsupported', paths=table_paths('chat'))])})
    assert resolve(stated)['capabilities']['text.chat'] == MISSING
    assert resolve(stated)['reasons'] == {'text.chat': 'unsupported'}


def test_a_supported_but_disabled_operation_is_missing():
    result = resolve(body({'image_generation': operation(exposure='disabled',
                                                         profiles=[profile('text_to_image',
                                                                           paths=table_paths('image_generation'))])}))
    assert result['capabilities']['image.generate'] == MISSING
    assert result['reasons'] == {'image.generate': 'endpoint_disabled'}
    assert result['unresolved'] == []


def test_an_unsupported_profile_is_missing_in_a_supported_operation():
    result = resolve(body({'speech': operation(profiles=[
        profile('text_to_speech', paths=table_paths('speech')),
        profile('lyrics_to_music', 'unsupported', paths=table_paths('speech'))])}))
    assert result['capabilities']['audio.speech'] == AVAILABLE
    assert result['capabilities']['audio.music'] == MISSING
    assert result['reasons'] == {'audio.music': 'unsupported'}


def test_a_refused_model_and_a_closed_route_are_told_apart():
    """Both are a positive no, but the deployment did different things."""
    refused = resolve(body({'image_edit': operation(support='unsupported', profiles=[
        profile('image_to_image', 'unsupported', paths=table_paths('image_edit'))])}))
    assert refused['capabilities']['image.edit'] == MISSING
    assert refused['reasons'] == {'image.edit': 'unsupported'}
    closed = resolve(body({'image_edit': operation(exposure='disabled', profiles=[
        profile('image_to_image', paths=table_paths('image_edit'))])}))
    assert closed['capabilities']['image.edit'] == MISSING
    assert closed['reasons'] == {'image.edit': 'endpoint_disabled'}
    route_closed = resolve(body({'image_edit': operation(profiles=[
        profile('image_to_image', routes=[route('/v1/images/edits', exposure='disabled')])])}))
    assert route_closed['capabilities']['image.edit'] == MISSING
    assert route_closed['reasons'] == {'image.edit': 'route_disabled'}
    assert set(refused['reasons'].values()) <= set(MISSING_REASONS)


def test_reasons_never_explain_an_available_or_unknown_capability():
    result = resolve(body(every_operation()))
    assert set(result['reasons']) <= {item for item, state in result['capabilities'].items() if state == MISSING}


def test_a_capability_no_profile_mentions_is_unknown_not_missing():
    result = resolve(body({'chat': operation(profiles=[profile('text_response', paths=table_paths('chat'))])}))
    assert result['capabilities']['video.generate'] == UNKNOWN
    assert result['capabilities']['audio.music'] == UNKNOWN
    assert result['reasons'] == {}


# --- profile-level route exposure ----------------------------------------

def test_a_profile_whose_only_route_is_disabled_is_missing():
    """`support=supported` is not enough: the profile's own route says `disabled`."""
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='disabled')])])}))
    assert result['capabilities']['image.generate'] == MISSING
    assert result['reasons'] == {'image.generate': 'route_disabled'}
    assert result['unresolved'] == []


def test_a_profile_whose_routes_are_all_unknown_cannot_be_confirmed():
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='unknown')])])}))
    assert result['capabilities']['image.generate'] == UNKNOWN
    assert result['reasons'] == {}
    assert result['unresolved'] == []


def test_one_enabled_route_is_enough_when_another_is_disabled():
    result = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/videos', exposure='disabled'),
                                         route('/v1/videos/sync')])])}))
    assert result['capabilities']['video.generate'] == AVAILABLE


def test_a_profile_that_declares_no_route_is_unknown():
    """`routes` is `default_factory=list` upstream: `[]` is a legal shape, not a refusal."""
    entry = profile('text_to_speech', paths=[])
    assert entry['routes'] == []
    result = resolve(body({'speech': operation(profiles=[entry])}))
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert result['unresolved'] == [{'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
                                     'reason': NO_ROUTE_DECLARED}]


def test_one_unrecognised_route_does_not_void_a_profile_that_answered():
    """Upstream adds routes; one new path must not turn a confirmed profile into `unknown`."""
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', paths=['/v1/images/generations', '/v1/images/generations/stream'])])}))
    assert result['capabilities']['image.generate'] == AVAILABLE
    assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                     'route': '/v1/images/generations/stream', 'reason': UNKNOWN_ROUTE}]
    # With nothing usable left, the profile cannot be confirmed.
    alone = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', paths=['/v1/images/generations/stream'])])}))
    assert alone['capabilities']['image.generate'] == UNKNOWN


def test_a_route_entry_without_a_usable_path_is_reported_not_dropped():
    entry = profile('text_to_speech')
    entry['routes'] = [{'method': 'POST'}, {'path': 123}]
    result = resolve(body({'speech': operation(profiles=[entry])}))
    assert result['capabilities']['audio.speech'] == UNKNOWN
    # Both facts hold: nothing readable was declared, and what was declared is broken.
    assert result['unresolved'] == [{'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
                                     'reason': MALFORMED_ROUTE},
                                    {'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
                                     'reason': NO_ROUTE_DECLARED}]


# --- transport / method ---------------------------------------------------

def test_a_wrong_method_is_a_route_mismatch():
    """`DELETE /v1/chat/completions` would be a 405, not a chat request."""
    result = resolve(body({'chat': operation(profiles=[
        profile('text_response', routes=[route('/v1/chat/completions', method='DELETE')])])}))
    assert result['capabilities']['text.chat'] == UNKNOWN
    assert result['unresolved'] == [{'operation': 'chat', 'profile': 'text_response',
                                     'route': '/v1/chat/completions', 'reason': ROUTE_MISMATCH}]


def test_a_wrong_transport_is_a_route_mismatch():
    """The websocket method literal belongs to one route only."""
    result = resolve(body({'speech': operation(profiles=[
        profile('text_to_speech', routes=[route('/v1/audio/speech', method='WEBSOCKET', transport='websocket')])])}))
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert result['unresolved'] == [{'operation': 'speech', 'profile': 'text_to_speech',
                                     'route': '/v1/audio/speech', 'reason': ROUTE_MISMATCH}]


def test_the_video_websocket_route_needs_its_declared_method():
    accepted = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/realtime/video', method='WEBSOCKET', transport='websocket')])])}))
    assert accepted['capabilities']['video.generate'] == AVAILABLE
    http_spelling = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/realtime/video', method='POST')])])}))
    assert http_spelling['capabilities']['video.generate'] == UNKNOWN
    assert http_spelling['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                            'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}]


# --- what each chat profile grants ---------------------------------------

def test_an_image_only_chat_deployment_does_not_read_as_text_chat():
    """`image_response` output is an image; `text.chat` is served by a text-only adapter."""
    result = resolve(body({'chat': operation(profiles=[
        profile('image_response', outputs=('image',), paths=table_paths('chat'))])}))
    assert result['capabilities']['text.chat'] != AVAILABLE
    assert result['capabilities']['text.chat'] == UNKNOWN
    assert result['unresolved'] == [{'operation': 'chat', 'profile': 'image_response', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY}]


def test_an_audio_only_chat_deployment_does_not_read_as_text_chat():
    result = resolve(body({'chat': operation(profiles=[
        profile('audio_response', outputs=('audio',), paths=table_paths('chat'))])}))
    assert result['capabilities']['text.chat'] == UNKNOWN
    assert result['unresolved'] == [{'operation': 'chat', 'profile': 'audio_response', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY}]


def test_a_text_chat_deployment_still_reads_as_text_chat():
    result = resolve(body({'chat': operation(profiles=[
        profile('text_response', paths=table_paths('chat'))])}))
    assert result['capabilities']['text.chat'] == AVAILABLE
    assert result['unresolved'] == []


def test_text_to_audio_grants_audio_music():
    """StableAudio / LTX2-t2a serve `/v1/audio/generate`: text to audio is audio.music here."""
    result = resolve(body({'audio_generation': operation(profiles=[
        profile('text_to_audio', paths=table_paths('audio_generation'), outputs=('audio',))])}))
    assert result['capabilities']['audio.music'] == AVAILABLE
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert result['unresolved'] == []


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
    for path in ('/v1/videos/segmentations', '/v1/images/segmentations'):
        result = resolve(body({'image_generation': operation(
            profiles=[profile('text_to_image', paths=[path])])}))
        assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                         'route': path, 'reason': UNKNOWN_ROUTE}], path
        assert result['capabilities']['image.generate'] == UNKNOWN
        assert result['capabilities']['image.segment'] == UNKNOWN


def test_a_profile_filed_under_the_wrong_operation_is_an_operation_mismatch():
    result = resolve(body({'audio_generation': operation(profiles=[
        profile('lyrics_to_music', paths=table_paths('speech'))])}))
    assert result['unresolved'] == [{'operation': 'audio_generation', 'profile': 'lyrics_to_music',
                                     'route': None, 'reason': OPERATION_MISMATCH}]
    assert result['capabilities']['audio.music'] == UNKNOWN
    assert result['capabilities']['audio.speech'] == UNKNOWN


def test_unknown_operation_and_unknown_profile_stay_distinguishable():
    result = resolve(body({'speech': operation(profiles=[profile('speech_to_speech',
                                                                 paths=table_paths('speech'))])}))
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
    result = resolve(body({'speech': operation(profiles=[
        profile('caption_to_audio', paths=table_paths('speech'), inputs=('ambient_sound',), outputs=('audio',))])}))
    assert result['unresolved'] == [{'operation': 'speech', 'profile': 'caption_to_audio',
                                     'route': None, 'reason': NO_LOCAL_CAPABILITY}]
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert MISSING not in result['capabilities'].values()


def test_an_unsupported_profile_without_a_local_capability_stays_quiet():
    result = resolve(body({'speech': operation(profiles=[
        profile('caption_to_audio', 'unsupported', paths=table_paths('speech'))])}))
    assert result['unresolved'] == []


def test_profile_order_inside_a_model_does_not_change_the_result():
    declared = [profile('text_to_speech', paths=table_paths('speech')),
                profile('lyrics_to_music', 'unsupported', paths=table_paths('speech')),
                profile('caption_to_audio', paths=table_paths('speech'), inputs=('ambient_sound',))]
    forward = resolve(body({'speech': operation(profiles=declared)}))
    backward = resolve(body({'speech': operation(profiles=list(reversed(declared)))}))
    assert forward == backward


def test_two_models_repeating_one_declaration_are_reported_once():
    declaration = {'video_generation': operation(profiles=[profile('text_to_video', paths=['/v1/images/edits'])])}
    result = resolve(body(models=[model(declaration, 'model-a', ('7',)),
                                  model(declaration, 'model-b', ('7',))]))
    assert result['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                     'route': '/v1/images/edits', 'reason': ROUTE_MISMATCH}]


# --- shape and plumbing ---------------------------------------------------

def test_capabilities_are_reported_in_table_order():
    """Presentation reads this order; sorting here would make the table's order meaningless."""
    result = resolve(body({'speech': operation(profiles=[profile('lyrics_to_music', paths=table_paths('speech'))]),
                           'chat': operation(profiles=[profile('text_response', paths=table_paths('chat'))])}))
    assert list(result['capabilities']) == VOCABULARY_ORDER
    assert list(result['capabilities'])[:2] == ['text.chat', 'image.generate']


def test_declarations_keep_document_order_and_drop_repeats():
    operations = {'speech': operation(profiles=[profile('lyrics_to_music', paths=table_paths('speech')),
                                                profile('text_to_speech', paths=table_paths('speech'))]),
                  'chat': operation(profiles=[profile('text_response', paths=table_paths('chat'))])}
    assert declarations(body(operations)) == [('speech', 'lyrics_to_music'), ('speech', 'text_to_speech'),
                                              ('chat', 'text_response')]
    twin = body(models=[model(operations, 'model-a', ('7',)), model(operations, 'model-b', ('7',))])
    assert declarations(twin) == declarations(body(operations))
    assert declarations({'models': [{'id': 'm', 'operations': {}}]}) is None


@pytest.mark.parametrize('spelling', ['audio/speech', '/audio/speech', '/v1/audio/speech/',
                                      '/v1/audio/speech?x=1'])
def test_route_spellings_normalize_to_one_path(spelling):
    assert route_path(spelling) == '/v1/audio/speech'
    assert route_path({'path': spelling}) == '/v1/audio/speech'
    result = resolve(body({'speech': operation(profiles=[
        profile('text_to_speech', routes=[route(spelling)])])}))
    assert result['capabilities']['audio.speech'] == AVAILABLE
    assert result['unresolved'] == []


def test_results_use_only_the_contract_vocabulary():
    for _, cases in raw_cases():
        for case in cases:
            expected = case['expected']
            assert set(expected) == {'endpoint', 'topology', 'capabilities', 'reasons', 'unresolved'}
            assert expected['endpoint'] in {ABSENT, EMPTY, PRESENT}
            assert set(expected['capabilities']) == set(classified_capabilities())
            assert set(expected['capabilities'].values()) <= {AVAILABLE, MISSING, UNKNOWN}
            assert set(expected['reasons']) <= {item for item, state in expected['capabilities'].items()
                                                if state == MISSING}
            assert set(expected['reasons'].values()) <= set(MISSING_REASONS)
            assert {item['reason'] for item in expected['unresolved']} <= REASONS
            assert {tuple(sorted(item)) for item in expected['unresolved']} <= {
                ('operation', 'profile', 'reason', 'route')}
            for stage in expected['topology']:
                assert set(stage) == {'id', 'type', 'depends_on'}


def test_fixtures_are_schema_valid():
    """Structural invariants of upstream's response model, checked on our fixtures.

    Upstream ships these as pydantic models (`protocol/capabilities.py:16-79`,
    head `d1104f8`). Re-implementing them here would be a second copy to keep in
    sync, so this test only asserts the invariants a rejected body would break:
    all six operations, `support`/`exposure` on every operation, `profiles` as a
    list (it serializes as `[]`, it never disappears), the profile `support`
    required, stages as `{id, type, depends_on}` with numeric-string ids.
    """
    operations = set(OPERATIONS)
    seen_body = 0
    for document, cases in raw_cases():
        for case in cases:
            payload = case['payload']
            if payload is None:
                assert case['expected']['endpoint'] == ABSENT, case['id']
                continue
            seen_body += 1
            assert set(payload) == {'object', 'schema_version', 'observed_at', 'stages', 'models', 'routes'}, case['id']
            assert payload['object'] == 'omni.capabilities' and payload['schema_version'] == 1
            for stage in payload['stages']:
                assert set(stage) == {'id', 'type', 'depends_on'}, case['id']
                assert isinstance(stage['id'], str) and stage['id'].isdigit(), stage
                assert isinstance(stage['depends_on'], list), stage
                assert stage['type'] in {'llm', 'diffusion', 'unknown'}, stage
            for model in payload['models']:
                assert {'id', 'stage_ids', 'operations'} <= set(model), case['id']
                assert isinstance(model['stage_ids'], list), model
                assert all(isinstance(stage_id, str) and stage_id.isdigit() for stage_id in model['stage_ids'])
                assert set(model['operations']) == operations, (case['id'], sorted(model['operations']))
                for operation_id, declared in model['operations'].items():
                    assert declared['support'] in {'supported', 'unsupported', 'unknown'}, (case['id'], operation_id)
                    assert declared['exposure'] in {'enabled', 'disabled', 'unknown'}, (case['id'], operation_id)
                    assert isinstance(declared.get('profiles'), list), (case['id'], operation_id)
                    for entry in declared['profiles']:
                        assert entry['support'] in {'supported', 'unsupported', 'unknown'}, (case['id'], entry['id'])
                        assert isinstance(entry.get('routes'), list), entry
                        assert isinstance(entry.get('required_inputs'), list), entry
                        # Published `STANDARD_PROFILES` outputs (`serving_capabilities.py:43-45`).
                        if entry['id'] == 'image_response':
                            assert entry['outputs'] == ['image'], entry
                        if entry['id'] == 'audio_response':
                            assert entry['outputs'] == ['audio'], entry
            for declared_route in payload['routes']:
                assert set(declared_route) == {'transport', 'method', 'path', 'exposure'}, case['id']
                assert declared_route['transport'] in {'http', 'websocket'}, declared_route
    assert seen_body >= 5


def test_fixtures_carry_no_credentials_or_provider_responses():
    for path in sorted(FIXTURES.glob('*.json')):
        text = path.read_text(encoding='utf-8').lower()
        assert not [word for word in FORBIDDEN if word in text], path.name


def test_model_names_and_other_provider_fields_never_reach_the_result():
    payload = body({'chat': operation(profiles=[profile('text_response', paths=table_paths('chat'))])})
    payload['models'][0]['id'] = 'a-private-model-name'
    payload['models'][0]['extra'] = {'owner': 'someone'}
    assert 'a-private-model-name' not in json.dumps(resolve(payload), ensure_ascii=False)
