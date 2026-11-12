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
import ast
import datetime
import json
from pathlib import Path
from typing import get_args

import pytest

from opendirector.domain.capabilities import Capability
from opendirector.domain import capability_contract as contract
from opendirector.domain.capability_contract import (ABSENT, AVAILABLE, BY_PAIR, EMPTY, ENDPOINT, MALFORMED_ROUTE,
                                                     MALFORMED_MODEL, MALFORMED_OPERATION, MALFORMED_PROFILE, MISSING,
                                                     MISSING_REASONS, ENDPOINT_DISABLED_REASON,
                                                     NO_LOCAL_CAPABILITY, NO_ROUTE_DECLARED, EXPOSURE_UNKNOWN,
                                                     OPERATION_MISMATCH, OPERATION_PROFILES, OPERATION_ROUTES,
                                                     OPERATIONS, POSTABLE_ROUTES, PRESENT, PROFILE_OPERATIONS, REASONS,
                                                     ROUTED_PATHS,
                                                     ROUTE_MISMATCH, UNKNOWN, UNKNOWN_PROFILE, UNKNOWN_ROUTE,
                                                     UNMAPPED_STAGE, UNREADABLE, UNROUTED, UNROUTED_REASONS,
                                                     capabilities_for, ROLE_NOT_DECLARED, UNSUPPORTED_FORMAT,
                                                     UNSUPPORTED_REASON, candidates_for,
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
    """A route reference whose `request.inputs` declares roles, as upstream does.

    A value is either the `support` string or a whole constraint dict, so a case
    can carry `max_count` beside the enum the way upstream publishes it.
    """
    constraints = {role: {'support': value} if isinstance(value, str) else dict(value)
                   for role, value in inputs.items()}
    return {**route(path), 'request': {'inputs': constraints}}


def socket_route(exposure: str | None = 'enabled', inputs=None):
    """The operation's own websocket route as a declared reference.

    `exposure` may be None to omit the key: upstream serves the body with
    `response_model_exclude_none`, so an optional field can be absent, and an
    absent exposure is its own default.
    """
    value = route('/v1/realtime/video', method='WEBSOCKET', transport='websocket')
    if exposure is None:
        del value['exposure']
    else:
        value['exposure'] = exposure
    if inputs is not None:
        value['request'] = route_with_inputs('/v1/realtime/video', inputs)['request']
    return value


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


def test_postable_routes_are_the_route_each_local_adapter_posts():
    """Ownership says what the operation serves; `POSTABLE_ROUTES` says what we post.

    Written out rather than derived from the table: the table is the claim under
    review. The table is then checked against the adapter source, not against
    itself: for every operation except `audio_generation`, the postable path has
    to appear as a literal in `integrations/model_adapters.py`, so a route
    nobody posts cannot be smuggled into the evidence table.
    `audio_generation` is the documented exception — upstream publishes
    `POST /v1/audio/generate`, this repository has no adapter for it, and the
    row stays so the published operation keeps a placement entry. Its absence
    from the adapter file is asserted too, so the exception cannot silently
    become a lie in the other direction.
    """
    assert set(POSTABLE_ROUTES) == set(OPERATIONS)
    assert POSTABLE_ROUTES == {
        'chat': (('http', 'POST', '/v1/chat/completions'),),
        'image_generation': (('http', 'POST', '/v1/images/generations'),),
        'image_edit': (('http', 'POST', '/v1/images/edits'),),
        'video_generation': (('http', 'POST', '/v1/videos'),),
        'speech': (('http', 'POST', '/v1/audio/speech'),),
        'audio_generation': (('http', 'POST', '/v1/audio/generate'),),
    }
    # Every postable route is an owned route, and only video_generation has any
    # owned route that is not postable.
    for operation_id, routes in POSTABLE_ROUTES.items():
        assert set(routes) <= set(OPERATION_ROUTES[operation_id]), operation_id
    non_postable = {operation_id: tuple(key for key in routes if key not in POSTABLE_ROUTES[operation_id])
                    for operation_id, routes in OPERATION_ROUTES.items()}
    assert {operation_id: keys for operation_id, keys in non_postable.items() if keys} == {
        'video_generation': (('http', 'POST', '/v1/videos/sync'),
                             ('websocket', 'WEBSOCKET', '/v1/realtime/video'))}

    # The adapter source is the evidence for "this is the route we post".
    source = (Path(__file__).resolve().parents[1]
              / 'packages/core/src/opendirector/integrations/model_adapters.py').read_text(encoding='utf-8')
    upstream_only = {'audio_generation'}
    assert upstream_only < set(POSTABLE_ROUTES)
    for operation_id, routes in POSTABLE_ROUTES.items():
        if operation_id in upstream_only:
            continue
        for transport, method, path in routes:
            assert transport == 'http' and method == 'POST', (operation_id, transport, method)
            literal = "'" + path[len('/v1'):] + "'"
            assert literal in source, (operation_id, literal)
    # The exception is real: no adapter in this repository posts it.
    assert "'/audio/generate'" not in source


def test_only_the_postable_route_is_evidence():
    """The one route the adapter posts decides; every other declaration is a note.

    Eight declarations, one rule: `/v1/videos/sync` and the socket are channels
    this tool never uses, so neither an `enabled` sync nor a socket of any
    `exposure` can reopen a closed `/v1/videos`, and neither can grant anything
    on its own. Each is reported once (`route_mismatch`, `unknown_route` for a
    path nothing owns), with no effect on the verdict — not a grant, not a
    refusal, not a doubt. Cases (5)–(7) are the ones that separate the branches:
    a socket spelling the postable path, a sibling declaration beside an *open*
    postable route, and a path no operation owns beside an open postable route.
    Case (8) is the one that separates the *fields* of the key: it differs from
    the baseline in `transport` only — method and path are the table's own;
    `exposure` is flipped to `enabled` on purpose, since a disabled socket cannot
    reopen anything.
    """
    # (1) Nothing this tool posts to is open: `/v1/videos` says `disabled` while
    # `/v1/videos/sync` says `enabled`. The sync variant does not rescue it.
    sync_open = profile('text_to_video', routes=[route('/v1/videos', exposure='disabled'),
                                                 route('/v1/videos/sync')])
    hardened = resolve(body({'video_generation': operation(profiles=[sync_open])}))
    assert hardened['capabilities']['video.generate'] == MISSING
    assert hardened['reasons'] == {'video.generate': 'route_disabled'}
    assert hardened['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                       'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]

    # (2) A socket claiming the http path this tool does post to (`/v1/videos`)
    # is a wrong declaration, and it is inert in all four `exposure` spellings.
    socket_reports = {}
    for exposure in ('enabled', 'unknown', None, 'disabled'):
        claiming = route('/v1/videos', exposure=exposure if exposure else 'enabled',
                         method='WEBSOCKET', transport='websocket')
        if exposure is None:
            del claiming['exposure']
        entry = profile('text_to_video', routes=[route('/v1/videos', exposure='disabled'), claiming])
        report = resolve(body({'video_generation': operation(profiles=[entry])}))
        assert report['capabilities']['video.generate'] == MISSING, exposure
        assert report['reasons'] == {'video.generate': 'route_disabled'}, exposure
        assert report['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                         'route': '/v1/videos', 'reason': ROUTE_MISMATCH}], exposure
        socket_reports[exposure] = report
    assert len({json.dumps(report, sort_keys=True) for report in socket_reports.values()}) == 1

    # (3) Only `/v1/videos/sync` declared: no postable route at all, so the
    # profile is `unknown` with `no_route_declared`, never `missing`.
    sync_only = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/videos/sync')])])}))
    assert sync_only['capabilities']['video.generate'] == UNKNOWN
    assert sync_only['reasons'] == {}
    assert sync_only['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                       'route': None, 'reason': NO_ROUTE_DECLARED},
                                      {'operation': 'video_generation', 'profile': 'text_to_video',
                                       'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]

    # (4) Only the socket declared: the same answer, and the same single note
    # about a channel this tool never opens.
    socket_only = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[socket_route('enabled')])])}))
    assert socket_only == sync_only | {'unresolved': [
        {'operation': 'video_generation', 'profile': 'text_to_video', 'route': None,
         'reason': NO_ROUTE_DECLARED},
        {'operation': 'video_generation', 'profile': 'text_to_video',
         'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}]}

    # (5) A socket that spells the postable path and declares every role the
    # gated id needs. If the role filter compared paths instead of whole
    # `(transport, method, path)` keys, this declaration would lend `video.edit`
    # its three roles beside an open `/v1/videos` that names none of them — the
    # grant this case forbids. The gate has to agree with `resolve()`, which
    # counts no exposure for a socket.
    edit_roles = {'source_video': 'supported', 'video_noise_mask': 'supported',
                  'audio_noise_mask': 'supported'}
    claiming_socket = {**route('/v1/videos', method='WEBSOCKET', transport='websocket'),
                       'request': route_with_inputs('/v1/videos', edit_roles)['request']}
    gated = profile('video_to_video', inputs=('video',), outputs=('video',),
                    routes=[route('/v1/videos'), claiming_socket])
    assert role_verdict(gated, 'video_generation', required_roles_for('video.edit')) == 'unknown'
    gated_report = resolve(body({'video_generation': operation(profiles=[gated])}))
    assert gated_report['capabilities']['video.edit'] == UNKNOWN
    assert AVAILABLE not in (gated_report['capabilities']['video.edit'],
                             gated_report['capabilities']['video.first_frame'])
    assert gated_report['unresolved'] == [
        {'operation': 'video_generation', 'profile': 'video_to_video', 'route': None,
         'reason': ROLE_NOT_DECLARED},
        {'operation': 'video_generation', 'profile': 'video_to_video', 'route': '/v1/videos',
         'reason': ROUTE_MISMATCH}]

    # (6) An `enabled` sync beside an *open* postable route: the verdict is the
    # postable route's, and the sync declaration is one note and nothing else.
    open_beside_sync = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/videos'), route('/v1/videos/sync')])])}))
    assert open_beside_sync['capabilities']['video.generate'] == AVAILABLE
    assert open_beside_sync['reasons'] == {}
    assert open_beside_sync['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                               'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]

    # (7) A path no operation owns, beside an open postable route: reported as
    # `unknown_route` (nothing owns it), and the verdict does not move either.
    unowned_beside_postable = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations'),
                                        route('/v1/images/segmentations')])])}))
    assert unowned_beside_postable['capabilities']['image.generate'] == AVAILABLE
    assert unowned_beside_postable['reasons'] == {}
    assert unowned_beside_postable['unresolved'] == [
        {'operation': 'image_generation', 'profile': 'text_to_image',
         'route': '/v1/images/segmentations', 'reason': UNKNOWN_ROUTE}]

    # (8) A socket that keeps the http method *and* the http path, so `transport`
    # is the only field of the key that differs from the table's own route (the
    # baseline it is compared to is the closed `/v1/videos` below, so `exposure`
    # is flipped on purpose). Every case above that declared a socket also
    # changed the method to `WEBSOCKET`, which means a comparison of
    # `(method, path)` — or of the path alone — passed all of them: this is the
    # only declaration that fails when `transport` leaves the key. It has to fail
    # twice, on both sides of the rule. Beside a closed `/v1/videos` it must not
    # reopen the row (that would be a false `available`), and beside an open one
    # that names no roles it must not lend the gated id its roles either (a false
    # `yes` out of the role gate). Both comparisons are the whole
    # `(transport, method, path)` key for exactly this shape.
    transport_only = {'transport': 'websocket', 'method': 'POST', 'path': '/v1/videos',
                      'exposure': 'enabled'}
    socket_post = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/videos', exposure='disabled'),
                                        transport_only])])}))
    assert socket_post['capabilities']['video.generate'] == MISSING
    assert socket_post['reasons'] == {'video.generate': 'route_disabled'}
    assert socket_post['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                          'route': '/v1/videos', 'reason': ROUTE_MISMATCH}]

    socket_post_roles = {**transport_only,
                         'request': route_with_inputs('/v1/videos', edit_roles)['request']}
    ungranted = profile('video_to_video', inputs=('video',), outputs=('video',),
                        routes=[route('/v1/videos'), socket_post_roles])
    assert role_verdict(ungranted, 'video_generation', required_roles_for('video.edit')) == 'unknown'
    ungranted_report = resolve(body({'video_generation': operation(profiles=[ungranted])}))
    assert ungranted_report['capabilities']['video.edit'] == UNKNOWN
    assert AVAILABLE not in (ungranted_report['capabilities']['video.edit'],
                             ungranted_report['capabilities']['video.first_frame'])
    assert ungranted_report['unresolved'] == [
        {'operation': 'video_generation', 'profile': 'video_to_video', 'route': None,
         'reason': ROLE_NOT_DECLARED},
        {'operation': 'video_generation', 'profile': 'video_to_video', 'route': '/v1/videos',
         'reason': ROUTE_MISMATCH}]


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


# --- the regressions that keep coverage honest ----------------------------

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
    # profile support does not grant them. `route_mismatch`: the published body
    # declares all three of the operation's routes, and the two this adapter
    # never posts to (`/v1/videos/sync`, the socket) are reported as channels it
    # cannot use — the same declaration a real deployment publishes, read as
    # evidence for nothing.
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
                                    {'operation': 'video_generation', 'profile': 'image_to_video',
                                     'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH},
                                    {'operation': 'video_generation', 'profile': 'image_to_video',
                                     'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH},
                                    {'operation': 'video_generation', 'profile': 'text_to_video',
                                     'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH},
                                    {'operation': 'video_generation', 'profile': 'text_to_video',
                                     'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH},
                                    {'operation': 'video_generation', 'profile': 'video_to_video', 'route': None,
                                     'reason': ROLE_NOT_DECLARED},
                                    {'operation': 'video_generation', 'profile': 'video_to_video',
                                     'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH},
                                    {'operation': 'video_generation', 'profile': 'video_to_video',
                                     'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]
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
    # on the same path (upstream test_serving_capabilities.py:251,270).
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


def test_one_model_refusing_while_another_stays_silent_is_not_missing():
    """`missing` needs positive evidence from every model that could serve it.

    A deployment publishes several models and a capability is `available` when
    any one grants it; the mirror image is that one model's refusal cannot decide
    the capability while another model says nothing, because that model may
    serve. Silence used to harden into a refusal here, which also assumed every
    model lists all six operations — upstream's own model enforces that, so a
    body omitting one is a shape this table did not review, not a refusal.
    """
    refused = operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})])])
    refusing = model({'video_generation': refused}, model_id='model-a')
    speaking = model({'chat': operation(profiles=[profile('text_response', paths=table_paths('chat'))])},
                     model_id='model-b')

    silent = resolve(body(models=[refusing, speaking]))
    assert silent['capabilities']['video.first_frame'] == UNKNOWN
    assert silent['reasons'] == {}

    # A model that lists no operation at all says nothing either.
    blank = resolve(body(models=[refusing, model({}, model_id='model-b')]))
    assert blank['capabilities']['video.first_frame'] == UNKNOWN
    assert blank['reasons'] == {}

    # An element that is not a model is reported, not dropped: it says nothing,
    # so the refusal stays `unknown` — and the report names why the table is thin.
    junk = resolve(body(models=[refusing, 'not-a-model']))
    assert junk['capabilities']['video.first_frame'] == UNKNOWN
    assert junk['unresolved'] == [{'operation': None, 'profile': None, 'route': None,
                                   'reason': MALFORMED_MODEL}]
    # A model with an operation key but no `operations` object is the same case.
    broken = resolve(body(models=[refusing, {'id': 'model-b', 'operations': 'chat'}]))
    assert broken['capabilities']['video.first_frame'] == UNKNOWN
    assert broken['unresolved'] == [{'operation': None, 'profile': None, 'route': None,
                                     'reason': MALFORMED_MODEL}]
    # Nothing declared at all is `empty`, not a malformed body: the endpoint did
    # answer, it just did not say anything about any operation.
    assert resolve({'models': [{'id': 'model-b', 'stage_ids': ['7']}]})['unresolved'] == []

    # Two refusals still decide it: every model said no.
    both = resolve(body(models=[refusing, model({'video_generation': refused}, model_id='model-b')]))
    assert both['capabilities']['video.first_frame'] == MISSING
    assert both['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}


def test_a_verdict_note_from_one_model_does_not_survive_another_models_answer():
    """A note explains the aggregated verdict, not one model's row.

    Capabilities are decided across models, so a row one model leaves `unknown`
    (here: a route whose `exposure` cannot be read) is `available` as soon as
    another model declares it open. Keeping the first model's
    `exposure_unknown` would hang a doubt beside an answer nothing doubts.
    """
    unreadable = model({'image_generation': operation(profiles=[profile(
        'text_to_image', routes=[{'transport': 'http', 'method': 'POST',
                                  'path': '/v1/images/generations'}])])}, model_id='model-a')
    answered = model({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations')])])}, model_id='model-b')

    # On its own the unreadable row is exactly what the note is for.
    alone = resolve(body(models=[unreadable]))
    assert alone['capabilities']['image.generate'] == UNKNOWN
    assert [entry['reason'] for entry in alone['unresolved']] == [EXPOSURE_UNKNOWN]

    # Beside a model that answered, the note would contradict the result.
    together = resolve(body(models=[unreadable, answered]))
    assert together['capabilities']['image.generate'] == AVAILABLE
    assert together['unresolved'] == []

    # The other order is the same answer: aggregation is not order-dependent.
    reversed_order = resolve(body(models=[answered, unreadable]))
    assert reversed_order == together

    # A shape error is not a verdict note and is never held back: the second model
    # is malformed, and that is reported whatever the first one answered. Only
    # notes that explain a *doubt* are dropped when there is none.
    malformed = resolve(body(models=[answered, model({}, model_id='model-b')]))
    assert malformed['capabilities']['image.generate'] == AVAILABLE
    assert [entry['reason'] for entry in malformed['unresolved']] == [MALFORMED_MODEL]


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
    # The three id readers share one normalizer: padding and case are spelling,
    # not part of the id, so each answers for the same stored string.
    assert candidates_for(' Video.First_Frame ') == candidates_for('video.first_frame')
    assert required_roles_for(' Video.First_Frame ') == required_roles_for('video.first_frame')
    assert capabilities_for(' Video_Generation ', ' Image_To_Video ') == \
        capabilities_for('video_generation', 'image_to_video')
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

    # A role on a closed route is not evidence: that route cannot serve. And the
    # two declarations this tool never posts to cannot reopen it —
    # `/v1/videos/sync` left `enabled` beside a closed `/v1/videos` is a note,
    # not a channel, so the answer is the refusal the postable route states.
    closed = route_with_inputs('/v1/videos', {'first_frame': 'supported'})
    closed['exposure'] = 'disabled'
    disabled_only = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[closed, route('/v1/videos/sync'), route('/v1/realtime/video')])])}))
    assert disabled_only['capabilities']['video.first_frame'] == MISSING
    assert disabled_only['reasons'] == {'video.first_frame': 'route_disabled'}
    assert disabled_only['unresolved'] == [
        {'operation': 'video_generation', 'profile': 'image_to_video',
         'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH},
        {'operation': 'video_generation', 'profile': 'image_to_video',
         'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]

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


def test_a_role_on_a_route_the_tool_cannot_post_to_is_not_a_grant():
    """A websocket route is not evidence in either direction.

    `/v1/realtime/video` is one of `video_generation`'s own routes, but the
    adapter posts an http request and never opens that socket
    (`VllmOmniVideo.video` / `.edit_video`, `integrations/model_adapters.py:405-540`).
    A route counts only if the tool posts to it; every other owned route is not
    evidence in either direction — not a grant, not a refusal, not a doubt — and
    it is reported once, as `route_mismatch`, because the declaration names a
    channel this table cannot use. The five cases below are the whole rule: no
    grant, no rescue of an http refusal, the http grant unchanged, a closed
    socket as inert as an open one, and a socket whose `exposure` is absent or
    `unknown` just as inert.
    """
    websocket = route('/v1/realtime/video', method='WEBSOCKET', transport='websocket')

    # A role declared only on the socket: nothing this tool can send carries it,
    # so the id stays `unknown` — and the profile has no route this tool can
    # post to, which the report names as `no_route_declared` rather than blaming
    # a role gate it never reached.
    socket_only = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[{**websocket, 'request': {'inputs': {'first_frame': {'support': 'supported'}}}}])
    only = resolve(body({'video_generation': operation(profiles=[socket_only])}))
    assert role_verdict(socket_only, 'video_generation', ('first_frame',)) == 'unknown'
    assert only['capabilities']['video.first_frame'] == UNKNOWN
    assert only['reasons'] == {}
    assert only['unresolved'] == [{'operation': 'video_generation', 'profile': 'image_to_video',
                                   'route': None, 'reason': NO_ROUTE_DECLARED},
                                  {'operation': 'video_generation', 'profile': 'image_to_video',
                                   'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}]

    # The socket says nothing about a role, so it cannot keep an http refusal
    # from being the deployment's answer: the one route this tool can post to
    # refuses the role, and that is `missing`. The socket is still reported as a
    # declaration this table cannot use.
    socket_beside_refusal = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}), websocket])
    beside = resolve(body({'video_generation': operation(profiles=[socket_beside_refusal])}))
    assert role_verdict(socket_beside_refusal, 'video_generation', ('first_frame',)) == 'no'
    assert beside['capabilities']['video.first_frame'] == MISSING
    assert beside['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}
    assert beside['unresolved'] == [{'operation': 'video_generation', 'profile': 'image_to_video',
                                     'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}]

    # An http route that grants still grants, socket or no socket.
    socket_beside_grant = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'supported'}), websocket])
    beside_grant = resolve(body({'video_generation': operation(profiles=[socket_beside_grant])}))
    assert role_verdict(socket_beside_grant, 'video_generation', ('first_frame',)) == 'yes'
    assert beside_grant['capabilities']['video.first_frame'] == AVAILABLE
    assert beside_grant['unresolved'] == [{'operation': 'video_generation', 'profile': 'image_to_video',
                                          'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}]

    # A closed socket is not a channel at all: it neither grants nor keeps a
    # refusal from hardening, so the http refusal is the deployment's answer.
    closed_socket = {**websocket, 'exposure': 'disabled'}
    socket_closed = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}), closed_socket])
    hardened = resolve(body({'video_generation': operation(profiles=[socket_closed])}))
    assert role_verdict(socket_closed, 'video_generation', ('first_frame',)) == 'no'
    assert hardened['capabilities']['video.first_frame'] == MISSING
    assert hardened['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}

    # A socket whose `exposure` is absent or `unknown` is as inert as an open
    # one — the same refusal, and the same single note about a channel this tool
    # never opens.
    for variant in ('unknown', None):
        socket_hidden = profile(
            'image_to_video', inputs=('text', 'image'), outputs=('video',),
            routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                    socket_route(variant)])
        assert role_verdict(socket_hidden, 'video_generation', ('first_frame',)) == 'no', variant
        hidden = resolve(body({'video_generation': operation(profiles=[socket_hidden])}))
        assert hidden['capabilities']['video.first_frame'] == MISSING, variant
        assert hidden['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}, variant
        assert hidden['unresolved'] == [{'operation': 'video_generation', 'profile': 'image_to_video',
                                        'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}], variant


def test_a_complete_request_needs_one_route_and_a_refusal_is_missing():
    """Roles on two routes are not one request; a refusal is not a gap.

    The request leaves on `/v1/videos` — the one route this adapter posts — so
    `source_video` declared there beside the two noise masks declared on
    `/v1/videos/sync` cannot be combined: the sync declaration is a channel the
    tool never uses, and it is reported as `route_mismatch`. `support=unsupported`
    is the other side of the same rule — the deployment saying no, which is
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
    # The sync route holding the other two roles is not the third way out: it is
    # reported, and the id stays `unknown`.
    assert {'operation': 'video_generation', 'profile': 'video_to_video',
            'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH} in split['unresolved']

    # One route carrying the whole set is still enough — and it has to be the
    # route the tool posts, not the synchronous variant beside it.
    whole = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', complete)])])}))
    assert whole['capabilities']['video.edit'] == AVAILABLE
    assert whole['unresolved'] == []

    # The same declaration one path over grants nothing: `/v1/videos/sync` is
    # not a route this tool posts to, so the profile has no postable route.
    sync_only = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route('/v1/videos'), route_with_inputs('/v1/videos/sync', complete)])])}))
    assert sync_only['capabilities']['video.edit'] == UNKNOWN
    assert sync_only['unresolved'] == [
        {'operation': 'video_generation', 'profile': 'video_to_video', 'route': None,
         'reason': ROLE_NOT_DECLARED},
        {'operation': 'video_generation', 'profile': 'video_to_video',
         'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]

    # Refused on the only candidate route: no request can carry that input.
    refused = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})])])}))
    assert refused['capabilities']['video.first_frame'] == MISSING
    assert refused['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}
    assert refused['unresolved'] == []

    # Refused on the sync variant too: the same answer, and the sync declaration
    # is reported once — it is not a second chance.
    refused_twice = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                route_with_inputs('/v1/videos/sync', {'first_frame': 'unsupported'})])])}))
    assert refused_twice['capabilities']['video.first_frame'] == MISSING
    assert refused_twice['unresolved'] == [{'operation': 'video_generation', 'profile': 'image_to_video',
                                            'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]

    # A second route that says nothing is not doubt: the postable route refused,
    # and a channel this tool never posts to cannot keep that from being the
    # answer.
    silent_sibling = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                route('/v1/videos/sync')])])}))
    assert silent_sibling['capabilities']['video.first_frame'] == MISSING
    assert silent_sibling['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}

    # Nor is a path this table cannot place, switched on or silent.
    unreadable = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                route_with_inputs('/v1/videos/stream', {'first_frame': 'supported'})])])}))
    assert unreadable['capabilities']['video.first_frame'] == MISSING
    assert {'operation': 'video_generation', 'profile': 'image_to_video',
            'route': '/v1/videos/stream', 'reason': UNKNOWN_ROUTE} in unreadable['unresolved']

    # Two declarations that each refuse a different role are as final as one
    # refusing both: the postable route refuses a role the request needs.
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

    # An unrecognised route with no `exposure` is not a refusal either, and not a
    # doubt: only the path is reported.
    silent_unrecognised = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                {'transport': 'http', 'method': 'POST', 'path': '/v1/videos/stream'}])])}))
    assert silent_unrecognised['capabilities']['video.first_frame'] == MISSING
    assert silent_unrecognised['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}
    assert {'operation': 'video_generation', 'profile': 'image_to_video',
            'route': '/v1/videos/stream', 'reason': UNKNOWN_ROUTE} in silent_unrecognised['unresolved']

    # And an own route whose `exposure` cannot be read is inert for the same
    # reason: it is `/v1/videos/sync`, which this tool never posts to, so its
    # missing `exposure` says nothing about the request.
    unread_exposure = route_with_inputs('/v1/videos/sync', {'first_frame': 'supported'})
    del unread_exposure['exposure']
    undecided_exposure = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                unread_exposure])])}))
    assert undecided_exposure['capabilities']['video.first_frame'] == MISSING
    assert undecided_exposure['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}

    # A refusal on a closed postable route proves nothing about the model: the
    # deployment switched the route off, which is `route_disabled` and not
    # `unsupported`. The sync declaration beside it changes neither.
    closed = route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})
    closed['exposure'] = 'disabled'
    closed_only = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[closed, route('/v1/videos/sync')])])}))
    assert closed_only['capabilities']['video.first_frame'] == MISSING
    assert closed_only['reasons'] == {'video.first_frame': 'route_disabled'}
    assert closed_only['unresolved'] == [{'operation': 'video_generation', 'profile': 'image_to_video',
                                          'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]

    # The public gate and the report answer the same declaration the same way;
    # the focused cases live in `test_the_role_gate_answers_as_resolve_does`.


def test_a_count_window_that_excludes_one_item_is_not_a_grant():
    """The count window is part of the support answer, not decoration.

    Upstream publishes optional inclusive bounds beside the enum
    (`request_capabilities.InputConstraint`; `docs/serving/capabilities.md:92`) and the tool
    always sends one item. Reading only `support=supported` granted the id on a
    declaration that can never accept that item — `max_count: 0`, or
    `min_count: 2` — so those are refusals now: `missing` with `unsupported`,
    the same answer a refusing profile gets, because the same thing has to change
    upstream. A bound that is not a whole number is unreadable, and so is a bound
    upstream itself rejects — a negative count, or a `min_count` above the
    `max_count` — because a verdict read out of a window the publisher cannot emit
    is a verdict about a declaration that does not exist. An entry with no
    `support` still decides nothing whatever its counts say.
    """
    for constraints, verdict, state in (
            ({'support': 'supported', 'max_count': 0}, 'no', MISSING),
            ({'support': 'supported', 'max_count': -1}, 'unknown', UNKNOWN),
            ({'support': 'supported', 'min_count': -1, 'max_count': 1}, 'unknown', UNKNOWN),
            ({'support': 'supported', 'min_count': 2, 'max_count': 1}, 'unknown', UNKNOWN),
            # An inverted window that also contains a zero is still inverted:
            # reading it as a zero-capacity refusal would decide a window the
            # publisher rejects. This row is what pins the order of the two
            # checks in `_carries_one` (inverted first, zero capacity second).
            ({'support': 'supported', 'min_count': 1, 'max_count': 0}, 'unknown', UNKNOWN),
            ({'support': 'supported', 'max_count': 1}, 'yes', AVAILABLE),
            ({'support': 'supported', 'max_count': 3}, 'yes', AVAILABLE),
            ({'support': 'supported'}, 'yes', AVAILABLE),
            ({'support': 'supported', 'min_count': 1, 'max_count': 1}, 'yes', AVAILABLE),
            ({'support': 'supported', 'min_count': 0, 'max_count': 0}, 'no', MISSING),
            ({'support': 'supported', 'min_count': 2}, 'no', MISSING),
            ({'support': 'unsupported', 'max_count': 0}, 'no', MISSING),
            # An explicit refusal stands on its own: the malformed window beside
            # it is not what decided, so it must not be read as doubt either.
            ({'support': 'unsupported', 'max_count': -1}, 'no', MISSING),
            ({'support': 'unsupported', 'min_count': 2, 'max_count': 1}, 'no', MISSING),
            ({'support': 'supported', 'max_count': 'many'}, 'unknown', UNKNOWN),
            ({'support': 'supported', 'min_count': 'one'}, 'unknown', UNKNOWN),
            # A numeric string is a string, however numeric it looks: lax
            # coercion would read `'0'` as a zero-capacity refusal and `'2'` /
            # `'3'` as grants, describing a body `int | None` cannot emit. All
            # three are unreadable, so none of them decides anything.
            ({'support': 'supported', 'max_count': '0'}, 'unknown', UNKNOWN),
            ({'support': 'supported', 'min_count': '2'}, 'unknown', UNKNOWN),
            ({'support': 'supported', 'max_count': '3'}, 'unknown', UNKNOWN),
            # A whole-number float is the integer it names — there is no
            # fractional part to lose — so it is read, not refused: treating
            # every float as unreadable would reject a window whose value is
            # exactly a whole number of items.
            ({'support': 'supported', 'max_count': 2.0}, 'yes', AVAILABLE),
            ({'support': 'supported', 'min_count': 1.0, 'max_count': 1.0}, 'yes', AVAILABLE),
            ({'support': 'supported', 'max_count': True}, 'unknown', UNKNOWN),
            ({'support': 'supported', 'max_count': 0.5}, 'unknown', UNKNOWN),
            ({'support': 'supported', 'min_count': 1.5}, 'unknown', UNKNOWN),
            ({'max_count': 0}, 'unknown', UNKNOWN)):
        entry = profile('image_to_video', inputs=('text', 'image'), outputs=('video',),
                        routes=[route_with_inputs('/v1/videos', {'first_frame': constraints})])
        result = resolve(body({'video_generation': operation(profiles=[entry])}))
        assert role_verdict(entry, 'video_generation', ('first_frame',)) == verdict, constraints
        assert result['capabilities']['video.first_frame'] == state, constraints
        if state == MISSING:
            assert result['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}, constraints
        if state == UNKNOWN:
            assert {'operation': 'video_generation', 'profile': 'image_to_video', 'route': None,
                    'reason': ROLE_NOT_DECLARED} in result['unresolved'], constraints


def test_each_unreadable_bound_class_is_pinned_on_its_own():
    """Seven rule classes, seventeen assertions: each class has its own killer.

    The count-window table above covers these shapes too, but a loop is one
    mutation away from letting every class pass at once — a lazy `int(value)`
    would clear the numeric-string rows, a bare `isinstance(value, int)` the
    float and bool ones, and dropping the inverted-window check the window rows.
    No reader is shared here: the scalar rules are pinned against `_count()`'s
    sentinel directly, the window rule against `_carries_one()`, the refusal rule
    against `_declared_support()`, and the two ends of the float rule on
    two declarations that share no route. Deleting one class cannot leave another
    assertion standing in for it.
    """
    sentinel = contract._UNREADABLE_COUNT

    # 1. A negative count is not a smaller window: it is not a count at all.
    assert contract._count(-1) is sentinel
    assert contract._carries_one({'min_count': None, 'max_count': -1}) is None

    # 2. A bool is not 0 or 1, whatever Python's arithmetic says.
    assert contract._count(True) is sentinel and contract._count(False) is sentinel

    # 3. A fractional count is not rounded into a window.
    assert contract._count(1.5) is sentinel

    # 4. A numeric string is not coerced into an int — on either side.
    assert contract._count('0') is sentinel and contract._count('2') is sentinel

    # 5. An inverted / equal window is not read as a zero-capacity refusal: the
    #    rule is "the one item fits", not "the bounds are ordered" (`>` would let
    #    every equal window through).
    assert contract._carries_one({'min_count': 2, 'max_count': 1}) is None
    assert contract._carries_one({'min_count': 1, 'max_count': 0}) is None
    assert contract._carries_one({'min_count': 2, 'max_count': 2}) is False
    assert contract._carries_one({'min_count': 0, 'max_count': 0}) is False

    # 6. An explicit refusal stands whatever its bound says: the bound is not
    #    what decided, so a broken one must not soften it into doubt. Read on
    #    `video_to_video` / `/v1/videos`, a profile class 7 never touches.
    assert contract._declared_support({'support': 'unsupported', 'max_count': -1}) == 'unsupported'
    refused = profile('video_to_video', inputs=('video',), outputs=('video',),
                      routes=[route_with_inputs('/v1/videos', {'source_video': {
                          'support': 'unsupported', 'max_count': -1}})])
    assert role_verdict(refused, 'video_generation',
                        ('source_video', 'video_noise_mask', 'audio_noise_mask')) == 'no'
    refused_report = resolve(body({'video_generation': operation(profiles=[refused])}))
    assert refused_report['capabilities']['video.edit'] == MISSING
    assert refused_report['reasons'] == {'video.edit': UNSUPPORTED_REASON}

    # 7. The other side of class 3: a whole-number float is read, not refused.
    #    Without this, "every float is unreadable" is only killed by the table.
    #    Read on `image_to_video` / `/v1/videos` — the same path but another
    #    profile, another role and another capability, so neither block can stand
    #    in for the other.
    assert contract._count(2.0) == 2
    granted = profile('image_to_video', inputs=('text', 'image'), outputs=('video',),
                      routes=[route_with_inputs('/v1/videos', {
                          'first_frame': {'support': 'supported', 'max_count': 2.0}})])
    assert role_verdict(granted, 'video_generation', ('first_frame',)) == 'yes'
    granted_report = resolve(body({'video_generation': operation(profiles=[granted])}))
    assert granted_report['capabilities']['video.first_frame'] == AVAILABLE
    assert granted_report['reasons'] == {} and granted_report['unresolved'] == []


def test_a_malformed_bound_keeps_a_sibling_refusal_from_hardening():
    """A window upstream rejects decides nothing, so a sibling refusal is not `missing`.

    `InputConstraint` refuses negative bounds and `min_count > max_count`, so a
    route carrying one is a declaration the publisher cannot emit. It may still
    serve; counting it as a refusal would turn another model's explicit refusal
    into a deployment-wide `missing`, which is the same over-reach an unreadable
    `exposure` is kept out of. The conservative answer is `unknown` with
    `role_not_declared`, and the genuinely empty windows (`max_count: 0`,
    `min_count: 2`) still refuse when every model carries one.

    The sibling is a model here, not a route: one operation has exactly one
    postable route (`POSTABLE_ROUTES`), so "another route may still serve" is no
    longer expressible — several models are.
    """
    malformed = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': {
            'support': 'supported', 'min_count': 2, 'max_count': 1}})])
    refusing = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})])
    assert role_verdict(malformed, 'video_generation', ('first_frame',)) == 'unknown'
    assert role_verdict(refusing, 'video_generation', ('first_frame',)) == 'no'
    result = resolve(body(models=[
        model({'video_generation': operation(profiles=[refusing])}, model_id='model-a'),
        model({'video_generation': operation(profiles=[malformed])}, model_id='model-b')]))
    assert result['capabilities']['video.first_frame'] == UNKNOWN
    assert result['reasons'] == {}
    assert {'operation': 'video_generation', 'profile': 'image_to_video', 'route': None,
            'reason': ROLE_NOT_DECLARED} in result['unresolved']

    # Both models genuinely cannot carry the one item: that is still a refusal.
    empty = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': {
                    'support': 'supported', 'max_count': 0}})])
    too_many = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': {
                    'support': 'supported', 'min_count': 2}})])
    assert role_verdict(empty, 'video_generation', ('first_frame',)) == 'no'
    assert role_verdict(too_many, 'video_generation', ('first_frame',)) == 'no'
    refused = resolve(body(models=[
        model({'video_generation': operation(profiles=[empty])}, model_id='model-a'),
        model({'video_generation': operation(profiles=[too_many])}, model_id='model-b')]))
    assert refused['capabilities']['video.first_frame'] == MISSING
    assert refused['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}

    # An unreadable bound beside a model that does grant the role is still a
    # grant: the unreadable declaration decides nothing, so it cannot veto the
    # other one — and the note it queued is dropped with the doubt it explained.
    # This is the `available` arm of the documented rule and the only test that
    # pins it.
    unusable = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': {
                    'support': 'supported', 'min_count': 1, 'max_count': 0}})])
    granting = profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'supported'})])
    assert role_verdict(unusable, 'video_generation', ('first_frame',)) == 'unknown'
    granted_report = resolve(body(models=[
        model({'video_generation': operation(profiles=[unusable])}, model_id='model-a'),
        model({'video_generation': operation(profiles=[granting])}, model_id='model-b')]))
    assert granted_report['capabilities']['video.first_frame'] == AVAILABLE
    assert granted_report['reasons'] == {}
    assert granted_report['unresolved'] == []

    # An unreadable window on one required role does not cancel a refusal of
    # another role on the same route: the route still cannot carry the set, and
    # the id is `missing` for the ordinary reason.
    both = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'source_video': {
                    'support': 'supported', 'max_count': -1},
                    'video_noise_mask': 'unsupported',
                    'audio_noise_mask': 'unsupported'})])])}))
    assert both['capabilities']['video.edit'] == MISSING
    assert both['reasons'] == {'video.edit': UNSUPPORTED_REASON}


def test_a_refusal_excludes_its_route_even_when_the_rest_is_silent():
    """One refused role is final on the route this tool posts, whatever else is silent.

    A request needs the whole set on the one postable route, so a route that
    refuses one role is out of the running whatever it leaves unmentioned.
    Requiring every role to be decided before answering `no` left this shape
    `unknown`, which claimed doubt that does not exist: the request cannot be
    carried. And a grant on `/v1/videos/sync` cannot soften it, because that is
    not a route this tool posts to.
    """
    partial = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'video_noise_mask': 'unsupported'})])])}))
    assert partial['capabilities']['video.edit'] == MISSING
    assert partial['reasons'] == {'video.edit': UNSUPPORTED_REASON}
    assert partial['unresolved'] == []

    # The same refusal, with the other roles granted on the route: still `no`,
    # because the request needs `video_noise_mask` too.
    granted_beside = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'source_video': 'supported',
                                                'audio_noise_mask': 'supported',
                                                'video_noise_mask': 'unsupported'})])])}))
    assert granted_beside['capabilities']['video.edit'] == MISSING
    assert granted_beside['reasons'] == {'video.edit': UNSUPPORTED_REASON}

    # A grant declared one path over cannot lift the refusal: `/v1/videos/sync`
    # is not evidence, so the postable route's refusal stands and the sync
    # declaration is only a note.
    sync_grant = resolve(body({'video_generation': operation(profiles=[profile(
        'video_to_video', inputs=('video',), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'video_noise_mask': 'unsupported'}),
                route_with_inputs('/v1/videos/sync', {'source_video': 'supported'})])])}))
    assert sync_grant['capabilities']['video.edit'] == MISSING
    assert sync_grant['reasons'] == {'video.edit': UNSUPPORTED_REASON}
    assert sync_grant['unresolved'] == [{'operation': 'video_generation', 'profile': 'video_to_video',
                                         'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]


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
    'partial complementary refusals': [route_with_inputs('/v1/videos', {'video_noise_mask': 'unsupported'}),
                                       route_with_inputs('/v1/videos/sync', {'source_video': 'unsupported'})],
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
# The state each declaration must reach, written out: a consistency-only check
# (gate == resolve) would move both sides together and green-light the revert it
# is named for.
ROLE_GATE_EXPECTED = {
    'complete route': AVAILABLE,
    'split across routes': UNKNOWN,
    'refused on its only route': MISSING,
    'two routes, complementary refusals': MISSING,
    'partial complementary refusals': MISSING,
    # The three cases below used to be `unknown`: a second route that said
    # nothing, said nothing about its exposure, or was a path this table could
    # not place used to keep a refusal from hardening. None of the three is a
    # route this tool posts to, so none of them is doubt — the one postable route
    # refused the set and that is the answer.
    'silent sibling': MISSING,
    'sibling without exposure': MISSING,
    'unplaceable route left on': MISSING,
    'malformed route reference': MISSING,
}


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
    gate, so this compares the role question only. Each side is checked against
    the expected state as well as against the other: a rule change that moves
    both sides together must not pass on self-consistency alone.
    """
    entry = profile('video_to_video', inputs=('video',), outputs=('video',), routes=ROLE_GATE_CASES[name])
    result = resolve(body({'video_generation': operation(profiles=[entry])}))
    verdict = role_verdict(entry, 'video_generation', required_roles_for('video.edit'))
    assert result['capabilities']['video.edit'] == ROLE_GATE_EXPECTED[name], name
    assert ROLE_GATE_STATES[verdict] == ROLE_GATE_EXPECTED[name], name


def test_role_verdict_and_resolve_agree_on_every_open_profile_body():
    """The gate's answer and `resolve()`'s capability state are one answer.

    A general assertion, not another expected-value table: for bodies whose
    profile row is not refused, `role_verdict()` and `resolve()` must land on the
    same state for the gated id — the gate is what `resolve()` asks, so a body
    that makes them disagree is a second rule hiding in one of them. The shapes
    below are the ones that could disagree: the socket that spells the postable
    path, the socket alone, the split declaration across sync and http, the
    complete one and a refused one. Being consistency-only, it cannot kill a
    change that moves both sides together;
    `test_only_the_postable_route_is_evidence` holds the written-out expectations
    that do, and the two are meant to be read as a pair.
    """
    edit_roles = {'source_video': 'supported', 'video_noise_mask': 'supported',
                  'audio_noise_mask': 'supported'}
    claiming_socket = {**route('/v1/videos', method='WEBSOCKET', transport='websocket'),
                       'request': route_with_inputs('/v1/videos', edit_roles)['request']}
    shapes = {
        'complete': [route_with_inputs('/v1/videos', edit_roles)],
        'socket claims the path': [route('/v1/videos'), claiming_socket],
        'socket alone': [socket_route(inputs=edit_roles)],
        'split across http and sync': [route_with_inputs('/v1/videos', {'source_video': 'supported'}),
                                       route_with_inputs('/v1/videos/sync',
                                                         {'video_noise_mask': 'supported',
                                                          'audio_noise_mask': 'supported'})],
        'refused': [route_with_inputs('/v1/videos', {'video_noise_mask': 'unsupported'})],
    }
    for name, routes in shapes.items():
        entry = profile('video_to_video', inputs=('video',), outputs=('video',), routes=routes)
        result = resolve(body({'video_generation': operation(profiles=[entry])}))
        verdict = role_verdict(entry, 'video_generation', required_roles_for('video.edit'))
        assert ROLE_GATE_STATES[verdict] == result['capabilities']['video.edit'], name


def test_a_role_string_is_one_role_and_an_undecided_role_stays_unknown():
    """The gate's boundary cases: a bare string, no requirement, no declaration, no operation."""
    assert role_verdict({}, 'video_generation', ('first_frame',)) == 'unknown'
    assert role_verdict({'routes': [route('/v1/videos')]}, 'video_generation', ()) == 'yes'
    assert role_verdict({'routes': [route_with_inputs('/v1/videos', {'first_frame': 'supported'})]},
                        'video_generation', 'first_frame') == 'yes'
    assert role_verdict({'routes': [route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})]},
                        'video_generation', 'first_frame') == 'no'
    assert role_verdict({'routes': [route_with_inputs('/v1/videos', {})]},
                        'video_generation', 'first_frame') == 'unknown'

    # The operation is normalized the way `capabilities_for()` normalizes its
    # arguments, so a padded or differently-cased name still finds its route; an
    # operation this gate cannot read answers `unknown` instead of quietly
    # matching nothing (which would read as "no postable route" and be a doubt
    # for the wrong reason).
    declared = {'routes': [route_with_inputs('/v1/videos', {'first_frame': 'supported'})]}
    assert role_verdict(declared, ' VIDEO_GENERATION ', 'first_frame') == 'yes'
    assert role_verdict(declared, None, 'first_frame') == 'unknown'
    assert role_verdict(declared, 7, 'first_frame') == 'unknown'
    assert role_verdict(declared, '  ', 'first_frame') == 'unknown'

    # A constraint that is not an object is neither authorisation nor refusal.
    bare_constraint = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[{**route('/v1/videos'), 'request': {'inputs': {'first_frame': 'supported'}}}])])}))
    assert bare_constraint['capabilities']['video.first_frame'] == UNKNOWN
    assert bare_constraint['reasons'] == {}
    assert {'operation': 'video_generation', 'profile': 'image_to_video', 'route': None,
            'reason': ROLE_NOT_DECLARED} in bare_constraint['unresolved']


