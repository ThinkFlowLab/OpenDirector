"""The (operation, profile) pairs the upstream capability vocabulary publishes.

`GET /v1/omni/capabilities` (vllm-project/vllm-omni#10007, head `d1104f8`)
reports what a deployment serves. This module is the one place that turns that
vocabulary into `opendirector.domain.capabilities` ids. It performs no HTTP and
holds no display text: a caller consumes the table, and the presentation layer
renders reason codes through the message catalogs.

Upstream publishes exactly six operations and twelve profiles
(`vllm_omni/serving_capabilities.py:19-26`, `:43-54`)::

    chat              text_response, image_response, audio_response
    image_generation  text_to_image
    image_edit        image_to_image
    video_generation  text_to_video, image_to_video, video_to_video
    speech            text_to_speech, lyrics_to_music, caption_to_audio
    audio_generation  text_to_audio

Four rules keep the table honest.

* The key is `(operation, profile)`, never the route, never the stage.
  `/v1/audio/speech` is the single route of one operation and carries three
  profiles with three different contracts: `text_to_speech` (voice),
  `lyrics_to_music` (music) and `caption_to_audio` (sound effect). A path alone
  cannot say which one was granted, and a deployment can grant one while
  refusing the others (`tests/config/test_serving_capabilities.py:233,251`:
  MOSS-SoundEffect serves `caption_to_audio` and reports `text_to_speech`
  unsupported on the same path).
* `stages[]` is deployment topology, not a capability. It publishes only
  `id` / `type` / `depends_on` (`protocol/capabilities.py:67-70`), the ids are
  opaque numeric strings, and every model is handed the *same* full list
  (`entrypoints/openai/serving_capabilities.py:400`). Keying capabilities on
  stages would therefore give every model one shared state and no diagnosis;
  this module returns the topology for display and never reads it to decide a
  capability.
* A declaration that says nothing is `unknown`, never `missing`. Absent fields
  are the normal way to say "not established" (`response_model_exclude_none=True`,
  `api_server.py:2193`) and `unknown` is a first-class upstream value
  (`support`, `exposure`, and "Missing operations/profiles are unknown",
  `serving_capabilities.py:84`). Only positive evidence — `support=unsupported`
  or `exposure=disabled` for the profile — produces `missing`.
* A route without an operation proves nothing. `/v1/images/segmentations`,
  `/v1/videos/segmentations` and `/v1/videos/depth` are registered endpoints
  that no operation owns (`docs/serving/capabilities.md:41-43`): "segmentation
  and depth estimation do not acquire one of these operations merely by being
  present in a registry". Those capabilities stay `unknown` with
  `no_upstream_profile`.

`asr` is not an omission on this side: upstream publishes no recognition
operation at all and the omni router never registers `/v1/audio/transcriptions`,
so a caller naming it gets `unmapped_stage` — an upstream gap to be recorded,
not a row we forgot to add, and never silently read as `audio.score`.

Not yet confirmed upstream (recorded here instead of assumed): the exact
`observed_at` string format, whether `stages[].type` is ever the `"unknown"`
fallback, and whether a multi-model deployment can differentiate `operations`
per model. This module reads only what a body actually states, so those gaps
stay `unknown` rather than becoming policy.
"""

ENDPOINT = '/v1/omni/capabilities'
API_PREFIX = '/v1'

# Upstream's closed operation vocabulary, in its published order.
# (`vllm_omni/serving_capabilities.py:15,19-26`)
OPERATIONS: tuple[str, ...] = (
    'chat',
    'image_generation',
    'image_edit',
    'video_generation',
    'speech',
    'audio_generation',
)

