# Capability mapping contract / 能力映射表契约

## 中文

`GET /v1/omni/capabilities` 只说明部署「自述了什么」；产品要回答的是「这个部署能不能做某件事」。`packages/core/src/opendirector/domain/capability_contract.py` 是唯一把上游词表翻译成 `opendirector.domain.capabilities` id 的地方。它不发起 HTTP，不持有界面文案，也不创建第二套 operation 常量。

### 上游真实词表（取证）

取证对象：`vllm-project/vllm-omni` PR #10102（issue #10007），head `d1104f8`。下列 `path:line` 均取自 head 原文件。

**6 个 operation 是闭合常量**（`vllm_omni/serving_capabilities.py:15,19-26`）：
`chat` / `image_generation` / `image_edit` / `video_generation` / `speech` / `audio_generation`。
没有 `asr`、`transcription`、`segmentation`、`depth`、`music`。

**12 个 profile**（`:43-54`），以及本仓对应的 capability id：

| operation | profile | 本仓 capability id |
| --- | --- | --- |
| `chat` | `text_response` | `text.chat` |
| `chat` | `image_response` | `text.chat` |
| `chat` | `audio_response` | `text.chat` |
| `image_generation` | `text_to_image` | `image.generate` |
| `image_edit` | `image_to_image` | `image.edit` |
| `video_generation` | `text_to_video` | `video.generate` |
| `video_generation` | `image_to_video` | `video.generate` |
| `video_generation` | `video_to_video` | `video.generate` |
| `speech` | `text_to_speech` | `audio.speech` |
| `speech` | `lyrics_to_music` | `audio.music` |
| `speech` | `caption_to_audio` | （无）音效/环境声，本仓无对应 id |
| `audio_generation` | `text_to_audio` | （无）扩散侧独立契约，本仓无对应 id |

**operation → 路由**（`:42-54`，一致性校验用）：

| operation | 路由 |
| --- | --- |
| `chat` | `POST /v1/chat/completions` |
| `image_generation` | `POST /v1/images/generations` |
| `image_edit` | `POST /v1/images/edits` |
| `video_generation` | `POST /v1/videos`；`POST /v1/videos/sync`；`WEBSOCKET /v1/realtime/video` |
| `speech` | `POST /v1/audio/speech` |
| `audio_generation` | `POST /v1/audio/generate` |

另外三条事实决定了这份表的形状：

- 响应顶层只有 `object` / `schema_version` / `observed_at` / `models` / `stages` / `routes`（`protocol/capabilities.py:73-79`），端点是 `response_model=OmniCapabilitiesResponse`、`response_model_exclude_none=True`（`api_server.py:2193`）——**字段缺席是显式设计，等价于 unknown**。
- `models[].operations` **必须齐全 6 个**，少一个 pydantic 直接抛错（`protocol/capabilities.py:60-64`）。
- `models[].stage_ids` 是**数字字符串**，而且每个 model 拿到的都是同一份全量列表（`entrypoints/openai/serving_capabilities.py:400`）。

### 键是 (operation, profile)，不是 route，也不是 stage

**为什么不是 route**：`/v1/audio/speech` 一条路径挂 3 个 profile —— `text_to_speech`（配音）、`lyrics_to_music`（音乐）、`caption_to_audio`（音效）。上游自己的测试里，MOSS-SoundEffect 在 speech 上只声明 `caption_to_audio`，同时把 `text_to_speech` 标成 `unsupported`（`tests/config/test_serving_capabilities.py:233,251`）：**同一路径，两种答案**。只按路径匹配，「只做音效」的部署会看起来会配音，反过来也一样。因此 `OPERATION_PROFILES` 的键是成对的 `(operation, profile)`，经 `capabilities_for(operation, profile)` 查找。

**为什么不是 stage**：`stages[]` 只有 `id` / `type` / `depends_on`（`protocol/capabilities.py:67-70`），id 是不连续的数字字符串，而且每个 model 都是同一份列表。拿它当键，所有模型会共享一个状态，既区分不了也不能诊断。本模块把 `stages[]` 只放进 `topology` 供展示，**从不用它决定任何能力**；一个 stage 条目即使自带 `routes` 或 `name` 也被忽略，因为上游 schema 没有这两个键。

**route 仍然有用**：`OPERATION_ROUTES` 保留 operation 对路由的所有权，用来校验声明的一致性 —— 某个 profile 引用了不属于该 operation 的路径（例如 `text_to_video` 指向 `/v1/images/edits`），该 profile 不产生能力，并报 `route_mismatch`。

### 六种无法翻译的声明