def test_a_role_set_with_unreadable_members_keeps_only_its_strings():
    """`required` is filtered to `str` members instead of being handed to `.get()`.

    The elements come from a caller, not from the document, so a dict or a list
    inside the container is possible; passing one to `roles.get()` raises
    `TypeError` (unhashable key) and turns a lookup into a crash. A member that
    is not a role name is not a role: it is dropped, and a set left empty is
    `yes` — nothing is required of nobody, which is the answer the docstring
    already gives for an unreadable `required`.
    """
    declared = {'routes': [route_with_inputs('/v1/videos', {'first_frame': 'supported'})]}
    assert role_verdict(declared, 'video_generation', [{'first_frame': 'supported'}, ['x']]) == 'yes'
    assert role_verdict(declared, 'video_generation', ({'a': 1},)) == 'yes'
    assert role_verdict(declared, 'video_generation', ('first_frame', {'a': 1})) == 'yes'
    # A string member still counts: the filter drops the noise, not the question.
    assert role_verdict({'routes': [route_with_inputs('/v1/videos', {'first_frame': 'unsupported'})]},
                        'video_generation', ('first_frame', ['x'])) == 'no'


def test_a_role_key_is_stripped_before_it_is_matched():
    """A padded role name is the same role: `{' first_frame ': …}` grants the id.

    `_role_support()` normalizes the key with `str(role).strip()` before it is
    matched against `REQUIRED_ROLES`, so a document that publishes the name with
    surrounding whitespace is read, not silently missed. The whole report has to
    be identical to the unpadded declaration's — a normalization that only fed
    one of the two readers would move one number and not the other.
    """
    padded = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[{**route('/v1/videos'), 'request': {'inputs': {' first_frame ': {'support': 'supported'}}}}])])}))
    exact = resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'supported'})])])}))
    assert padded['capabilities']['video.first_frame'] == AVAILABLE
    assert padded == exact