# (operation, profile, capability ids that profile grants). Order is part of the
# contract: `resolve()` emits capabilities in this order, so a presentation
# change is a diff in one place. Every profile upstream publishes has a row,
# including the two for which this repository has no capability id yet: an empty
# tuple is the honest answer ("upstream says it can, we cannot name it"), and a
# supported declaration of such a profile is reported as `no_local_capability`
# rather than dropped or force-fitted to a neighbouring id.
#
# `caption_to_audio` is a sound-effect contract (upstream requires
# `ambient_sound`, `tests/config/test_serving_capabilities.py:233`), not speech;
# `text_to_audio` is the separate diffusion contract behind
# `/v1/audio/generate` (no voice, no lyrics; `docs/serving/capabilities.md:59-60`).
# Mapping either onto `audio.speech` would let a request carry a voice the
# deployment never accepted.
OPERATION_PROFILES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ('chat', 'text_response', ('text.chat',)),
    ('chat', 'image_response', ('text.chat',)),
    ('chat', 'audio_response', ('text.chat',)),
    ('image_generation', 'text_to_image', ('image.generate',)),
    ('image_edit', 'image_to_image', ('image.edit',)),
    ('video_generation', 'text_to_video', ('video.generate',)),
    ('video_generation', 'image_to_video', ('video.generate',)),
    ('video_generation', 'video_to_video', ('video.generate',)),
    ('speech', 'text_to_speech', ('audio.speech',)),
    ('speech', 'lyrics_to_music', ('audio.music',)),
    ('speech', 'caption_to_audio', ()),
    ('audio_generation', 'text_to_audio', ()),
)

# operation → the routes that operation owns (`serving_capabilities.py:42-54`).
# Kept beside the profile table so a declared profile can be checked against the
# operation it claims: a profile pointing at another operation's path is a
# declaration error, not a capability. `/v1/realtime/video` is a websocket route,
# compared by path here because the capability question is about the endpoint.
# Routes registered but owned by no operation (`/v1/audio/speech/batch`,
# `/v1/chat/completions/batch`, the `segmentations`/`depth` endpoints, …) belong
# to no value of this map, which is exactly why they cannot grant anything.
OPERATION_ROUTES: dict[str, tuple[str, ...]] = {
    'chat': ('/v1/chat/completions',),
    'image_generation': ('/v1/images/generations',),
    'image_edit': ('/v1/images/edits',),
    'video_generation': ('/v1/videos', '/v1/videos/sync', '/v1/realtime/video'),
    'speech': ('/v1/audio/speech',),
    'audio_generation': ('/v1/audio/generate',),
}

AVAILABLE, MISSING, UNKNOWN = 'available', 'missing', 'unknown'
ABSENT, PRESENT = 'absent', 'present'

# Upstream's three-valued vocabulary, shared by `support` and `exposure`
# (`serving_capabilities.py:16`, `protocol/capabilities.py:13`).
SUPPORTED, UNSUPPORTED = 'supported', 'unsupported'
ENABLED, DISABLED = 'enabled', 'disabled'
# `unknown` is the third value of both, and also the state of an absent field.

# Why a declaration could not be translated. Each names a different fix, so a
# reviewer can tell an upstream gap from a bug in this table.
UNKNOWN_ROUTE = 'unknown_route'  # the path belongs to no operation at all
ROUTE_MISMATCH = 'route_mismatch'  # the path belongs to a different operation
UNMAPPED_STAGE = 'unmapped_stage'  # no such operation upstream (e.g. `asr`)
UNKNOWN_PROFILE = 'unknown_profile'  # operation known, profile id not published
OPERATION_MISMATCH = 'operation_mismatch'  # profile known under another operation
NO_LOCAL_CAPABILITY = 'no_local_capability'  # upstream profile, no id here
REASONS = frozenset({UNKNOWN_ROUTE, ROUTE_MISMATCH, UNMAPPED_STAGE, UNKNOWN_PROFILE,
                     OPERATION_MISMATCH, NO_LOCAL_CAPABILITY})

