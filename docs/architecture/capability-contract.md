# Capability mapping contract / 能力映射表契约

## 中文

`GET /v1/omni/capabilities` 只说明部署「自述了什么」；产品要回答的是「这个部署能不能做某件事」。`packages/core/src/opendirector/domain/capability_contract.py` 是唯一把上游词表翻译成 `opendirector.domain.capabilities` id 的地方。它不发起 HTTP，不持有界面文案，也不创建第二套 operation 常量。

### 上游真实词表（取证）

取证对象：`vllm-project/vllm-omni` PR #10102（issue #10007），head `d1104f8`。下列 `path:line` 均取自 head 原文件。

**6 个 operation 是闭合常量**（`vllm_omni/serving_capabilities.py:15,19-26`）：
`chat` / `image_generation` / `image_edit` / `video_generation` / `speech` / `audio_generation`。
没有 `asr`、`transcription`、`segmentation`、`depth`、`music`。

**12 个 profile**（`:43-54`），以及本仓对应的 capability id。**输出模态不同的 profile 不合并**：`text.chat` 在本仓由纯文本适配器消费（`integrations/model_adapters.py:566-580` 直接取 `choices[0]["message"]["content"]` 当字符串），把「只出图」的 chat 部署折进 `text.chat` 会让它看起来能聊天。

| operation | profile | 上游 `required_inputs` → `outputs` | 本仓 capability id |
| --- | --- | --- | --- |
| `chat` | `text_response` | `("text",)` → `("text",)` | `text.chat` |
| `chat` | `image_response` | `("text",)` → `("image",)` | （无）输出是图像，不是本仓 `text.chat` |
| `chat` | `audio_response` | `("text",)` → `("audio",)` | （无）输出是音频，不是本仓 `text.chat` |
| `image_generation` | `text_to_image` | `("text",)` → `("image",)` | `image.generate` |
| `image_edit` | `image_to_image` | `("image","text")` → `("image",)` | `image.edit` |
| `video_generation` | `text_to_video` | `("text",)` → `("video",)` | `video.generate` |
| `video_generation` | `image_to_video` | `("image","text")` → `("video",)` | `video.generate` |
| `video_generation` | `video_to_video` | `("video","text")` → `("video",)` | `video.generate` |
| `speech` | `text_to_speech` | `("text",)` → `("audio",)` | `audio.speech` |
| `speech` | `lyrics_to_music` | `("text","instructions")` → `("audio",)` | `audio.music` |
| `speech` | `caption_to_audio` | `("text",)` → `("audio",)` | （无）音效/环境声，本仓无对应 id |
| `audio_generation` | `text_to_audio` | `("text",)` → `("audio",)` | `audio.music`（同为「文本生成音频」） |

两个「沉默」的行要一起读：

- `image_response` / `audio_response` 上游确实发布，但本仓没有「图片/音频版 chat」id，所以**保持 `unknown`**，`unresolved` 里报 `no_local_capability`。绝不折进 `text.chat`。
- `text_to_audio` 走的是扩散侧独立请求契约（`/v1/audio/generate`，无 voice/lyrics/instructions 映射，`docs/serving/capabilities.md:59-60`），但语义就是「文本生成音频」，与 `lyrics_to_music` 同属音频生成，因此映射到 `audio.music`。否则 StableAudio / LTX2-t2a 这种形状（`speech/text_to_speech=unsupported`、`audio_generation/text_to_audio=supported`）会把 `audio.music` 反判成 `missing`。

**operation → 路由**，三个维度都要对（`:42-54`）。上游的 `RouteKey` 是 `(transport, method, path)`，websocket 路由的 method 字面量就是 `WEBSOCKET`：

| operation | 路由（transport, method, path） |
| --- | --- |
| `chat` | `http POST /v1/chat/completions` |
| `image_generation` | `http POST /v1/images/generations` |
| `image_edit` | `http POST /v1/images/edits` |
| `video_generation` | `http POST /v1/videos`；`http POST /v1/videos/sync`；`websocket WEBSOCKET /v1/realtime/video` |
| `speech` | `http POST /v1/audio/speech` |
| `audio_generation` | `http POST /v1/audio/generate` |