def test_an_undecided_postable_route_keeps_the_role_answer_unknown():
    """A postable route whose `exposure` is unreadable is doubt, not a grant or a refusal.

    Three shapes, three different parts of the rule. ① One open postable route
    refuses `source_video` while a second postable reference carries no
    `exposure`: the open route has decided against the request, the silent one
    may still serve, so the role answer is `unknown` and never `missing` — a gate
    that dropped the undecided route would answer `no`. That reference is also a
    channel, so the report names it: the profile's own verdict is `yes` and the
    row is only undecided at the role gate, which is why `exposure_unknown` sits
    beside `role_not_declared`. ② Both postable references are undecided, so
    there is no open route to read a role from: the profile's own verdict is
    `unknown` before the gate runs, the gate is never consulted, and the report
    is the channel alone — `exposure_unknown`, no `role_not_declared`. ③ A
    `disabled` duplicate of the same postable route is a closed channel, not a
    doubt: the open route's refusal is the whole answer (`no`, `missing`) and
    nothing is reported, because a gate that read every non-`enabled` reference
    as undecided would turn that refusal into "may still serve". A refused
    profile gets no channel note in any of these shapes.
    """
    # ① An open route refuses, a second postable reference says nothing about its
    # `exposure`.
    undecided = route_with_inputs('/v1/videos', {'source_video': 'unsupported'})
    del undecided['exposure']
    one_open = profile('video_to_video', inputs=('video',), outputs=('video',),
                       routes=[route_with_inputs('/v1/videos', {'source_video': 'unsupported'}), undecided])
    verdict = role_verdict(one_open, 'video_generation', required_roles_for('video.edit'))
    assert verdict == 'unknown'
    result = resolve(body({'video_generation': operation(profiles=[one_open])}))
    assert result['capabilities']['video.edit'] == UNKNOWN
    assert result['reasons'] == {}
    assert ROLE_GATE_STATES[verdict] == result['capabilities']['video.edit']
    # The channel that keeps the role question open is reported beside the role
    # note: `role_not_declared` alone would leave the doubt unattributed.
    assert result['unresolved'] == [
        {'operation': 'video_generation', 'profile': 'video_to_video',
         'route': None, 'reason': ROLE_NOT_DECLARED},
        {'operation': 'video_generation', 'profile': 'video_to_video',
         'route': '/v1/videos', 'reason': EXPOSURE_UNKNOWN}]

    # ② Both postable references undecided: no open route to read a role from.
    other_undecided = route_with_inputs('/v1/videos', {'source_video': 'unsupported'})
    del other_undecided['exposure']
    no_open = profile('video_to_video', inputs=('video',), outputs=('video',),
                      routes=[undecided, other_undecided])
    verdict = role_verdict(no_open, 'video_generation', required_roles_for('video.edit'))
    assert verdict == 'unknown'
    result = resolve(body({'video_generation': operation(profiles=[no_open])}))
    assert result['capabilities']['video.edit'] == UNKNOWN
    assert result['reasons'] == {}
    assert ROLE_GATE_STATES[verdict] == result['capabilities']['video.edit']
    assert result['unresolved'] == [{'operation': 'video_generation', 'profile': 'video_to_video',
                                     'route': '/v1/videos', 'reason': EXPOSURE_UNKNOWN}]

    # ③ A `disabled` duplicate beside the open refusal is a closed channel, not a
    # doubt: the classification `_role_routes()` makes decides this case. Reading
    # every non-`enabled` reference as undecided would answer `unknown` here,
    # which is the "may still serve" reading this shape has to refuse.
    closed_duplicate = {**route_with_inputs('/v1/videos', {'audio_noise_mask': 'supported'}),
                        'exposure': 'disabled'}
    refused = profile('video_to_video', inputs=('video',), outputs=('video',), routes=[
        route_with_inputs('/v1/videos', {'source_video': 'unsupported'}), closed_duplicate])
    verdict = role_verdict(refused, 'video_generation', required_roles_for('video.edit'))
    assert verdict == 'no'
    result = resolve(body({'video_generation': operation(profiles=[refused])}))
    assert result['capabilities']['video.edit'] == MISSING
    assert result['reasons'] == {'video.edit': UNSUPPORTED_REASON}
    assert result['unresolved'] == []

    # A refused profile is not handed a channel note either, even with an
    # undecided reference beside it: its own enum is the explanation.
    refused_profile = profile('video_to_video', support='unsupported', inputs=('video',), outputs=('video',),
                              routes=[route('/v1/videos'), undecided])
    result = resolve(body({'video_generation': operation(profiles=[refused_profile])}))
    assert result['capabilities']['video.edit'] == MISSING
    assert result['reasons'] == {'video.edit': UNSUPPORTED_REASON}
    assert result['unresolved'] == []


