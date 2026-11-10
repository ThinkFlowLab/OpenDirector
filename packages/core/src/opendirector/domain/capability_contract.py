"""The (stage, route) pairs the capability vocabulary understands.

`GET /v1/omni/capabilities` (vllm-project/vllm-omni#10007) reports what a
deployment serves. This module is the one place that turns those names into
`opendirector.domain.capabilities` ids. It performs no HTTP and holds no
display text: `application.model_availability.requests_for()` consumes the
table, and the presentation layer renders the reason codes through the message
catalogs.

Three rules keep the table honest:

* The key is the pair, never the route alone. `/v1/audio/speech` carries both
  `tts` and `music`; `/v1/audio/transcriptions` carries both `asr` and `score`.
  A declared path without its stage cannot say which capability was meant.
* A capability no route can express stays `unknown` even when the deployment
  answers, because it is a request parameter rather than an endpoint:
  `video.first_frame` and `video.edit` are `/v1/videos` parameters, and
  `image.cutout` is a `/v1/images/generations` parameter.
* A declaration that places no stage is `unknown`, never `missing`: "the
  service did not say" is not "the service cannot".

A declared pair this table cannot translate is reported instead of dropped, so
a caller can show why a stage is unavailable rather than silently hiding it.
"""

ENDPOINT = '/v1/omni/capabilities'
API_PREFIX = '/v1'

# (upstream stage, upstream route, capability ids that pair can serve). Order is
# part of the contract: `resolve()` emits capabilities in this order, so a
# presentation change is a diff in one place. The routes are the ones this
# repository's adapters already call, so a declaration published by the service
# and a request we would send name the same path.
STAGE_ROUTES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ('text', '/v1/chat/completions', ('text.chat',)),
    ('image', '/v1/images/generations', ('image.generate',)),
    ('image', '/v1/images/edits', ('image.edit',)),
    ('image', '/v1/images/segmentations', ('image.segment',)),
    ('video', '/v1/videos', ('video.generate',)),
    ('video', '/v1/videos/segmentations', ('video.matting',)),
    ('video', '/v1/videos/depth', ('video.motion_capture',)),
    ('tts', '/v1/audio/speech', ('audio.speech',)),
    ('music', '/v1/audio/speech', ('audio.music',)),
    ('score', '/v1/audio/transcriptions', ('audio.score',)),
)

# `asr` is deliberately absent: recognition has no capability id yet, so
# `/v1/audio/transcriptions` under `asr` is reported as `unmapped_stage`
# instead of being read as `audio.score`.

# Capability ids no upstream route can express, with the reason to show. Values
# stay stable business codes; wording lives in the message catalogs.
UNROUTED: dict[str, str] = {
    'video.first_frame': 'parameter_only',
    'video.edit': 'parameter_only',
    'image.cutout': 'parameter_only',
    'audio.separate': 'no_local_adapter',
}

AVAILABLE, MISSING, UNKNOWN = 'available', 'missing', 'unknown'
ABSENT, PRESENT = 'absent', 'present'
PARTIAL, UNMAPPED = 'partial', 'unmapped'

# Why a declared pair could not be translated. Three distinct cases, because
# they lead to different fixes: add the route to the table, add the stage to the
# table, or correct a deployment that paired a known stage with another stage's
# route.
UNKNOWN_ROUTE, UNMAPPED_STAGE, STAGE_ROUTE_MISMATCH = 'unknown_route', 'unmapped_stage', 'stage_route_mismatch'
REASONS = frozenset({UNKNOWN_ROUTE, UNMAPPED_STAGE, STAGE_ROUTE_MISMATCH})
PARAMETER_ONLY, NO_LOCAL_ADAPTER = 'parameter_only', 'no_local_adapter'
UNROUTED_REASONS = frozenset({PARAMETER_ONLY, NO_LOCAL_ADAPTER})

KNOWN_STAGES = frozenset(stage for stage, _, _ in STAGE_ROUTES)
KNOWN_ROUTES = frozenset(route for _, route, _ in STAGE_ROUTES)
BY_PAIR: dict[tuple[str, str], tuple[str, ...]] = {(stage, route): capabilities
                                                   for stage, route, capabilities in STAGE_ROUTES}


def named(value):
    """Normalized stage name from a string or an object carrying `name`/`stage`."""
    if isinstance(value, dict):
        value = value.get('name', value.get('stage'))
    return value.strip().lower() if isinstance(value, str) else ''


def classified_capabilities():
    """Every capability id this contract places, in table order, without repeats.

    Routed capabilities come first in the order their pairs appear; unrouted
    ones follow in declaration order. Callers that render a list use this order
    instead of sorting, so the canvas and the contract cannot disagree.
    """
    ordered = []
    for _, _, capabilities in STAGE_ROUTES:
        for capability in capabilities:
            if capability not in ordered:
                ordered.append(capability)
    ordered.extend(capability for capability in UNROUTED if capability not in ordered)
    return tuple(ordered)