`method` 不是装饰：`DELETE /v1/chat/completions` 会得到 405，`transport=websocket` 声明在 http 路由上是错的声明，两者都报 `route_mismatch`。`transport` 上游有默认值 `http`（`protocol/capabilities.py:16-21`），缺席不算不符；`method` 没有默认值，缺席即无法确认，按不符处理。

三条 schema 事实决定了这份表的形状：

- 响应顶层只有 `object` / `schema_version` / `observed_at` / `models` / `stages` / `routes`（`protocol/capabilities.py:73-79`），端点是 `response_model=OmniCapabilitiesResponse`、`response_model_exclude_none=True`（`api_server.py:2193`）。
- **`exclude_none` 只能省掉值为 `None` 的可选字段**，也就是 profile 的 `request`（`RequestConstraints | None = None`）。列表/字典字段是 `default_factory`，空的时候序列化成 `[]`/`{}`，**不会缺席**：`profiles: []` 而不是「没有 `profiles` 键」。`support` / `exposure` / `reason_code` 在 operation 和 profile 上都是必填（`protocol/capabilities.py:36-52`），永远不会缺席；少了它们就不是上游能发出的 body。
- `models[].operations` **必须齐全 6 个**，少一个 pydantic 直接抛错（`protocol/capabilities.py:60-64`）；`models[].stage_ids` 是**数字字符串**，而且每个 model 拿到的都是同一份全量列表（`entrypoints/openai/serving_capabilities.py:400`）。

### 键是 (operation, profile)，不是 route，也不是 stage

**为什么不是 route**：`/v1/audio/speech` 一条路径挂 3 个 profile —— `text_to_speech`（配音）、`lyrics_to_music`（音乐）、`caption_to_audio`（音效）。上游自己的测试里，MOSS-SoundEffect 在 speech 上只声明 `caption_to_audio`，同时把 `text_to_speech` 标成 `unsupported`（`tests/config/test_serving_capabilities.py:233,251`）：**同一路径，两种答案**。只按路径匹配，「只做音效」的部署会看起来会配音，反过来也一样。因此 `OPERATION_PROFILES` 的键是成对的 `(operation, profile)`，经 `capabilities_for(operation, profile)` 查找。

**为什么不是 stage**：`stages[]` 只有 `id` / `type` / `depends_on`（`protocol/capabilities.py:67-70`），id 是不连续的数字字符串，而且每个 model 都是同一份列表。拿它当键，所有模型会共享一个状态，既区分不了也不能诊断。本模块把 `stages[]` 只放进 `topology` 供展示，**从不用它决定任何能力**；一个 stage 条目即使自带 `routes` 或 `name` 也被忽略，因为上游 schema 没有这两个键。

**route 仍然有用**：`OPERATION_ROUTES` 保留每个 operation 对 `(transport, method, path)` 的所有权，用来校验声明的一致性 —— 某个 profile 引用了不属于该 operation 的路径、或用错了 method/transport，该 profile 不产生能力，并报 `route_mismatch`。它同时决定「profile 自己说的可达性」：`profiles[*].routes[*].exposure` 是上游第三层 exposure，会按 profile 覆写（例如需要 video/audio 输入的 profile 在 `/v1/realtime/video` 上被强制 `disabled`，`serving_capabilities.py:341-343`）。

### 八种无法翻译的声明

| reason | 含义 | 修的地方 |
| --- | --- | --- |
| `unknown_route` | 路径不属于任何 operation（`/v1/videos/segmentations`，或已注册但无 operation 的 `/v1/images/segmentations`） | 表缺这个 operation，或声明写错了路径 |
| `route_mismatch` | 路径属于**另一个** operation，或 method/transport 与该 operation 的路由不符（`text_to_video` 指向 `/v1/images/edits`、`DELETE /v1/chat/completions`） | 部署声明的配对写错了 |
| `unmapped_stage` | 上游没有这个 operation（`asr`、`music`）。名字沿用上一版 stage-keyed 设计，含义是 operation 层缺口 | 上游词表缺口，不是本表漏行 |
| `unknown_profile` | operation 认识，profile id 上游未发布（`speech_to_speech`） | 上游新增 profile，本表待补 |
| `operation_mismatch` | profile 认识，但挂在别的 operation 下（`lyrics_to_music` 挂在 `audio_generation`） | 声明写错了 operation，或本表把归属搞错了 |
| `no_local_capability` | profile 支持，但本仓没有对应 capability id（`caption_to_audio`、`image_response`、`audio_response`） | 词表待补 |
| `no_route_declared` | profile 说自己支持，却一条路由都没声明（`routes: []` 是上游合法默认值） | 声明不完整；可达性无法确认 |
| `malformed_route` | 路由条目里没有可用的 `path`（畸形 body） | 上游 bug 或代理改写 |