| reason | 含义 | 修的地方 |
| --- | --- | --- |
| `unknown_route` | 路径不属于任何 operation（`/v1/videos/track`，或已注册但无 operation 的 `/v1/images/segmentations`） | 表缺这个 operation，或声明写错了路径 |
| `route_mismatch` | 路径属于**另一个** operation（`text_to_video` 指向 `/v1/images/edits`） | 部署声明的配对写错了 |
| `unmapped_stage` | 上游没有这个 operation（`asr`、`music`） | 上游词表缺口，不是本表漏行 |
| `unknown_profile` | operation 认识，profile id 上游未发布（`speech_to_speech`） | 上游新增 profile，本表待补 |
| `operation_mismatch` | profile 认识，但挂在别的 operation 下（`lyrics_to_music` 挂在 `audio_generation`） | 声明写错了 operation，或本表把归属搞错了 |
| `no_local_capability` | profile 支持，但本仓没有对应 capability id | 词表待补（`caption_to_audio`、`text_to_audio`） |

六种都进 `unresolved`，不被丢弃；每条都带 `operation` / `profile` / `route` / `reason` 四键（不适用处为 `null`），调用方可以解释「为什么这条声明没变成能力」，而不是静默隐藏。

### 三种能力状态，只有正面证据才是 missing

- `available`：某个 model 的 profile 明确 `support=supported`，且其 operation 不是 `exposure=disabled`；
- `missing`：某个 profile 或 operation **正面说不**（`support=unsupported` 或 `exposure=disabled`）；
- `unknown`：其余全部 —— 请求失败/404、字段缺席、枚举为 `unknown`、声明无法翻译、能力本身不可路由。

**「服务没说」不是「服务不能」**：没有 `models`、没有 operation、`profiles` 被 `exclude_none` 掉，一律 `unknown`，绝不产生 `missing`。

### 有路由、没有 operation 的能力

`/v1/images/segmentations`、`/v1/videos/segmentations`、`/v1/videos/depth` 是**已注册的端点，但没有任何 operation 拥有它们**（上游文档明示：segmentation 与 depth「不会仅因为出现在 registry 里就获得这些 operation」，`docs/serving/capabilities.md:41-43`）。所以 `image.segment` / `video.matting` / `video.motion_capture` 恒为 `unknown`，reason 是 `no_upstream_profile` —— 端点不发布该能力，无法判定；**不能**写成 `missing`。

`UNROUTED` 里其余几项理由不同，不要混：

| capability | reason | 说明 |
| --- | --- | --- |
| `image.segment` / `video.matting` / `video.motion_capture` | `no_upstream_profile` | 有路由，无 operation |
| `audio.score` | `no_upstream_operation` | 上游没有识别 operation |
| `video.first_frame` / `video.edit` / `image.cutout` | `parameter_only` | 是已发布 operation 的请求参数，不是 profile |
| `audio.separate` | `no_local_adapter` | 上游没说法，本仓也没适配器 |

### ASR：上游未发布该 operation

上游词表里没有识别 operation，omni 的 router 也不注册 `/v1/audio/transcriptions`（`api_server.py` 全量路由里没有它），上游自己的 recipe 写明该端点「not currently available with `--omni`」。因此请求侧写 `asr` 得到 `unmapped_stage`：这是**上游没发布这个 operation**，不是本表漏了一行；`audio.score` 因此恒为 `unknown`（`no_upstream_operation`）。等上游发布识别 operation（或本仓补 `audio.transcribe`）再谈映射，绝不把 `/v1/audio/transcriptions` 读成 `audio.score`。

### 与 V2 发现契约（#266）的关系

这份表是 #266 的**输入**，不是替代品，也不是第二套 schema：

- #266 的 `domain/omni_capabilities.py` 定义发现文档与匹配；本模块只提供 `(operation, profile) → capability` 这一层。文件名不同，互不覆盖。
- 本模块**不再**读 `Model.stage_ids`：它是拓扑，不是能力键。`declarations()` 只读上游真实发布的 `models[].operations[<op>].profiles[]`。
- 本模块不改 `domain/omni_capabilities.py`、`integrations/capability_probe.py`、`application/model_availability.py`、`src/**`。

### 如何作为 `requests_for()` 的输入

`application/model_availability.py` 现在按 `(kind, protocol)` 硬编码 profile 名。表驱动后，调用方只需要自己正在调用的 operation 与 profile：

```python
from opendirector.domain.capability_contract import capabilities_for

capabilities_for('speech', 'lyrics_to_music')   # ('audio.music',)
capabilities_for('speech', 'text_to_speech')    # ('audio.speech',)
```

`resolve(payload)` 返回逐能力状态、`topology`（`stages[]`，仅供展示）与 `unresolved`；`classified_capabilities()` 按表顺序给出词表，展示层据此排列。是否接进 `requests_for()` 由 #266 一侧决定，本契约只保证查找是成对的、稳定的、可测的。

### 三档 fixture 与验证

