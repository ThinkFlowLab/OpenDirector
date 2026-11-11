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

Five rules keep the table honest.

* The key is `(operation, profile)`, never the route, never the stage.
  `/v1/audio/speech` is the single route of one operation and carries three
  profiles with three different contracts: `text_to_speech` (voice),
  `lyrics_to_music` (music) and `caption_to_audio` (sound effect). A path alone
  cannot say which one was granted, and a deployment can grant one while
  refusing the others (`tests/config/test_serving_capabilities.py:233,251`:
  MOSS-SoundEffect serves `caption_to_audio` and reports `text_to_speech`
  unsupported on the same path).
* A profile is never force-fitted onto a neighbouring id. The three `chat`
  profiles publish different output modalities — `text_response` is `("text",)`,
  `image_response` is `("image",)` and `audio_response` is `("audio",)`
  (`serving_capabilities.py:43-45`) — and `text.chat` is consumed by a
  text-only adapter (`integrations/model_adapters.py:566-580` reads
  `choices[0]["message"]["content"]` as a string), so only `text_response`
  grants it: an image-only chat deployment must not read as able to chat.
  `caption_to_audio` (sound effect) has no id here either. Neither does
  `text_to_audio`: it is the diffusion contract behind `/v1/audio/generate`
  with no lyrics and no `instructions` (`docs/serving/capabilities.md:59-60`),
  while this repository's only `audio.music` adapter posts `/v1/audio/speech`
  with both (`VllmOmniMusic`, `integrations/model_adapters.py:510-537`).
  Mapping it would promise a request the deployment never accepted — the same
  error as pushing `caption_to_audio` onto `audio.speech`.
* A declaration that says nothing is `unknown`, never `missing`. Optional fields
  are simply absent from a published body (`response_model_exclude_none=True`,
  `api_server.py:2193`) and `unknown` is a first-class upstream value
  (`support`, `exposure`; "Missing operations/profiles are unknown",
  `serving_capabilities.py:84`). Required fields are never absent: `support` and
  `reason_code` are mandatory on every operation and on every profile,
  `exposure` on every operation and on every top-level route, and all six
  operations must be listed (`protocol/capabilities.py:24-64`). A profile has no
  `exposure` field of its own (`:36-44`): how reachable it is comes from
  aggregating the exposures of the routes it references. A body that omits a
  required field is malformed input to be defended against, not a shape
  upstream publishes. Only positive evidence produces `missing`, and the result
  keeps the two kinds apart in its `reasons` map: `unsupported` (the model
  refused the profile), `endpoint_disabled` (the deployment switched the
  operation's routes off) and `route_disabled` (every route the profile itself
  declares is switched off).
* A route without an operation proves nothing. `/v1/images/segmentations`,
  `/v1/videos/segmentations` and `/v1/videos/depth` are registered endpoints
  that no operation owns (`docs/serving/capabilities.md:41-43`): "segmentation
  and depth estimation do not acquire one of these operations merely by being
  present in a registry". Those capabilities stay `unknown` with
  `no_upstream_profile`.
* Reachability is decided on the profile's own route references, and their
  `exposure` is read. Every declared route `disabled` means `missing` with
  `route_disabled`; every route `unknown` (or no route at all) means `unknown`,
  because reachability cannot be confirmed; one `enabled` owned route is enough.
  A route this table does not recognise is reported in `unresolved`, and its own
  `exposure` still counts: such a route saying `enabled` (or nothing) is a
  channel this table cannot judge, so owned routes that are all `disabled` are
  not proof of absence and the profile stays `unknown` instead of `missing`. A
  profile that already answered stays `available` either way: upstream adds
  routes over time, and one new path must not void a confirmed profile.

