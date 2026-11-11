"""The capability contract translates upstream's (operation, profile) vocabulary.

`tests/fixtures/omni-capabilities/` is the shared sample set: three tiers
(`full`, `partial`, `absent`) built from the response shape upstream actually
publishes — `stages[]` as topology,
`models[].operations[<operation>].profiles[]` as the declaration, and only
optional fields ever absent. `test_fixtures_are_schema_valid` checks the
structural invariants of that shape (`protocol/capabilities.py:16-79`), so a
fixture that upstream's own pydantic model would reject cannot be frozen into
the oracle. The expected blocks are the reviewed oracle, not a copy of the
mapping table, so changing a mapping has to argue with them.

A fourth file, `malformed.json`, holds bodies only a rewrite can produce — a
profile pointing at another operation's route, a disabled route beside a path
this table does not know. It is read by the defensive, structural and
profile-row checks, never by the sample oracle: it is input to defend against,
not evidence of what upstream publishes. The shapes upstream can never emit —
an `asr` operation key, a profile filed under the wrong operation, a missing
required `support` — stay inline in the tests that defend against them.

The last group guards the failure this table exists to prevent: a route (or a
stage) that is read as if it named a capability. `/v1/audio/speech` carries
three profiles, `stages[].id` is opaque topology, and a registered endpoint
without an operation proves nothing — each of those gets its own regression
test below.
"""
import datetime
import json
from pathlib import Path
from typing import get_args

import pytest

from opendirector.domain.capabilities import Capability
from opendirector.domain.capability_contract import (ABSENT, AVAILABLE, BY_PAIR, EMPTY, ENDPOINT, MALFORMED_ROUTE,
                                                     MISSING, MISSING_REASONS, NO_LOCAL_CAPABILITY, NO_ROUTE_DECLARED,
                                                     OPERATION_MISMATCH, OPERATION_PROFILES, OPERATION_ROUTES,
                                                     OPERATIONS, PRESENT, PROFILE_OPERATIONS, REASONS, ROUTED_PATHS,
                                                     ROUTE_MISMATCH, UNKNOWN, UNKNOWN_PROFILE, UNKNOWN_ROUTE,
                                                     UNMAPPED_STAGE, UNROUTED, UNROUTED_REASONS, capabilities_for,
                                                     ROLE_NOT_DECLARED, UNSUPPORTED_REASON, candidates_for,
                                                     classified_capabilities, declarations, required_roles_for,
                                                     resolve, role_verdict, route_path)

FIXTURES = Path(__file__).parent / 'fixtures' / 'omni-capabilities'
CONTRACT_DOC = Path(__file__).resolve().parents[1] / 'docs' / 'architecture' / 'capability-contract.md'
# The published sample. `malformed` is deliberately not among them: defining it
# as a fourth tier here is what keeps defensive bodies out of the oracle.
TIERS = ('absent', 'full', 'partial')
VIDEO_PATHS = {'/v1/videos', '/v1/videos/sync', '/v1/realtime/video'}
DEFENSIVE_TIER = 'malformed'
# Upstream bodies may name models; credentials and raw provider responses never
# belong in a fixture, so their vocabulary is refused outright.
FORBIDDEN = ('apikey', 'api_key', 'authorization', 'bearer', 'secret', 'password', 'cookie', '://')

OBSERVED = '2026-11-10T00:00:00Z'
EXECUTION = {'state': 'unpaused', 'scope': 'worker', 'observed_at': OBSERVED}

# The vocabulary in contract order: routed ids in table order, then the unrouted
# ids in declaration order. Written out instead of derived, so a reordering of
# the tables is a visible decision rather than a silent presentation change.
VOCABULARY_ORDER = ['text.chat', 'image.generate', 'image.edit', 'video.generate', 'video.first_frame', 'video.edit',
                    'audio.speech', 'audio.music', 'image.segment', 'video.matting', 'video.motion_capture',
                    'audio.score', 'image.cutout', 'audio.separate']

# Every capability id that no upstream profile can express, with its reason.
UNROUTED_EXPECTED = {
    'image.segment': 'no_upstream_profile',
    'video.matting': 'no_upstream_profile',
    'video.motion_capture': 'no_upstream_profile',
    'audio.score': 'no_upstream_operation',
    'image.cutout': 'parameter_only',
    'audio.separate': 'no_local_adapter',
}


# Upstream's `STANDARD_PROFILES` (`vllm_omni/serving_capabilities.py:43-54`, head
# `d1104f8`), transcribed as `(profile, required_inputs, outputs)`. Literal on
# purpose: this is the one place in the change that claims to quote upstream, so
# deriving it from the module under test would only prove the table echoes
# itself. Order inside a tuple is part of the declaration (`image_to_image` is
# text-then-image) and `image_response`/`audio_response` publish a non-text
# output, which is why they grant nothing here.
UPSTREAM_PROFILES = (
    ('text_response', ('text',), ('text',)),
    ('image_response', ('text',), ('image',)),
    ('audio_response', ('text',), ('audio',)),
    ('text_to_image', ('text',), ('image',)),
    ('image_to_image', ('text', 'image'), ('image',)),
    ('text_to_video', ('text',), ('video',)),
    ('image_to_video', ('text', 'image'), ('video',)),
    ('video_to_video', ('video',), ('video',)),
    ('text_to_speech', ('text',), ('audio',)),
    ('lyrics_to_music', ('text', 'instructions'), ('audio',)),
    ('caption_to_audio', ('text',), ('audio',)),
    ('text_to_audio', ('text',), ('audio',)),
)


def parse_observed(value):
    """A datetime from an upstream `observed_at`, raising if it is not one."""
    assert isinstance(value, str) and value, value
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