`tests/fixtures/omni-capabilities/{full,partial,absent}.json` 按**真实响应形状**写：`stages[]` 是 `{id,type,depends_on}`，`models[].operations` 六个齐全、每个含 `support`/`exposure`/`reason_code`/`profiles`/`execution`，profile 带 `routes[]`/`required_inputs`/`outputs`；`absent` 档用**字段缺席**（模拟 `exclude_none=True`）而不是 `null`；`partial` 档覆盖 `support=unsupported`、`exposure=disabled`、`route_mismatch`、`unknown_route`、`unknown_profile`、`operation_mismatch`、`unmapped_stage`、`no_local_capability`。

防「假覆盖」的回归测试（`tests/test_capability_contract.py`）：

| 测试 | 钉住的事实 |
| --- | --- |
| `test_real_shaped_body_resolves_non_empty_pairs` | 真实形状 body 解析出 12 个成对声明，不是空表 |
| `test_route_alone_cannot_distinguish_speech_profiles` | 同一路径 3 个 profile 解析出 3 个不同答案 |
| `test_stage_ids_do_not_collapse_capabilities` | 两个 model 的 `stage_ids` 相同，能力状态仍各自独立 |
| `test_unrouted_capabilities_are_unknown_not_missing` | 有路由无 operation 的能力恒 `unknown` |
| `test_absent_fields_are_unknown` | 字段缺席是 `unknown`，只有明确 `unsupported` 才是 `missing` |

```bash
PYTHONPATH=packages/core/src:apps/api/src python -m pytest tests/test_capability_contract.py -q
```

## English

`GET /v1/omni/capabilities` reports what a deployment says about itself; the product needs to know what that deployment can do. `packages/core/src/opendirector/domain/capability_contract.py` is the only place that translates upstream's vocabulary into `opendirector.domain.capabilities` ids. It performs no HTTP, holds no display text, and introduces no second set of operation constants.

### The upstream vocabulary (as evidenced)

Source: `vllm-project/vllm-omni` PR #10102 (issue #10007), head `d1104f8`; every `path:line` below is from the head tree.

**Six closed operations** (`vllm_omni/serving_capabilities.py:15,19-26`): `chat`, `image_generation`, `image_edit`, `video_generation`, `speech`, `audio_generation`. There is no `asr`, `transcription`, `segmentation`, `depth` or `music`.

**Twelve profiles** (`:43-54`) and the ids this repository has for them:

| operation | profile | capability here |
| --- | --- | --- |
| `chat` | `text_response`, `image_response`, `audio_response` | `text.chat` |
| `image_generation` | `text_to_image` | `image.generate` |
| `image_edit` | `image_to_image` | `image.edit` |
| `video_generation` | `text_to_video`, `image_to_video`, `video_to_video` | `video.generate` |
| `speech` | `text_to_speech` | `audio.speech` |
| `speech` | `lyrics_to_music` | `audio.music` |
| `speech` | `caption_to_audio` | none — sound effect / ambience |
| `audio_generation` | `text_to_audio` | none — separate diffusion contract |

**Operation → routes** (`:42-54`): `chat` → `POST /v1/chat/completions`; `image_generation` → `POST /v1/images/generations`; `image_edit` → `POST /v1/images/edits`; `video_generation` → `POST /v1/videos`, `POST /v1/videos/sync`, `WEBSOCKET /v1/realtime/video`; `speech` → `POST /v1/audio/speech`; `audio_generation` → `POST /v1/audio/generate`.

Three more facts shape the table: the body has only `object`, `schema_version`, `observed_at`, `models`, `stages`, `routes` (`protocol/capabilities.py:73-79`) and is served with `response_model_exclude_none=True` (`api_server.py:2193`), so **an absent field is the designed way to say unknown**; `models[].operations` **must list all six** or pydantic raises (`protocol/capabilities.py:60-64`); and `models[].stage_ids` are numeric strings, the *same* full list for every model (`entrypoints/openai/serving_capabilities.py:400`).

### The key is the pair (operation, profile)

Not the route: `/v1/audio/speech` is one path with three contracts — `text_to_speech` (voice), `lyrics_to_music` (music), `caption_to_audio` (sound effect). Upstream's own tests show MOSS-SoundEffect serving `caption_to_audio` while reporting `text_to_speech` unsupported on that same path (`tests/config/test_serving_capabilities.py:233,251`): one path, two answers. A path-only key makes a sound-effect deployment look able to speak, and the reverse.

Not the stage either: `stages[]` publishes only `id` / `type` / `depends_on`, the ids are opaque numeric strings, and every model carries the same list. Keying on stages gives all models one shared state and no diagnosis, so `stages[]` only becomes `topology` here and never decides a capability; a stage entry carrying `routes` or `name` is ignored, because upstream's `CapabilityStage` has no such fields.