`asr` is not an omission on this side: upstream publishes no recognition
operation at all (`OperationId` is a closed `Literal`) and the omni router never
registers `/v1/audio/transcriptions` (no `@router` decorator in `api_server.py`;
`recipes/inclusionAI/Ming-3.0-audio-flash.md:331` says the endpoint "is not
currently available with `--omni`"). A body naming it is outside the vocabulary
and is recorded as `unmapped_stage`. `audio.score` therefore cannot be judged
from this endpoint: this repository's `VllmOmniScore` adapter does post to
`/audio/transcriptions` (`integrations/model_adapters.py:547,556`), but a
capabilities body never mentions that path, so the id stays `unknown` with
`no_upstream_operation` instead of being derived from a route we happen to know.

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
# including the ones for which this repository has no capability id yet: an empty
# tuple is the honest answer ("upstream says it can, we cannot name it"), and a
# supported declaration of such a profile is reported as `no_local_capability`
# rather than dropped or force-fitted to a neighbouring id.
#
# `image_response` / `audio_response` are empty on purpose. They are chat
# profiles whose published output is an image or an audio clip
# (`serving_capabilities.py:44-45`), while `text.chat` here is served by a
# text-only adapter: mapping them would make an image-only deployment read as
# able to chat, and would contradict this module's own refusal to push
# `caption_to_audio` onto `audio.speech`.
#
# `caption_to_audio` is a sound-effect contract, not speech: MOSS-SoundEffect
# overrides its `required_inputs` with `ambient_sound`
# (`model_executor/models/moss_tts/pipeline.py:205`), and mapping it onto
# `audio.speech` would let a request carry a voice the deployment never accepted.
# `text_to_audio` is empty for the same kind of reason. It is the separate
# diffusion contract behind `/v1/audio/generate`, with no lyrics and no
# `instructions` (`docs/serving/capabilities.md:59-60`), while the only
# `audio.music` adapter here (`VllmOmniMusic`, `integrations/model_adapters.py:510-537`)
# posts `/v1/audio/speech` with lyrics *and* `instructions`, both required. A
# deployment publishing `text_to_audio` cannot answer that request, so calling it
# `audio.music` would be a false `available` — the same error as pushing
# `caption_to_audio` onto `audio.speech`. Such a deployment reports
# `no_local_capability`, and `audio.music` keeps whatever `lyrics_to_music`
# says (no evidence -> `unknown`) rather than being granted by a neighbour.
#
# The three `video_generation` profiles are told apart the way the adapter tells
# their requests apart (`VllmOmniVideo.video` / `.edit_video`,
# `integrations/model_adapters.py:467-590`): `text_to_video` sends no reference
# and `task=t2va`, `image_to_video` sends `input_reference` and `task=fl2va`
# (first frame), `video_to_video` sends `source_video` plus the frame and audio
# masks. That is the same pairing the application already uses when it turns a
# capability into a request (`application/model_availability.py:109-112`), so one
# profile grants exactly one id here: an image-to-video deployment is not a
# text-to-video one, and a video-to-video deployment is not either.
OPERATION_PROFILES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ('chat', 'text_response', ('text.chat',)),
    ('chat', 'image_response', ()),
    ('chat', 'audio_response', ()),
    ('image_generation', 'text_to_image', ('image.generate',)),
    ('image_edit', 'image_to_image', ('image.edit',)),
    ('video_generation', 'text_to_video', ('video.generate',)),
    ('video_generation', 'image_to_video', ('video.first_frame',)),
    ('video_generation', 'video_to_video', ('video.edit',)),
    ('speech', 'text_to_speech', ('audio.speech',)),
    ('speech', 'lyrics_to_music', ('audio.music',)),
    ('speech', 'caption_to_audio', ()),
    ('audio_generation', 'text_to_audio', ()),
)

# operation → the routes that operation owns, as `(transport, method, path)`
# (`entrypoints/openai/serving_capabilities.py:42-54`). Kept beside the profile
# table so a declared profile can be checked against the operation it claims: a
# profile pointing at another operation's path, or declaring a method or a
# transport the operation does not serve, is a declaration error, not a
# capability. The websocket route's `method` literal is `WEBSOCKET`
# (`protocol/capabilities.py:17`), which is why the method is compared and not
# merely the path: `DELETE /v1/chat/completions` is a 405, not chat.
# Routes registered but owned by no operation (`/v1/audio/speech/batch`,
# `/v1/chat/completions/batch`, the `segmentations`/`depth` endpoints, …) belong
# to no value of this map, which is exactly why they cannot grant anything.
OPERATION_ROUTES: dict[str, tuple[tuple[str, str, str], ...]] = {
    'chat': (('http', 'POST', '/v1/chat/completions'),),
    'image_generation': (('http', 'POST', '/v1/images/generations'),),
    'image_edit': (('http', 'POST', '/v1/images/edits'),),
    'video_generation': (('http', 'POST', '/v1/videos'),
                         ('http', 'POST', '/v1/videos/sync'),
                         ('websocket', 'WEBSOCKET', '/v1/realtime/video')),
    'speech': (('http', 'POST', '/v1/audio/speech'),),
    'audio_generation': (('http', 'POST', '/v1/audio/generate'),),
}

AVAILABLE, MISSING, UNKNOWN = 'available', 'missing', 'unknown'
# `absent`: the endpoint did not answer (404, timeout, no capability body).
# `empty`: it answered with a model list but no model declared an operation.
# `present`: at least one model declared operations.
ABSENT, EMPTY, PRESENT = 'absent', 'empty', 'present'