def test_a_doubtful_routes_roles_are_not_evidence():
    """A reference whose `exposure` cannot be read decides nothing, in either direction.

    Three shapes that only appear when the same postable path is declared more
    than once, or when two refusal reasons compete:

    ① An undecided reference that names the required role cannot lend it. The
    open reference beside it names nothing, so the role question is `unknown`,
    never `available` — reading roles out of a reference this table cannot place
    is the false grant the module exists to prevent.
    ② One open reference refuses the role and a second open reference is silent:
    the refusal is not the whole answer, because a silent open route may still
    serve. `every` and `any` differ here, and `unknown` is the answer.
    ③ A refusal keeps the reason that produced it: the profile's own
    `unsupported` outranks the operation's `endpoint_disabled`, so a reader is
    pointed at the profile rather than at the endpoint.
    """
    # ① Roles on an undecided reference are not evidence.
    undecided_with_role = route_with_inputs('/v1/videos', {'first_frame': 'supported'})
    del undecided_with_role['exposure']
    doubtful = profile('image_to_video', inputs=('text', 'image'), outputs=('video',),
                       routes=[route_with_inputs('/v1/videos', {}), undecided_with_role])
    verdict = role_verdict(doubtful, 'video_generation', required_roles_for('video.first_frame'))
    assert verdict == 'unknown'
    result = resolve(body({'video_generation': operation(profiles=[doubtful])}))
    assert result['capabilities']['video.first_frame'] == UNKNOWN
    assert ROLE_GATE_STATES[verdict] == result['capabilities']['video.first_frame']
    assert {'operation': 'video_generation', 'profile': 'image_to_video',
            'route': '/v1/videos', 'reason': EXPOSURE_UNKNOWN} in result['unresolved']

    # ② One open refusal beside a silent open route is a doubt, not a refusal.
    silent_sibling = profile('video_to_video', inputs=('video',), outputs=('video',), routes=[
        route_with_inputs('/v1/videos', {'source_video': 'unsupported'}),
        route_with_inputs('/v1/videos', {})])
    verdict = role_verdict(silent_sibling, 'video_generation', required_roles_for('video.edit'))
    assert verdict == 'unknown'
    result = resolve(body({'video_generation': operation(profiles=[silent_sibling])}))
    assert result['capabilities']['video.edit'] == UNKNOWN
    assert result['reasons'] == {}
    assert ROLE_GATE_STATES[verdict] == result['capabilities']['video.edit']

    # ③ The refusal reason is the profile's, not the endpoint's.
    closed_endpoint = resolve(body({'image_generation': operation(
        exposure='disabled', profiles=[profile('text_to_image', routes=[route('/v1/images/generations')])])}))
    assert closed_endpoint['capabilities']['image.generate'] == MISSING
    assert closed_endpoint['reasons'] == {'image.generate': ENDPOINT_DISABLED_REASON}
    refused_profile = resolve(body({'image_generation': operation(
        exposure='disabled',
        profiles=[profile('text_to_image', support='unsupported',
                          routes=[route('/v1/images/generations')])])}))
    assert refused_profile['capabilities']['image.generate'] == MISSING
    assert refused_profile['reasons'] == {'image.generate': UNSUPPORTED_REASON}