def raw_documents(tiers):
    """Fixture documents of the requested tiers, in filename order."""
    paths = sorted(FIXTURES.glob('*.json'))
    assert {path.stem for path in paths} == set(TIERS) | {DEFENSIVE_TIER}
    for path in paths:
        if path.stem not in tiers:
            continue
        document = json.loads(path.read_text(encoding='utf-8'))
        assert document['tier'] == path.stem, path.stem
        assert document['upstreamEndpoint'] == ENDPOINT, path.stem
        yield document, document['cases']


def raw_cases():
    """The published sample: bodies upstream's own projection can emit."""
    return raw_documents(TIERS)


def defensive_cases():
    """Bodies a proxy, cache or older revision can hand us; never a sample."""
    return raw_documents((DEFENSIVE_TIER,))


def fixture_cases():
    for document, cases in raw_cases():
        for case in cases:
            yield pytest.param(case['payload'], case['expected'], id=f"{document['tier']}-{case['id']}")


def defensive_params():
    return [pytest.param(case['payload'], case['expected'], id=f"{document['tier']}-{case['id']}")
            for document, cases in defensive_cases() for case in cases]


def route(path, exposure='enabled', method='POST', transport='http'):
    return {'transport': transport, 'method': method, 'path': path, 'exposure': exposure}


def route_with_inputs(path, inputs):
    """A route reference whose `request.inputs` declares roles, as upstream does."""
    return {**route(path), 'request': {'inputs': {role: {'support': support} for role, support in inputs.items()}}}


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


@pytest.mark.parametrize('payload, expected', defensive_params())
def test_defensive_fixture_bodies_resolve_to_the_reviewed_expectation(payload, expected):
    """`malformed.json` is input to defend against, not a sample of a real body.

    It is kept apart from the sample oracle precisely so the three tiers above
    can claim to be published shapes; these cases only prove the defensive
    branches still answer as reviewed.
    """
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
    """Registered routes without an operation must not be readable as capabilities.

    The top-level `routes[]` is display data: `resolve()` never consults it, which
    is why this test resolves one set of declarations three times — with the
    published routes, with none, and with only unowned paths — and requires one
    identical result. Asserting "an unowned path is not in `ROUTED_PATHS`" alone
    would only test a constant; the point is that publishing such a path in the
    body changes no verdict.
    """
    unowned = ('/v1/images/segmentations', '/v1/videos/segmentations', '/v1/videos/depth',
               '/v1/audio/transcriptions', '/v1/audio/speech/batch', '/v1/chat/completions/batch')
    for path in unowned:
        assert path not in ROUTED_PATHS, path
    declared = body(every_operation())
    from_unowned = {**declared, 'routes': [route(path) for path in unowned]}
    from_nothing = {**declared, 'routes': []}
    assert resolve(from_unowned) == resolve(from_nothing) == resolve(declared)
    for capability in ('image.segment', 'video.matting', 'video.motion_capture', 'audio.score'):
        assert resolve(from_unowned)['capabilities'][capability] == UNKNOWN, capability
    # A body that carries only unowned routes and no model declaration answered
    # nothing at all: it is `empty`, not a list of capabilities.
    assert resolve(body(models=[], stages=[]) | {'routes': [route(path) for path in unowned]})['endpoint'] == EMPTY


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
    # `no_local_capability`: the chat profiles whose output is not text, and the
    # diffusion `text_to_audio`, carry no id here, so they are reported instead
    # of being folded into `text.chat` or `audio.music`. `role_not_declared`: the
    # two video tools need an input role this document never names, so broad
    # profile support does not grant them.
    assert result['unresolved'] == [{'operation': 'audio_generation', 'profile': 'text_to_audio', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY},
                                    {'operation': 'chat', 'profile': 'audio_response', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY},
                                    {'operation': 'chat', 'profile': 'image_response', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY},
                                    {'operation': 'speech', 'profile': 'caption_to_audio', 'route': None,
                                     'reason': NO_LOCAL_CAPABILITY},
                                    {'operation': 'video_generation', 'profile': 'image_to_video', 'route': None,
                                     'reason': ROLE_NOT_DECLARED},
                                    {'operation': 'video_generation', 'profile': 'video_to_video', 'route': None,
                                     'reason': ROLE_NOT_DECLARED}]
    assert result['capabilities']['video.first_frame'] == UNKNOWN
    assert result['capabilities']['video.edit'] == UNKNOWN


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


def test_the_reverse_lookup_is_the_same_table_read_backwards():
    """`candidates_for` is derived, never a second vocabulary."""
    for operation, profile, capabilities in OPERATION_PROFILES:
        for capability in capabilities:
            assert (operation, profile) in candidates_for(capability)
    for operation, profile in BY_PAIR:
        assert set(capabilities_for(operation, profile)) == {
            capability for capability in classified_capabilities()
            if (operation, profile) in candidates_for(capability)}
    assert candidates_for('text.chat') == (('chat', 'text_response'),)
    assert candidates_for('audio.music') == (('speech', 'lyrics_to_music'),)
    for capability in UNROUTED:
        assert candidates_for(capability) == (), capability
    # A stored id may carry padding; case is part of the local id, not a variant.
    assert candidates_for(' video.first_frame ') == candidates_for('video.first_frame')
    assert candidates_for('Video.First_Frame') == ()
    assert candidates_for(None) == () and candidates_for(7) == ()


