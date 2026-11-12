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

Nine rules keep the table honest.

* The key is `(operation, profile)`, never the route, never the stage.
  `/v1/audio/speech` is the single route of one operation and carries three
  profiles with three different contracts: `text_to_speech` (voice),
  `lyrics_to_music` (music) and `caption_to_audio` (sound effect). A path alone
  cannot say which one was granted, and a deployment can grant one while
  refusing the others (`tests/config/test_serving_capabilities.py:251,270`:
  MOSS-SoundEffect serves `caption_to_audio` and reports `text_to_speech`
  unsupported on the same path).
* A profile is never force-fitted onto a neighbouring id. The three `chat`
  profiles publish different output modalities — `text_response` is `("text",)`,
  `image_response` is `("image",)` and `audio_response` is `("audio",)`
  (`serving_capabilities.py:43-45`) — and `text.chat` is consumed by a
  text-only adapter (`integrations/model_adapters.py:631-647` reads
  `choices[0]["message"]["content"]` as a string), so only `text_response`
  grants it: an image-only chat deployment must not read as able to chat.
  `caption_to_audio` (sound effect) has no id here either. Neither does
  `text_to_audio`: it is the diffusion contract behind `/v1/audio/generate`
  with no lyrics and no `instructions` (`docs/serving/capabilities.md:59-60`),
  while this repository's only `audio.music` adapter posts `/v1/audio/speech`
  with both (`VllmOmniMusic`, `integrations/model_adapters.py:573-604`).
  Mapping it would promise a request the deployment never accepted — the same
  error as pushing `caption_to_audio` onto `audio.speech`.
* A declaration that says nothing is `unknown`, never `missing`. Optional fields
  are simply absent from a published body (`response_model_exclude_none=True`,
  `api_server.py:2196`) and `unknown` is a first-class upstream value
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
  operation's routes off) and `route_disabled` (every route of the profile this
  tool can actually reach — `POSTABLE_ROUTES` — is switched off; a socket or
  `/v1/videos/sync` saying `enabled` cannot reopen one, since this table never
  opens it).
* A route without an operation proves nothing. `/v1/images/segmentations`,
  `/v1/videos/segmentations` and `/v1/videos/depth` are registered endpoints
  that no operation owns (`docs/serving/capabilities.md:41-43`): "segmentation
  and depth estimation do not acquire one of these operations merely by being
  present in a registry". Those capabilities stay `unknown` with
  `no_upstream_profile`.
* Reachability is decided on the profile's own **postable** route references,
  and their `exposure` is read. `POSTABLE_ROUTES` names the tool request route
  this contract recognises for each operation, which today is the one http route
  this repository's adapter actually posts; `audio_generation` is the one
  exception, because upstream publishes `/v1/audio/generate` and this repository
  has no adapter that posts it (no `audio/generate` literal outside this
  module) — the operation keeps its placement row so the declaration still has
  somewhere to be read. Only a declaration equal to one of those is evidence.
  `/v1/videos/sync`, the `websocket
  /v1/realtime/video`, another operation's path and a different method are
  declarations of channels this tool never uses: they are reported
  (`route_mismatch`, or `unknown_route` when no operation owns the path, or
  `malformed_route` when it has no usable transport, method or path) and they
  change nothing — they neither grant a capability, nor refuse one, nor keep a
  row undecided. `transport` is the only route field whose *absence* has an
  upstream default (`http`, `protocol/capabilities.py:16-21`), so a reference
  that omits the key still names the http route; `method` has no default at all
  and `path` has none either, so an absent one of those cannot be confirmed. A
  `transport` that is *present but unreadable* — anything that is not `http` or
  `websocket` once stripped and lower-cased (`''`, a blank string, `0`, `False`,
  `[]`, `'bogus'`, `'http/2'`), `None` included, because upstream's non-`None`
  default gives `response_model_exclude_none=True` nothing to drop there and
  only a proxy or a cache hands one over — is not that default: it is a broken
  reference, reported `malformed_route` and counted nowhere, because reading an
  unreadable value as `http` would be the one place in this module where a
  malformed declaration turns into evidence. Every
  postable route `disabled`
  means `missing` with `route_disabled`; a postable route whose `exposure` is
  `unknown` or absent means `unknown`, because reachability cannot be confirmed;
  one `enabled` postable route is enough. A profile that declares no postable
  route at all — no routes, no usable path, only sync, only a socket, only some
  other operation's path — is `unknown` with `no_route_declared`, never
  `missing`: nothing this tool can post to was closed, because nothing this tool
  posts to was declared. Those three fields — `transport`, `method`, `path` —
  are *reported* when absent or unreadable, not folded into a verdict; `support`
  and `exposure` are the fields that fold, and the next rule says how.
* `support` and `exposure` each have three ways of saying "not confirmed", and
  this table folds them into one answer: the field absent, an enum value it does
  not recognise, and the literal `unknown` all read as `unknown`
  (`_route_exposure`, `_declared_support`, both built on the shared normalized
  readers `_exposure()` and `_support()`). The same vocabulary is read the same
  way at every level — a route reference, a profile and an operation all go
  through those two readers, so a padded or upper-cased `' enabled'` means the
  same thing at each of them and no level is stricter than another. The fold is
  a decision, not an oversight — upstream defaults `exposure` to `unknown` and
  publishes `unknown` as a first-class value of both enums, so the three arrive
  as the same declaration, and a row that lands in the fold is not attributed a
  note for being one rather than another. A caller that needs to know which of
  the three a body actually wrote has to read the body: this table says what the
  declaration means, not what it looked like.
* A role has to come from the one postable route. A capability in
  `REQUIRED_ROLES` names request roles upstream may not publish, and a request
  leaves on exactly one route: the profile's own postable route has to declare
  every required role with `support=supported`. Roles gathered from different
  routes are not a request, and a role named on `/v1/videos/sync` or on the
  socket is not a role this tool's request can carry either, because the adapter
  posts to neither — such a declaration is a note, never a grant and never a
  doubt. Silence, an absent `support` and `support=unknown` all keep the id
  `unknown`; when the postable route is open and refuses at least one required
  role, the document has said no — including when it says nothing about the
  other roles — and the id is `missing` with `unsupported`, because "the
  deployment refuses that input" needs a different fix from "the document does
  not say". The count bound published beside
  `support` is part of that answer: a role declared supported with
  `max_count: 0` cannot carry the one item the tool sends and is a refusal in
  effect. On an entry that says `supported`, a bound this table cannot read — a
  negative count, a `min_count` greater than `max_count`, a fractional value, a bool,
  a numeric string — decides nothing of its own: it can neither grant the role
  nor turn it into a refusal, so the id follows the rest of the declaration
  (`missing` when the same route still refuses another required role — one
  refusal is enough — otherwise `unknown`, and `available` only from another
  model that declares the whole set; a profile's own reachability is decided
  before this gate, so a closed profile stays `missing` whatever its roles say).
  An explicit
  `unsupported` refuses whatever its counts say: that refusal comes from
  `support`, not from the bound.
* A capability is granted by one model and refused by all of them. Several
  models are alternatives, so any one saying `supported` with an open route is
  `available`; the mirror is that `missing` needs every model to say no. A model
  that does not mention an operation — or lists no operation at all — says
  nothing about it, so the id stays `unknown`: the deployment may still serve it
  from that model.