# Why a capability can never be decided from a declaration here.
NO_UPSTREAM_PROFILE, NO_UPSTREAM_OPERATION = 'no_upstream_profile', 'no_upstream_operation'
PARAMETER_ONLY, NO_LOCAL_ADAPTER = 'parameter_only', 'no_local_adapter'
UNROUTED_REASONS = frozenset({NO_UPSTREAM_PROFILE, NO_UPSTREAM_OPERATION, PARAMETER_ONLY, NO_LOCAL_ADAPTER})

# Capability ids no upstream profile can express, with the reason to show. Values
# stay stable business codes; wording lives in the message catalogs. Every entry
# here resolves to `unknown`: the endpoint does not publish the ability, so
# "cannot judge" is the only defensible state.
UNROUTED: dict[str, str] = {
    # Endpoints exist, but no operation owns them (see the module docstring).
    'image.segment': NO_UPSTREAM_PROFILE,
    'video.matting': NO_UPSTREAM_PROFILE,
    'video.motion_capture': NO_UPSTREAM_PROFILE,
    # Upstream publishes no transcription operation at all.
    'audio.score': NO_UPSTREAM_OPERATION,
    # Request fields of an operation that does publish a profile.
    'video.first_frame': PARAMETER_ONLY,
    'video.edit': PARAMETER_ONLY,
    'image.cutout': PARAMETER_ONLY,
    # No adapter here offers it; upstream says nothing either way.
    'audio.separate': NO_LOCAL_ADAPTER,
}

BY_PAIR: dict[tuple[str, str], tuple[str, ...]] = {(operation, profile): capabilities
                                                  for operation, profile, capabilities in OPERATION_PROFILES}
PROFILE_OPERATIONS: dict[str, str] = {profile: operation for operation, profile, _ in OPERATION_PROFILES}
ROUTED_PATHS = frozenset(path for paths in OPERATION_ROUTES.values() for path in paths)