# Upstream's three-valued vocabulary, shared by `support` and `exposure`
# (`serving_capabilities.py:16`, `protocol/capabilities.py:13`).
SUPPORTED, UNSUPPORTED = 'supported', 'unsupported'
ENABLED, DISABLED = 'enabled', 'disabled'
# `unknown` is the third value of both, and also the state of an absent field.
ROUTE_UNKNOWN = UNKNOWN

# Upstream's `transport` vocabulary (`protocol/capabilities.py:17`).
HTTP, WEBSOCKET = 'http', 'websocket'

# Why a declaration could not be translated. Each names a different fix, so a
# reviewer can tell an upstream gap from a bug in this table.
UNKNOWN_ROUTE = 'unknown_route'  # the path belongs to no operation at all
ROUTE_MISMATCH = 'route_mismatch'  # path, transport or method belongs to another operation
UNMAPPED_STAGE = 'unmapped_stage'  # no such operation upstream (e.g. `asr`); `stage` is the old name
UNKNOWN_PROFILE = 'unknown_profile'  # operation known, profile id not published
OPERATION_MISMATCH = 'operation_mismatch'  # profile known under another operation
NO_LOCAL_CAPABILITY = 'no_local_capability'  # upstream profile, no id here
NO_ROUTE_DECLARED = 'no_route_declared'  # supported profile that declares no route at all
MALFORMED_ROUTE = 'malformed_route'  # a route entry without a usable path
REASONS = frozenset({UNKNOWN_ROUTE, ROUTE_MISMATCH, UNMAPPED_STAGE, UNKNOWN_PROFILE, OPERATION_MISMATCH,
                     NO_LOCAL_CAPABILITY, NO_ROUTE_DECLARED, MALFORMED_ROUTE})

# Why a capability can never be decided from a declaration here.
NO_UPSTREAM_PROFILE, NO_UPSTREAM_OPERATION = 'no_upstream_profile', 'no_upstream_operation'
PARAMETER_ONLY, NO_LOCAL_ADAPTER = 'parameter_only', 'no_local_adapter'
UNROUTED_REASONS = frozenset({NO_UPSTREAM_PROFILE, NO_UPSTREAM_OPERATION, PARAMETER_ONLY, NO_LOCAL_ADAPTER})

# Why a capability is `missing`. `support=unsupported` and `exposure=disabled`
# are both a positive no, but they are not the same fact: one is the model, the
# other is the deployment's switch. Kept apart in `resolve()['reasons']`, most
# specific first, so a screen can say "this deployment turned it off" instead of
# "this model cannot do it".
UNSUPPORTED_REASON = 'unsupported'
ENDPOINT_DISABLED_REASON = 'endpoint_disabled'
ROUTE_DISABLED_REASON = 'route_disabled'
MISSING_REASONS = (UNSUPPORTED_REASON, ENDPOINT_DISABLED_REASON, ROUTE_DISABLED_REASON)

# Capability ids no upstream profile can express, with the reason to show. Values
# stay stable business codes; wording lives in the message catalogs. Every entry
# here resolves to `unknown`: the endpoint does not publish the ability, so
# "cannot judge" is the only defensible state. None of these ids is a value of
# `OPERATION_PROFILES`, which is what makes `unknown` fall out of "no evidence"
# rather than out of a special case in `resolve()`.
UNROUTED: dict[str, str] = {
    # Endpoints exist, but no operation owns them (see the module docstring).
    'image.segment': NO_UPSTREAM_PROFILE,
    'video.matting': NO_UPSTREAM_PROFILE,
    'video.motion_capture': NO_UPSTREAM_PROFILE,
    # Upstream publishes no transcription operation at all.
    'audio.score': NO_UPSTREAM_OPERATION,
    # Request field of an operation that does publish a profile.
    'image.cutout': PARAMETER_ONLY,
    # No adapter here offers it; upstream says nothing either way.
    'audio.separate': NO_LOCAL_ADAPTER,
}

BY_PAIR: dict[tuple[str, str], tuple[str, ...]] = {(operation, profile): capabilities
                                                  for operation, profile, capabilities in OPERATION_PROFILES}


def _reverse() -> dict[str, tuple[tuple[str, str], ...]]:
    """Capability id -> every `(operation, profile)` pair that supplies it, in table order."""
    reverse: dict[str, list[tuple[str, str]]] = {}
    for operation, profile, capabilities in OPERATION_PROFILES:
        for capability in capabilities:
            reverse.setdefault(capability, []).append((operation, profile))
    return {capability: tuple(pairs) for capability, pairs in reverse.items()}