def test_a_video_profile_grants_a_narrower_id_only_when_its_route_declares_the_role():
    """`i2v` and `v2v` are modality contracts, not tool contracts.

    Upstream's route-level `request.inputs` names modality roles only
    (`image`, `mask_image`, `reference_image`, `last_frame`, `video`, `audio`,
    `voice`, `instructions`), so `image_to_video` proves "accepts an image" and
    `video_to_video` proves "accepts a video". The tools here send
    `first_frame`, or `source_video` plus two video/audio noise masks
    (`integrations/model_adapters.py:405-540`), so the id stays `unknown` until
    the document names that role: VACE treats the image as reference images, and
    SeedVR2 declares V2V for video restoration without latent-mask editing.
    """
    assert capabilities_for('video_generation', 'text_to_video') == ('video.generate',)
    assert capabilities_for('video_generation', 'image_to_video') == ('video.first_frame',)
    assert capabilities_for('video_generation', 'video_to_video') == ('video.edit',)
    assert required_roles_for('video.generate') == ()
    assert required_roles_for('video.first_frame') == ('first_frame',)
    assert required_roles_for('video.edit') == ('source_video', 'video_noise_mask', 'audio_noise_mask')
    assert required_roles_for('text.chat') == () and required_roles_for(None) == ()

    modality_only = resolve(body({'video_generation': operation(profiles=[
        profile('image_to_video', paths=table_paths('video_generation'), inputs=('text', 'image'),
                outputs=('video',))])}))
    assert modality_only['capabilities']['video.first_frame'] == UNKNOWN
    assert modality_only['capabilities']['video.generate'] == UNKNOWN
    assert {'operation': 'video_generation', 'profile': 'image_to_video', 'route': None,
            'reason': ROLE_NOT_DECLARED} in modality_only['unresolved']

    declared = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'supported'})])])}))
    assert declared['capabilities']['video.first_frame'] == AVAILABLE
    assert declared['unresolved'] == []

    # A role on a closed route is not evidence: that route cannot serve.
    closed = route_with_inputs('/v1/videos', {'first_frame': 'supported'})
    closed['exposure'] = 'disabled'
    disabled_only = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[closed, route('/v1/videos/sync'), route('/v1/realtime/video')])])}))
    assert disabled_only['capabilities']['video.first_frame'] == UNKNOWN

    # An absent or unrecognised `support` is not a declaration either.
    for declared in ({}, {'max_count': 0}, {'support': 'unknown'}):
        unresolved_shape = resolve(body({'video_generation': operation(profiles=[profile(
            'image_to_video', inputs=('text', 'image'), outputs=('video',),
            routes=[{**route('/v1/videos'), 'request': {'inputs': {'first_frame': declared}}}])])}))
        assert unresolved_shape['capabilities']['video.first_frame'] == UNKNOWN, declared

    # `support=unsupported` is a different answer: a positive refusal, covered
    # with the rest of the role gate in
    # `test_a_complete_request_needs_one_route_and_a_refusal_is_missing`.

    # A path this operation does not own cannot declare the role either.
    foreign = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos/stream', {'first_frame': 'supported'}),
                route('/v1/videos')])])}))
    assert foreign['capabilities']['video.first_frame'] == UNKNOWN
    assert {'operation': 'video_generation', 'profile': 'image_to_video',
            'route': '/v1/videos/stream', 'reason': UNKNOWN_ROUTE} in foreign['unresolved']

    # Every role the tool transmits has to be declared, not just one of them.
    partial_roles = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'source_video': 'supported'})])])}))
    assert partial_roles['capabilities']['video.edit'] == UNKNOWN
    assert {'operation': 'video_generation', 'profile': 'video_to_video', 'route': None,
            'reason': ROLE_NOT_DECLARED} in partial_roles['unresolved']


def test_a_complete_request_needs_one_route_and_a_refusal_is_missing():
    """Roles on two routes are not one request; a refusal is not a gap.

    `/v1/videos` and `/v1/videos/sync` are two different requests, so
    `source_video` declared on the first beside the two noise masks on the second
    cannot be combined: a request leaves on one route. `support=unsupported` is
    the other side of the same rule — the deployment saying no, which is
    `missing` with `unsupported`, not the `unknown` of a document that is silent.
    """
    complete = {'source_video': 'supported', 'video_noise_mask': 'supported', 'audio_noise_mask': 'supported'}
    split = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'source_video': 'supported'}),
                route_with_inputs('/v1/videos/sync', {'video_noise_mask': 'supported',
                                                      'audio_noise_mask': 'supported'})])])}))
    assert split['capabilities']['video.edit'] == UNKNOWN
    assert {'operation': 'video_generation', 'profile': 'video_to_video', 'route': None,
            'reason': ROLE_NOT_DECLARED} in split['unresolved']

    # One route carrying the whole set is still enough, wherever it sits.
    whole = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route('/v1/videos'), route_with_inputs('/v1/videos/sync', complete)])])}))
    assert whole['capabilities']['video.edit'] == AVAILABLE
    assert whole['unresolved'] == []

    # Refused on the only candidate route: no request can carry that input.
    refused = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})])])}))
    assert refused['capabilities']['video.first_frame'] == MISSING
    assert refused['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}
    assert refused['unresolved'] == []

    # Refused on every open route is the same answer.
    refused_twice = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                route_with_inputs('/v1/videos/sync', {'first_frame': 'unsupported'})])])}))
    assert refused_twice['capabilities']['video.first_frame'] == MISSING

    # A sibling that has not decided keeps it `unknown`: it may still serve.
    undecided = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                route('/v1/videos/sync')])])}))
    assert undecided['capabilities']['video.first_frame'] == UNKNOWN
    assert undecided['reasons'] == {}

    # So does a route this table cannot read but that is switched on.
    unreadable = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                route_with_inputs('/v1/videos/stream', {'first_frame': 'supported'})])])}))
    assert unreadable['capabilities']['video.first_frame'] == UNKNOWN
    assert {'operation': 'video_generation', 'profile': 'image_to_video',
            'route': '/v1/videos/stream', 'reason': UNKNOWN_ROUTE} in unreadable['unresolved']

    # Two routes that each refuse a different role are as final as one refusing
    # both: no route can carry the set, and every route has said so.
    complementary = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'source_video': 'supported',
                                                 'video_noise_mask': 'unsupported',
                                                 'audio_noise_mask': 'unsupported'}),
                route_with_inputs('/v1/videos/sync', {'source_video': 'unsupported',
                                                      'video_noise_mask': 'supported',
                                                      'audio_noise_mask': 'supported'})])])}))
    assert complementary['capabilities']['video.edit'] == MISSING
    assert complementary['reasons'] == {'video.edit': UNSUPPORTED_REASON}

    # A three-role id is refused by the one role nobody accepts.
    partial_refusal = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'source_video': 'supported',
                                                'video_noise_mask': 'unsupported',
                                                'audio_noise_mask': 'unsupported'})])])}))
    assert partial_refusal['capabilities']['video.edit'] == MISSING
    assert partial_refusal['reasons'] == {'video.edit': UNSUPPORTED_REASON}

    # An unrecognised route with no `exposure` is `unknown` exposure, not a
    # refusal: it must keep the answer `unknown` too.
    silent_unrecognised = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                {'transport': 'http', 'method': 'POST', 'path': '/v1/videos/stream'}])])}))
    assert silent_unrecognised['capabilities']['video.first_frame'] == UNKNOWN
    assert silent_unrecognised['reasons'] == {}
    assert {'operation': 'video_generation', 'profile': 'image_to_video',
            'route': '/v1/videos/stream', 'reason': UNKNOWN_ROUTE} in silent_unrecognised['unresolved']

    # And an own route whose exposure cannot be read: it may still serve, so a
    # refusal on its sibling is not the whole story either.
    unread_exposure = route_with_inputs('/v1/videos/sync', {'first_frame': 'supported'})
    del unread_exposure['exposure']
    undecided_exposure = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                unread_exposure])])}))
    assert undecided_exposure['capabilities']['video.first_frame'] == UNKNOWN
    assert undecided_exposure['reasons'] == {}

    # A refusal on a closed route proves nothing: that route cannot serve.
    closed = route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})
    closed['exposure'] = 'disabled'
    closed_only = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[closed, route('/v1/videos/sync')])])}))
    assert closed_only['capabilities']['video.first_frame'] == UNKNOWN

    # The public gate and the report answer the same declaration the same way;
    # the focused cases live in `test_the_role_gate_answers_as_resolve_does`.