八种都进 `unresolved`，不被丢弃；每条都带 `operation` / `profile` / `route` / `reason` 四键（不适用处为 `null`），调用方可以解释「为什么这条声明没变成能力」，而不是静默隐藏。

### 三种能力状态，只有正面证据才是 missing

- `available`：某个 model 的 profile 明确 `support=supported`，其 operation 是 `supported` + `exposure=enabled`，且该 profile **至少有一条自己的路由 `exposure=enabled`**；
- `missing`：某个 profile 或 operation **正面说不**（`support=unsupported` / `exposure=disabled` / 自己的路由全 `disabled`）；
- `unknown`：其余全部 —— 请求失败/404、字段缺席、枚举为 `unknown`、路由可达性无法确认、声明无法翻译、能力本身不可路由。

`resolve()` 的返回值除 `capabilities` 外，还有 **`reasons`**：只给 `missing` 的能力一个原因码（`unsupported` / `endpoint_disabled` / `route_disabled`）。`support=unsupported` 与 `exposure=disabled` 都是「正面说不」，但事实不同——一个是模型不行，一个是管理员把路由关了——所以不再坍缩成同一个 `missing`。

`unknown` 的原因不在 `reasons` 里，而在 `unresolved`（声明级）或 `UNROUTED` 表（能力级），见下表。

### 状态与 reason 的映射表（契约）

维护者改这张表前先看这一节：每一种上游形状落到哪个 status、从哪个出口能查到原因。

| 上游声明 | status | 原因出口 |
| --- | --- | --- |
| profile `support=unsupported` | `missing` | `reasons[cid] = "unsupported"` |
| operation `support=unsupported`（profile 说什么都一样） | `missing` | `reasons[cid] = "unsupported"` |
| operation `support=supported` + `exposure=disabled`（部署关了路由） | `missing` | `reasons[cid] = "endpoint_disabled"` |
| profile `support=supported`，但它声明的路由**全部** `exposure=disabled` | `missing` | `reasons[cid] = "route_disabled"` |
| profile 声明的路由全部 `exposure=unknown`（上游默认值） | `unknown` | 无（可达性无法确认，不是拒绝） |
| profile `routes: []`（上游默认空列表） | `unknown` | `unresolved: no_route_declared` |
| 路由条目没有可用 `path` | `unknown` | `unresolved: malformed_route` |
| 路由 path 不认得，且没有别的可用路由 | `unknown` | `unresolved: unknown_route` |
| 路由 path 属于别的 operation，或 method/transport 不符 | `unknown` | `unresolved: route_mismatch` |
| 上游有 profile，本仓没有 id（`caption_to_audio` 等） | `unknown` | `unresolved: no_local_capability` |
| operation 认不出（`asr`）/ profile 认不出 / profile 挂错 operation | 该能力无证据 → `unknown` | `unresolved: unmapped_stage` / `unknown_profile` / `operation_mismatch` |
| `support=supported` + `exposure=enabled` + 至少一条自己的路由 `enabled` | `available` | 无 |
| 能力本身没有上游 profile（`image.segment` 等 8 项） | `unknown` | `UNROUTED[cid]`（`no_upstream_profile` / `no_upstream_operation` / `parameter_only` / `no_local_adapter`） |
| body 没答（`None`、无 `models` 键、`models` 不是列表） | 全部 `unknown` | `endpoint = "absent"` |
| 答了，但没有 model 声明任何 operation（含 `models: []`） | 全部 `unknown` | `endpoint = "empty"` |
| operation 答了但 `profiles: []` | 该 operation 的能力 `unknown` | `endpoint = "present"` |