def route_path(value):
    """Canonical `/v1/...` path for a declared route, or None when it is unusable.

    Upstream may report `/v1/audio/speech`, `audio/speech` or an object carrying
    `path`; the base URL already contains `/v1`, so the prefix is normalized
    here once instead of at every comparison. Query strings are dropped: a
    version parameter does not change which capability a path serves.
    """
    if isinstance(value, dict):
        value = value.get('path')
    if not isinstance(value, str):
        return None
    path = value.strip().split('?', 1)[0].strip()
    if not path:
        return None
    path = '/' + path.lstrip('/')
    if len(path) > 1:
        path = path.rstrip('/')
    if path == API_PREFIX or path.startswith(API_PREFIX + '/'):
        return path
    return API_PREFIX + path


def capabilities_for(stage, route):
    """Capability ids for one pair, or `()` when this table does not place it.

    This is the single lookup `requests_for()` needs: given the stage it is
    executing and the path it is about to post to, it gets the capabilities the
    deployment granted and never has to know profile names.
    """
    path = route_path(route)
    if path is None:
        return ()
    return BY_PAIR.get((named(stage), path), ())


def _stage_pairs(stages):
    """Pairs from a `stages: [{name, routes: [...]}]` body, in document order."""
    if not isinstance(stages, list):
        return
    for entry in stages:
        stage = named(entry)
        routes = entry.get('routes') if isinstance(entry, dict) else None
        if not stage or not isinstance(routes, list):
            continue
        for route in routes:
            path = route_path(route)
            if path:
                yield stage, path


def _model_pairs(models):
    """Pairs from a `models: [{stage_ids, operations}]` body, in document order.

    The discovery document this repository parses today names routes per
    operation and profile, and the stages per model. Cross-producting them is
    what makes such a document readable as (stage, route) pairs; when
    `stage_ids` holds opaque ids the pairs surface as unmapped stages instead of
    being guessed at.
    """
    if not isinstance(models, list):
        return
    for model in models:
        stages = [stage for stage in map(named, model.get('stage_ids') or ()) if stage] \
            if isinstance(model, dict) else []
        operations = model.get('operations') if isinstance(model, dict) else None
        if not stages or not isinstance(operations, dict):
            continue
        for operation in operations.values():
            profiles = operation.get('profiles') if isinstance(operation, dict) else None
            if not isinstance(profiles, list):
                continue
            for profile in profiles:
                routes = profile.get('routes') if isinstance(profile, dict) else None
                if not isinstance(routes, list):
                    continue
                for route in routes:
                    path = route_path(route)
                    if not path:
                        continue
                    for stage in stages:
                        yield stage, path


def declarations(payload):
    """Ordered (stage, route) pairs from a capabilities body, or None when it declares none.

    Both published shapes are read: a `stages` list is taken as written, and a
    `models` list is expanded through `stage_ids` and its operation profiles. A
    body that declares neither returns None, which callers must treat as "no
    evidence" rather than "nothing supported".
    """
    if not isinstance(payload, dict):
        return None
    pairs = []
    for pair in (*_stage_pairs(payload.get('stages')), *_model_pairs(payload.get('models'))):
        if pair not in pairs:
            pairs.append(pair)
    return pairs or None


def resolve(payload):
    """Per-capability availability, the per-stage view, and the unresolved pairs.

    `payload` is the decoded body of `ENDPOINT`, or None when the request failed
    (404, timeout, disabled endpoint). Model names and any other provider fields
    never reach the result.
    """
    vocabulary = classified_capabilities()
    pairs = declarations(payload)
    if not pairs:
        return {'endpoint': ABSENT, 'stages': {},
                'capabilities': {item: UNKNOWN for item in vocabulary}, 'unresolved': []}
    granted, unresolved, stage_flags = set(), [], {}
    for stage, route in pairs:
        capabilities = capabilities_for(stage, route)
        flags = stage_flags.setdefault(stage, [])
        if capabilities:
            granted.update(capabilities)
            flags.append(True)
            continue
        flags.append(False)
        if route not in KNOWN_ROUTES:
            reason = UNKNOWN_ROUTE
        elif stage not in KNOWN_STAGES:
            reason = UNMAPPED_STAGE
        else:
            reason = STAGE_ROUTE_MISMATCH
        unresolved.append({'stage': stage, 'route': route, 'reason': reason})
    stages = {stage: AVAILABLE if all(flags) else PARTIAL if any(flags) else UNMAPPED
              for stage, flags in sorted(stage_flags.items())}
    capabilities = {item: AVAILABLE if item in granted else UNKNOWN if item in UNROUTED else MISSING
                    for item in vocabulary}
    return {'endpoint': PRESENT, 'stages': stages, 'capabilities': capabilities,
            'unresolved': sorted(unresolved, key=lambda item: (item['stage'], item['route']))}