* A body is read only in the envelope it was reviewed in. `object` and
  `schema_version` are upstream's version gate (`protocol/capabilities.py:73-79`),
  so a body naming another object or version is `unreadable` with
  `unsupported_format` and its `models` are never read: a newer shape read as v1
  would grant ids from a declaration nobody reviewed. A body that names neither
  key is read as v1: upstream's response model always emits both, so a missing
  envelope cannot be told apart from a v1 body a proxy stripped, and refusing it
  would reclassify the bodies the `absent` and `empty` states exist for.

`asr` is not an omission on this side: upstream publishes no recognition
operation at all (`OperationId` is a closed `Literal`) and the omni router never
registers `/v1/audio/transcriptions` (no `@router` decorator in `api_server.py`;
`recipes/inclusionAI/Ming-3.0-audio-flash.md:331` says the endpoint "is not
currently available with `--omni`"). A body naming it is outside the vocabulary
and is recorded as `unmapped_stage`. `audio.score` therefore cannot be judged
from this endpoint: this repository's `VllmOmniScore` adapter does post to
`/audio/transcriptions` (`integrations/model_adapters.py:605-628`, POST at `:620`), but a
capabilities body never mentions that path, so the id stays `unknown` with
`no_upstream_operation` instead of being derived from a route we happen to know.

Not yet confirmed upstream (recorded here instead of assumed): the exact
`observed_at` string format, whether `stages[].type` is ever the `"unknown"`
fallback, and whether a multi-model deployment can differentiate `operations`
per model. This module reads only what a body actually states, so the first two
gaps stay `unknown` rather than becoming policy; for the third it reads each
model's `operations` as that model's own declaration (see the rule above) and
makes no claim about why two models would differ.
"""

ENDPOINT = '/v1/omni/capabilities'
API_PREFIX = '/v1'
# The envelope this table reviewed: `object: "omni.capabilities"`,
# `schema_version: 1` (`protocol/capabilities.py:73-79`). A body naming another
# object or version is a different contract, not a newer copy of this one.
ENVELOPE_OBJECT = 'omni.capabilities'
ENVELOPE_VERSION = 1

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
# `audio.music` adapter here (`VllmOmniMusic`, `integrations/model_adapters.py:573-604`)
# posts `/v1/audio/speech` with lyrics *and* `instructions`, both required. A
# deployment publishing `text_to_audio` cannot answer that request, so calling it
# `audio.music` would be a false `available` — the same error as pushing
# `caption_to_audio` onto `audio.speech`. Such a deployment reports
# `no_local_capability`, and `audio.music` keeps whatever `lyrics_to_music`
# says (no evidence -> `unknown`) rather than being granted by a neighbour.
#
# The three `video_generation` profiles are told apart the way the adapter tells
# their requests apart (`VllmOmniVideo.video` / `.edit_video`,
# `integrations/model_adapters.py:405-540`): `text_to_video` sends no reference
# and `task=t2va`, `image_to_video` sends `input_reference` and `task=fl2va`
# (first frame), `video_to_video` sends `source_video` plus the frame and audio
# masks. That is the pairing `application/tool_tasks.py:362` already makes when it
# picks the capability for a request, so one profile grants exactly one id here: an image-to-video deployment is not a
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
# (`entrypoints/openai/serving_capabilities.py:42-54`). Kept for *placement* and
# for the mismatch report: a path in `ROUTED_PATHS` belongs to an operation, so a
# declaration that is not a postable route of the operation it is filed under is
# `route_mismatch` rather than `unknown_route`. Ownership is not evidence — see
# `POSTABLE_ROUTES`. The websocket route's `method` literal is `WEBSOCKET`
# (`entrypoints/openai/serving_capabilities.py:50`); the `transport` field it sits
# in is `Literal["http", "websocket"]` (`protocol/capabilities.py:17`), which is
# why the method is compared and not merely the path:
# `DELETE /v1/chat/completions` is a 405, not chat.
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

# operation → the tool request route this contract recognises, and therefore the
# whole of the evidence question. Today that equals the one http route this
# repository's adapter actually posts — `VllmOmniVideo` posts `/videos` only
# (`integrations/model_adapters.py:456`), and
# `grep -rn "videos/sync" packages apps` finds the contract table and nothing
# else in this repository — with one exception, `audio_generation`:
# `POST /v1/audio/generate` is an upstream route this repository has no adapter
# for (`grep -rn "audio/generate" packages apps --include=*.py` prints this
# module and nothing else), and it stays here so the published operation keeps a
# placement row instead of losing its declaration. Everything else an operation
# owns is a channel some other client uses: `/v1/videos/sync` is the synchronous
# variant of `/v1/videos` and `/v1/realtime/video` is a websocket. A declaration
# outside these tuples is reported — `route_mismatch` when the path belongs to a
# known operation, `unknown_route` when it does not — and is evidence in neither
# direction: it cannot grant a capability, cannot refuse one, and cannot leave
# one undecided.
POSTABLE_ROUTES: dict[str, tuple[tuple[str, str, str], ...]] = {
    'chat': (('http', 'POST', '/v1/chat/completions'),),
    'image_generation': (('http', 'POST', '/v1/images/generations'),),
    'image_edit': (('http', 'POST', '/v1/images/edits'),),
    'video_generation': (('http', 'POST', '/v1/videos'),),
    'speech': (('http', 'POST', '/v1/audio/speech'),),
    'audio_generation': (('http', 'POST', '/v1/audio/generate'),),
}

AVAILABLE, MISSING, UNKNOWN = 'available', 'missing', 'unknown'
# `absent`: the endpoint did not answer (404, timeout, no capability body).
# `empty`: it answered with a model list but no model declared an operation.
# `present`: at least one model declared operations.
ABSENT, EMPTY, PRESENT = 'absent', 'empty', 'present'
# `unreadable`: the endpoint answered in an envelope this table does not read —
# `object` or `schema_version` names another contract. Not `absent` (it did
# answer) and not `present` (nothing in it could be read).
UNREADABLE = 'unreadable'

# Upstream's three-valued vocabulary, shared by `support` and `exposure`
# (`serving_capabilities.py:16`, `protocol/capabilities.py:13`).
SUPPORTED, UNSUPPORTED = 'supported', 'unsupported'
ENABLED, DISABLED = 'enabled', 'disabled'
# `unknown` is the third value of both, and also the state of an absent field.
ROUTE_UNKNOWN = UNKNOWN

# Upstream's `transport` vocabulary (`protocol/capabilities.py:17`), read as a
# closed set: `Literal["http", "websocket"]`. A reference outside it — including
# a value that only looks like `http` under a lenient coercion — is unreadable
# (`malformed_route`), never the default.
HTTP, WEBSOCKET = 'http', 'websocket'

# Why a declaration could not be translated. Each names a different fix, so a
# reviewer can tell an upstream gap from a bug in this table.
UNKNOWN_ROUTE = 'unknown_route'  # the path belongs to no operation at all
ROUTE_MISMATCH = 'route_mismatch'  # path, transport or method belongs to another operation
UNMAPPED_STAGE = 'unmapped_stage'  # no such operation upstream (e.g. `asr`); `stage` is the old name
UNKNOWN_PROFILE = 'unknown_profile'  # operation known, profile id not published
OPERATION_MISMATCH = 'operation_mismatch'  # profile known under another operation
NO_LOCAL_CAPABILITY = 'no_local_capability'  # upstream profile, no id here
NO_ROUTE_DECLARED = 'no_route_declared'  # supported profile with no postable route
# A `routes` field that is not a list at all (a dict, a string, `null`), or a
# route entry with no usable `transport`, `method` or `path`. All are shapes
# upstream cannot publish — `routes` is `list[CapabilityRouteReference]`,
# `method`/`path` are required on every reference and `transport` is a closed
# literal (`protocol/capabilities.py`) — so a declaration this table cannot read
# is reported instead of dropped, which would turn a broken reference into
# `unknown` with no explanation. A route whose `path` is readable but whose
# `method` or `transport` is not is *not* `route_mismatch`: that name says the
# declaration belongs to another operation, and an unreadable field says only
# that the field cannot be confirmed. Those three fields — `transport`, `method`,
# `path` — degrade here, because they are the key this table compares and an
# unreadable one leaves nothing to compare: `transport` is the one field with an
# upstream default (`http`), so its *absence* is legal while a present value that
# is not `http` or `websocket` once normalized (`''`, a blank string, `0`,
# `False`, `[]`, `'bogus'`, `'http/2'`) is a broken reference; `method` and
# `path` have no default at all, so absence and unreadability are equally
# unconfirmed for them. `support` and `exposure` do not degrade
# — an absent or unrecognised one is the fold described at `_route_exposure`.
MALFORMED_ROUTE = 'malformed_route'
# A postable route whose `exposure` is `unknown` or absent: the profile's
# verdict is `unknown` because that route may still serve, and this name is what
# lets a caller attribute the `unknown` to a channel instead of an empty report.
# `unknown` is the upstream default for the field (`exposure: Exposure =
# "unknown"`), so this is not a shape upstream refuses to publish — a defensive
# projection, or a proxy that dropped an optional field, can hand one over — and
# an absent value is read as that same default rather than as a schema error. Not
# a refusal — the route is undecided, not closed — and reported only when the
# `unknown` is this route's: never beside a positive no, and never when the
# profile itself declares `support=unknown`.
EXPOSURE_UNKNOWN = 'exposure_unknown'
# The profile is published and supported, but this id needs a request role the
# profile's postable route does not declare as supported (see `REQUIRED_ROLES`):
# the role is absent, its `support` is absent or unrecognised, it is declared only
# on `/v1/videos/sync` or on the socket, or it is declared `supported` behind a
# count window this table cannot read. Not a refusal: `unknown`. A document whose
# postable route refuses at least one required role is not reported here
# — that is a `missing` verdict with `unsupported`, the same answer a refusing
# profile gets.
ROLE_NOT_DECLARED = 'role_not_declared'
# The body answered in a different contract: `object` or `schema_version` is not
# the one this table reviewed. Reading its `models` anyway would grant
# capabilities from a shape nobody checked, so the whole body is refused once.
UNSUPPORTED_FORMAT = 'unsupported_format'
# A `models[]` element that is not a model: not an object, no `operations` object,
# or an empty one. Upstream lists all six operations on every model, so such an
# element is a shape this table does not read. Reported once, and only when
# another model declared operations — a body where nothing was declared is the
# `empty` endpoint state, not a malformed one — and its silence is kept as
# `unknown`: a broken element must not let another model's refusal harden into
# `missing`, and it must not vanish without a word either.
MALFORMED_MODEL = 'malformed_model'
# A `profiles[]` element whose `id` cannot be read — not an object, no `id`, or a
# blank one — or a `profiles` field that is not a list at all (a dict, a string,
# `null`). Dropped in silence it leaves the operation's ids `unknown` with an
# empty report, which is the failure this module exists to prevent: upstream
# names every profile it publishes, so an element this table cannot name is a
# declaration somebody broke. Reported once per operation, with the operation it
# was declared under and no profile and no route, because the broken element has
# neither a readable name nor a route. `profiles: []` stays silent: a published
# empty list is a legal answer, not a broken one.
MALFORMED_PROFILE = 'malformed_profile'
# An `operations[<operation>]` value that is not an object at all (a string, a
# list, `null`) or is an empty object. The operation's ids stay `unknown` and
# every other row is read as usual; without this name the doubt would have no
# attribution, so it is reported once per operation, with no profile and no
# route, beside `malformed_profile`. `{}` belongs here rather than in
# `malformed_profile`: upstream always emits `support`, `exposure`,
# `reason_code`, `profiles` and `execution`, so an empty object carries no
# declaration to read at all, and blaming a `profiles` field that was never
# there would name the wrong problem.
# One note per operation, not per model: two models repeating the same broken
# shape are one declaration error.
MALFORMED_OPERATION = 'malformed_operation'
REASONS = frozenset({UNKNOWN_ROUTE, ROUTE_MISMATCH, UNMAPPED_STAGE, UNKNOWN_PROFILE, OPERATION_MISMATCH,
                     NO_LOCAL_CAPABILITY, NO_ROUTE_DECLARED, MALFORMED_ROUTE, EXPOSURE_UNKNOWN,
                     ROLE_NOT_DECLARED, UNSUPPORTED_FORMAT, MALFORMED_MODEL, MALFORMED_PROFILE,
                     MALFORMED_OPERATION})

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

    Two fields, two kinds of absence, and only one of them tolerates absence.
    `transport` **absent** takes the upstream default `http`
    (`protocol/capabilities.py:16-21`), so such a route is still not a mismatch.
    Nothing else takes it — not `None`, not a blank string: upstream's
    `transport: Literal["http", "websocket"] = "http"` has a non-`None` default,
    so `response_model_exclude_none=True` has nothing to drop there and a body
    handing over `null` cannot be a body upstream published. A `transport` that
    is **present and unreadable** is therefore not the default and not "absent":
    it yields an empty transport, which equals no postable route, and
    `_route_exposures()` reports it as `malformed_route` exactly like a missing
    `method`. Reading it as `http` — or promoting `None` to the default — would
    be the one place in this module where an unreadable value leans towards the
    permissive side, and a broken declaration would become evidence for the
    route it only appears to name.

    Readability is a closed set, because upstream's field is one: after stripping
    and lower-casing, the value has to be `http` or `websocket`. Everything else
    — `''`, a blank string, `0`, `False`, `[]`, `'bogus'`, `'http/2'` — is
    unreadable, and none of them is read as the default. Normalizing first is
    what makes `' HTTP '` the http route rather than a broken reference.

    `method` has no default upstream: an absent or blank method cannot be
    confirmed, and is compared as an empty string that matches no postable
    route.
    """
    if not isinstance(value, dict):
        # No field to read at all: a bare path string is not a route reference,
        # so `transport` is absent rather than unreadable.
        return HTTP, '', route_path(value)
    transport, method = value.get('transport'), value.get('method')
    if 'transport' not in value:
        # The one absent spelling that has an upstream default. `None` is a
        # *present* value a published body cannot carry, so it is unreadable
        # below rather than defaulted here.
        transport = HTTP
    elif isinstance(transport, str) and transport.strip().lower() in (HTTP, WEBSOCKET):
        transport = transport.strip().lower()
    else:
        # Present, but outside upstream's closed literal: unreadable, and
        # deliberately not the `http` default.
        transport = ''
    method = method.strip().upper() if isinstance(method, str) and method.strip() else ''
    return transport, method, route_path(value)


def _exposure(value):
    """One published `exposure` value, normalized; everything else is `unknown`.

    The one reader every level uses: a route reference, a profile and an
    operation all publish this enum, and all three are compared here the same
    way — stripped, lower-cased, then tested against the closed set upstream
    declares (`Literal["enabled", "disabled", "unknown"]`). A value outside it
    (`'bogus'`, `''`, `0`, `True`, `[]`, `1.0`, `{}`) is `ROUTE_UNKNOWN`, never
    a fourth state and never a grant, and no level gets a laxer comparison than
    another: reading a padded `' enabled'` as a grant on a route while an
    operation's `' enabled'` fell through to `unknown` would make the same
    declaration mean two things one nesting level apart.
    """
    if isinstance(value, str):
        value = value.strip().lower()
    return value if value in (ENABLED, DISABLED) else ROUTE_UNKNOWN


def _support(value):
    """One published `support` value, normalized; `None` when it decides nothing.

    `_exposure`'s twin, and deliberately the same shape: strip, lower-case, then
    a closed-set test against `Literal["supported", "unsupported", "unknown"]`.
    The three non-answers — absent, unrecognised (including every non-string)
    and the literal `unknown` — come back as `None`, which is this table's
    "not confirmed" for the field, so a profile's `' Supported'` and an
    operation's `' SUPPORTED '` are the same declaration the route-level reader
    sees.
    """
    if isinstance(value, str):
        value = value.strip().lower()
    return value if value in (SUPPORTED, UNSUPPORTED) else None


def _route_exposure(value):
    """Declared exposure of one route reference; absent is `unknown` (the upstream default).

    Three shapes, one answer, on purpose: a missing `exposure`, a value outside
    `ENABLED`/`DISABLED` that this table does not recognise, and the literal
    `unknown` all come back as `ROUTE_UNKNOWN`. The fold is deliberate — the
    upstream default (`exposure: Exposure = "unknown"`) makes the first and the
    third the same declaration, and neither of them is a shape error — so this
    function adds no note of its own for which of the three it read. What the
    fold does *not* do is silence the doubt: a **postable route** that lands here
    leaves the row reachability-unconfirmed, and `resolve()` reports that channel
    as `exposure_unknown` (see the status table in
    `docs/architecture/capability-contract.md`). A profile- or operation-level
    `exposure: unknown` is its own explanation and gets no note; a route-level
    one points at the channel that keeps the row undecided. A caller that must
    know which spelling the body actually used has to read the body, not this
    table.

    The comparison is a closed set, like the field upstream publishes
    (`Literal["enabled", "disabled", "unknown"]`), and it goes through the one
    shared reader `_exposure()` that the profile and operation levels use too: a
    value is stripped and lower-cased, so `' enabled'` and `'ENABLED'` are the
    `enabled` route rather than an unrecognised spelling, and anything else
    (`'bogus'`, `''`, `0`, `True`, `[]`, `1.0`, `{}`) is `ROUTE_UNKNOWN` rather
    than a fourth state. `_support()` is the same reader for the sibling enum,
    so no level of this table is stricter or laxer than another.

    The `not isinstance(value, dict)` branch below is a defensive guard for a
    direct caller: every call site in this module has already read the value as a
    route mapping before it gets here, so the branch decides nothing today.
    """
    if not isinstance(value, dict):
        return ROUTE_UNKNOWN
    return _exposure(value.get('exposure'))


def _normalised_id(value):
    """One published id, normalized the way every id reader compares it.

    The three id readers (`capabilities_for()`, `required_roles_for()`,
    `candidates_for()`) share this one normalizer so a stored id with padding or
    upper case answers the same way through all of them; the table's own keys are
    already stripped and lower-cased, so normalizing the lookup cannot move one.
    """
    return value.strip().lower()


def capabilities_for(operation, profile):
    """Capability ids for one pair, or `()` when this table does not place it.

    This is the single lookup a caller needs: given the operation it believes it
    is calling and the profile it intends to use, it gets the capabilities that
    profile grants. `()` means either "no such row" or "upstream publishes the
    profile but this repository has no id for it" — `resolve()` distinguishes
    those two cases in its `unresolved` list. A returned id is a *declaration*
    slot, not an authorisation: it says the pair publishes that capability, not
    that a request may be sent. The adapter for the configured model still
    decides the route, the transmitted inputs and the output, and an id gated by
    `REQUIRED_ROLES` is only granted once the declaration passes
    `role_verdict()` — the same disclaimer `candidates_for()` carries.
    """
    if not isinstance(operation, str) or not isinstance(profile, str):
        return ()
    return BY_PAIR.get((_normalised_id(operation), _normalised_id(profile)), ())


# Request roles a capability needs before a declaration about its profile can
# grant it. These are the fields this repository actually transmits for the
# tool (see `integrations/model_adapters.py:405-540`), and the document does not
# publish them: the route-level `request.inputs` names only modality-level roles
# (`image`, `mask_image`, `reference_image`, `last_frame`, `video`, `audio`,
# `voice`, `instructions`). A profile saying `image_to_video` therefore proves it
# accepts an image, not that the image is a first frame; `video_to_video` proves
# it accepts a video, not that it takes latent masks. Both ids stay `unknown`
# until the profile's own postable route declares every role the id needs;
# a document that never declares them keeps them `unknown`, while one whose
# postable route refuses at least one of them reports `missing` with `unsupported`.
# `first_frame` names the slot, not the wire field: the adapter sends it as
# `input_reference` with `task=fl2va`. The role name is what the document would
# have to publish, so the two sides share one spelling.
REQUIRED_ROLES: dict[str, tuple[str, ...]] = {
    'video.first_frame': ('first_frame',),
    'video.edit': ('source_video', 'video_noise_mask', 'audio_noise_mask'),
}


def required_roles_for(capability_id):
    """The request roles one capability needs, or `()` when a declaration suffices.

    `()` means the profile's own `required_inputs` are the whole story (modality
    level). A non-empty tuple means the profile's own postable route must
    declare every named role with `support=supported` before this id can read
    `available` — all of them on the same route, since a request leaves on one.
    A role the document never declares leaves it `unknown`; a document whose
    postable route refuses at least one required role leaves it `missing` with
    `unsupported` (`role_verdict()` applies the rule).
    """
    if not isinstance(capability_id, str):
        return ()
    return REQUIRED_ROLES.get(_normalised_id(capability_id), ())


_UNREADABLE_COUNT = object()


def _count(value):
    """`min_count`/`max_count` as an int, None when absent, sentinel when unreadable.

    Upstream publishes both bounds as optional inclusive counts
    (`docs/serving/capabilities.md:92`, `request_capabilities.InputConstraint`)
    and both are nonnegative there — a count is a number of items, so a negative
    bound is not a smaller window, it is a value this table must not read.
    Anything that is not a whole number, and any negative whole number, is
    unreadable: reading a bound out of it would turn an unreviewed number into
    a verdict. Upstream types both fields `int | None`, so a bool or a numeric
    string is not a count this table reads either, even though lax coercion
    would take `false` for 0 or `"2"` for 2; `unknown` is the conservative
    answer in both directions there. A whole-number float (`2.0`) is the integer
    it names: it carries no fractional part to lose, and reading it as unreadable
    would refuse a window the publisher can emit.

    An absent bound is not the same thing as one this table cannot read. Upstream
    calls an omitted maximum "unknown" (`docs/serving/capabilities.md:92`), and
    this table does not translate that into "no limit": it reads an absent bound
    as "no declared bound", which is why a `min_count: 1` window still carries
    the one item the tool sends. The grant comes from `support`, and an absent
    maximum cannot contradict it — upstream's own validator rejects
    `min_count > max_count` (`request_capabilities.py:44-48`), so a window whose
    minimum admits one item has no maximum below it to fail. An unreadable value
    decides nothing at all — it can neither grant nor refuse — while an absent
    one simply is not a refusal.

    The table reads only JSON numbers; a string or a bool is refused even though
    upstream's lax validation would coerce it, because a declaration that needs
    coercion is not one this table can vouch for. A whole-number float is read as
    the integer it names; a fractional value is unreadable.
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return _UNREADABLE_COUNT
    if isinstance(value, float) and not value.is_integer():
        return _UNREADABLE_COUNT
    count = int(value)
    if count < 0:
        return _UNREADABLE_COUNT
    return count


def _carries_one(constraint):
    """True/False/None: can this constraint carry the one item the tool sends?

    The window `[min_count, max_count]` is part of the answer, not decoration: a
    role capped at 0 cannot carry anything, and one demanding 2 items cannot be
    satisfied by the single item the tool sends, however `support` reads. An
    absent bound is an absent bound — not a refusal, and not a promise of no
    limit either (see `_count()`). A bound this table cannot read — not a whole
    number, a negative count, or a window whose minimum exceeds its maximum —
    leaves the entry undecided rather than guessed: upstream publishes both
    bounds as nonnegative `int | None` and rejects `min_count > max_count`
    (`request_capabilities.InputConstraint`), so a verdict read out of one would
    describe a declaration the publisher cannot emit.
    """
    low = _count(constraint.get('min_count'))
    high = _count(constraint.get('max_count'))
    if low is _UNREADABLE_COUNT or high is _UNREADABLE_COUNT:
        return None
    # Invariant, not a decision: what is left after the sentinel is an int or
    # None (absent), because `_count()` reads nothing else. No test can kill
    # these two asserts — they are here so the arithmetic below is readable.
    assert low is None or type(low) is int
    assert high is None or type(high) is int
    if low is not None and high is not None and low > high:
        return None
    if high is not None and high < 1:
        return False
    if low is not None and low > 1:
        return False
    return True


def _declared_support(constraint):
    """`supported`, `unsupported`, or None when this entry decides nothing.

    `supported` and `unsupported` are both answers; an absent or unrecognised
    `support` is None, so a refusal stays distinguishable from silence and from
    a value this table does not read. A `supported` role capped at zero items is
    a refusal in effect — the request needs one — while `unsupported` stands on
    its own whatever the capacity says. A `supported` entry whose count window
    this table cannot read yields None as well: that is what keeps a malformed
    window from deciding anything in either direction.

    As with `_route_exposure`, three shapes share one answer on purpose: a
    missing `support`, an unrecognised enum value (including every non-string)
    and the literal `unknown` are all None here. The value goes through the same
    normalized reader `_support()` the profile and operation levels use, so a
    padded `' Supported'` is a grant at all three. Upstream requires the field
    and publishes the same three-valued vocabulary, so the fold costs nothing at
    the only place the answer is used ("not confirmed"), and the rows that land
    in it carry no note — a declaration that says nothing needs no attribution,
    and unlike a route-level `exposure` there is no channel here for a note to
    name. Which of the three the body said is a question for the body.
    """
    if not isinstance(constraint, dict):
        return None
    value = _support(constraint.get('support'))
    if value is None:
        return None
    if value == UNSUPPORTED:
        return UNSUPPORTED
    carries = _carries_one(constraint)
    if carries is None:
        return None
    return SUPPORTED if carries else UNSUPPORTED


def _role_support(request):
    """`{role: declared support}` of one `RequestConstraints`, membership kept.

    One value per declared role: `supported`, `unsupported`, or None when the
    entry decides nothing (see `_declared_support`).
    """
    inputs = request.get('inputs') if isinstance(request, dict) else None
    if not isinstance(inputs, dict):
        return {}
    support = {}
    for role, constraint in inputs.items():
        support[str(role).strip()] = _declared_support(constraint)
    return support


def _role_routes(entry, operation):
    """What the profile's own postable routes say about one request role set.

    Returns two things: one `{role: support}` map per open postable route, and
    whether a postable route is undecided.

    One map per route, in declaration order, because a request leaves on exactly
    one of them: a role named by `/v1/videos/sync` says nothing about a request
    sent to `/v1/videos`. Reads `routes[*].request.inputs[*].support`; the route
    reference is where upstream's projection lands the per-path facts, and it
    already carries the profile-level constraints it copied (`_route_request`
    starts from `dict(request.inputs)`), so reading the profile's own `request`
    as well would only re-add what a route just narrowed.

    A route contributes nothing unless it is one of the operation's
    `POSTABLE_ROUTES` with `exposure: enabled`: `/v1/videos/sync`, the socket,
    another operation's path and a wrong method are channels this tool never
    posts to, so they are not evidence for a role in either direction — not a
    grant, not a refusal, not a doubt. The comparison is the whole
    `(transport, method, path)` key, exactly the test `resolve()` uses, so a
    socket spelling the http path is not that route and cannot lend it roles.
    An open postable route is the only channel a role can come from, and one
    whose `exposure` is absent or unreadable may still serve, so it is
    `undecided` rather than either a grant or a refusal.
    """
    if not isinstance(entry, dict) or not isinstance(operation, str):
        return [], False
    postable = set(POSTABLE_ROUTES.get(operation, ()))
    roles = []
    undecided = False
    for value in _routes(entry):
        key = _route_key(value)
        if key[2] is None or key not in postable:
            continue
        exposure = _route_exposure(value)
        if exposure == ENABLED:
            roles.append(_role_support(value.get('request')))
        elif exposure == ROUTE_UNKNOWN:
            undecided = True
    return roles, undecided


def role_verdict(entry, operation, required):
    """Can the profile's postable route carry every required role?

    The rule `resolve()` applies to `REQUIRED_ROLES`, exposed for a caller that
    holds one profile's declaration and needs the same answer for the role
    question — it reads the whole declaration, and ignores every route this tool
    does not post to. The profile's own verdict and its routes' reachability are
    decided before this gate runs, so a refused profile still reads refused
    however this call answers. `required` is the role set one capability needs
    (`required_roles_for()`): a bare string is read as that one role, every
    non-`str` member of a container is dropped (an unhashable one would raise
    inside the lookup rather than answer), and a set left empty by that
    filtering — or one that never named anything — is `yes`, because nothing is
    being asked of anyone.

    `yes` — the postable route declares all of them with `support=supported`. A
    role that only `/v1/videos/sync` or a socket names leaves the answer
    `unknown`, not `yes`, and does not refuse one either: this tool posts to
    neither, so neither is evidence about the request it sends.
    `no` — a postable route is open, refuses at least one of them, and no
    postable route carries the whole set, so no request this deployment accepts
    can carry it. A route that refuses one role is out of the running whatever
    the rest of that route says — the request needs the whole set on one route.
    A role the route leaves unmentioned only matters when the route refuses
    nothing: that route is undecided, not excluded.
    `unknown` — anything else: no postable route, a role nobody names on the
    postable route, an absent or unrecognised `support`, or a postable route
    whose `exposure` is absent or unreadable, which may still serve.

    `operation` is normalized the way `capabilities_for()` normalizes its
    arguments and `resolve()` normalizes the operation keys it reads: a string is
    stripped and lower-cased, and anything that is not a non-blank string answers
    `unknown`, because no operation is being judged and this gate cannot invent
    one. (`required` is normalized first, so an unreadable `operation` beside an
    empty role set still answers `yes` — nothing is required of nobody.)
    """
    if isinstance(required, str):
        required = (required,)
    elif not isinstance(required, (tuple, list, set, frozenset)):
        required = ()
    # Only `str` members are roles: a dict or a list inside the container would
    # reach `roles.get(...)` as an unhashable key and raise instead of answering,
    # and a role set nothing can be asked about is not a doubt — it is empty, so
    # the answer is `yes`, exactly as the docstring says of a filtered-empty set.
    required = tuple(role for role in required if isinstance(role, str))
    if not required:
        return 'yes'
    if not isinstance(operation, str) or not operation.strip():
        return 'unknown'
    operation = operation.strip().lower()
    routes, undecided = _role_routes(entry, operation)
    if any(all(roles.get(role) == SUPPORTED for role in required) for roles in routes):
        return 'yes'
    if not routes or undecided:
        return 'unknown'
    if all(any(roles.get(role) == UNSUPPORTED for role in required) for roles in routes):
        return 'no'
    return 'unknown'


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
    return BY_CAPABILITY.get(_normalised_id(capability_id), ())


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
    """Declared route references of a profile; an unreadable field reads as none.

    The role gate's tolerant reader: `_route_exposures()` reads the same field
    directly so it can report a non-list `routes` as `malformed_route`, while
    here a field this table cannot read simply cannot lend a role — the same
    answer the gate gives for silence.
    """
    routes = entry.get('routes')
    return routes if isinstance(routes, list) else []


def _profile_id(entry):
    """Readable `id` of one `profiles[]` element, or None when it has none.

    A profile the document cannot name is not a profile this table can place:
    `resolve()` reports it as `malformed_profile` instead of dropping it in
    silence, and `declarations()` skips it (a body with no readable profile is
    still `None`, not an empty declaration).
    """
    profile_id = entry.get('id') if isinstance(entry, dict) else None
    if isinstance(profile_id, str) and profile_id.strip():
        return profile_id.strip().lower()
    return None


def _profiles(operation):
    """`(profile id, profile entry)` pairs a declared operation body carries."""
    if not isinstance(operation, dict):
        return
    profiles = operation.get('profiles')
    for entry in profiles if isinstance(profiles, list) else []:
        profile_id = _profile_id(entry)
        if profile_id is not None:
            yield profile_id, entry


def declarations(payload):
    """Ordered (operation, profile) pairs from a capabilities body, or None.

    A **raw reader**: it lists the pairs the document names, not the pairs this
    table has evidence for. Pairs `resolve()` treats as no evidence are returned
    here all the same — an operation upstream does not publish (`unmapped_stage`),
    a profile filed under the wrong operation (`operation_mismatch`), a profile
    id this table does not place (`unknown_profile`) — and `capabilities_for()`
    answers `()` for every one of them. A pair this table *does* place is listed
    even when `resolve()` refuses it: an operation whose `support` is
    `unsupported`, or whose `exposure` is `disabled`, makes every profile under
    it `missing`, while `capabilities_for()` still returns that pair's ids,
    because placement and verdict are different questions. So a non-empty
    `declarations()` is not a list of grants, and neither is a non-empty
    `capabilities_for()`: a caller must pass each pair through
    `capabilities_for()` (does this table place it at all?) and take the verdict
    from `resolve()`, which reads the declaration itself.

    Only the published shape is read: `models[].operations[<operation>].profiles[]`.
    `stages[]` is deliberately skipped — it is topology, and reading routes or
    names out of it is how the earlier table grew pairs upstream never published.
    A body that declares no profile returns None, which callers must treat as
    "no evidence" rather than "nothing supported". (`resolve()` still reports
    `endpoint=present` for a body that carries operation entries without
    profiles: the service answered, it just did not say which profiles it
    serves, and that is `unknown`, not `absent`.) A body naming another envelope
    yields None for the same reason `resolve()` refuses it: the two readers must
    not disagree about one body.
    """
    if not isinstance(payload, dict):
        return None
    if _envelope_unsupported(payload):
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

    Both fields are read through the shared normalized readers (`_support()`,
    `_exposure()`), not compared as published: an operation that pads or
    upper-cases either enum means what its route-level twin means, because the
    same vocabulary is compared the same way at every level of this table.
    """
    support, exposure = _support(operation.get('support')), _exposure(operation.get('exposure'))
    if support == UNSUPPORTED:
        return 'no', UNSUPPORTED_REASON
    if exposure == DISABLED:
        return 'no', ENDPOINT_DISABLED_REASON
    if support == SUPPORTED and exposure == ENABLED:
        return 'yes', None
    return 'unknown', None


def _profile_verdict(entry, operation_verdict, operation_reason, exposures):
    """`(verdict, reason)` for one profile inside an already-judged operation.

    `exposures` holds one value per declared route that is one of the operation's
    `POSTABLE_ROUTES`: an empty list means the profile declared no route this
    tool can post to — no routes, no usable path, only `/v1/videos/sync`, only a
    socket, or only some other path. Those declarations are already reported by
    `_route_exposures()`; they are not evidence here, in either direction, so
    they cannot keep the `unknown` from being what it is.

    A profile or operation that publishes `support: unknown` or
    `exposure: unknown` is not attributed with a note: the document itself says
    it does not know, so the enum is its own explanation. A route-level
    `exposure` that is `unknown` or absent is attributed with `exposure_unknown`,
    and only when the profile itself says `supported` and the operation is
    enabled: otherwise the `unknown` is the declaration's, not the route's.
    (Whether that note survives is `resolve()`'s question, not this verdict's:
    it is kept only while the aggregated pair still has an undecided capability,
    so a `yes` row that is granted anyway carries none.)

    `support` is read through the shared normalized reader `_support()`, the same
    one the operation and route levels use: a padded or upper-cased spelling is
    the enum it names, not an unrecognised value. `None` covers absent,
    unrecognised and the literal `unknown` alike.
    """
    support = _support(entry.get('support'))
    if support == UNSUPPORTED:
        return 'no', UNSUPPORTED_REASON
    if operation_verdict == 'no':
        return 'no', operation_reason
    if support != SUPPORTED or operation_verdict != 'yes':
        return 'unknown', None
    if ENABLED in exposures:
        return 'yes', None
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
    """True when `key` is the route this tool posts for the operation; else report why not.

    `POSTABLE_ROUTES` is the whole test: a route the operation owns but this tool
    never posts to (`/v1/videos/sync`, the websocket) fails it exactly like
    another operation's path does, and is reported the same way. Returns False
    for every non-postable declaration, which is how the caller knows to count
    nothing — the note is the whole of its effect.

    Compared as the whole `(transport, method, path)` key, never by path alone:
    a socket that spells the http path is not that route.
    """
    if key in POSTABLE_ROUTES.get(operation, ()):
        return True
    path = key[2]
    _note(unresolved, operation, profile, path,
          ROUTE_MISMATCH if path in ROUTED_PATHS else UNKNOWN_ROUTE)
    return False


def _route_exposures(operation, profile, entry, unresolved):
    """`(postable route exposures, unreadable postable paths)` for one profile.

    A route reference whose path cannot be read is reported rather than dropped:
    silently ignoring it would turn a broken declaration into `unknown` with no
    explanation, which is the failure this module exists to prevent. The same
    holds for a `routes` field that is not a list at all, for a reference with a
    readable path but no usable `method`, and for one whose `transport` is
    present but unreadable (`''`, a blank string, `0`, `False`, `[]`, `'bogus'`,
    `'http/2'`, and `None` too — the default applies only to a missing key):
    upstream requires a
    method on every reference and types `transport` as a closed literal, so such
    an entry cannot be placed and is `malformed_route`, not `route_mismatch` (an
    absent or unreadable field says the field is unconfirmed, not that the
    declaration belongs to another operation). `path` degrades the same way.
    Those three are the whole key this table compares, so an unreadable one
    leaves nothing to compare. An unreadable
    `exposure` or `support` is a different case — it is the profile-level
    three-state fold (`_route_exposure`, `_declared_support`, both on the shared
    normalized readers `_exposure()`/`_support()`), where absent, an
    unrecognised enum and the literal `unknown` all mean "not confirmed" and
    none of them is a shape error. A non-list `routes` field yields one note for
    the profile — there is no entry to attribute it to — and no exposures, so
    the row is judged like a profile that declared nothing.

    Only a declaration equal to one of the operation's `POSTABLE_ROUTES` enters
    the returned list. Every other declaration — another operation's path, a
    wrong method, `/v1/videos/sync`, the websocket — is reported by
    `_check_route()` and then dropped: it is evidence in neither direction, so it
    must not grant a capability, must not refuse one, and must not leave a row
    undecided. Filtering on transport or on ownership instead would let some of
    them act as a channel, which is the reading this rule exists to remove.

    A postable route whose `exposure` is `unknown` or absent (the upstream
    default for the field is `unknown`, and a defensive body may omit it) is
    returned both in the exposure list and as a candidate for `exposure_unknown`
    rather than noted here: the note only makes sense while that channel is what
    leaves the pair undecided, so `resolve()` records it after
    `_profile_verdict()` and the capability gate have decided — an `enabled`
    sibling can answer the row while the same reference still keeps a role-gated
    id waiting. A row judged `no` is explained by
    its refusal and gets no note, and neither does a profile whose own `support`
    is `unknown`.
    """
    declared = entry.get('routes')
    if not isinstance(declared, list):
        _note(unresolved, operation, profile, None, MALFORMED_ROUTE)
        return [], []
    exposures = []
    unreadable = []
    for value in declared:
        key = _route_key(value)
        if key[2] is None or not key[1] or not key[0]:
            # The path is named when it could be read, so two broken references
            # to two different paths stay two notes: a `None` route for both
            # would collapse them into one and leave neither attributable.
            _note(unresolved, operation, profile, key[2], MALFORMED_ROUTE)
            continue
        if not _check_route(operation, profile, key, unresolved):
            continue
        exposure = _route_exposure(value)
        if exposure == ROUTE_UNKNOWN:
            # One entry per postable reference whose `exposure` is `unknown` or
            # absent. The list says nothing about the row's own verdict: an
            # `ENABLED` sibling can make the profile `yes` while this reference
            # is still the reason a gated id waits on a role, so `resolve()`
            # decides — after the capability gate, against the aggregated row —
            # whether the channel still explains an undecided capability.
            unreadable.append(key[2])
        exposures.append(exposure)
    return exposures, unreadable


def _envelope_unsupported(payload):
    """True when the body names an envelope this table does not read.

    `object` and `schema_version` are upstream's version gate
    (`protocol/capabilities.py:73-79`), compared as published: `object` is the
    string `omni.capabilities` and `schema_version` the integer `1`, so a string
    `"1"` is a different shape, not the same version. A body that states either
    one and disagrees is a different contract: reading its `models` would grant
    capabilities from a shape nobody reviewed. What this gate rejects is a body
    that *names* another contract. A body that names neither is read as v1:
    upstream's response model always emits both, so a missing envelope cannot be
    told apart from a v1 body a proxy stripped, and refusing it would also
    reclassify the defensive bodies the `absent` and `empty` states exist for.
    """
    if not isinstance(payload, dict):
        return False
    if 'object' in payload and payload.get('object') != ENVELOPE_OBJECT:
        return True
    if 'schema_version' in payload:
        version = payload.get('schema_version')
        # The published field is the integer `1`; a float `1.0` is a different
        # shape too, and Python would otherwise compare it equal.
        if isinstance(version, bool) or not isinstance(version, int) or version != ENVELOPE_VERSION:
            return True
    return False


def resolve(payload):
    """Per-capability availability, the declared topology, and untranslated claims.

    `payload` is the decoded body of `ENDPOINT`, or None when the request failed
    (404, timeout, disabled endpoint). Model names and any other provider fields
    never reach the result.

    `endpoint` separates "did not answer" from "answered without declaring"
    from "answered in a contract this table does not read": `absent` when there
    is no body or no model list at all, `empty` when a model list came back but
    no model declared an operation, `present` when at least one did, and
    `unreadable` when `object` or `schema_version` names another contract (see
    `_envelope_unsupported`). Every capability is `unknown` in the first two
    cases, with `reasons` empty and nothing listed as unresolved; the unreadable
    case also reports the body once as `unsupported_format` and never reads its
    `models`.

    A capability is `available` only when some model's profile says so, its
    operation is enabled and its postable route is enabled;
    `missing` only when every model positively says no — a profile, an operation
    or the role gate — with the kind of refusal in `reasons` (`unsupported`,
    including a required input role no postable route carries, `endpoint_disabled`,
    `route_disabled`); `unknown` otherwise — no body, an absent field, an unknown
    enum, an unrouted capability, a model that does not mention the operation
    (the deployment may still serve it from that model), or a declaration this
    table could not translate.
    """
    vocabulary = classified_capabilities()
    unresolved: list[dict] = []
    if _envelope_unsupported(payload):
        # Refuse the whole body once: its `models` and its `stages` are both a
        # shape nobody reviewed, so not even the topology is handed back.
        _note(unresolved, None, None, None, UNSUPPORTED_FORMAT)
        return {'endpoint': UNREADABLE, 'topology': [],
                'capabilities': {item: UNKNOWN for item in vocabulary}, 'reasons': {},
                'unresolved': unresolved}
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
    unreadable_models = False
    # Notes that explain a *verdict* rather than a shape are held back until every
    # model has been read: capabilities are aggregated across models, so a row one
    # model leaves `unknown` can be `available` from another, and the note would
    # then explain a doubt the result does not have.
    deferred: list[tuple] = []
    for model in models if isinstance(models, list) else []:
        operations = model.get('operations') if isinstance(model, dict) else None
        if not isinstance(operations, dict):
            operations = {}
        declared_operations = {operation_id.strip().lower() for operation_id in operations
                               if isinstance(operation_id, str) and operation_id.strip()}
        if not declared_operations:
            # A model that lists no operation says nothing about any of them. Its
            # silence must not let another model's refusal harden into `missing`:
            # the silent model may still serve, so every row stays `unknown` —
            # and the element is reported rather than dropped, because upstream
            # lists all six operations on every model.
            unreadable_models = True
            for _, _, row_capabilities in OPERATION_PROFILES:
                record(row_capabilities, 'unknown')
            continue
        declared = True
        for operation_id, operation in operations.items():
            key = operation_id.strip().lower() if isinstance(operation_id, str) else ''
            if not key:
                continue
            if key not in OPERATIONS:
                _note(unresolved, key, None, None, UNMAPPED_STAGE)
                continue
            if not isinstance(operation, dict) or not operation:
                # An operation entry this table cannot read is a shape error, not
                # a capability answer: the ids stay `unknown` and the doubt gets
                # a name. One note per operation, no profile and no route — the
                # value has neither. An empty object is the same doubt and not a
                # `malformed_profile`: upstream always emits `support`,
                # `exposure`, `reason_code`, `profiles` and `execution`, so `{}`
                # carries nothing at all, and blaming a `profiles` field that was
                # never declared would name the wrong problem.
                _note(unresolved, key, None, None, MALFORMED_OPERATION)
                for row_operation, _, row_capabilities in OPERATION_PROFILES:
                    if row_operation == key:
                        record(row_capabilities, 'unknown')
                continue
            operation_verdict, operation_reason = _operation_verdict(operation)
            # A `profiles` field this table cannot read used to be dropped
            # without a word, leaving the operation's ids `unknown` beside an
            # empty report. It is reported once per operation, with no profile and
            # no route: neither a non-list field nor an unnamed element has them.
            # `profiles: []` is a published answer, not a broken one, and stays
            # silent.
            profiles_declared = operation.get('profiles')
            if not isinstance(profiles_declared, list):
                _note(unresolved, key, None, None, MALFORMED_PROFILE)
            else:
                for raw in profiles_declared:
                    if _profile_id(raw) is None:
                        _note(unresolved, key, None, None, MALFORMED_PROFILE)
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
                exposures, unreadable = _route_exposures(key, profile_id, entry, unresolved)
                verdict, reason = _profile_verdict(entry, operation_verdict, operation_reason, exposures)
                # A supported profile with no postable route — no routes, no
                # usable path, only `/v1/videos/sync`, only a socket, only some
                # other path: reachability cannot be confirmed, and nothing else
                # explains the `unknown`. A profile that publishes
                # `support=unknown` is not attributed: the document itself says it
                # does not know, so its own enum is the explanation.
                if (verdict == 'unknown' and operation_verdict == 'yes'
                        and _support(entry.get('support')) == SUPPORTED and not exposures):
                    deferred.append((key, profile_id, None, NO_ROUTE_DECLARED))
                # Only a row that is not a refusal needs the channel named: a
                # refusal is already explained by its own kind, and a profile
                # that publishes `support=unknown` explains itself. A row judged
                # `yes` is queued too, because the pair can still be undecided
                # one gate later: an `enabled` `/v1/videos` beside an undecided
                # reference to the same path leaves a gated id waiting on a role,
                # and this channel is exactly what keeps it undecided. The final
                # loop below drops the note when the aggregated row has no
                # undecided capability left, which is also what keeps a refusal
                # from carrying one across models.
                if operation_verdict == 'yes' and _support(entry.get('support')) == SUPPORTED:
                    for unreadable_path in unreadable:
                        deferred.append((key, profile_id, unreadable_path, EXPOSURE_UNKNOWN))
                capabilities = BY_PAIR[(key, profile_id)]
                if capabilities:
                    # The role gate is per capability, not per row: a row that
                    # ever grants a gated id beside an ungated one must not let
                    # the gated id's refusal reach the other one.
                    for capability in capabilities:
                        capability_verdict, capability_reason = verdict, reason
                        required = required_roles_for(capability)
                        if required and verdict == 'yes':
                            roles = role_verdict(entry, key, required)
                            if roles == 'no':
                                # Every open route has decided the role set and
                                # none carries it: a positive no, reported like a
                                # refusing profile because upstream has to change
                                # the same thing.
                                capability_verdict, capability_reason = 'no', UNSUPPORTED_REASON
                            elif roles != 'yes':
                                # A broad profile (i2v / v2v) does not authorise a
                                # narrower tool: one of the profile's own open
                                # routes has to name every role, and silence is
                                # not evidence.
                                capability_verdict, capability_reason = 'unknown', None
                                deferred.append((key, profile_id, None, ROLE_NOT_DECLARED))
                        record((capability,), capability_verdict, capability_reason)
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
        # Operations this model never mentions establish nothing either: upstream
        # lists all six (`protocol/capabilities.py:60-64`), so an omission is a
        # body this table did not review, and `missing` needs positive evidence
        # from every model. One model refusing while another stays silent is
        # `unknown`, because the silent one may serve.
        for row_operation, _, row_capabilities in OPERATION_PROFILES:
            if row_operation not in declared_operations:
                record(row_capabilities, 'unknown')

    if not declared:
        # `models` being a list is the service answering; no operations at all
        # means it answered without declaring anything, which is not the same as
        # never having answered.
        endpoint = EMPTY if isinstance(models, list) else ABSENT
        return {'endpoint': endpoint, 'topology': topology, 'capabilities': {item: UNKNOWN for item in vocabulary},
                'reasons': {}, 'unresolved': []}
    if unreadable_models:
        # Reported only once something was declared: an endpoint that said
        # nothing at all is the `empty` answer above, not a malformed one.
        _note(unresolved, None, None, None, MALFORMED_MODEL)
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
    # A verdict note lands only when the pair it is about still has an undecided
    # capability in the aggregated answer: another model may have answered it, and
    # then the note would sit beside an `available` it does not explain. A pair
    # with no capability id at all gets no note either — it grants nothing, so
    # there is no undecided capability for the note to explain. The test is
    # id-agnostic on purpose: a row carrying several ids is undecided while *any*
    # of them still is, so reading only the first id would drop the note for a
    # row whose first id was answered and whose second was not. Today every row
    # of `OPERATION_PROFILES` carries at most one id, and
    # `test_every_profile_row_carries_at_most_one_id` pins that; the `any()` is
    # what keeps the note correct if the table ever grows a second id.
    for operation, profile, route, reason in deferred:
        row_capabilities = BY_PAIR.get((operation, profile), ())
        if row_capabilities and any(capabilities[cid] == UNKNOWN for cid in row_capabilities):
            _note(unresolved, operation, profile, route, reason)
    return {'endpoint': PRESENT, 'topology': topology, 'capabilities': capabilities, 'reasons': reasons,
            'unresolved': sorted(unresolved, key=lambda item: (item['operation'] or '', item['profile'] or '',
                                                               item['route'] or '', item['reason']))}