def test_a_profile_row_grants_at_most_one_role_gated_id():
    """A role-gated row grants nothing else, so a refusal cannot reach a free id."""
    for operation, profile_id, capabilities in OPERATION_PROFILES:
        gated = [capability for capability in capabilities if required_roles_for(capability)]
        assert not gated or tuple(gated) == tuple(capabilities), (operation, profile_id, capabilities)


def test_every_profile_row_carries_at_most_one_id():
    """The flush guard's `any()` is about a row that *could* carry several ids.

    `resolve()` decides whether a deferred note still explains a doubt by asking
    whether any id of the row is `unknown`, not by reading the row's first id.
    That is only equivalent to the first-id test while every row carries at most
    one id, so the premise is pinned here, right beside the role-gated row
    invariant it shares a reason with: a second id on a row has to be a decision
    somebody makes, not a silent change to what the guard means.
    """
    assert all(len(capabilities) <= 1 for _, _, capabilities in OPERATION_PROFILES)


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


def test_a_body_from_another_contract_is_unreadable_instead_of_v1():
    """`object` and `schema_version` are a version gate, not decoration.

    Reading `models` out of a body that names another version is how a v2
    declaration grants v1 ids nobody reviewed. The whole body is refused once,
    with no capability read out of it — and a body that states no envelope at all
    stays the defensive no-body case instead of being reclassified.
    """
    granting = body({'chat': operation(profiles=[profile('text_response', paths=table_paths('chat'))])})
    assert resolve(granting)['capabilities']['text.chat'] == AVAILABLE

    for mutation in ({'object': 'omni.capabilities.v2'}, {'object': None}, {'object': 2},
                     {'schema_version': 2}, {'schema_version': '1'}, {'schema_version': True},
                     {'schema_version': 1.0}, {'schema_version': None}):
        result = resolve({**granting, **mutation})
        assert result['endpoint'] == UNREADABLE, mutation
        assert set(result['capabilities'].values()) == {UNKNOWN}, mutation
        assert result['reasons'] == {}, mutation
        assert result['unresolved'] == [{'operation': None, 'profile': None, 'route': None,
                                         'reason': UNSUPPORTED_FORMAT}], mutation
        # A body this table does not read hands back no topology either: `stages`
        # of a foreign contract are the same unreviewed shape as its `models`.
        assert result['topology'] == [], mutation

    # The gate runs before `absent`/`empty`: a foreign envelope is `unreadable`
    # even when it carries no models at all.
    assert resolve({'models': [], 'schema_version': 2})['endpoint'] == UNREADABLE
    assert resolve({'stages': [], 'object': 'omni.capabilities.v2'})['endpoint'] == UNREADABLE

    # A body that names no envelope is read as v1, and that is a decision, not an
    # accident: upstream always emits both keys, so an envelope that is missing
    # (rather than different) cannot be told from a v1 body a proxy stripped, and
    # refusing it would reclassify the defensive `absent`/`empty` shapes below.
    envelope_less = {key: value for key, value in granting.items() if key not in ('object', 'schema_version')}
    assert resolve(envelope_less)['capabilities']['text.chat'] == AVAILABLE
    assert resolve(envelope_less)['endpoint'] == PRESENT

    # The other reader applies the same gate: `declarations()` must not hand out
    # pairs from a body `resolve()` refuses, or the two disagree about one body.
    assert declarations({**granting, 'schema_version': 2}) is None
    assert declarations(granting) == [('chat', 'text_response')]

    # No envelope and nothing to declare: still `absent`/`empty`, a different
    # answer from a refused contract.
    assert resolve({'models': []})['endpoint'] == EMPTY
    assert resolve({})['endpoint'] == ABSENT
    assert resolve({'models': []})['unresolved'] == []


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


@pytest.mark.parametrize('value', [None, 'not-a-body', [], 3, 0, True, {}],
                         ids=['null', 'string', 'list', 'int', 'zero', 'bool', 'empty-object'])
def test_an_operation_value_that_is_not_a_body_records_unknown(value):
    """Defensive: `{"chat": null}` answers nothing about chat, so its rows stay unknown.

    The doubt is attributed rather than left blank: the operation value is not a
    body at all, which is `malformed_operation`, reported once for that operation
    with no profile and no route. The shapes are parameterized because they are
    six non-object values and one empty object, i.e. the two halves of the guard:
    `None`, a string, a list, an int, `0` and `True` are the values that are not
    an object at all, and `{}` is an object with nothing to read. `[]` doubles as
    the mutation detector — a guard narrowed to "None or a string" lets it through
    to the `.get('profiles')` call below and raises `AttributeError`, so this test
    fails instead of quietly changing what the report says.
    """
    payload = body({'chat': value})
    result = resolve(payload)  # ① no shape may raise
    assert result['endpoint'] == PRESENT, payload
    assert set(result['capabilities'].values()) == {UNKNOWN}
    assert result['reasons'] == {}, payload
    assert result['unresolved'] == [{'operation': 'chat', 'profile': None, 'route': None,
                                     'reason': MALFORMED_OPERATION}], payload


def test_a_broken_operation_value_is_one_declaration_error_across_models():
    """Two models repeating the same broken operation are one declaration error."""
    repeated = resolve(body(models=[model({'chat': None}, model_id='model-a'),
                                   model({'chat': None}, model_id='model-b')]))
    assert repeated['unresolved'] == [{'operation': 'chat', 'profile': None, 'route': None,
                                       'reason': MALFORMED_OPERATION}]


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


def test_a_path_this_table_cannot_place_is_a_note_not_a_channel():
    """Every postable route off, plus a path this table cannot place.

    Upstream adds routes over time and this table can lag behind, so the path is
    reported as `unknown_route` rather than dropped. It is still not a channel
    this tool posts to: its own `exposure` cannot turn the closed postable route
    into doubt, so the answer is the refusal the declaration states.
    """
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='disabled'),
                                         route('/v1/images/generations/stream')])])}))
    assert result['capabilities']['image.generate'] == MISSING
    assert result['reasons'] == {'image.generate': 'route_disabled'}
    assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                     'route': '/v1/images/generations/stream', 'reason': UNKNOWN_ROUTE}]
    # Declared `disabled` or `enabled`, the note is the same note and the verdict
    # the same verdict: the exposure of a path this tool never posts to is not a
    # fact about the request.
    still_missing = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='disabled'),
                                         route('/v1/images/generations/stream', exposure='disabled')])])}))
    assert still_missing == result


@pytest.mark.parametrize('exposure', ['enabled', 'unknown', None, 'disabled'])
def test_unrecognised_route_outcome_depends_on_its_exposure(exposure):
    """A path this table cannot place is a note, whatever its `exposure` says.

    Upstream sets a route's `exposure` to `unknown` when the route is registered
    but its reachability is not settled (`serving_capabilities.py:267,304`), so
    "every postable route `disabled`, plus an unrecognised route whose `exposure`
    is `unknown`" is a body upstream really publishes, and so is the same body
    with the field absent (upstream's default). None of the four spellings is a
    channel this tool posts to, so all four read the same: the closed postable
    route is the answer, and the path is reported once.
    """
    declared = route('/v1/images/generations/stream')
    if exposure is None:
        del declared['exposure']
    else:
        declared['exposure'] = exposure
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='disabled'), declared])])}))
    assert result['capabilities']['image.generate'] == 'missing'
    assert result['reasons'] == {'image.generate': 'route_disabled'}
    assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                     'route': '/v1/images/generations/stream', 'reason': 'unknown_route'}]


def test_a_profile_whose_routes_are_all_unknown_cannot_be_confirmed():
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='unknown')])])}))
    assert result['capabilities']['image.generate'] == UNKNOWN
    assert result['reasons'] == {}
    # The `unknown` is a channel this table cannot judge, not an empty report:
    # exactly one entry says so, and it names the route.
    assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                     'route': '/v1/images/generations',
                                     'reason': EXPOSURE_UNKNOWN}]


@pytest.mark.parametrize('exposure', [None, 'unknown'])
def test_a_default_or_explicit_unknown_exposure_is_the_same_unreadable_state(exposure):
    """`exposure: unknown` is the upstream default; an absent field is that same state.

    Upstream types the field `exposure: Exposure = "unknown"`, so `unknown` is a
    value it publishes and an omitted one reads as the same thing — not as a
    schema error, and not as a refusal. Either way the route may still serve, so
    the row is `unknown` and the note names the channel. The report's exact shape
    is pinned once, in
    `test_exposure_unknown_is_only_reported_when_it_explains_an_unknown`; this
    test pins only that the two spellings are one state, and the closed reason set.
    """
    declared = {'transport': 'http', 'method': 'POST', 'path': '/v1/images/generations'}
    if exposure is not None:
        declared['exposure'] = exposure
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='disabled'), declared])])}))
    assert result['capabilities']['image.generate'] == UNKNOWN
    assert result['reasons'] == {}
    assert [entry['reason'] for entry in result['unresolved']] == [EXPOSURE_UNKNOWN], exposure


@pytest.mark.parametrize('spelling', [' enabled', 'ENABLED', 'Enabled '])
def test_an_exposure_is_normalized_before_the_closed_set_is_applied(spelling):
    """`exposure` is matched in the same closed set as `transport` and `method`.

    A proxy or a hand-built body may pad or upper-case the enum the way it may
    pad `transport`; upstream's field is `Literal["enabled", "disabled",
    "unknown"]`, so `' enabled'` is that value, not a fourth state. Normalizing
    first is what makes the route a grant — a reader that only fed the mismatch
    report would leave the row `unknown` with a note about a field that was
    readable all along.
    """
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure=spelling)])])}))
    assert result['capabilities']['image.generate'] == AVAILABLE, spelling
    assert result['reasons'] == {}, spelling
    assert result['unresolved'] == [], spelling


@pytest.mark.parametrize('exposure', ['Bogus ', 0, True, False, [], 1.0, {}])
def test_an_exposure_outside_the_closed_set_is_unknown_not_a_fourth_state(exposure):
    """Anything outside the closed set is not a fourth exposure: the fold, with a note.

    The other side of the same closed set: after stripping and lower-casing the
    value has to be `enabled`, `disabled` or `unknown`, and anything else is
    `ROUTE_UNKNOWN` — a postable channel this table cannot confirm, reported as
    `exposure_unknown` rather than read as either a grant or a refusal. The
    non-string spellings matter as much as the misspelled ones: upstream types
    the field as a closed `Literal`, so `0`, `True`, `False`, `[]`, `1.0` and
    `{}` are shapes no published body carries, and a reader that let any of them
    through would be reading an unreadable field as a grant. Same shape as the
    non-string `transport` cases, which are pinned the same way.
    """
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure=exposure)])])}))
    assert result['capabilities']['image.generate'] == UNKNOWN, exposure
    assert result['reasons'] == {}, exposure
    assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                     'route': '/v1/images/generations',
                                     'reason': EXPOSURE_UNKNOWN}], exposure


def test_every_level_normalizes_its_enums_the_way_the_route_does():
    """One vocabulary, one reader: profile and operation spellings match the route's.

    `support` and `exposure` are published at three levels, and a padded or
    upper-cased spelling has to mean the same thing at each of them. Before the
    readers were shared, only the route level stripped and lower-cased: a route
    saying `' enabled'` was a grant while an operation saying `' enabled'` fell
    through to `unknown`, which made the same declaration mean two things one
    nesting level apart.
    """
    spelled = resolve(body({'image_generation': operation(
        exposure=' enabled', profiles=[profile('text_to_image', support=' Supported',
                                               routes=[route('/v1/images/generations')])])}))
    assert spelled['capabilities']['image.generate'] == AVAILABLE
    assert spelled['reasons'] == {}
    assert spelled['unresolved'] == []

    # The same at the other end of the enum: an operation's `'Disabled'` closes
    # the row exactly like a route's, and says so with the operation's reason.
    closed = resolve(body({'image_generation': operation(
        exposure='Disabled', profiles=[profile('text_to_image', routes=[route('/v1/images/generations')])])}))
    assert closed['capabilities']['image.generate'] == MISSING
    assert closed['reasons'] == {'image.generate': 'endpoint_disabled'}

    # A profile refusing in a padded spelling refuses; it does not read as silent.
    refused = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', support=' Unsupported ', routes=[route('/v1/images/generations')])])}))
    assert refused['capabilities']['image.generate'] == MISSING
    assert refused['reasons'] == {'image.generate': UNSUPPORTED_REASON}

    # The operation level on its own: a padded `support` is still a grant, so the
    # row is reachable — a verbatim closed-set comparison here would make it
    # `unknown`.
    operation_grant = resolve(body({'image_generation': operation(
        support=' Supported ', profiles=[profile('text_to_image', routes=[route('/v1/images/generations')])])}))
    assert operation_grant['capabilities']['image.generate'] == AVAILABLE
    assert operation_grant['reasons'] == {}
    assert operation_grant['unresolved'] == []

    # ... and a padded `exposure` at the operation level is still the refusal,
    # with the operation's own reason rather than a fall-through to `unknown`.
    operation_closed = resolve(body({'image_generation': operation(
        exposure=' Disabled ', profiles=[profile('text_to_image', routes=[route('/v1/images/generations')])])}))
    assert operation_closed['capabilities']['image.generate'] == MISSING
    assert operation_closed['reasons'] == {'image.generate': 'endpoint_disabled'}

    # The route level on its own: a padded refusal on the route that would carry
    # the role still refuses, so the row is `missing`/`unsupported` rather than
    # falling through to the `unknown` an unread spelling would leave.
    route_refused = resolve(body({'video_generation': operation(profiles=[
        profile('image_to_video', inputs=('text', 'image'), outputs=('video',),
                routes=[route_with_inputs('/v1/videos', {'first_frame': ' Unsupported '})])])}))
    assert route_refused['capabilities']['video.first_frame'] == MISSING
    assert route_refused['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}
    assert route_refused['unresolved'] == []


def test_the_same_unreadable_route_declared_twice_is_reported_once():
    """`exposure_unknown` is one entry per distinct (profile, route), not per reference.

    Upstream hands every profile of an operation the operation's full route list,
    so a body repeating one reference is a shape a defensive fixture can carry.
    The note is deduplicated on `(operation, profile, route, reason)`, so the
    duplicate collapses instead of stacking: the report says which channel is
    unconfirmed, and saying it twice would add nothing.
    """
    twice = {'transport': 'http', 'method': 'POST', 'path': '/v1/images/generations'}
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[dict(twice), dict(twice)])])}))
    assert result['capabilities']['image.generate'] == UNKNOWN
    assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                     'route': '/v1/images/generations',
                                     'reason': EXPOSURE_UNKNOWN}]