BY_CAPABILITY: dict[str, tuple[tuple[str, str], ...]] = _reverse()
PROFILE_OPERATIONS: dict[str, str] = {profile: operation for operation, profile, _ in OPERATION_PROFILES}
ROUTED_PATHS = frozenset(path for routes in OPERATION_ROUTES.values() for _, _, path in routes)


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


def _route_key(value):
    """`(transport, method, path)` of a declared route; path is None when unusable.

    `transport` defaults to `http` upstream (`protocol/capabilities.py:16-21`), so
    an absent transport is not a mismatch. `method` has no default there: an
    absent or blank method cannot be confirmed, and is compared as an empty
    string that matches no owned route.
    """
    transport = value.get('transport') if isinstance(value, dict) else None
    method = value.get('method') if isinstance(value, dict) else None
    transport = transport.strip().lower() if isinstance(transport, str) and transport.strip() else HTTP
    method = method.strip().upper() if isinstance(method, str) and method.strip() else ''
    return transport, method, route_path(value)


def _route_exposure(value):
    """Declared exposure of one route reference; absent is `unknown` (the upstream default)."""
    exposure = value.get('exposure') if isinstance(value, dict) else None
    return exposure if exposure in (ENABLED, DISABLED) else ROUTE_UNKNOWN


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


def candidates_for(capability_id):
    """Every `(operation, profile)` pair that supplies one capability id, in table order.

    The reverse of `capabilities_for`: callers that start from a local
    configuration (`requests_for()`) need to know which pairs could serve the
    capability they intend to use. `()` means no profile supplies the id — it is
    one of the `UNROUTED` ids, whose reason says why. A candidate is a
    *declaration* slot, not an authorisation: the adapter for the configured
    model still decides the route, the transmitted inputs and the output, and a
    per-request check must still confirm the selected pair is the one admitted.
    """
    if not isinstance(capability_id, str):
        return ()
    return BY_CAPABILITY.get(capability_id.strip(), ())


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
    """`(verdict, reason)` for an operation from its own two enums.

    Upstream keeps `support` and `exposure` independent: a supported operation
    can have disabled routes, and an installed route can coexist with an
    unsupported operation (`docs/serving/capabilities.md:45-51`). Either one
    saying no is a definitive no for the deployment as it stands — but the reason
    says which: the model refused, or the deployment closed the route.
    """
    support, exposure = operation.get('support'), operation.get('exposure')
    if support == UNSUPPORTED:
        return 'no', UNSUPPORTED_REASON
    if exposure == DISABLED:
        return 'no', ENDPOINT_DISABLED_REASON
    if support == SUPPORTED and exposure == ENABLED:
        return 'yes', None
    return 'unknown', None


def _profile_verdict(entry, operation_verdict, operation_reason, exposures, unrecognised=()):
    """`(verdict, reason)` for one profile inside an already-judged operation.

    `exposures` holds one value per route reference the operation owns, and
    `unrecognised` one per declared route this table could not place: an empty
    `exposures` means the profile declared no usable route of its own.
    """
    support = entry.get('support')
    if support == UNSUPPORTED:
        return 'no', UNSUPPORTED_REASON
    if operation_verdict == 'no':
        return 'no', operation_reason
    if support != SUPPORTED or operation_verdict != 'yes':
        return 'unknown', None
    if ENABLED in exposures:
        return 'yes', None
    # A route this table cannot place still states whether it is switched on.
    # One saying `enabled` (or nothing) is a channel whose reachability cannot be
    # confirmed, so owned routes that are all `disabled` are not proof of
    # absence: `unknown`, never `missing`.
    if ENABLED in unrecognised or ROUTE_UNKNOWN in unrecognised:
        return 'unknown', None
    if not exposures:
        return 'unknown', None
    if ROUTE_UNKNOWN in exposures:
        return 'unknown', None
    return 'no', ROUTE_DISABLED_REASON


def _note(unresolved, operation, profile, route, reason):
    """Append a translation failure once; models repeat the same declarations."""
    entry = {'operation': operation, 'profile': profile, 'route': route, 'reason': reason}
    if entry not in unresolved:
        unresolved.append(entry)


def _check_route(operation, profile, key, unresolved):
    """True when `(transport, method, path)` is one the operation owns; else report why not."""
    if key in OPERATION_ROUTES[operation]:
        return True
    path = key[2]
    _note(unresolved, operation, profile, path,
          ROUTE_MISMATCH if path in ROUTED_PATHS else UNKNOWN_ROUTE)
    return False