def route_path(value):
    """Canonical `/v1/...` path for a declared route, or None when it is unusable.

    Upstream may report `/v1/audio/speech`, `audio/speech` or an object carrying
    `path`; the base URL already contains `/v1`, so the prefix is normalized
    here once instead of at every comparison. Query strings are dropped: a
    version parameter does not change which operation owns a path.
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


def capabilities_for(operation, profile):
    """Capability ids for one pair, or `()` when this table does not place it.

    This is the single lookup a caller needs: given the operation it believes it
    is calling and the profile it intends to use, it gets the capabilities that
    profile grants. `()` means either "no such row" or "upstream publishes the
    profile but this repository has no id for it" — `resolve()` distinguishes
    those two cases in its `unresolved` list.
    """
    if not isinstance(operation, str) or not isinstance(profile, str):
        return ()
    return BY_PAIR.get((operation.strip().lower(), profile.strip().lower()), ())


def classified_capabilities():
    """Every capability id this contract places, in table order, without repeats.

    Routed capabilities come first in the order their rows appear; unrouted ones
    follow in declaration order. Callers that render a list use this order
    instead of sorting, so the canvas and the contract cannot disagree.
    """
    ordered = []
    for _, _, capabilities in OPERATION_PROFILES:
        for capability in capabilities:
            if capability not in ordered:
                ordered.append(capability)
    ordered.extend(capability for capability in UNROUTED if capability not in ordered)
    return tuple(ordered)


def _routes(entry):
    """Declared route references of a profile; anything malformed is ignored."""
    routes = entry.get('routes')
    return routes if isinstance(routes, list) else []


def _profiles(operation):
    """`(profile id, profile entry)` pairs a declared operation body carries."""
    if not isinstance(operation, dict):
        return
    profiles = operation.get('profiles')
    for entry in profiles if isinstance(profiles, list) else []:
        profile_id = entry.get('id') if isinstance(entry, dict) else None
        if isinstance(profile_id, str) and profile_id.strip():
            yield profile_id.strip().lower(), entry


def declarations(payload):
    """Ordered (operation, profile) pairs from a capabilities body, or None.

    Only the published shape is read: `models[].operations[<operation>].profiles[]`.
    `stages[]` is deliberately skipped — it is topology, and reading routes or
    names out of it is how the earlier table grew pairs upstream never published.
    A body that declares no profile returns None, which callers must treat as
    "no evidence" rather than "nothing supported". (`resolve()` still reports
    `endpoint=present` for a body that carries operation entries without
    profiles: the service answered, it just did not say which profiles it
    serves, and that is `unknown`, not `absent`.)
    """
    if not isinstance(payload, dict):
        return None
    models = payload.get('models')
    if not isinstance(models, list):
        return None
    pairs: list[tuple[str, str]] = []
    for model in models:
        operations = model.get('operations') if isinstance(model, dict) else None
        if not isinstance(operations, dict):
            continue
        for operation_id, operation in operations.items():
            if not isinstance(operation_id, str) or not operation_id.strip():
                continue
            for profile_id, _ in _profiles(operation):
                pair = (operation_id.strip().lower(), profile_id)
                if pair not in pairs:
                    pairs.append(pair)
    return pairs or None


def _topology(payload):
    """Deployment topology as declared: `[{id, type, depends_on}]`, display only.

    Never consulted for a capability decision. A stage entry that happens to
    carry routes or names is ignored on purpose: those keys do not exist in
    upstream's `CapabilityStage` (`protocol/capabilities.py:67-70`), so honouring
    them would resurrect the stage-keyed reading this module exists to replace.
    `type` falls back to `unknown` the way upstream's own projection does
    (`entrypoints/openai/serving_capabilities.py:86`).
    """
    stages = payload.get('stages') if isinstance(payload, dict) else None
    topology = []
    for entry in stages if isinstance(stages, list) else []:
        stage_id = entry.get('id') if isinstance(entry, dict) else None
        if stage_id is None:
            continue
        depends_on = entry.get('depends_on')
        stage_type = entry.get('type')
        topology.append({
            'id': str(stage_id),
            'type': stage_type if isinstance(stage_type, str) and stage_type else UNKNOWN,
            'depends_on': [str(item) for item in depends_on] if isinstance(depends_on, list) else [],
        })
    return topology


def _operation_verdict(operation):
    """`yes` / `no` / `unknown` for an operation from its own two enums.

    Upstream keeps `support` and `exposure` independent: a supported operation
    can have disabled routes, and an installed route can coexist with an
    unsupported operation (`docs/serving/capabilities.md:45-51`). Either one
    saying no is a definitive no for the deployment as it stands; anything less
    than both saying yes is not enough to claim availability.
    """
    support, exposure = operation.get('support'), operation.get('exposure')
    if support == UNSUPPORTED or exposure == DISABLED:
        return 'no'
    if support == SUPPORTED and exposure == ENABLED:
        return 'yes'
    return 'unknown'


def _profile_verdict(entry, operation_verdict):
    """`yes` / `no` / `unknown` for one profile inside an already-judged operation."""
    if operation_verdict == 'no':
        return 'no'
    support = entry.get('support')
    if support == UNSUPPORTED:
        return 'no'
    if support != SUPPORTED or operation_verdict != 'yes':
        return 'unknown'
    return 'yes'


def _note(unresolved, operation, profile, route, reason):
    """Append a translation failure once; models repeat the same declarations."""
    entry = {'operation': operation, 'profile': profile, 'route': route, 'reason': reason}
    if entry not in unresolved:
        unresolved.append(entry)


def _check_route(operation, profile, path, unresolved):
    """True when `path` is one the operation owns; otherwise report why not."""
    if path in OPERATION_ROUTES[operation]:
        return True
    _note(unresolved, operation, profile, path,
          ROUTE_MISMATCH if path in ROUTED_PATHS else UNKNOWN_ROUTE)
    return False


def resolve(payload):
    """Per-capability availability, the declared topology, and untranslated claims.

    `payload` is the decoded body of `ENDPOINT`, or None when the request failed
    (404, timeout, disabled endpoint). Model names and any other provider fields
    never reach the result.

    `endpoint` is `absent` when the body carries no operation entry at all, and
    then every capability is `unknown` and nothing is listed as unresolved.

    A capability is `available` only when some model's profile says so and its
    operation is enabled; `missing` only when a profile or operation positively
    says no; `unknown` otherwise — no body, an absent field, an unknown enum, an
    unrouted capability, or a declaration this table could not translate.
    """
    vocabulary = classified_capabilities()
    unresolved: list[dict] = []
    topology = _topology(payload)
    evidence: dict[str, set[str]] = {}

    def record(capabilities, verdict):
        for capability in capabilities:
            evidence.setdefault(capability, set()).add(verdict)

    models = payload.get('models') if isinstance(payload, dict) else None
    declared = False
    for model in models if isinstance(models, list) else []:
        operations = model.get('operations') if isinstance(model, dict) else None
        if not isinstance(operations, dict) or not operations:
            continue
        declared = True
        for operation_id, operation in operations.items():
            key = operation_id.strip().lower() if isinstance(operation_id, str) else ''
            if not key:
                continue
            if key not in OPERATIONS:
                _note(unresolved, key, None, None, UNMAPPED_STAGE)
                continue
            if not isinstance(operation, dict):
                for row_operation, _, row_capabilities in OPERATION_PROFILES:
                    if row_operation == key:
                        record(row_capabilities, 'unknown')
                continue
            operation_verdict = _operation_verdict(operation)
            seen = set()
            for profile_id, entry in _profiles(operation):
                seen.add(profile_id)
                owner = PROFILE_OPERATIONS.get(profile_id)
                if owner is None:
                    _note(unresolved, key, profile_id, None, UNKNOWN_PROFILE)
                    continue
                if owner != key:
                    _note(unresolved, key, profile_id, None, OPERATION_MISMATCH)
                    continue
                paths = [path for path in map(route_path, _routes(entry)) if path]
                broken = [path for path in paths if not _check_route(key, profile_id, path, unresolved)]
                verdict = _profile_verdict(entry, operation_verdict)
                capabilities = BY_PAIR[(key, profile_id)]
                # Without a route we cannot confirm reachability, and a profile
                # pointing at another operation's path tells us nothing reliable.
                if verdict != 'no' and (broken or not paths):
                    verdict = 'unknown'
                if capabilities:
                    record(capabilities, verdict)
                elif verdict == 'yes':
                    _note(unresolved, key, profile_id, None, NO_LOCAL_CAPABILITY)
            # A profile the operation never mentions establishes nothing, unless
            # the operation itself refused (`declare_capabilities` fills omitted
            # standard profiles with unsupported upstream, so silence is silence).
            for row_operation, profile_id, row_capabilities in OPERATION_PROFILES:
                if row_operation == key and profile_id not in seen:
                    record(row_capabilities, 'no' if operation_verdict == 'no' else 'unknown')

    if not declared:
        return {'endpoint': ABSENT, 'topology': topology,
                'capabilities': {item: UNKNOWN for item in vocabulary}, 'unresolved': []}
    capabilities = {}
    for item in vocabulary:
        verdicts = evidence.get(item, set())
        if 'yes' in verdicts:
            capabilities[item] = AVAILABLE
        elif item in UNROUTED or 'unknown' in verdicts or not verdicts:
            capabilities[item] = UNKNOWN
        else:
            capabilities[item] = MISSING
    return {'endpoint': PRESENT, 'topology': topology, 'capabilities': capabilities,
            'unresolved': sorted(unresolved, key=lambda item: (item['operation'] or '', item['profile'] or '',
                                                               item['route'] or '', item['reason']))}