def test_exposure_unknown_is_only_reported_when_it_explains_an_unknown():
    """The note names an open channel, so it belongs only beside a row left `unknown`.

    A profile that refuses, or an operation that is closed, has already said why
    it answers `no`: hanging `exposure_unknown` beside that verdict would read as
    a doubt the verdict does not have. An `available` row needs no note either —
    nothing about it is open.
    """
    # A refused profile: `support=unsupported` decides, whatever its routes say.
    refused = profile('text_to_image', support='unsupported',
                      routes=[{'transport': 'http', 'method': 'POST', 'path': '/v1/images/generations'}])
    refused_report = resolve(body({'image_generation': operation(profiles=[refused])}))
    assert refused_report['capabilities']['image.generate'] == MISSING
    assert refused_report['reasons'] == {'image.generate': UNSUPPORTED_REASON}
    assert [entry for entry in refused_report['unresolved']
            if entry['reason'] == EXPOSURE_UNKNOWN] == []

    # A closed operation: `endpoint_disabled` decides.
    closed = resolve(body({'image_generation': operation(exposure='disabled', profiles=[profile(
        'text_to_image', routes=[{'transport': 'http', 'method': 'POST',
                                  'path': '/v1/images/generations'}])])}))
    assert closed['capabilities']['image.generate'] == MISSING
    assert closed['reasons'] == {'image.generate': 'endpoint_disabled'}
    assert [entry for entry in closed['unresolved'] if entry['reason'] == EXPOSURE_UNKNOWN] == []

    # An `unknown` row is exactly where the note belongs: one route, one note.
    # The route's `exposure` is absent here, which is as unreadable as an
    # explicit value this table does not know.
    unknown = resolve(body({'image_generation': operation(profiles=[profile(
        'text_to_image', routes=[{'transport': 'http', 'method': 'POST',
                                  'path': '/v1/images/generations'}])])}))
    assert unknown['capabilities']['image.generate'] == UNKNOWN
    assert unknown['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                      'route': '/v1/images/generations', 'reason': EXPOSURE_UNKNOWN}]

    # An available row is answered: the open sibling route is not a doubt.
    available = resolve(body({'image_generation': operation(profiles=[profile(
        'text_to_image', routes=[route('/v1/images/generations'),
                                 {'transport': 'http', 'method': 'POST',
                                  'path': '/v1/images/generations'}])])}))
    assert available['capabilities']['image.generate'] == AVAILABLE
    assert available['unresolved'] == []


def test_exposure_unknown_is_not_attributed_to_a_profile_that_says_unknown():
    """A route note explains a profile's `unknown`, not the document's own `unknown`.

    `support=unknown` at profile level is already the answer, so hanging
    `exposure_unknown` on it would attribute a doubt to a channel when the profile
    is what declined to answer. The same unreadable route under a `supported`
    profile is the case the note exists for.
    """
    unreadable = {'transport': 'http', 'method': 'POST', 'path': '/v1/images/generations'}

    silent = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', support='unknown', routes=[dict(unreadable)])])}))
    assert silent['capabilities']['image.generate'] == UNKNOWN
    assert silent['reasons'] == {}
    assert [entry['reason'] for entry in silent['unresolved']] == []

    declared = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[dict(unreadable)])])}))
    assert declared['capabilities']['image.generate'] == UNKNOWN
    assert declared['reasons'] == {}
    assert [entry['reason'] for entry in declared['unresolved']] == [EXPOSURE_UNKNOWN]

    # A profile that only names a socket gets no verdict note either: the socket
    # is not a request this tool sends, so there is nothing to be undecided
    # about, and `no_route_declared` is reserved for a profile that says
    # `supported`. The socket declaration itself is still a shape note: it is a
    # wrong route, whatever the profile's `support` says.
    socket_only = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', support='unknown',
                routes=[route('/v1/realtime/video', method='WEBSOCKET', transport='websocket')])])}))
    assert socket_only['capabilities']['image.generate'] == UNKNOWN
    assert [entry['reason'] for entry in socket_only['unresolved']] == [ROUTE_MISMATCH]