def _route_exposures(operation, profile, entry, unresolved):
    """`(owned route exposures, unrecognised route exposures, any path declared)`.

    A route reference whose path cannot be read is reported rather than dropped:
    silently ignoring it would turn a broken declaration into `unknown` with no
    explanation, which is the failure this module exists to prevent.

    Routes the operation does not own are reported too, and their `exposure` is
    kept in its own list: they may not grant a capability, but they can still
    say that a channel exists, which is what keeps known-but-off routes from
    being read as a refusal (see `_profile_verdict`).
    """
    exposures = []
    unrecognised = []
    declared_path = False
    for value in _routes(entry):
        key = _route_key(value)
        if key[2] is None:
            _note(unresolved, operation, profile, None, MALFORMED_ROUTE)
            continue
        declared_path = True
        if _check_route(operation, profile, key, unresolved):
            exposures.append(_route_exposure(value))
        else:
            unrecognised.append(_route_exposure(value))
    return exposures, unrecognised, declared_path


def resolve(payload):
    """Per-capability availability, the declared topology, and untranslated claims.

    `payload` is the decoded body of `ENDPOINT`, or None when the request failed
    (404, timeout, disabled endpoint). Model names and any other provider fields
    never reach the result.

    `endpoint` separates "did not answer" from "answered without declaring":
    `absent` when there is no body or no model list at all, `empty` when a model
    list came back but no model declared an operation, `present` otherwise. In
    the first two cases every capability is `unknown`, `reasons` is empty and
    nothing is listed as unresolved.

    A capability is `available` only when some model's profile says so, its
    operation is enabled and at least one of its own routes is enabled;
    `missing` only when a profile or operation positively says no, with the kind
    of refusal in `reasons` (`unsupported`, `endpoint_disabled`,
    `route_disabled`); `unknown` otherwise — no body, an absent field, an unknown
    enum, an unrouted capability, or a declaration this table could not
    translate.
    """
    vocabulary = classified_capabilities()
    unresolved: list[dict] = []
    topology = _topology(payload)
    evidence: dict[str, set[str]] = {}
    refusals: dict[str, set[str]] = {}

    def record(capabilities, verdict, reason=None):
        for capability in capabilities:
            evidence.setdefault(capability, set()).add(verdict)
            if verdict == 'no' and reason:
                refusals.setdefault(capability, set()).add(reason)

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
            operation_verdict, operation_reason = _operation_verdict(operation)
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
                exposures, unrecognised, declared_path = _route_exposures(key, profile_id, entry, unresolved)
                verdict, reason = _profile_verdict(entry, operation_verdict, operation_reason, exposures,
                                                   unrecognised)
                # A supported profile that declares no route at all: reachability
                # cannot be confirmed, and nothing else explains the `unknown`.
                if verdict == 'unknown' and not exposures and not declared_path:
                    _note(unresolved, key, profile_id, None, NO_ROUTE_DECLARED)
                capabilities = BY_PAIR[(key, profile_id)]
                if capabilities:
                    record(capabilities, verdict, reason)
                elif verdict == 'yes':
                    _note(unresolved, key, profile_id, None, NO_LOCAL_CAPABILITY)
            # A profile the operation never mentions establishes nothing, unless
            # the operation itself refused (`declare_capabilities` fills omitted
            # standard profiles with unsupported upstream, so silence is silence).
            for row_operation, profile_id, row_capabilities in OPERATION_PROFILES:
                if row_operation == key and profile_id not in seen:
                    if operation_verdict == 'no':
                        record(row_capabilities, 'no', operation_reason)
                    else:
                        record(row_capabilities, 'unknown')

    if not declared:
        # `models` being a list is the service answering; no operations at all
        # means it answered without declaring anything, which is not the same as
        # never having answered.
        endpoint = EMPTY if isinstance(models, list) else ABSENT
        return {'endpoint': endpoint, 'topology': topology, 'capabilities': {item: UNKNOWN for item in vocabulary},
                'reasons': {}, 'unresolved': []}
    capabilities = {}
    reasons = {}
    for item in vocabulary:
        verdicts = evidence.get(item, set())
        if 'yes' in verdicts:
            capabilities[item] = AVAILABLE
        elif ROUTE_UNKNOWN in verdicts or not verdicts:
            capabilities[item] = UNKNOWN
        else:
            capabilities[item] = MISSING
            refusal = refusals.get(item, set())
            reason = next((name for name in MISSING_REASONS if name in refusal), None)
            if reason:
                reasons[item] = reason
    return {'endpoint': PRESENT, 'topology': topology, 'capabilities': capabilities, 'reasons': reasons,
            'unresolved': sorted(unresolved, key=lambda item: (item['operation'] or '', item['profile'] or '',
                                                               item['route'] or '', item['reason']))}