ROLE_GATE_CASES = {
    'complete route': [route_with_inputs('/v1/videos', {'source_video': 'supported',
                                                       'video_noise_mask': 'supported',
                                                       'audio_noise_mask': 'supported'})],
    'split across routes': [route_with_inputs('/v1/videos', {'source_video': 'supported'}),
                            route_with_inputs('/v1/videos/sync', {'video_noise_mask': 'supported',
                                                                  'audio_noise_mask': 'supported'})],
    'refused on its only route': [route_with_inputs('/v1/videos', {'source_video': 'unsupported',
                                                                   'video_noise_mask': 'unsupported',
                                                                   'audio_noise_mask': 'unsupported'})],
    'two routes, complementary refusals': [route_with_inputs('/v1/videos', {'source_video': 'supported',
                                                                           'video_noise_mask': 'unsupported',
                                                                           'audio_noise_mask': 'unsupported'}),
                                           route_with_inputs('/v1/videos/sync', {'source_video': 'unsupported',
                                                                                'video_noise_mask': 'supported',
                                                                                'audio_noise_mask': 'supported'})],
    'silent sibling': [route_with_inputs('/v1/videos', {'source_video': 'unsupported',
                                                        'video_noise_mask': 'unsupported',
                                                        'audio_noise_mask': 'unsupported'}),
                       route('/v1/videos/sync')],
    'sibling without exposure': [route_with_inputs('/v1/videos', {'source_video': 'unsupported',
                                                                 'video_noise_mask': 'unsupported',
                                                                 'audio_noise_mask': 'unsupported'}),
                                 {**route('/v1/videos/sync'), 'exposure': None}],
    'unplaceable route left on': [route_with_inputs('/v1/videos', {'source_video': 'unsupported',
                                                                  'video_noise_mask': 'unsupported',
                                                                  'audio_noise_mask': 'unsupported'}),
                                  route_with_inputs('/v1/videos/stream', {'source_video': 'supported'})],
    'malformed route reference': [route_with_inputs('/v1/videos', {'source_video': 'unsupported',
                                                                  'video_noise_mask': 'unsupported',
                                                                  'audio_noise_mask': 'unsupported'}),
                                  {'method': 'POST', 'exposure': 'enabled'}],
}
ROLE_GATE_STATES = {'yes': AVAILABLE, 'no': MISSING, 'unknown': UNKNOWN}


def test_a_malformed_route_reference_is_not_a_channel():
    """A reference with no usable path is reported, never counted as a route that may serve.

    `_route_exposures()` notes it as `malformed_route` and keeps it out of the
    reachability decision; the role gate has to agree, or a broken reference
    would silently keep a refusal from being a refusal.
    """
    entry = profile('video_to_video', inputs=('video',), outputs=('video',), routes=[
        route_with_inputs('/v1/videos', {'source_video': 'unsupported',
                                         'video_noise_mask': 'unsupported',
                                         'audio_noise_mask': 'unsupported'}),
        {'method': 'POST', 'exposure': 'enabled'},
    ])
    result = resolve(body({'video_generation': operation(profiles=[entry])}))
    assert result['capabilities']['video.edit'] == MISSING
    assert result['reasons'] == {'video.edit': UNSUPPORTED_REASON}
    assert {'operation': 'video_generation', 'profile': 'video_to_video', 'route': None,
            'reason': MALFORMED_ROUTE} in result['unresolved']


@pytest.mark.parametrize('name', list(ROLE_GATE_CASES))
def test_the_role_gate_answers_as_resolve_does(name):
    """One declaration, one role answer: `resolve()` asks this gate, never re-derives it.

    The profile's own verdict and its routes' reachability are decided before the
    gate, so this compares the role question only.
    """
    entry = profile('video_to_video', inputs=('video',), outputs=('video',), routes=ROLE_GATE_CASES[name])
    result = resolve(body({'video_generation': operation(profiles=[entry])}))
    verdict = role_verdict(entry, 'video_generation', required_roles_for('video.edit'))
    assert result['capabilities']['video.edit'] == ROLE_GATE_STATES[verdict], name