def test_one_enabled_route_is_enough_when_another_is_disabled():
    """The postable route decides; another declaration being off changes nothing."""
    result = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/videos'), route('/v1/videos/sync', exposure='disabled')])])}))
    assert result['capabilities']['video.generate'] == AVAILABLE
    assert result['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                     'route': '/v1/videos/sync', 'reason': ROUTE_MISMATCH}]


def test_a_profile_that_declares_no_route_is_unknown():
    """`routes` is `default_factory=list` upstream: `[]` is a legal shape, not a refusal."""
    entry = profile('text_to_speech', paths=[])
    assert entry['routes'] == []
    result = resolve(body({'speech': operation(profiles=[entry])}))
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert result['unresolved'] == [{'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
                                     'reason': NO_ROUTE_DECLARED}]


def test_no_route_declared_is_not_blamed_on_a_profile_that_says_unknown():
    """A profile publishing `support=unknown` is not attributed a second reason.

    The document itself says it does not know, so `no_route_declared` — which
    claims a *supported* profile declared nothing usable — would contradict the
    declaration it is read from. Silence is only a report when the profile said
    yes and its routes said nothing.
    """
    silent = profile('text_to_speech', support='unknown', paths=[])
    result = resolve(body({'speech': operation(profiles=[silent])}))
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert result['reasons'] == {}
    assert result['unresolved'] == []

    # The same declaration saying `supported` is exactly one note.
    supported = resolve(body({'speech': operation(profiles=[profile('text_to_speech', paths=[])])}))
    assert supported['capabilities']['audio.speech'] == UNKNOWN
    assert supported['unresolved'] == [{'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
                                        'reason': NO_ROUTE_DECLARED}]

    # The operation's own `unknown` is the same rule, one level up: a profile that
    # declared no route is not blamed while the operation itself has not said yes.
    undecided_operation = resolve(body({'speech': operation(exposure='unknown', profiles=[
        profile('text_to_speech', paths=[])])}))
    assert undecided_operation['capabilities']['audio.speech'] == UNKNOWN
    assert undecided_operation['unresolved'] == []


def test_a_pair_with_no_capability_id_gets_no_verdict_note():
    """A verdict note explains an undecided id; a pair that grants none has none.

    `no_route_declared`, `role_not_declared` and `exposure_unknown` are all
    queued while a profile is read and flushed only if the pair it belongs to
    still has an `unknown` capability in the aggregated answer. A pair with no
    capability id at all (`image_response`, `audio_response`, `caption_to_audio`,
    `text_to_audio`) can never be undecided — it grants nothing — so the note is
    dropped instead of describing a doubt no capability has. The same shape on a
    pair that does carry an id keeps its note, which is what makes this a rule
    about the pair and not about the reason.
    """
    for operation_id, profile_id in (('chat', 'image_response'), ('chat', 'audio_response'),
                                     ('speech', 'caption_to_audio'), ('audio_generation', 'text_to_audio')):
        assert BY_PAIR[(operation_id, profile_id)] == (), (operation_id, profile_id)
        silent_pair = resolve(body({operation_id: operation(profiles=[profile(profile_id, paths=[])])}))
        assert silent_pair['unresolved'] == [], (operation_id, profile_id)

    # The control: an id-carrying pair with the same declaration is reported.
    carrying = resolve(body({'speech': operation(profiles=[profile('text_to_speech', paths=[])])}))
    assert carrying['unresolved'] == [{'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
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


def test_two_broken_references_to_two_paths_are_two_notes():
    """A `malformed_route` note names its path, so two bad references stay distinct.

    Both entries here are unplaceable — one has no `method`, the other a
    `transport` outside the literal — but they name different paths. With a
    `None` route on both, `_note()` would deduplicate them into a single entry,
    and neither path could be attributed. The path is readable in both, so both
    are named, and the only `None` left belongs to `no_route_declared`, which is
    about the profile rather than about one reference.
    """
    entry = profile('text_to_speech', routes=[
        {'path': '/v1/audio/speech'},
        {'transport': 'http/2', 'method': 'POST', 'path': '/v1/audio/voices'}])
    result = resolve(body({'speech': operation(profiles=[entry])}))
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert result['unresolved'] == [
        {'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
         'reason': NO_ROUTE_DECLARED},
        {'operation': 'speech', 'profile': 'text_to_speech', 'route': '/v1/audio/speech',
         'reason': MALFORMED_ROUTE},
        {'operation': 'speech', 'profile': 'text_to_speech', 'route': '/v1/audio/voices',
         'reason': MALFORMED_ROUTE}]


def test_a_route_entry_without_a_usable_method_is_malformed_not_a_mismatch():
    """An absent method says "unconfirmed", not "another operation's route".

    `method` has no default upstream (`transport` does), so an entry that omits it
    — or spells it blank, or is a bare path string — cannot be placed. Reporting
    that as `route_mismatch` would claim the declaration belongs to another
    operation, which the body never said; `malformed_route` is the honest name,
    and the entry is still not a channel.
    """
    unconfirmed = [{'path': '/v1/audio/speech', 'exposure': 'enabled'},
                   {'path': '/v1/audio/speech', 'method': '   ', 'exposure': 'enabled'},
                   '/v1/audio/speech']
    for reference in unconfirmed:
        result = resolve(body({'speech': operation(profiles=[
            profile('text_to_speech', routes=[reference])])}))
        assert result['capabilities']['audio.speech'] == UNKNOWN, reference
        assert result['unresolved'] == [
            {'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
             'reason': NO_ROUTE_DECLARED},
            {'operation': 'speech', 'profile': 'text_to_speech', 'route': '/v1/audio/speech',
             'reason': MALFORMED_ROUTE}], reference

    # A method that *is* stated and wrong stays a mismatch: the declaration is
    # readable, it just names a request this tool never sends.
    stated = resolve(body({'speech': operation(profiles=[
        profile('text_to_speech', routes=[route('/v1/audio/speech', method='DELETE')])])}))
    assert {'operation': 'speech', 'profile': 'text_to_speech', 'route': '/v1/audio/speech',
            'reason': ROUTE_MISMATCH} in stated['unresolved']


def test_a_routes_field_that_is_not_a_list_is_reported_once_per_profile():
    """`routes` is `list[CapabilityRouteReference]` upstream, so a dict/str/null is broken.

    The mirror of `malformed_profile` for `profiles`: dropped in silence the field
    would leave the row `unknown` with an empty report. Reported once per profile,
    with no route — there is no entry to name — and the row is then judged like a
    profile that declared nothing. `routes: []` stays silent: a published empty
    list is an answer.
    """
    for broken in ({'path': '/v1/audio/speech'}, '/v1/audio/speech', None, 7):
        entry = profile('text_to_speech')
        entry['routes'] = broken
        result = resolve(body({'speech': operation(profiles=[entry])}))
        assert result['capabilities']['audio.speech'] == UNKNOWN, broken
        assert result['reasons'] == {}, broken
        assert result['unresolved'] == [
            {'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
             'reason': MALFORMED_ROUTE},
            {'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
             'reason': NO_ROUTE_DECLARED}], broken

    # Once per profile, not once per body.
    two = resolve(body({'speech': operation(profiles=[
        {**profile('text_to_speech'), 'routes': None},
        {**profile('lyrics_to_music'), 'routes': {'path': '/v1/audio/speech'}}])}))
    assert [entry for entry in two['unresolved'] if entry['reason'] == MALFORMED_ROUTE] == [
        {'operation': 'speech', 'profile': 'lyrics_to_music', 'route': None, 'reason': MALFORMED_ROUTE},
        {'operation': 'speech', 'profile': 'text_to_speech', 'route': None, 'reason': MALFORMED_ROUTE}]

    empty = resolve(body({'speech': operation(profiles=[profile('text_to_speech', routes=[])])}))
    assert empty['unresolved'] == [{'operation': 'speech', 'profile': 'text_to_speech', 'route': None,
                                    'reason': NO_ROUTE_DECLARED}]
    # The role gate reads the same field and must not raise on the broken shape.
    gated = profile('video_to_video')
    gated['routes'] = 'nonsense'
    assert role_verdict(gated, 'video_generation', ('source_video',)) == 'unknown'


@pytest.mark.parametrize('element', [
    pytest.param({'support': 'supported', 'routes': []}, id='no-id'),
    pytest.param(['text_to_speech'], id='not-an-object'),
    pytest.param({'id': '   ', 'support': 'supported', 'routes': []}, id='blank-id'),
])
def test_a_profile_element_without_a_readable_id_is_reported(element):
    """A `profiles[]` element this table cannot name is reported, not dropped.

    Upstream names every profile it publishes, so an element with no readable
    `id` — a missing one, a blank one, or something that is not an object at all —
    is a declaration somebody broke. Dropped in silence it left `audio.speech`
    `unknown` beside an empty `reasons` and `unresolved`: the "the table had
    nothing to say" report this module exists to prevent.
    """
    result = resolve(body({'speech': operation(profiles=[element])}))
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert result['reasons'] == {}
    # One note per operation, with no profile and no route: the element has
    # neither a readable name nor a route this table could place.
    assert result['unresolved'] == [{'operation': 'speech', 'profile': None, 'route': None,
                                     'reason': MALFORMED_PROFILE}]


def test_a_profiles_field_that_is_not_a_list_is_reported_once():
    """`profiles` is `list[CapabilityProfile]` upstream, so a dict/str/null is broken.

    Reported once per operation with no profile and no route, exactly like an
    unnamed element — the field carries no readable declaration at all. Three
    broken elements in one operation are the same single note, and
    `profiles: []` is not a broken field: it is the answer upstream publishes for
    an operation that serves nothing.
    """
    for broken in ({'text_to_speech': {}}, 'text_to_speech', None, 7):
        # `operation()` normalizes its argument, so the field is set on the body
        # directly: this is the shape upstream's pydantic would reject.
        declared = operation(profiles=[])
        declared['profiles'] = broken
        result = resolve(body({'speech': declared}))
        assert result['capabilities']['audio.speech'] == UNKNOWN, broken
        assert result['reasons'] == {}, broken
        assert result['unresolved'] == [{'operation': 'speech', 'profile': None, 'route': None,
                                         'reason': MALFORMED_PROFILE}], broken

    three_bad = resolve(body({'speech': operation(
        profiles=[{'support': 'supported'}, ['text_to_speech'], {'id': '  '}])}))
    assert three_bad['unresolved'] == [{'operation': 'speech', 'profile': None, 'route': None,
                                        'reason': MALFORMED_PROFILE}]

    empty = resolve(body({'speech': operation(profiles=[])}))
    assert empty['capabilities']['audio.speech'] == UNKNOWN
    assert empty['unresolved'] == []


# --- transport / method ---------------------------------------------------

def test_a_wrong_method_is_a_route_mismatch():
    """`DELETE /v1/chat/completions` would be a 405, not a chat request.

    The path belongs to `chat`, so the declaration is reported as a mismatch and
    not as an unknown path — and since `POST` is the only method this tool uses,
    the profile is left with no postable route at all.
    """
    result = resolve(body({'chat': operation(profiles=[
        profile('text_response', routes=[route('/v1/chat/completions', method='DELETE')])])}))
    assert result['capabilities']['text.chat'] == UNKNOWN
    assert result['unresolved'] == [{'operation': 'chat', 'profile': 'text_response',
                                     'route': None, 'reason': NO_ROUTE_DECLARED},
                                    {'operation': 'chat', 'profile': 'text_response',
                                     'route': '/v1/chat/completions', 'reason': ROUTE_MISMATCH}]


def test_a_wrong_transport_is_a_route_mismatch():
    """The websocket method literal belongs to one route only."""
    result = resolve(body({'speech': operation(profiles=[
        profile('text_to_speech', routes=[route('/v1/audio/speech', method='WEBSOCKET', transport='websocket')])])}))
    assert result['capabilities']['audio.speech'] == UNKNOWN
    assert result['unresolved'] == [{'operation': 'speech', 'profile': 'text_to_speech',
                                     'route': None, 'reason': NO_ROUTE_DECLARED},
                                    {'operation': 'speech', 'profile': 'text_to_speech',
                                     'route': '/v1/audio/speech', 'reason': ROUTE_MISMATCH}]


def test_a_route_key_is_normalized_before_it_is_compared():
    """`method` and `transport` match without regard to case or padding.

    A body assembled by a proxy or by hand may spell `POST` as `" post "` and
    `http` as `"HTTP"`. The key is normalized once, in `_route_key()`, so such a
    declaration reaches the same postable route as the table's
    `('http', 'POST', …)` — and it has to reach it as a *grant*: a normalization
    that only fed the mismatch report would leave the row `unknown` with no note,
    which is the silent loss this table exists to prevent.
    """
    result = resolve(body({'speech': operation(profiles=[
        profile('text_to_speech', routes=[route('/v1/audio/speech', method=' post ', transport='HTTP')])])}))
    assert result['capabilities']['audio.speech'] == AVAILABLE
    assert result['reasons'] == {}
    assert result['unresolved'] == []


def test_a_transport_that_is_present_but_unreadable_is_malformed_not_http():
    """Absence is the `http` default; a value that cannot be read is not, and proves nothing.

    `transport` is the one route field with an upstream default (`http`), so a
    reference that *omits the key* still names the http route — and that is the
    only spelling that does. Readability is a closed set, because upstream's
    field is one (`Literal["http", "websocket"]`): a value that is *there* and
    outside it (`''`, a blank string, `0`, `False`, `[]`, `'bogus'`, `'http/2'`)
    is a different thing, and reading it as the default would be the one place in
    this module where an unreadable value leans permissive — this declaration, a
    closed `/v1/videos` beside it, would come back `available` from a body nobody
    could have published. `None` is the same case, not the default: upstream's
    `transport` has a non-`None` default, so `response_model_exclude_none=True`
    has nothing to drop there and only a proxy or a cache hands `null` over. The
    role gate reads the same key, so the second half checks that the broken
    reference cannot lend the gated id its roles either: if `''` were the `http`
    default, this profile would grant `video.edit` from a route the document
    never named.
    """
    for value in ('', '   ', 0, False, [], 'bogus', 'http/2'):
        entry = profile('text_to_video', routes=[
            route('/v1/videos', exposure='disabled'),
            {'transport': value, 'method': 'POST', 'path': '/v1/videos', 'exposure': 'enabled'}])
        result = resolve(body({'video_generation': operation(profiles=[entry])}))
        assert result['capabilities']['video.generate'] == MISSING, value
        assert result['reasons'] == {'video.generate': 'route_disabled'}, value
        assert result['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                         'route': '/v1/videos', 'reason': MALFORMED_ROUTE}], value

    # `None` is that same present-but-unreadable shape, and is pinned on its own
    # because it is the one spelling an `in value` test can mistake for absence:
    # the key *is* there, so the default does not apply. Before this was fixed,
    # this exact body came back `available` — a closed `/v1/videos` reopened by a
    # `null` no published body can carry.
    nulled = profile('text_to_video', routes=[
        route('/v1/videos', exposure='disabled'),
        {'transport': None, 'method': 'POST', 'path': '/v1/videos', 'exposure': 'enabled'}])
    nulled_report = resolve(body({'video_generation': operation(profiles=[nulled])}))
    assert nulled_report['capabilities']['video.generate'] == MISSING
    assert nulled_report['reasons'] == {'video.generate': 'route_disabled'}
    assert nulled_report['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                            'route': '/v1/videos', 'reason': MALFORMED_ROUTE}]

    # Only the omitted spelling is the default: same body, `transport` absent.
    entry = profile('text_to_video', routes=[
        route('/v1/videos', exposure='disabled'),
        {'method': 'POST', 'path': '/v1/videos', 'exposure': 'enabled'}])
    result = resolve(body({'video_generation': operation(profiles=[entry])}))
    assert result['capabilities']['video.generate'] == AVAILABLE
    assert result['unresolved'] == []

    # Role-gated side of the same rule: the broken reference must not become a
    # second open postable route that lends `video.edit` all three of its roles
    # beside an open route that names none. `available` is the false grant this
    # half forbids; the row stays `unknown`, with the broken reference and the
    # missing roles both reported.
    edit_roles = {'source_video': 'supported', 'video_noise_mask': 'supported',
                  'audio_noise_mask': 'supported'}
    gated = profile('video_to_video', inputs=('video',), outputs=('video',), routes=[
        route('/v1/videos'),
        {'transport': '', 'method': 'POST', 'path': '/v1/videos', 'exposure': 'enabled',
         'request': route_with_inputs('/v1/videos', edit_roles)['request']}])
    assert role_verdict(gated, 'video_generation', required_roles_for('video.edit')) == 'unknown'
    gated_report = resolve(body({'video_generation': operation(profiles=[gated])}))
    assert gated_report['capabilities']['video.edit'] == UNKNOWN
    assert AVAILABLE not in (gated_report['capabilities']['video.edit'],
                             gated_report['capabilities']['video.first_frame'])
    assert gated_report['unresolved'] == [
        {'operation': 'video_generation', 'profile': 'video_to_video', 'route': None,
         'reason': ROLE_NOT_DECLARED},
        {'operation': 'video_generation', 'profile': 'video_to_video', 'route': '/v1/videos',
         'reason': MALFORMED_ROUTE}]


def test_the_video_websocket_route_needs_its_declared_method():
    """`WEBSOCKET /v1/realtime/video` is a real route of the operation — and no capability.

    Spelling it correctly buys nothing: `/v1/realtime/video` is not in
    `POSTABLE_ROUTES`, so a profile whose only route is that socket has no route
    this tool can use and reads `unknown` with `no_route_declared`. Both
    spellings of the declaration land in the same place — the right one is
    reported as a channel this table cannot use, the `POST` one as a wrong
    method on a path `video_generation` does own.
    """
    accepted = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/realtime/video', method='WEBSOCKET', transport='websocket')])])}))
    assert accepted['capabilities']['video.generate'] == UNKNOWN
    assert accepted['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                       'route': None, 'reason': NO_ROUTE_DECLARED},
                                      {'operation': 'video_generation', 'profile': 'text_to_video',
                                       'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}]
    http_spelling = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/realtime/video', method='POST')])])}))
    assert http_spelling['capabilities']['video.generate'] == UNKNOWN
    assert http_spelling['unresolved'] == accepted['unresolved']


def test_a_websocket_route_never_moves_a_verdict():
    """The socket's presence, switch and exposure never change a verdict.

    The same profile is read with four variants of its socket — absent, `enabled`,
    `disabled`, and `exposure: unknown` — and the whole reports have to be
    identical, with and without a postable route beside it. A route counts only
    if the tool posts to it, so any place the socket's `exposure` leaks into a
    verdict (a grant, a refusal, an `undecided`, an `exposure_unknown` note)
    makes one of the four differ. The single `route_mismatch` each variant
    carries is the declaration being reported, not the socket being read.
    """
    socket_only = {variant: resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[socket_route(variant)])])}))
        for variant in (None, 'enabled', 'disabled', 'unknown')}
    for variant, report in socket_only.items():
        assert report['capabilities']['video.generate'] == UNKNOWN, variant
        assert report['reasons'] == {}, variant
        assert report['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                         'route': None, 'reason': NO_ROUTE_DECLARED},
                                        {'operation': 'video_generation', 'profile': 'text_to_video',
                                         'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}], variant
    assert len({json.dumps(report, sort_keys=True) for report in socket_only.values()}) == 1

    with_http = {variant: resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/videos'), socket_route(variant)])])}))
        for variant in (None, 'enabled', 'disabled', 'unknown')}
    for variant, report in with_http.items():
        assert report['capabilities']['video.generate'] == AVAILABLE, variant
        # One note, and the same one in all four variants: the declaration is
        # reported, its `exposure` is not read.
        assert report['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                         'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}], variant
    assert len({json.dumps(report, sort_keys=True) for report in with_http.values()}) == 1

    # Nor does the socket rescue a closed postable route: it is not a channel
    # this tool can post to, so the operation's answer stays `route_disabled`.
    hardened = resolve(body({'video_generation': operation(profiles=[
        profile('text_to_video', routes=[route('/v1/videos', exposure='disabled'),
                                         socket_route('enabled')])])}))
    assert hardened['capabilities']['video.generate'] == MISSING
    assert hardened['reasons'] == {'video.generate': 'route_disabled'}
    assert hardened['unresolved'] == [{'operation': 'video_generation', 'profile': 'text_to_video',
                                       'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}]

    # A role-gated id answers the same way in all four variants: the postable
    # route refuses `first_frame`, and the socket's exposure cannot soften that.
    gated = {variant: resolve(body({'video_generation': operation(profiles=[profile(
        'image_to_video', inputs=('text', 'image'), outputs=('video',),
        routes=[route_with_inputs('/v1/videos', {'first_frame': 'unsupported'}),
                socket_route(variant)])])}))
        for variant in (None, 'enabled', 'disabled', 'unknown')}
    for variant, report in gated.items():
        assert report['capabilities']['video.first_frame'] == MISSING, variant
        assert report['reasons'] == {'video.first_frame': UNSUPPORTED_REASON}, variant
        assert report['unresolved'] == [{'operation': 'video_generation', 'profile': 'image_to_video',
                                         'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}], variant
    assert len({json.dumps(report, sort_keys=True) for report in gated.values()}) == 1


def test_a_socket_outside_the_operation_is_not_a_channel_either():
    """A websocket route the operation does not own is not evidence and not doubt.

    `/v1/realtime/video` belongs to `video_generation`; declared on
    `image_generation` it is neither a route this tool sends nor a postable one.
    Its `enabled` cannot turn the closed postable route into `unknown` — the
    false doubt `route_disabled` exists to avoid — and because the path is one
    this table places, the declaration is a `route_mismatch` and not an
    `unknown_route`.
    """
    foreign_socket = route('/v1/realtime/video', method='WEBSOCKET', transport='websocket')
    result = resolve(body({'image_generation': operation(profiles=[
        profile('text_to_image', routes=[route('/v1/images/generations', exposure='disabled'),
                                         foreign_socket])])}))
    assert result['capabilities']['image.generate'] == MISSING
    assert result['reasons'] == {'image.generate': 'route_disabled'}
    assert result['unresolved'] == [{'operation': 'image_generation', 'profile': 'text_to_image',
                                     'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}]

    # A socket on a path no operation owns is the other note, and still no
    # channel: the role gate reads the same declaration the same way, so a
    # socket it never opens cannot keep the postable route's refusal from being
    # the answer.
    refused = profile('video_to_video', inputs=('video',), outputs=('video',),
                      routes=[route_with_inputs('/v1/videos', {'source_video': 'unsupported',
                                                              'video_noise_mask': 'unsupported',
                                                              'audio_noise_mask': 'unsupported'}),
                              route('/v1/realtime/audio', method='WEBSOCKET', transport='websocket')])
    required = ('source_video', 'video_noise_mask', 'audio_noise_mask')
    assert role_verdict(refused, 'video_generation', required) == 'no'
    refused_report = resolve(body({'video_generation': operation(profiles=[refused])}))
    assert refused_report['capabilities']['video.edit'] == MISSING
    assert refused_report['reasons'] == {'video.edit': UNSUPPORTED_REASON}
    assert refused_report['unresolved'] == [{'operation': 'video_generation', 'profile': 'video_to_video',
                                             'route': '/v1/realtime/audio', 'reason': UNKNOWN_ROUTE}]


def test_the_socket_grants_no_gated_role_even_when_it_names_all_four():
    """All four gated roles on the socket grant neither video id.

    Upstream really does declare `image` on that socket
    (`serving_capabilities.py:196-198`, `max_count: 1`), so a role there is not
    nonsense — it is simply not a role any request this tool sends can carry.
    The socket cannot satisfy `REQUIRED_ROLES`, and it cannot be what makes the
    answer `available` either.
    """
    roles = {'first_frame': 'supported', 'source_video': 'supported',
             'video_noise_mask': 'supported', 'audio_noise_mask': 'supported'}
    socket = socket_route(inputs=roles)
    alone = profile('video_to_video', inputs=('video',), outputs=('video',), routes=[socket])
    assert role_verdict(alone, 'video_generation', ('first_frame',)) == 'unknown'
    assert role_verdict(alone, 'video_generation',
                        ('source_video', 'video_noise_mask', 'audio_noise_mask')) == 'unknown'
    alone_report = resolve(body({'video_generation': operation(profiles=[alone])}))
    assert alone_report['capabilities']['video.edit'] == UNKNOWN
    assert alone_report['unresolved'] == [{'operation': 'video_generation', 'profile': 'video_to_video',
                                           'route': None, 'reason': NO_ROUTE_DECLARED},
                                          {'operation': 'video_generation', 'profile': 'video_to_video',
                                           'route': '/v1/realtime/video', 'reason': ROUTE_MISMATCH}]

    # Beside an open http route that names none of them the profile is
    # reachable, and the ids still stay `unknown` with `role_not_declared`.
    beside = profile('video_to_video', inputs=('video',), outputs=('video',),
                     routes=[route('/v1/videos'), socket])
    beside_report = resolve(body({'video_generation': operation(profiles=[beside])}))
    assert role_verdict(beside, 'video_generation',
                        ('source_video', 'video_noise_mask', 'audio_noise_mask')) == 'unknown'
    assert beside_report['capabilities']['video.edit'] == UNKNOWN
    assert beside_report['reasons'] == {}
    assert beside_report['unresolved'] == [{'operation': 'video_generation', 'profile': 'video_to_video',
                                            'route': None, 'reason': ROLE_NOT_DECLARED},
                                           {'operation': 'video_generation', 'profile': 'video_to_video',
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
        {'operation': 'video_generation', 'profile': 'text_to_video', 'route': None,
         'reason': NO_ROUTE_DECLARED},
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
                                         'route': None, 'reason': NO_ROUTE_DECLARED},
                                        {'operation': 'image_generation', 'profile': 'text_to_image',
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
                                     'route': None, 'reason': NO_ROUTE_DECLARED},
                                    {'operation': 'video_generation', 'profile': 'text_to_video',
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


def test_declarations_is_a_raw_reader_that_capabilities_for_must_check():
    """`declarations()` lists what the body names; `capabilities_for()` says what it means.

    The reader is deliberately raw — it is the "which pairs did this deployment
    mention" question — so it returns pairs `resolve()` treats as no evidence.
    A caller that wants grants has to pass each pair through
    `capabilities_for()`, which is `()` for all three shapes here.
    """
    payload = body({'speech': operation(profiles=[profile('text_to_speech')]),
                    'chat': operation(profiles=[profile('text_to_speech'), profile('mystery')]),
                    'asr': operation(profiles=[profile('text_to_speech')])})
    pairs = declarations(payload)
    assert pairs == [('speech', 'text_to_speech'), ('chat', 'text_to_speech'), ('chat', 'mystery'),
                     ('asr', 'text_to_speech')]
    # No such operation upstream, a profile filed under the wrong operation, and
    # a profile id nobody publishes.
    for pair in (('asr', 'text_to_speech'), ('chat', 'text_to_speech'), ('chat', 'mystery')):
        assert capabilities_for(*pair) == (), pair
        assert pair in pairs, pair
    assert [pair for pair in pairs if capabilities_for(*pair)] == [('speech', 'text_to_speech')]
    # The same body, read for verdicts: the three pairs are reported, not granted.
    reasons = {entry['reason'] for entry in resolve(payload)['unresolved']}
    assert {'unmapped_stage', 'operation_mismatch', 'unknown_profile'} <= reasons


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


def test_a_deferred_note_survives_a_model_that_declares_nothing():
    """A queued note is about the pair's aggregated answer, not about one model.

    The first model leaves `image.generate` `unknown` because its only route's
    `exposure` cannot be read, so the note is queued. The second model lists no
    operation at all, which also keeps the row `unknown` — so the note still
    explains the result and must survive both reading orders.
    """
    unreadable = model({'image_generation': operation(profiles=[profile(
        'text_to_image', routes=[route('/v1/images/generations', exposure='unknown')])])},
        model_id='model-a')
    silent = model({}, model_id='model-b')
    forward = resolve(body(models=[unreadable, silent]))
    assert forward['capabilities']['image.generate'] == UNKNOWN
    assert {'operation': 'image_generation', 'profile': 'text_to_image',
            'route': '/v1/images/generations', 'reason': EXPOSURE_UNKNOWN} in forward['unresolved']
    backward = resolve(body(models=[silent, unreadable]))
    assert backward == forward

    # The mirror: a note that no longer explains anything is dropped. The same
    # unreadable declaration beside a model that answers the row leaves one
    # `available` and no note at all.
    answering = model({'image_generation': operation(profiles=[profile(
        'text_to_image', routes=[route('/v1/images/generations')])])}, model_id='model-b')
    answered = resolve(body(models=[unreadable, answering]))
    assert answered['capabilities']['image.generate'] == AVAILABLE
    assert [entry for entry in answered['unresolved'] if entry['reason'] == EXPOSURE_UNKNOWN] == []


# Every reason name this module may emit. Written out, not derived from
# `REASONS`: the list is the review, and the constants below it are what the
# closed-set assertion compares against.
REASON_CONSTANTS = ('UNKNOWN_ROUTE', 'ROUTE_MISMATCH', 'UNMAPPED_STAGE', 'UNKNOWN_PROFILE', 'OPERATION_MISMATCH',
                    'NO_LOCAL_CAPABILITY', 'NO_ROUTE_DECLARED', 'MALFORMED_ROUTE', 'EXPOSURE_UNKNOWN',
                    'ROLE_NOT_DECLARED', 'UNSUPPORTED_FORMAT', 'MALFORMED_MODEL', 'MALFORMED_PROFILE',
                    'MALFORMED_OPERATION')


def reason_sites(source):
    """`(constants, sites)` of a module source: every place a reason is written.

    Three shapes, all collected, because each one is a way the closed set could
    be widened without touching `REASONS`:

    * `_note(...)`, with the reason as the fifth positional argument or as the
      `reason=` keyword;
    * `deferred.append((operation, profile, route, REASON))`, whose last tuple
      element is the reason;
    * any dict literal carrying a `'reason'` key — `_note()`'s own envelope
      (`{operation, profile, route, reason}`, the one dict that passes the local
      variable through) and, separately, any other dict, which is how an
      `unresolved.append({'reason': NEW})` would have to be written.

    `sites` holds `(kind, expression)` pairs; the caller reduces the expressions
    to names.
    """
    tree = ast.parse(source)
    constants = {}
    sites = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name, value = node.targets[0].id, node.value
            if name.isupper() and isinstance(value, ast.Constant) and isinstance(value.value, str):
                constants[name] = value.value
        if isinstance(node, ast.Dict):
            keys = {key.value for key in node.keys if isinstance(key, ast.Constant)}
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value == 'reason':
                    # `_note()`'s own envelope is the one dict that passes the
                    # local variable through verbatim; anything else — even a
                    # four-key dict — is an emission site whose value must
                    # reduce to a registered name.
                    envelope = ({'operation', 'profile', 'route'} <= keys
                                and isinstance(value, ast.Name) and value.id == 'reason')
                    sites.append(('envelope' if envelope else 'dict', value))
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == '_note':
            expression = node.args[4] if len(node.args) >= 5 else None
            for keyword in node.keywords:
                if keyword.arg == 'reason':
                    expression = keyword.value
            assert expression is not None, ast.dump(node)
            sites.append(('_note', expression))
        elif (isinstance(func, ast.Attribute) and func.attr == 'append'
              and isinstance(func.value, ast.Name) and func.value.id == 'deferred'):
            assert node.args and isinstance(node.args[0], ast.Tuple) and node.args[0].elts, ast.dump(node)
            sites.append(('deferred', node.args[0].elts[-1]))
    return constants, sites


def reason_names(constants, sites):
    """The reason names a module can emit, from `reason_sites()` output."""

    def names_of(node):
        """Constant names one expression can be: a name, a literal, or both arms of a conditional."""
        if isinstance(node, ast.Name):
            return {node.id}
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return {node.value}
        assert isinstance(node, ast.IfExp), ast.dump(node)
        return names_of(node.body) | names_of(node.orelse)

    emitted = set()
    for kind, expression in sites:
        for name in names_of(expression):
            if name == 'reason':
                # `_note()`'s local and the deferred flush hand a queued value
                # straight through; every value they can carry was checked where
                # it was decided.
                assert kind in ('envelope', '_note'), (kind, name)
                continue
            emitted.add(constants[name] if name in constants else name)
    return emitted


def test_every_emitted_reason_is_in_the_closed_set():
    """Every reason the module can emit is one of the fourteen registered names.

    Read from the source, not from the module's objects: a reason that nobody
    added to `REASONS` fails here, which is what the presentation layer relies on
    when it renders a code. The collector itself is proven by
    `test_the_reason_collector_sees_every_emission_shape`, so this test can claim
    "every emission" and not just "every emission of the shape this collector
    happened to know about".
    """
    source = Path(contract.__file__).read_text(encoding='utf-8')
    constants, sites = reason_sites(source)
    kinds = {kind for kind, _ in sites}
    assert {'envelope', '_note', 'deferred'} <= kinds, sites
    emitted = reason_names(constants, sites)
    assert emitted, 'no reason expression was found'
    assert emitted <= REASONS, emitted - REASONS
    # And the closed set is exactly the fourteen constants, each of them emitted
    # somewhere: a name nobody can produce is as much a bug as an unregistered one.
    assert len(REASON_CONSTANTS) == 14
    assert {constants[name] for name in REASON_CONSTANTS} == set(REASONS)
    assert emitted == {constants[name] for name in REASON_CONSTANTS}, emitted ^ {
        constants[name] for name in REASON_CONSTANTS}


def test_the_reason_set_is_the_reviewed_fourteen():
    """The closed set the presentation layer renders: fourteen names, one per kind.

    Kept beside `test_every_emitted_reason_is_in_the_closed_set` rather than
    inside an exposure test: a change to this set is a change to the report
    vocabulary, and it used to be reported as a failure of a test named after
    exposure normalization — the wrong subject for the diff it named. The last
    three names added were `exposure_unknown`, `malformed_profile` and
    `malformed_operation`; which round added which is not repeated here, because
    that arithmetic drifts every round and the constants are the check.
    """
    assert EXPOSURE_UNKNOWN in REASONS and MALFORMED_PROFILE in REASONS
    assert MALFORMED_OPERATION in REASONS
    assert len(REASONS) == 14


def test_the_reason_collector_sees_every_emission_shape():
    """The two shapes the old collector missed are collected, and reduce.

    The stale collector only read a fifth positional `_note(...)` argument and a
    `deferred.append((...))` tuple, so `unresolved.append({'reason': NEW})` and
    `_note(..., reason=NEW)` were invisible to the closed-set assertion — an
    unregistered name could ship. Both appear in this snippet, and both have to
    come back as names.
    """
    snippet = (
        "NEW_ONE = 'new_one'\n"
        "def f(unresolved, deferred):\n"
        "    unresolved.append({'operation': None, 'profile': None, 'route': None, 'reason': NEW_ONE})\n"
        "    _note(None, None, None, None, reason=NEW_ONE)\n"
        "    _note(None, None, None, None, NEW_ONE)\n"
        "    deferred.append((None, None, None, NEW_ONE))\n"
    )
    constants, sites = reason_sites(snippet)
    assert {kind for kind, _ in sites} == {'dict', '_note', 'deferred'}, sites
    assert constants['NEW_ONE'] == 'new_one'
    assert reason_names(constants, sites) == {'new_one'}


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


def test_defensive_case_ids_are_bound_to_the_bodies_they_describe():
    """A `malformed.json` id has to name something in the body it labels.

    The file's two cases are told apart by their ids and by nothing else that the
    suite would notice: swapping the two labels would leave both payloads
    resolving and both expectations matching, so the only broken thing would be
    the diagnosis a reader trusts. Each id is therefore pinned to what it blames
    — the operation and profile it is filed under, the path that profile
    declares, the note that comes back for it, and the one capability state that
    differs between the two cases. All of it is read out of the fixture, so a
    swapped or renamed id fails here instead of passing quietly.
    """
    anchors = {
        'profile-on-another-operations-route': {
            'operation': 'video_generation', 'profile': 'text_to_video',
            'route': '/v1/images/edits', 'reason': ROUTE_MISMATCH,
            'capability': ('video.generate', UNKNOWN)},
        'unrecognised-route-cannot-reopen-a-disabled-route': {
            'operation': 'image_edit', 'profile': 'image_to_image',
            'route': '/v1/images/edits/stream', 'reason': UNKNOWN_ROUTE,
            'capability': ('video.generate', AVAILABLE)},
    }
    cases = {case['id']: case for _, cases in defensive_cases() for case in cases}
    assert set(cases) == set(anchors), set(cases) ^ set(anchors)
    for case_id, anchor in anchors.items():
        case = cases[case_id]
        # The path is declared by that profile, in the operation the note names.
        declared = [value.get('path') if isinstance(value, dict) else value
                    for model_body in case['payload']['models']
                    for operation_id, operation_body in model_body['operations'].items()
                    if operation_id == anchor['operation']
                    for entry in operation_body.get('profiles', [])
                    if entry.get('id') == anchor['profile']
                    for value in entry.get('routes', [])]
        assert anchor['route'] in declared, (case_id, declared)
        assert {'operation': anchor['operation'], 'profile': anchor['profile'],
                'route': anchor['route'], 'reason': anchor['reason']} in case['expected']['unresolved'], case_id
        capability, state = anchor['capability']
        assert case['expected']['capabilities'][capability] == state, case_id


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