两条边界值得单独记住：

1. **一条不认得的路由不打穿已确认的 profile**。上游会加路由，本表会落后；只有当该 profile **全部**路由都不认得（或全部被拒）时才降为 `unknown`，否则保留判定并在 `unresolved` 里记一条。
2. **`endpoint` 三值**区分「没答」与「答了但没声明」：`absent` / `empty` / `present`。前者该降级或报错，后者该提示「服务未声明能力」，两者对用户的意义完全不同。

### 有路由、没有 operation 的能力

`/v1/images/segmentations`、`/v1/videos/segmentations`、`/v1/videos/depth` 是**已注册的端点，但没有任何 operation 拥有它们**（上游文档明示：segmentation 与 depth「不会仅因为出现在 registry 里就获得这些 operation」，`docs/serving/capabilities.md:41-43`）。所以 `image.segment` / `video.matting` / `video.motion_capture` 恒为 `unknown`，reason 是 `no_upstream_profile` —— 端点不发布该能力，无法判定；**不能**写成 `missing`。

`UNROUTED` 里其余几项理由不同，不要混：

| capability | reason | 说明 |
| --- | --- | --- |
| `image.segment` / `video.matting` / `video.motion_capture` | `no_upstream_profile` | 有路由，无 operation |
| `audio.score` | `no_upstream_operation` | 上游没有识别 operation |
| `video.first_frame` / `video.edit` / `image.cutout` | `parameter_only` | 是已发布 operation 的请求参数，不是 profile |
| `audio.separate` | `no_local_adapter` | 上游没说法，本仓也没适配器 |

这 8 个 id **不出现在** `OPERATION_PROFILES` 的值域里，所以它们永远收不到证据，`unknown` 是「没有证据」的自然结果，而不是 `resolve()` 里的一个特例分支（这条不变量由 `test_every_capability_id_is_routed_or_explained` 守着）。

### ASR：上游未发布该 operation

上游词表里没有识别 operation，omni 的 router 也不注册 `/v1/audio/transcriptions`（`api_server.py` 全量路由里没有它），上游自己的 recipe 写明该端点「not currently available with `--omni`」。因此 body 里出现 `asr` 得到 `unmapped_stage`：这是**上游没发布这个 operation**，不是本表漏了一行。