Routes still matter, as a consistency check: `OPERATION_ROUTES` records which operation owns which path, and a profile that references another operation's path (say `text_to_video` → `/v1/images/edits`) grants nothing and is reported as `route_mismatch`.

### Six untranslatable declarations

`unknown_route` (the path belongs to no operation, including registered-but-unowned `/v1/images/segmentations`), `route_mismatch` (the path belongs to another operation), `unmapped_stage` (no such operation upstream — `asr`, `music`), `unknown_profile` (operation known, profile id unpublished), `operation_mismatch` (profile known under another operation), `no_local_capability` (profile supported, no id here). All six land in `unresolved` with `operation` / `profile` / `route` / `reason`, never dropped.

### Three capability states, and `missing` needs positive evidence

`available` when a model's profile says `supported` and its operation is not `exposure=disabled`; `missing` only when a profile or operation says no (`support=unsupported` or `exposure=disabled`); `unknown` for everything else — failed request, absent field, `unknown` enum value, an untranslatable declaration, or a capability no profile can express. **"The service did not say" is not "the service cannot"**: no models, no operations, or a dropped `profiles` field yields `unknown`, never `missing`.

### Routes without an operation

`/v1/images/segmentations`, `/v1/videos/segmentations` and `/v1/videos/depth` are registered endpoints that no operation owns; upstream's docs state that "segmentation and depth estimation do not acquire one of these operations merely by being present in a registry" (`docs/serving/capabilities.md:41-43`). `image.segment`, `video.matting` and `video.motion_capture` therefore stay `unknown` with `no_upstream_profile` — the endpoint does not publish the ability, so it cannot be judged, and it must never read as `missing`. `audio.score` is `no_upstream_operation`; `video.first_frame`, `video.edit` and `image.cutout` are `parameter_only` (request fields of a published operation); `audio.separate` is `no_local_adapter`.

### ASR: an upstream gap, not a missing row

Upstream publishes no recognition operation and omni's router never registers `/v1/audio/transcriptions` (absent from `api_server.py`; its own recipe says the endpoint is "not currently available with `--omni`"). A caller naming `asr` gets `unmapped_stage` — the upstream vocabulary has no such operation, this table did not lose a row — and `audio.score` stays `unknown` (`no_upstream_operation`). `/v1/audio/transcriptions` is never read as `audio.score`.

### Relationship to the V2 discovery contract (#266)

This table is an input to #266, not a replacement and not a second schema: `domain/omni_capabilities.py` owns the discovery document and matching, this module owns only the `(operation, profile) → capability` layer, under a different file name. It no longer reads `Model.stage_ids` — that is topology, not a capability key — and `declarations()` reads only the published `models[].operations[<op>].profiles[]` shape. It does not modify `domain/omni_capabilities.py`, `integrations/capability_probe.py`, `application/model_availability.py` or `src/**`.

### Feeding `requests_for()`

`application/model_availability.py` currently hard-codes profile names per `(kind, protocol)`; with a table the caller needs only the operation and profile it is about to use:

```python
from opendirector.domain.capability_contract import capabilities_for

capabilities_for('speech', 'lyrics_to_music')   # ('audio.music',)
capabilities_for('speech', 'text_to_speech')    # ('audio.speech',)
```

`resolve(payload)` returns per-capability states, `topology` (display only) and `unresolved`; `classified_capabilities()` returns the vocabulary in table order. Whether to wire this into `requests_for()` is #266's decision; this contract only guarantees the lookup is paired, ordered and testable.

### Fixtures and checks

`tests/fixtures/omni-capabilities/{full,partial,absent}.json` follow the real response shape — `stages[]` as `{id,type,depends_on}`, six complete `operations` per model each with `support`/`exposure`/`reason_code`/`profiles`/`execution`, profiles with `routes[]`/`required_inputs`/`outputs`; the `absent` tier omits fields the way `exclude_none=True` does instead of writing `null`; the `partial` tier covers `support=unsupported`, `exposure=disabled`, `route_mismatch`, `unknown_route`, `unknown_profile`, `operation_mismatch`, `unmapped_stage` and `no_local_capability`.

Five regressions keep coverage honest: `test_real_shaped_body_resolves_non_empty_pairs` (a real body yields twelve pairs), `test_route_alone_cannot_distinguish_speech_profiles` (one path, three profiles, three answers), `test_stage_ids_do_not_collapse_capabilities` (identical `stage_ids`, independent states), `test_unrouted_capabilities_are_unknown_not_missing`, and `test_absent_fields_are_unknown` (absence is `unknown`; only an explicit `unsupported` is `missing`).

```bash
PYTHONPATH=packages/core/src:apps/api/src python -m pytest tests/test_capability_contract.py -q
```