def test_a_role_string_is_one_role_and_an_undecided_role_stays_unknown():
    """The gate's boundary cases: a bare string, no requirement, no declaration."""
    assert role_verdict({}, 'video_generation', ('first_frame',)) == 'unknown'
    assert role_verdict({'routes': [route('/v1/videos')]}, 'video_generation', ()) == 'yes'
    assert role_verdict({'routes': [route_with_inputs('/v1/videos', {'first_frame': 'supported'})]},
                        'video_generation', 'first_frame') == 'yes'
    assert role_verdict({'routes': [route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})]},
                        'video_generation', 'first_frame') == 'no'
    assert role_verdict({'routes': [route_with_inputs('/v1/videos', {})]},
                        'video_generation', 'first_frame') == 'unknown'

    # A constraint that is not an object is neither authorisation nor refusal.
    bare_constraint = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[{**route('/v1/videos'), 'request': {'inputs': {'first_frame': 'supported'}}}])])}))
    assert bare_constraint['capabilities']['video.first_frame'] == UNKNOWN
    assert bare_constraint['reasons'] == {}
    assert {'operation': 'video_generation', 'profile': 'image_to_video', 'route': None,
            'reason': ROLE_NOT_DECLARED} in bare_constraint['unresolved']


def test_a_profile_row_grants_at_most_one_role_gated_id():
    """A role-gated row grants nothing else, so a refusal cannot reach a free id."""
    for operation, profile_id, capabilities in OPERATION_PROFILES:
        gated = [capability for capability in capabilities if required_roles_for(capability)]
        assert not gated or tuple(gated) == tuple(capabilities), (operation, profile_id, capabilities)


def test_a_gated_ids_refusal_does_not_reach_the_ids_beside_it(monkeypatch):
    """The gate runs per capability, so a mixed row cannot lend it a verdict.

    No row in the table mixes a gated id with an ungated one, and the invariant
    above keeps it that way; this pins the code, not just the table, by handing
    `resolve()` one such row: `video.first_frame` is refused, `video.generate`
    beside it is not.
    """
    monkeypatch.setitem(BY_PAIR, ('video_generation', 'image_to_video'),
                        ('video.generate', 'video.first_frame'))
    mixed = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})])])}))
    assert mixed['capabilities']['video.first_frame'] == MISSING
    assert mixed['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}
    assert mixed['capabilities']['video.generate'] == AVAILABLE


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


def test_a_disabled_profile_with_an_unknown_enabled_route_is_unknown():
    """Every known route off, plus a path this table cannot place that says `enabled`.

    Upstream adds routes over time and this table can lag behind. An unrecognised
    route that reports `enabled` is a channel whose reachability cannot be
    confirmed, so the known-but-off routes are not proof of absence: `unknown`,
    never `missing`. A route that cannot be placed is no excuse for a positive no.
    """
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='disabled'),
                                         route('/v1/images/generations/stream')])])}))
    assert result['capabilities']['image.generate'] == UNKNOWN
    assert result['reasons'] == {}
    assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                     'route': '/v1/images/generations/stream', 'reason': UNKNOWN_ROUTE}]
    # An unrecognised route that is itself `disabled` adds no channel, so the
    # known-off routes remain a refusal.
    still_missing = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='disabled'),
                                         route('/v1/images/generations/stream', exposure='disabled')])])}))
    assert still_missing['capabilities']['image.generate'] == MISSING
    assert still_missing['reasons'] == {'image.generate': 'route_disabled'}


@pytest.mark.parametrize('exposure', ['enabled', 'unknown', None, 'disabled'])
def test_unrecognised_route_outcome_depends_on_its_exposure(exposure):
    """A path this table cannot place still states whether it is switched on.

    Upstream sets a route's `exposure` to `unknown` when the route is registered
    but its reachability is not settled (`serving_capabilities.py:267,304`), so
    "every known route of the profile is `disabled`, plus an unrecognised route
    whose `exposure` is `unknown`" is a body upstream really publishes, and so
    is the same body with the field absent (upstream's default). Reading either
    as a refusal would be the false `missing` this table exists to prevent.
    Only an unrecognised route that itself says `disabled` adds no channel, and
    then the known-but-off routes remain a positive no.
    """
    declared = route('/v1/images/generations/stream')
    if exposure is None:
        del declared['exposure']
    else:
        declared['exposure'] = exposure
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='disabled'), declared])])}))
    if exposure == 'disabled':
        assert result['capabilities']['image.generate'] == 'missing'
        assert result['reasons'] == {'image.generate': 'route_disabled'}
    else:
        assert result['capabilities']['image.generate'] == 'unknown'
        assert result['reasons'] == {}
    assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                     'route': '/v1/images/generations/stream', 'reason': 'unknown_route'}]


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
    assert result['capabilities']['text.chat'] == 'unknown'
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


def test_text_to_audio_alone_does_not_make_audio_music_available():
    """`text_to_audio` is the diffusion `/v1/audio/generate` contract, not music.

    It carries no lyrics and no `instructions`, while the only `audio.music`
    adapter here (`VllmOmniMusic`) posts `/v1/audio/speech` with both required.
    A deployment that publishes only `text_to_audio` therefore cannot answer an
    `audio.music` request: the profile is reported and the capability stays
    `unknown`, never a false `available`.
    """
    assert capabilities_for('audio_generation', 'text_to_audio') == ()
    result = resolve(body({'audio_generation': operation(profiles=[
        profile('text_to_audio', paths=table_paths('audio_generation'), outputs=('audio',))])}))
    assert result['capabilities']['audio.music'] == 'unknown'
    assert {'operation': 'audio_generation', 'profile': 'text_to_audio', 'route': None,
            'reason': 'no_local_capability'} in result['unresolved']
    assert result['capabilities']['audio.speech'] == 'unknown'
    # The music path is still the speech profile, on the speech route.
    music = resolve(body({'speech': operation(profiles=[
        profile('lyrics_to_music', paths=table_paths('speech'), inputs=('text', 'instructions'),
                outputs=('audio',))])}))
    assert music['capabilities']['audio.music'] == AVAILABLE