这不等于「本仓不认 `audio.score`」——恰恰相反，本仓 `VllmOmniScore` 适配器 POST 的正是 `/audio/transcriptions`（`integrations/model_adapters.py:547,556`），对端是上游的独立工具 `tools/sheetsage2_serve.py:124`。但 **capabilities body 从不会提到这条路径**，所以 `audio.score` 只能判 `unknown`（`no_upstream_operation`）：本表不从「我们知道某条路由」反推能力，那样会把部署策略、代理改写和表 bug 混成同一个结论。等上游发布识别 operation（或把该路径纳入词表）再谈映射。

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
capabilities_for('audio_generation', 'text_to_audio')  # ('audio.music',)
```

`resolve(payload)` 返回逐能力状态（`capabilities`）、缺失原因（`reasons`）、`topology`（`stages[]`，仅供展示）与 `unresolved`；`classified_capabilities()` 按表顺序给出词表，展示层据此排列。是否接进 `requests_for()` 由 #266 一侧决定，本契约只保证查找是成对的、稳定的、可测的。

### 三档 fixture 与验证

`tests/fixtures/omni-capabilities/{full,partial,absent}.json` 按**真实响应形状**写：`stages[]` 是 `{id,type,depends_on}` 且 id 为数字字符串，`models[].operations` 六个齐全、每个含 `support`/`exposure`/`reason_code`/`profiles`/`execution`，每个 profile 都带 `support` 与 `routes[]`（可以是 `[]`），`image_response`/`audio_response` 的 `outputs` 照上游 `STANDARD_PROFILES` 分别是 `["image"]`/`["audio"]`。

- `full`：全支持全启用，12 个 profile 齐全；`image_response`/`audio_response`/`caption_to_audio` 报 `no_local_capability`，`text_to_audio` 让 `audio.music` 为 `available`。
- `partial`：`support=unsupported`、operation `exposure=disabled`（`endpoint_disabled`）、profile 自己的路由 `disabled`（`route_disabled`）、`route_mismatch`、`no_local_capability`，以及整个 body 都是 `unknown` 枚举的形态。
- `absent`：没答（`absent`）、只答拓扑（`empty`）、六个 operation 都答了但 `profiles: []`（`present` 且全 `unknown`）。

**上游不可能发出的形状**（`asr` operation 键、profile 挂在错 operation、缺必填 `support`、`profiles` 整键缺席）**不进 fixture**，只在对应测试里内联构造 —— 它们是防御性输入的用例，混进 fixture 会让「fixture = 真实样本」这句话变成假话。`test_fixtures_are_schema_valid` 只断言上游 schema 的**结构不变量**（六操作齐全、必填字段在、`profiles` 是列表、stages 形状、id 为数字字符串），不把上游 pydantic 源码抄一份进本仓。

防「假覆盖」的回归测试（`tests/test_capability_contract.py`）：

| 测试 | 钉住的事实 |
| --- | --- |
| `test_real_shaped_body_resolves_non_empty_pairs` | 真实形状 body 解析出 12 个成对声明，不是空表 |
| `test_route_alone_cannot_distinguish_speech_profiles` | 同一路径 3 个 profile 解析出 3 个不同答案 |
| `test_stage_ids_do_not_collapse_capabilities` | 两个 model 的 `stage_ids` 相同，能力状态仍各自独立 |
| `test_capabilities_without_an_upstream_profile_are_unknown_not_missing` | 8 个无上游 profile 的 id 恒 `unknown`，且 `reasons` 里不出现 |
| `test_a_profile_without_support_is_unknown_even_when_its_operation_is_supported` | profile 级字段缺席是 `unknown`（不是 `supported`） |
| `test_a_profile_that_declares_no_route_is_unknown` | `supported + routes: []` 不能判 `available` |
| `test_a_profile_whose_only_route_is_disabled_is_missing` | profile 路由全 `disabled` → `missing` + `route_disabled` |
| `test_a_profile_whose_routes_are_all_unknown_cannot_be_confirmed` | 路由全 `unknown` → `unknown` |
| `test_one_unrecognised_route_does_not_void_a_profile_that_answered` | 一条不认得的路由不打穿已确认的 profile |
| `test_a_wrong_method_is_a_route_mismatch` | `DELETE /v1/chat/completions` 不授予 chat |
| `test_an_image_only_chat_deployment_does_not_read_as_text_chat` | `image_response` 不折进 `text.chat` |
| `test_text_to_audio_grants_audio_music` | `text_to_audio` → `audio.music` |
| `test_a_refused_model_and_a_closed_route_are_told_apart` | `unsupported` / `endpoint_disabled` / `route_disabled` 三码可分 |

```bash
PYTHONPATH=packages/core/src:apps/api/src python -m pytest tests/test_capability_contract.py -q
```

## English

`GET /v1/omni/capabilities` reports what a deployment says about itself; the product needs to know what that deployment can do. `packages/core/src/opendirector/domain/capability_contract.py` is the only place that translates upstream's vocabulary into `opendirector.domain.capabilities` ids. It performs no HTTP, holds no display text, and introduces no second set of operation constants.

### The upstream vocabulary (as evidenced)

Source: `vllm-project/vllm-omni` PR #10102 (issue #10007), head `d1104f8`; every `path:line` below is from the head tree.

**Six closed operations** (`vllm_omni/serving_capabilities.py:15,19-26`): `chat`, `image_generation`, `image_edit`, `video_generation`, `speech`, `audio_generation`. There is no `asr`, `transcription`, `segmentation`, `depth` or `music`.

**Twelve profiles** (`:43-54`) and the ids this repository has for them. Profiles with a different output modality are not merged: `text.chat` here is consumed by a text-only adapter (`integrations/model_adapters.py:566-580` reads `choices[0]["message"]["content"]` as a string), so an image-only chat deployment must not read as able to chat.

| operation | profile | upstream `required_inputs` → `outputs` | capability here |
| --- | --- | --- | --- |
| `chat` | `text_response` | `("text",)` → `("text",)` | `text.chat` |
| `chat` | `image_response` | `("text",)` → `("image",)` | none — the output is an image, not this repo's `text.chat` |
| `chat` | `audio_response` | `("text",)` → `("audio",)` | none — the output is audio, not this repo's `text.chat` |
| `image_generation` | `text_to_image` | `("text",)` → `("image",)` | `image.generate` |
| `image_edit` | `image_to_image` | `("image","text")` → `("image",)` | `image.edit` |
| `video_generation` | `text_to_video` | `("text",)` → `("video",)` | `video.generate` |
| `video_generation` | `image_to_video` | `("image","text")` → `("video",)` | `video.generate` |
| `video_generation` | `video_to_video` | `("video","text")` → `("video",)` | `video.generate` |
| `speech` | `text_to_speech` | `("text",)` → `("audio",)` | `audio.speech` |
| `speech` | `lyrics_to_music` | `("text","instructions")` → `("audio",)` | `audio.music` |
| `speech` | `caption_to_audio` | `("text",)` → `("audio",)` | none — sound effect / ambience |
| `audio_generation` | `text_to_audio` | `("text",)` → `("audio",)` | `audio.music` (text to audio, same family) |

`image_response` and `audio_response` are published upstream but have no id here: they stay `unknown` and are reported as `no_local_capability` instead of being folded into `text.chat`. `text_to_audio` uses the separate diffusion request contract behind `/v1/audio/generate` (no voice, no lyrics; `docs/serving/capabilities.md:59-60`) yet is still text-to-audio, so it grants `audio.music` alongside `lyrics_to_music`; without that row a StableAudio / LTX2-t2a shape (`speech/text_to_speech=unsupported`, `audio_generation/text_to_audio=supported`) would report `audio.music=missing`.

**Operation → routes** (`:42-54`) as `(transport, method, path)`, because upstream's `RouteKey` is exactly that and the websocket method literal is `WEBSOCKET`: `chat` → `http POST /v1/chat/completions`; `image_generation` → `http POST /v1/images/generations`; `image_edit` → `http POST /v1/images/edits`; `video_generation` → `http POST /v1/videos`, `http POST /v1/videos/sync`, `websocket WEBSOCKET /v1/realtime/video`; `speech` → `http POST /v1/audio/speech`; `audio_generation` → `http POST /v1/audio/generate`. `DELETE /v1/chat/completions` would be a 405 and a `websocket` declaration on an http route is wrong, so both are `route_mismatch`. `transport` defaults to `http` upstream (`protocol/capabilities.py:16-21`) and an absent transport is not a mismatch; `method` has no default and an absent one cannot be confirmed.

Three schema facts shape the table: the body has only `object`, `schema_version`, `observed_at`, `models`, `stages`, `routes` (`protocol/capabilities.py:73-79`) and is served with `response_model_exclude_none=True` (`api_server.py:2193`); **`exclude_none` drops only `None`-valued optional fields** — in practice the profile's `request` — while `default_factory` lists serialize as `[]` (`profiles: []`, never a missing key) and `support`/`exposure`/`reason_code` are required on every operation and profile (`protocol/capabilities.py:36-52`), so a body lacking them is not a shape upstream can emit; and `models[].operations` **must list all six** or pydantic raises (`:60-64`), with `stage_ids` numeric strings, the *same* full list for every model (`entrypoints/openai/serving_capabilities.py:400`).

### The key is the pair (operation, profile)

Not the route: `/v1/audio/speech` is one path with three contracts — `text_to_speech` (voice), `lyrics_to_music` (music), `caption_to_audio` (sound effect). Upstream's own tests show MOSS-SoundEffect serving `caption_to_audio` while reporting `text_to_speech` unsupported on that same path (`tests/config/test_serving_capabilities.py:233,251`): one path, two answers. A path-only key makes a sound-effect deployment look able to speak, and the reverse.

Not the stage either: `stages[]` publishes only `id` / `type` / `depends_on`, the ids are opaque numeric strings, and every model carries the same list. Keying on stages gives all models one shared state and no diagnosis, so `stages[]` only becomes `topology` here and never decides a capability; a stage entry carrying `routes` or `name` is ignored, because upstream's `CapabilityStage` has no such fields.

Routes still matter, in two ways: `OPERATION_ROUTES` records which operation owns which `(transport, method, path)` and a profile referencing another operation's path — or the wrong method — grants nothing and is reported as `route_mismatch`; and `profiles[*].routes[*].exposure` is upstream's third exposure layer, overridden per profile (a profile needing video/audio input is forced `disabled` on `/v1/realtime/video`, `serving_capabilities.py:341-343`).

### Eight untranslatable declarations

`unknown_route` (the path belongs to no operation, including registered-but-unowned `/v1/images/segmentations`), `route_mismatch` (another operation's path, or a wrong method/transport), `unmapped_stage` (no such operation upstream — `asr`, `music`; the name predates the pair-keyed table), `unknown_profile` (operation known, profile id unpublished), `operation_mismatch` (profile known under another operation), `no_local_capability` (profile supported, no id here), `no_route_declared` (a supported profile with `routes: []`), `malformed_route` (a route entry with no usable `path`). All eight land in `unresolved` with `operation` / `profile` / `route` / `reason`, never dropped.

### Three capability states, and `missing` needs positive evidence

`available` when a model's profile says `supported`, its operation is `supported`+`enabled`, and at least one of the profile's own routes is `enabled`; `missing` only when a profile or operation says no; `unknown` for everything else — failed request, absent field, `unknown` enum value, unconfirmed reachability, an untranslatable declaration, or a capability no profile can express. `resolve()` also returns `reasons`, which names the kind of refusal for every `missing` capability: `unsupported` (the model refused), `endpoint_disabled` (the deployment closed the operation's routes) or `route_disabled` (every route the profile declares is closed). Reasons for `unknown` live in `unresolved` (declaration level) or in `UNROUTED` (capability level).

### Status and reason mapping (the contract)

| Upstream declaration | status | where the reason lives |
| --- | --- | --- |
| profile `support=unsupported` | `missing` | `reasons[cid] = "unsupported"` |
| operation `support=unsupported` | `missing` | `reasons[cid] = "unsupported"` |
| operation `supported` + `exposure=disabled` | `missing` | `reasons[cid] = "endpoint_disabled"` |
| all of the profile's routes `exposure=disabled` | `missing` | `reasons[cid] = "route_disabled"` |
| all of the profile's routes `exposure=unknown` | `unknown` | none — reachability unconfirmed, not a refusal |
| profile `routes: []` | `unknown` | `unresolved: no_route_declared` |
| a route entry with no usable `path` | `unknown` | `unresolved: malformed_route` |
| an unrecognised path, and nothing else usable | `unknown` | `unresolved: unknown_route` |
| another operation's path, or a wrong method/transport | `unknown` | `unresolved: route_mismatch` |
| upstream profile, no id here | `unknown` | `unresolved: no_local_capability` |
| unknown operation / profile / misplaced profile | no evidence → `unknown` | `unresolved: unmapped_stage` / `unknown_profile` / `operation_mismatch` |
| `supported`, `enabled`, one `enabled` route | `available` | none |
| a capability no upstream profile can express | `unknown` | `UNROUTED[cid]` (`no_upstream_profile` / `no_upstream_operation` / `parameter_only` / `no_local_adapter`) |
| no answer (`None`, no `models`, `models` not a list) | all `unknown` | `endpoint = "absent"` |
| answered, but no model declared an operation | all `unknown` | `endpoint = "empty"` |
| operation answered with `profiles: []` | `unknown` | `endpoint = "present"` |

Two boundaries to keep: one unrecognised route must not void a profile that answered (upstream adds routes; only when nothing usable remains does the profile fall to `unknown`), and `endpoint` distinguishes "did not answer" (`absent`) from "answered without declaring" (`empty`) from "declared" (`present`).

### Routes without an operation

`/v1/images/segmentations`, `/v1/videos/segmentations` and `/v1/videos/depth` are registered endpoints that no operation owns; upstream's docs state that "segmentation and depth estimation do not acquire one of these operations merely by being present in a registry" (`docs/serving/capabilities.md:41-43`). `image.segment`, `video.matting` and `video.motion_capture` therefore stay `unknown` with `no_upstream_profile` — the endpoint does not publish the ability, so it cannot be judged, and it must never read as `missing`. `audio.score` is `no_upstream_operation`; `video.first_frame`, `video.edit` and `image.cutout` are `parameter_only` (request fields of a published operation); `audio.separate` is `no_local_adapter`. None of these eight ids is a value of `OPERATION_PROFILES`, so `unknown` falls out of "no evidence" rather than a special case.

### ASR: an upstream gap, not a missing row

Upstream publishes no recognition operation and omni's router never registers `/v1/audio/transcriptions` (absent from `api_server.py`; its own recipe says the endpoint is "not currently available with `--omni`"). A body naming `asr` gets `unmapped_stage` — the upstream vocabulary has no such operation, this table did not lose a row. That is not a claim that this repository ignores `audio.score`: the `VllmOmniScore` adapter does post to `/audio/transcriptions` (`integrations/model_adapters.py:547,556`), whose peer is the standalone `tools/sheetsage2_serve.py:124`. But a capabilities body never mentions that path, so `audio.score` can only be `unknown` (`no_upstream_operation`): a route we happen to know is not evidence of a published capability.

### Relationship to the V2 discovery contract (#266)

This table is an input to #266, not a replacement and not a second schema: `domain/omni_capabilities.py` owns the discovery document and matching, this module owns only the `(operation, profile) → capability` layer, under a different file name. It no longer reads `Model.stage_ids` — that is topology, not a capability key — and `declarations()` reads only the published `models[].operations[<op>].profiles[]` shape. It does not modify `domain/omni_capabilities.py`, `integrations/capability_probe.py`, `application/model_availability.py` or `src/**`.

### Feeding `requests_for()`

`application/model_availability.py` currently hard-codes profile names per `(kind, protocol)`; with a table the caller needs only the operation and profile it is about to use:

```python
from opendirector.domain.capability_contract import capabilities_for

capabilities_for('speech', 'lyrics_to_music')   # ('audio.music',)
capabilities_for('speech', 'text_to_speech')    # ('audio.speech',)
capabilities_for('audio_generation', 'text_to_audio')  # ('audio.music',)
```

`resolve(payload)` returns per-capability states, per-capability `reasons`, `topology` (display only) and `unresolved`; `classified_capabilities()` returns the vocabulary in table order. Whether to wire this into `requests_for()` is #266's decision; this contract only guarantees the lookup is paired, ordered and testable.

### Fixtures and checks

`tests/fixtures/omni-capabilities/{full,partial,absent}.json` follow the real response shape — `stages[]` as `{id,type,depends_on}` with numeric-string ids, six complete `operations` per model each with `support`/`exposure`/`reason_code`/`profiles`/`execution`, every profile carrying `support` and `routes` (possibly `[]`), and `image_response`/`audio_response` outputs `["image"]`/`["audio"]` as published. `full` is the all-yes deployment, `partial` mixes refusals, a policy-disabled operation, a profile whose own route is disabled, a misplaced route and an all-`unknown` body, and `absent` covers no answer (`absent`), topology only (`empty`) and six operations that declare `profiles: []` (`present`, all `unknown`).

Shapes upstream can never emit — an `asr` operation key, a profile filed under the wrong operation, a missing required `support` — are built inline in the tests that defend against malformed input, never in a fixture, so "the fixtures are a real sample" stays true. `test_fixtures_are_schema_valid` asserts only the structural invariants of upstream's model, not a copy of it.

Five regressions keep coverage honest: `test_real_shaped_body_resolves_non_empty_pairs`, `test_route_alone_cannot_distinguish_speech_profiles`, `test_stage_ids_do_not_collapse_capabilities`, `test_capabilities_without_an_upstream_profile_are_unknown_not_missing`, and `test_a_profile_without_support_is_unknown_even_when_its_operation_is_supported`; the route-level exposure, transport/method, chat-modality and missing-reason cases each have their own test, listed in the Chinese section above.

```bash
PYTHONPATH=packages/core/src:apps/api/src python -m pytest tests/test_capability_contract.py -q
```