# --- untranslatable declarations -----------------------------------------

def test_a_profile_declaring_another_operations_route_is_a_route_mismatch():
    payload = body({'video_generation': operation(profiles=[
        profile('text_to_video', paths=['/v1/images/edits']),
        profile('image_to_video', paths=['/v1/videos'])])})
    result = resolve(payload)
    # The broken profile grants nothing. The coherent one still cannot grant the
    # first-frame tool: no route names the role.
    assert result['capabilities']['video.first_frame'] == UNKNOWN
    assert result['capabilities']['video.generate'] == UNKNOWN
    assert result['unresolved'] == [
        {'operation': 'video_generation', 'profile': 'image_to_video', 'route': None,
         'reason': ROLE_NOT_DECLARED},
        {'operation': 'video_generation', 'profile': 'text_to_video',
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


def schema_problems(payload):
    """Structural invariants upstream's pydantic models impose on a body.

    Upstream ships `protocol/capabilities.py:16-79` as pydantic models. Copying
    them here would be a second implementation to keep in sync, so this only
    checks the invariants a rejected body would break: the six keys, `observed_at`
    as a datetime, `reason_code` present wherever `support` is, `execution` as
    `{state, scope, observed_at}`, `support`/`exposure` domains, `profiles` as a
    list (it serializes as `[]`, it never disappears), and routes as
    `{transport, method, path, exposure}` with a method.
    """
    problems = []
    if set(payload) != {'object', 'schema_version', 'observed_at', 'stages', 'models', 'routes'}:
        problems.append(f'keys {sorted(payload)}')
    if payload.get('object') != 'omni.capabilities' or payload.get('schema_version') != 1:
        problems.append('object/schema_version')
    try:
        assert parse_observed(payload['observed_at']).tzinfo is not None
    except (AssertionError, KeyError, TypeError, ValueError) as error:
        problems.append(f'observed_at: {error!r}')
    for stage in payload.get('stages', []):
        if set(stage) != {'id', 'type', 'depends_on'}:
            problems.append(f'stage keys {sorted(stage)}')
        if not (isinstance(stage.get('id'), str) and stage['id'].isdigit()):
            problems.append(f'stage id {stage.get("id")!r}')
        if not isinstance(stage.get('depends_on'), list):
            problems.append(f'stage depends_on {stage.get("depends_on")!r}')
        if stage.get('type') not in {'llm', 'diffusion', 'unknown'}:
            problems.append(f'stage type {stage.get("type")!r}')
    for model in payload.get('models', []):
        if not {'id', 'stage_ids', 'operations'} <= set(model):
            problems.append(f'model keys {sorted(model)}')
        stage_ids = model.get('stage_ids')
        if not isinstance(stage_ids, list) or not all(isinstance(item, str) and item.isdigit()
                                                      for item in stage_ids):
            problems.append(f'model stage_ids {stage_ids!r}')
        operations = model.get('operations')
        if not isinstance(operations, dict) or set(operations) != set(OPERATIONS):
            problems.append(f'operations {sorted(operations or ())}')
            continue
        for operation_id, declared in operations.items():
            if declared.get('support') not in {'supported', 'unsupported', 'unknown'}:
                problems.append(f'{operation_id} support {declared.get("support")!r}')
            if declared.get('exposure') not in {'enabled', 'disabled', 'unknown'}:
                problems.append(f'{operation_id} exposure {declared.get("exposure")!r}')
            if not (isinstance(declared.get('reason_code'), str) and declared['reason_code']):
                problems.append(f'{operation_id} reason_code {declared.get("reason_code")!r}')
            execution = declared.get('execution')
            if not isinstance(execution, dict) or set(execution) != {'state', 'scope', 'observed_at'}:
                problems.append(f'{operation_id} execution {execution!r}')
                continue
            if execution['state'] not in {'unpaused', 'paused', 'unknown'}:
                problems.append(f'{operation_id} execution.state {execution["state"]!r}')
            if execution['scope'] not in {'deployment', 'worker'}:
                problems.append(f'{operation_id} execution.scope {execution["scope"]!r}')
            try:
                assert parse_observed(execution['observed_at']).tzinfo is not None
            except (AssertionError, TypeError, ValueError) as error:
                problems.append(f'{operation_id} execution.observed_at: {error!r}')
            if not isinstance(declared.get('profiles'), list):
                problems.append(f'{operation_id} profiles {declared.get("profiles")!r}')
                continue
            for entry in declared['profiles']:
                if entry.get('support') not in {'supported', 'unsupported', 'unknown'}:
                    problems.append(f'{operation_id}/{entry.get("id")} support {entry.get("support")!r}')
                if not (isinstance(entry.get('reason_code'), str) and entry['reason_code']):
                    problems.append(f'{operation_id}/{entry.get("id")} reason_code')
                if not isinstance(entry.get('required_inputs'), list):
                    problems.append(f'{operation_id}/{entry.get("id")} required_inputs')
                if not isinstance(entry.get('outputs'), list):
                    problems.append(f'{operation_id}/{entry.get("id")} outputs')
                if not isinstance(entry.get('routes'), list):
                    problems.append(f'{operation_id}/{entry.get("id")} routes')
                    continue
                for reference in entry['routes']:
                    # `CapabilityRouteReference` carries an optional `request`
                    # (`protocol/capabilities.py`); refusing it would reject bodies
                    # upstream really emits.
                    legal = {'transport', 'method', 'path', 'exposure'}
                    request = reference.get('request')
                    if request is not None:
                        legal |= {'request'}
                        if not isinstance(request, dict) or not set(request) <= {
                                'inputs', 'required_any_of', 'parameters', 'mask', 'max_output_pixels'}:
                            problems.append(f'{operation_id}/{entry.get("id")} request {request!r}')
                    if set(reference) - legal:
                        problems.append(f'{operation_id}/{entry.get("id")} route keys {sorted(reference)}')
                    if isinstance(request, dict) and reference.get('path') in VIDEO_PATHS:
                        # `_route_request` writes these facts on every video path;
                        # a request block without them is a shape upstream cannot
                        # emit, so a fixture may not use one to prove the gate.
                        inputs = request.get('inputs')
                        parameters = request.get('parameters')
                        last_frame = inputs.get('last_frame') if isinstance(inputs, dict) else None
                        if not isinstance(last_frame, dict) or last_frame.get('support') != 'unsupported':
                            problems.append(f'{operation_id}/{entry.get("id")} request without last_frame')
                        if not isinstance(parameters, dict) or \
                                not {'width', 'height', 'num_frames', 'fps'} <= set(parameters):
                            problems.append(f'{operation_id}/{entry.get("id")} request parameters')
                    if reference.get('transport') not in {'http', 'websocket'}:
                        problems.append(f'{operation_id}/{entry.get("id")} transport {reference.get("transport")!r}')
                    if not (isinstance(reference.get('method'), str) and reference['method']):
                        problems.append(f'{operation_id}/{entry.get("id")} method {reference.get("method")!r}')
                    if not isinstance(reference.get('path'), str):
                        problems.append(f'{operation_id}/{entry.get("id")} path {reference.get("path")!r}')
                    if reference.get('exposure') not in {'enabled', 'disabled', 'unknown'}:
                        problems.append(f'{operation_id}/{entry.get("id")} exposure {reference.get("exposure")!r}')
    # The top-level list is a different model (`CapabilityRoute`) with a required
    # `exposure`; it is display data, but it still has to be structurally legal.
    for declared_route in payload.get('routes', []):
        if set(declared_route) != {'transport', 'method', 'path', 'exposure'}:
            problems.append(f'top-level route keys {sorted(declared_route)}')
        if declared_route.get('transport') not in {'http', 'websocket'}:
            problems.append(f'top-level route transport {declared_route.get("transport")!r}')
        if not (isinstance(declared_route.get('method'), str) and declared_route['method']):
            problems.append(f'top-level route method {declared_route.get("method")!r}')
    return problems


def test_fixtures_are_schema_valid():
    """Every fixture body, defensive ones included, is structurally legal."""
    seen_body = 0
    for document, cases in raw_documents(TIERS + (DEFENSIVE_TIER,)):
        for case in cases:
            payload = case['payload']
            if payload is None:
                assert case['expected']['endpoint'] == ABSENT, case['id']
                continue
            seen_body += 1
            assert schema_problems(payload) == [], (document['tier'], case['id'])
    assert seen_body >= 5


def test_the_fixture_guard_rejects_a_video_request_shape_upstream_cannot_emit():
    """The video-route request facts are an invariant, so the guard has to bite.

    `_route_request` writes `last_frame: unsupported` and the four transport
    parameters on every video path. A fixture that omits them is a shape the
    projection cannot emit, and proving a capability with it would be fake
    coverage.
    """
    def payload_for(request):
        entry = profile('image_to_video', inputs=('text', 'image'), outputs=('video',),
                        routes=[{**route('/v1/videos'), 'request': request}])
        operations = every_operation()
        operations['video_generation'] = operation(profiles=[entry])
        return body(operations)

    broken = payload_for({'inputs': {'first_frame': {'support': 'supported'}},
                          'parameters': {'width': {}, 'height': {}}})
    problems = schema_problems(broken)
    assert any('without last_frame' in problem for problem in problems), problems
    assert any('request parameters' in problem for problem in problems), problems

    complete = payload_for({
        'inputs': {'first_frame': {'support': 'supported'}, 'last_frame': {'support': 'unsupported'}},
        'parameters': {name: {'support': 'supported'} for name in ('width', 'height', 'num_frames', 'fps')}})
    assert schema_problems(complete) == []


def test_fixtures_obey_upstream_construction_invariants():
    """The three sample tiers only carry shapes upstream's projection can emit.

    Upstream derives an operation's `exposure` from that operation's own routes
    (`entrypoints/openai/serving_capabilities.py:384-387`: any `enabled` →
    `enabled`, else any `unknown` → `unknown`, else `disabled`) and hands every
    profile of the operation the *full* route list of its operation (`:320-329`,
    with `/v1/realtime/video` forced `disabled` for the profiles that take video
    or audio input). "Operation says off, route says on" and "profile references
    half of the video routes" are therefore bodies upstream cannot publish, and
    a fixture claiming to be a real response shape cannot contain them.

    `malformed.json` is excluded on purpose: it is the one file that exists to
    hold shapes a proxy, cache or older revision can hand us — exactly the
    bodies this test forbids in a sample. The defensive cases pin their own
    expectations instead.
    """
    checked = 0
    for document, cases in raw_cases():
        for case in cases:
            payload = case['payload']
            if not isinstance(payload, dict):
                continue
            for model_entry in payload['models']:
                for operation_id, declared in model_entry['operations'].items():
                    if operation_id not in OPERATION_ROUTES:
                        continue
                    legal = set(OPERATION_ROUTES[operation_id])
                    exposures = []
                    for entry in declared['profiles']:
                        keys = {(reference['transport'], reference['method'], reference['path'])
                                for reference in entry['routes']}
                        assert keys, (case['id'], operation_id, entry['id'], 'no route declared')
                        assert keys <= legal, (case['id'], operation_id, entry['id'], sorted(keys - legal))
                        exposures.extend(reference['exposure'] for reference in entry['routes'])
                    if not exposures:
                        # No profile, hence no route: nothing to aggregate.
                        continue
                    aggregate = ('enabled' if 'enabled' in exposures else
                                 'unknown' if 'unknown' in exposures else 'disabled')
                    assert declared['exposure'] == aggregate, (case['id'], operation_id,
                                                               declared['exposure'], aggregate)
                    if operation_id == 'video_generation' and declared['exposure'] != 'disabled':
                        # Three routes are owned here; a profile that references
                        # a subset would hide a channel upstream does publish.
                        for entry in declared['profiles']:
                            keys = {(reference['transport'], reference['method'], reference['path'])
                                    for reference in entry['routes']}
                            assert keys == legal, (case['id'], entry['id'], sorted(legal - keys))
                    # 2026-11-11 加：`/v1/realtime/video` 是上游唯一会改写 exposure 的路由
                    # （`entrypoints/openai/serving_capabilities.py:342-347`：profile 的
                    # required_inputs 含 video 或 audio → forced disabled，否则沿用该路由自身）。
                    # 一条路径对同一 operation 的所有 profile 是同一个 route 对象，所以除这条
                    # 改写外 exposure 必须一致；`image_to_video`（text+image）曾被写成 disabled。
                    per_path: dict[str, set[str]] = {}
                    for entry in declared['profiles']:
                        for reference in entry['routes']:
                            per_path.setdefault(reference['path'], set()).add(reference['exposure'])
                    for path, seen in per_path.items():
                        if path == '/v1/realtime/video':
                            continue
                        assert len(seen) == 1, (case['id'], operation_id, path, sorted(seen))
                    realtime_base = {reference['exposure']
                                     for entry in declared['profiles']
                                     for reference in entry['routes']
                                     if reference['path'] == '/v1/realtime/video'
                                     and not {'video', 'audio'} & set(entry['required_inputs'])}
                    assert len(realtime_base) <= 1, (case['id'], operation_id, sorted(realtime_base))
                    for entry in declared['profiles']:
                        for reference in entry['routes']:
                            if reference['path'] != '/v1/realtime/video':
                                continue
                            forced = {'video', 'audio'} & set(entry['required_inputs'])
                            wanted = 'disabled' if forced else next(iter(realtime_base), reference['exposure'])
                            assert reference['exposure'] == wanted, (
                                case['id'], operation_id, entry['id'], reference['exposure'], wanted)
            checked += 1
    assert checked >= 5


def rendered_cell(inputs, outputs):
    """The doc's spelling of one profile row: `("text","image")` → `("image",)`."""

    def cell(items):
        body = ','.join(f'"{item}"' for item in items)
        return '(' + body + (',' if len(items) == 1 else '') + ')'

    return cell(inputs) + '→' + cell(outputs)


def documented_profiles():
    """`(profile, required_inputs → outputs cell)` pairs from the contract doc."""
    cells = []
    for line in CONTRACT_DOC.read_text(encoding='utf-8').splitlines():
        parts = [part.strip() for part in line.split('|')]
        # A four-column row splits into six parts: two outer empties plus cells.
        if len(parts) != 6 or '→' not in parts[3]:
            continue
        profile_id = parts[2].strip('`')
        if profile_id == 'profile':  # the header row
            continue
        cells.append((profile_id, parts[3].replace('`', '').replace(' ', '')))
    return cells


def test_documented_required_inputs_match_fixtures():
    """The literal upstream table, the doc table and every fixture agree.

    `required_inputs` order is part of the declaration (`image_to_image` is
    text-then-image), `video_to_video` needs no text, `lyrics_to_music` needs
    `instructions`, and `image_response`/`audio_response` publish a non-text
    output. `resolve()` reads none of it, so nothing else can catch rot here.
    `malformed.json` is included: its bodies are structurally legal pydantic, so
    the profiles they carry are still upstream's `STANDARD_PROFILES` rows, and
    leaving them out only let that file rot silently. What is defensive about it
    is the routes and the exposures, not the profile rows.
    """
    assert len(UPSTREAM_PROFILES) == 12
    assert {profile_id for profile_id, _, _ in UPSTREAM_PROFILES} == set(PROFILE_OPERATIONS)
    expected = {profile_id: (inputs, outputs) for profile_id, inputs, outputs in UPSTREAM_PROFILES}

    cells = documented_profiles()
    assert len(cells) == 12, 'the documented table must list all twelve profiles'
    assert {profile_id for profile_id, _ in cells} == set(expected)
    for profile_id, cell in cells:
        inputs, outputs = expected[profile_id]
        assert cell == rendered_cell(inputs, outputs), profile_id

    seen = set()
    for _, cases in raw_documents(TIERS + (DEFENSIVE_TIER,)):
        for case in cases:
            payload = case['payload']
            if not isinstance(payload, dict):
                continue
            for model_entry in payload['models']:
                for declared in model_entry['operations'].values():
                    for entry in declared['profiles']:
                        inputs, outputs = expected[entry['id']]
                        assert (tuple(entry['required_inputs']), tuple(entry['outputs'])) == (inputs, outputs), \
                            (case['id'], entry['id'])
                        seen.add(entry['id'])
    assert seen == set(expected), f'fixtures never exercise {sorted(set(expected) - seen)}'


def test_fixtures_carry_no_credentials_or_provider_responses():
    for path in sorted(FIXTURES.glob('*.json')):
        text = path.read_text(encoding='utf-8').lower()
        assert not [word for word in FORBIDDEN if word in text], path.name


def test_model_names_and_other_provider_fields_never_reach_the_result():
    payload = body({'chat': operation(profiles=[profile('text_response', paths=table_paths('chat'))])})
    payload['models'][0]['id'] = 'a-private-model-name'
    payload['models'][0]['extra'] = {'owner': 'someone'}
    assert 'a-private-model-name' not in json.dumps(resolve(payload), ensure_ascii=False)
