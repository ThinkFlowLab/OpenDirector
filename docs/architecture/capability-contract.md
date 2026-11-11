# Capability mapping contract / 能力映射表契约

## 中文

`GET /v1/omni/capabilities` 只说明部署「自述了什么」；产品要回答的是「这个部署能不能做某件事」。`packages/core/src/opendirector/domain/capability_contract.py` 是唯一把上游词表翻译成 `opendirector.domain.capabilities` id 的地方。它不发起 HTTP，不持有界面文案，也不创建第二套 operation 常量。

### 上游真实词表（取证）

取证对象：`vllm-project/vllm-omni` PR #10102（issue #10007），head `d1104f8`。下列 `path:line` 均取自 head 原文件。

**6 个 operation 是闭合常量**（`vllm_omni/serving_capabilities.py:15,19-26`）：
`chat` / `image_generation` / `image_edit` / `video_generation` / `speech` / `audio_generation`。
没有 `asr`、`transcription`、`segmentation`、`depth`、`music`。

**12 个 profile**（`:43-54`），以及本仓对应的 capability id。**输出模态不同的 profile 不合并**：`text.chat` 在本仓由纯文本适配器消费（`integrations/model_adapters.py:631-647` 直接取 `choices[0]["message"]["content"]` 当字符串），把「只出图」的 chat 部署折进 `text.chat` 会让它看起来能聊天。

| operation | profile | 上游 `required_inputs` → `outputs` | 本仓 capability id |
| --- | --- | --- | --- |
| `chat` | `text_response` | `("text",)` → `("text",)` | `text.chat` |
| `chat` | `image_response` | `("text",)` → `("image",)` | （无）输出是图像，不是本仓 `text.chat` |
| `chat` | `audio_response` | `("text",)` → `("audio",)` | （无）输出是音频，不是本仓 `text.chat` |
| `image_generation` | `text_to_image` | `("text",)` → `("image",)` | `image.generate` |
| `image_edit` | `image_to_image` | `("text","image")` → `("image",)` | `image.edit` |
| `video_generation` | `text_to_video` | `("text",)` → `("video",)` | `video.generate` |
| `video_generation` | `image_to_video` | `("text","image")` → `("video",)` | `video.first_frame` |
| `video_generation` | `video_to_video` | `("video",)` → `("video",)` | `video.edit` |
| `speech` | `text_to_speech` | `("text",)` → `("audio",)` | `audio.speech` |
| `speech` | `lyrics_to_music` | `("text","instructions")` → `("audio",)` | `audio.music` |
| `speech` | `caption_to_audio` | `("text",)` → `("audio",)` | （无）音效/环境声，本仓无对应 id |
| `audio_generation` | `text_to_audio` | `("text",)` → `("audio",)` | （无）扩散侧 `/v1/audio/generate` 契约，不是本仓 `audio.music` |

`video_generation` 的三行必须**一对一**，不能都折进 `video.generate`。本仓适配器是按请求形状分开的（`VllmOmniVideo.video` / `.edit_video`，`integrations/model_adapters.py:405-540`）：`text_to_video` 不带参考图、`task=t2va`；`image_to_video` 带 `input_reference`、`task=fl2va`（首帧）；`video_to_video` 带 `source_video` 与画面/音频 mask。这与本仓既有的配对一致：`application/tool_tasks.py:362` 在有首帧时选 `video.first_frame`、否则选 `video.generate`；#266 的请求侧表也是这么配三者的。一个部署只声明 `image_to_video` 时，它服务得了「首帧生视频」，服务不了「文生视频」；三个 profile 合起来给一个 id，就是在 `video.generate` 上误放。

本仓没有 id 的这四行（`image_response` / `audio_response` / `caption_to_audio` / `text_to_audio`）要一起读：

- `image_response` / `audio_response` 上游确实发布，但本仓没有「图片/音频版 chat」id，所以**保持 `unknown`**，`unresolved` 里报 `no_local_capability`。绝不折进 `text.chat`。
- `text_to_audio` 走的是扩散侧独立请求契约（`/v1/audio/generate`，无 voice/lyrics/instructions 映射，`docs/serving/capabilities.md:59-60`），而本仓 `audio.music` 的**唯一**适配器 `VllmOmniMusic`（`integrations/model_adapters.py:573-604`）POST 的是 `/v1/audio/speech`，payload 必带歌词与 `instructions`。上游说这个 profile 没有这两样、本仓却要这两样，把它映射成 `audio.music` 就是承诺一个该部署从未接受的请求。所以 `text_to_audio` 也留空：`support=supported` 时 `unresolved` 报 `no_local_capability`，`audio.music` 只由 `lyrics_to_music` 决定，没有证据就是 `unknown`。这与「绝不把 `caption_to_audio` 塞进 `audio.speech`」是同一条规则。

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

- 响应顶层只有 `object` / `schema_version` / `observed_at` / `models` / `stages` / `routes`（`protocol/capabilities.py:73-79`），端点是 `response_model=OmniCapabilitiesResponse`、`response_model_exclude_none=True`（`api_server.py:2193`）。顶层 `routes[]` 是**上游聚合 operation `exposure` 的来源**（`entrypoints/openai/serving_capabilities.py:383-387`：任一 `enabled` → `enabled`，否则任一 `unknown` → `unknown`，否则 `disabled`），而每个 profile 的 `routes[]` 就是这张表的拷贝、只对需要 video/audio 输入的 profile 在 `/v1/realtime/video` 上强制 `disabled`（`:339-343`）。所以一条顶层 `disabled` 意味着这个 operation 的 HTTP 端点已关闭，**profile 侧写 `enabled` 也重开不了**。更窄的关法语义上只能落在 profile 路由上，但这层投影（`43ff7b9`）除 `/v1/realtime/video` 外不会单独改写 profile 路由，所以「顶层 `enabled` + 该 profile 的路由 `disabled`」今天**产不出来**，只能当消费侧的向前兼容分支，不是可用的控制手段。本模块读 operation 的 `exposure`（上游已经替调用方聚好），不再单独读顶层清单——这是"往顶层塞一条没有 operation 拥有的路径不会改变任何判定"的原因，**不是**因为那串路由"仅供展示"。
- **`exclude_none` 只能省掉值为 `None` 的可选字段**，也就是 profile 的 `request`（`RequestConstraints | None = None`）。列表/字典字段是 `default_factory`，空的时候序列化成 `[]`/`{}`，**不会缺席**：`profiles: []` 而不是「没有 `profiles` 键」。`support` / `reason_code` 在 operation 与 profile 上都是必填，`exposure` 在 operation 与顶层路由上是必填（`protocol/capabilities.py:24-52`），永远不会缺席；少了它们就不是上游能发出的 body。**profile 自己没有 `exposure` 字段**（`:36-44`）：某个 profile 可达不可达，看的是它引用的各条路由的 `exposure` 聚合，而不是 profile 上的一个开关。
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
| `unmapped_stage` | 上游没有这个 operation（`asr`、`music`）。名字沿用早期 stage-keyed 设计，含义是 operation 层缺口 | 上游词表缺口，不是本表漏行 |
| `unknown_profile` | operation 认识，profile id 上游未发布（`speech_to_speech`） | 上游新增 profile，本表待补 |
| `operation_mismatch` | profile 认识，但挂在别的 operation 下（`lyrics_to_music` 挂在 `audio_generation`） | 声明写错了 operation，或本表把归属搞错了 |
| `no_local_capability` | profile 支持，但本仓没有对应 capability id（`caption_to_audio`、`text_to_audio`、`image_response`、`audio_response`） | 词表待补 |
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
| 自有路由全 `disabled`，但另有一条本表不认识的 `enabled`（或没写 `exposure`）路由 | `unknown` | 无（存在判断不了的通道，不是拒绝） |
| profile 声明的路由全部 `exposure=unknown`（上游默认值） | `unknown` | 无（可达性无法确认，不是拒绝） |
| profile `routes: []`（上游默认空列表） | `unknown` | `unresolved: no_route_declared` |
| 路由条目没有可用 `path` | `unknown` | `unresolved: malformed_route` |
| 路由 path 不认得，且没有别的可用路由 | `unknown` | `unresolved: unknown_route` |
| 路由 path 属于别的 operation，或 method/transport 不符 | `unknown` | `unresolved: route_mismatch` |
| 上游有 profile，本仓没有 id（`caption_to_audio` 等） | `unknown` | `unresolved: no_local_capability` |
| operation 认不出（`asr`）/ profile 认不出 / profile 挂错 operation | 该能力无证据 → `unknown` | `unresolved: unmapped_stage` / `unknown_profile` / `operation_mismatch` |
| `support=supported` + `exposure=enabled` + 至少一条自己的路由 `enabled` | `available` | 无 |
| 能力本身没有上游 profile（`image.segment` 等 6 项） | `unknown` | `UNROUTED[cid]`（`no_upstream_profile` / `no_upstream_operation` / `parameter_only` / `no_local_adapter`） |
| body 没答（`None`、无 `models` 键、`models` 不是列表） | 全部 `unknown` | `endpoint = "absent"` |
| 答了，但没有 model 声明任何 operation（含 `models: []`） | 全部 `unknown` | `endpoint = "empty"` |
| operation 答了但 `profiles: []` | 该 operation 的能力 `unknown` | `endpoint = "present"` |

两条边界值得单独记住：

1. **一条不认得的路由既不打穿已确认的 profile，也不把「自有路由全 disabled」变成 `missing`**。上游会加路由，本表会落后：不认得的路由自身若说 `enabled`（或没写 `exposure`，上游默认即 `unknown`），就说明存在一条本表判断不了的通道，自有路由全关也就不构成「正面说不」，结果是 `unknown`；只有它自己也说 `disabled` 时，全 `disabled` 才仍然是 `missing`。已经确认（有 `enabled` 自有路由）的 profile 不受影响，继续 `available`。
2. **`endpoint` 三值**区分「没答」与「答了但没声明」：`absent` / `empty` / `present`。前者该降级或报错，后者该提示「服务未声明能力」，两者对用户的意义完全不同。

### 有路由、没有 operation 的能力

`/v1/images/segmentations`、`/v1/videos/segmentations`、`/v1/videos/depth` 是**已注册的端点，但没有任何 operation 拥有它们**（上游文档明示：segmentation 与 depth「不会仅因为出现在 registry 里就获得这些 operation」，`docs/serving/capabilities.md:41-43`）。所以 `image.segment` / `video.matting` / `video.motion_capture` 恒为 `unknown`，reason 是 `no_upstream_profile` —— 端点不发布该能力，无法判定；**不能**写成 `missing`。

`UNROUTED` 里其余几项理由不同，不要混：

| capability | reason | 说明 |
| --- | --- | --- |
| `image.segment` / `video.matting` / `video.motion_capture` | `no_upstream_profile` | 有路由，无 operation |
| `audio.score` | `no_upstream_operation` | 上游没有识别 operation |
| `image.cutout` | `parameter_only` | 是已发布 operation 的请求参数，不是 profile（`video.first_frame` / `video.edit` 各有自己的 profile，见上表） |
| `audio.separate` | `no_local_adapter` | 上游没说法，本仓也没适配器 |

这 6 个 id **不出现在** `OPERATION_PROFILES` 的值域里，所以它们永远收不到证据，`unknown` 是「没有证据」的自然结果，而不是 `resolve()` 里的一个特例分支（这条不变量由 `test_every_capability_id_is_routed_or_explained` 守着）。

### ASR：上游未发布该 operation

上游词表里没有识别 operation，omni 的 router 也不注册 `/v1/audio/transcriptions`（`api_server.py` 全量路由里没有它），上游自己的 recipe 写明该端点「not currently available with `--omni`」。因此 body 里出现 `asr` 得到 `unmapped_stage`：这是**上游没发布这个 operation**，不是本表漏了一行。

这不等于「本仓不认 `audio.score`」——恰恰相反，本仓 `VllmOmniScore` 适配器 POST 的正是 `/audio/transcriptions`（`integrations/model_adapters.py:605-628`，POST 在 `:620`），对端是上游的独立工具 `tools/sheetsage2_serve.py:124`。但 **capabilities body 从不会提到这条路径**，所以 `audio.score` 只能判 `unknown`（`no_upstream_operation`）：本表不从「我们知道某条路由」反推能力，那样会把部署策略、代理改写和表 bug 混成同一个结论。等上游发布识别 operation（或把该路径纳入词表）再谈映射。

### 与 V2 发现契约（#266）的关系

这份表是 #266 的**输入**，不是替代品，也不是第二套 schema：

- #266 的 `domain/omni_capabilities.py` 定义发现文档与匹配；本模块只提供 `(operation, profile) → capability` 这一层。文件名不同，互不覆盖。
- 本模块**不再**读 `Model.stage_ids`：它是拓扑，不是能力键。`declarations()` 只读上游真实发布的 `models[].operations[<op>].profiles[]`。
- 本模块不改 `domain/omni_capabilities.py`、`integrations/capability_probe.py`、`application/model_availability.py`、`src/**`。

### 如何作为 `requests_for()` 的输入

#266 引入的 `application/model_availability.py` 目前按 `(kind, protocol)` 硬编码 profile 名。表驱动后，调用方只需要自己正在调用的 operation 与 profile：

```python
from opendirector.domain.capability_contract import capabilities_for

capabilities_for('speech', 'lyrics_to_music')   # ('audio.music',)
capabilities_for('speech', 'text_to_speech')    # ('audio.speech',)
capabilities_for('audio_generation', 'text_to_audio')  # ()：上游有 profile，本仓没有对应 id
candidates_for('video.first_frame')                     # (('video_generation', 'image_to_video'),)
candidates_for('audio.separate')                        # ()：没有任何 profile 提供它
```

反查是同一张表的反向索引（`BY_CAPABILITY`，由 `OPERATION_PROFILES` 派生，不另抄一份词表）：从本地配置出发的调用方（`requests_for()` 就是这种）手里是 capability id，需要知道**哪些** `(operation, profile)` 可能供货。候选不是授权——实际路由、实际传输的输入与输出仍由配置选中的适配器决定，单次提交还必须再核一次「选中的这个 pair 就是被准入的那个」，另一条 profile 的 `available` 不能替它背书。

`resolve(payload)` 返回逐能力状态（`capabilities`）、缺失原因（`reasons`）、`topology`（`stages[]`，仅供展示）与 `unresolved`；`classified_capabilities()` 按表顺序给出词表，展示层据此排列。是否接进 `requests_for()` 由 #266 一侧决定，本契约只保证查找是成对的、稳定的、可测的。

`resolve()` 的结论是**目录级**的：它回答「这个部署声明了什么」，不授权任何一个具体请求。一个能力 `available` 只说明「至少有一条 profile 声明支持且其路由开着」，调用方仍要按自己的模型、输入、输出与路由逐个核对；`stages[]` 更是只描述流水线拓扑，提供不了任何准入证据。

### 三档 fixture（外加一档防御输入）与验证

`tests/fixtures/omni-capabilities/{full,partial,absent}.json` 是**求值样本**，按真实响应形状写：`stages[]` 是 `{id,type,depends_on}` 且 id 为数字字符串，`models[].operations` 六个齐全、每个含 `support`/`exposure`/`reason_code`/`profiles`/`execution`，每个 profile 都带 `support`、`reason_code` 与 `routes[]`（可以是 `[]`），`required_inputs`/`outputs` 逐条照上游 `STANDARD_PROFILES`（含顺序；`image_response`/`audio_response` 分别是 `["image"]`/`["audio"]`）。

- `full`：全支持全启用，12 个 profile 齐全；`image_response`/`audio_response`/`caption_to_audio`/`text_to_audio` 报 `no_local_capability`（`text_to_audio` **不**授 `audio.music`，`audio.music` 由 `lyrics_to_music` 供货）。
- `partial`：`support=unsupported`、operation `exposure=disabled`（`endpoint_disabled`）、`no_local_capability`，以及整个 body 都是 `unknown` 枚举的形态；`route_disabled` 只在 `malformed.json` 里出现——上游把「自有路由全 `disabled`」聚合成 operation `exposure=disabled`，所以样本里那个全 `disabled` 的 profile（`partial` 的 `text_to_image`）拿到的是 `endpoint_disabled`。
- `absent`：没答（`absent`）、只答拓扑（`empty`）、六个 operation 都答了但 `profiles: []`（`present` 且全 `unknown`）。

第四档 `malformed.json` **只用于防御输入**，不代表上游可能产出：里面的 body 是合法 pydantic（结构断言照样过），但上游投影发不出来（例如 profile 引用了别的 operation 的路由，或自有路由全 `disabled` 旁边挂着一条本表不认识的 `enabled` 路径）。代理、缓存、旧版本才可能把这种 body 交给我们，所以它只被防御性、结构性与 profile 行校验读取，不进样本 oracle，也不参与「fixture = 真实样本」这句话。

**上游不可能发出的形状**（`asr` operation 键、profile 挂在错 operation、缺必填 `support`、`profiles` 整键缺席）**不进 fixture**，只在对应测试里内联构造 —— 它们是防御性输入的用例，混进样本会让「fixture = 真实样本」这句话变成假话。`test_fixtures_are_schema_valid` 只断言上游 schema 的**结构不变量**（六键、`observed_at` 可解析且带时区、`reason_code` 在 operation 与 profile 上都在、`execution` 为 `{state,scope,observed_at}`、枚举值域、`profiles` 是列表、route 的 `transport`/`method`/`path` 齐全、stages 形状与数字字符串 id），不把上游 pydantic 源码抄一份进本仓。

回归测试一览（其中 5 条是正文所说的「防假覆盖」回归，见英文段）：

| 测试 | 钉住的事实 |
| --- | --- |
| `test_real_shaped_body_resolves_non_empty_pairs` | 真实形状 body 解析出 12 个成对声明，不是空表 |
| `test_route_alone_cannot_distinguish_speech_profiles` | 同一路径 3 个 profile 解析出 3 个不同答案 |
| `test_stage_ids_do_not_collapse_capabilities` | 两个 model 的 `stage_ids` 相同，能力状态仍各自独立 |
| `test_capabilities_without_an_upstream_profile_are_unknown_not_missing` | `UNROUTED` 的 6 个 id 恒 `unknown`，且 `reasons` 里不出现 |
| `test_a_profile_without_support_is_unknown_even_when_its_operation_is_supported` | profile 级字段缺席是 `unknown`（不是 `supported`） |
| `test_a_profile_that_declares_no_route_is_unknown` | `supported + routes: []` 不能判 `available` |
| `test_a_profile_whose_only_route_is_disabled_is_missing` | profile 路由全 `disabled` → `missing` + `route_disabled` |
| `test_a_disabled_profile_with_an_unknown_enabled_route_is_unknown` | 自有路由全关 + 一条不认识的 `enabled` 路由 → `unknown`（不是 `missing`） |
| `test_a_profile_whose_routes_are_all_unknown_cannot_be_confirmed` | 路由全 `unknown` → `unknown` |
| `test_one_unrecognised_route_does_not_void_a_profile_that_answered` | 一条不认得的路由不打穿已确认的 profile |
| `test_a_wrong_method_is_a_route_mismatch` | `DELETE /v1/chat/completions` 不授予 chat |
| `test_an_image_only_chat_deployment_does_not_read_as_text_chat` | `image_response` 不折进 `text.chat` |
| `test_text_to_audio_alone_does_not_make_audio_music_available` | `text_to_audio` 不授 `audio.music`，只报 `no_local_capability` |
| `test_documented_required_inputs_match_fixtures` | 12 行上游 `required_inputs`/`outputs` 字面量表 = 两份文档表格 = 所有 fixture |
| `test_fixtures_are_schema_valid` | 三档样本 + 防御档的结构不变量（`observed_at`、`reason_code`、`execution`、route 三元组） |
| `test_a_refused_model_and_a_closed_route_are_told_apart` | `unsupported` / `endpoint_disabled` / `route_disabled` 三码可分 |

```bash
PYTHONPATH=packages/core/src:apps/api/src python -m pytest tests/test_capability_contract.py -q
```

## English

`GET /v1/omni/capabilities` reports what a deployment says about itself; the product needs to know what that deployment can do. `packages/core/src/opendirector/domain/capability_contract.py` is the only place that translates upstream's vocabulary into `opendirector.domain.capabilities` ids. It performs no HTTP, holds no display text, and introduces no second set of operation constants.

### The upstream vocabulary (as evidenced)

Source: `vllm-project/vllm-omni` PR #10102 (issue #10007), head `d1104f8`; every `path:line` below is from the head tree.

**Six closed operations** (`vllm_omni/serving_capabilities.py:15,19-26`): `chat`, `image_generation`, `image_edit`, `video_generation`, `speech`, `audio_generation`. There is no `asr`, `transcription`, `segmentation`, `depth` or `music`.

**Twelve profiles** (`:43-54`) and the ids this repository has for them. Profiles with a different output modality are not merged: `text.chat` here is consumed by a text-only adapter (`integrations/model_adapters.py:631-647` reads `choices[0]["message"]["content"]` as a string), so an image-only chat deployment must not read as able to chat.

| operation | profile | upstream `required_inputs` → `outputs` | capability here |
| --- | --- | --- | --- |
| `chat` | `text_response` | `("text",)` → `("text",)` | `text.chat` |
| `chat` | `image_response` | `("text",)` → `("image",)` | none — the output is an image, not this repo's `text.chat` |
| `chat` | `audio_response` | `("text",)` → `("audio",)` | none — the output is audio, not this repo's `text.chat` |
| `image_generation` | `text_to_image` | `("text",)` → `("image",)` | `image.generate` |
| `image_edit` | `image_to_image` | `("text","image")` → `("image",)` | `image.edit` |
| `video_generation` | `text_to_video` | `("text",)` → `("video",)` | `video.generate` |
| `video_generation` | `image_to_video` | `("text","image")` → `("video",)` | `video.first_frame` |
| `video_generation` | `video_to_video` | `("video",)` → `("video",)` | `video.edit` |
| `speech` | `text_to_speech` | `("text",)` → `("audio",)` | `audio.speech` |
| `speech` | `lyrics_to_music` | `("text","instructions")` → `("audio",)` | `audio.music` |
| `speech` | `caption_to_audio` | `("text",)` → `("audio",)` | none — sound effect / ambience |
| `audio_generation` | `text_to_audio` | `("text",)` → `("audio",)` | none — the diffusion `/v1/audio/generate` contract, not this repo's `audio.music` |

The three `video_generation` rows stay **one-to-one**. The adapter already distinguishes the shapes (`VllmOmniVideo.video` / `.edit_video`, `integrations/model_adapters.py:405-540`): `text_to_video` carries no reference and sends `task=t2va`, `image_to_video` carries `input_reference` with `task=fl2va` (first frame), `video_to_video` carries `source_video` plus the picture and audio masks. `application/tool_tasks.py:362` already picks `video.first_frame` whenever a first frame is present, and only `video.generate` otherwise. Folding all three onto `video.generate` therefore let an image-to-video-only deployment read as able to do text-to-video — a false `available`, not merely a missing one.

Four rows carry no id here (`image_response`, `audio_response`, `caption_to_audio`, `text_to_audio`), and they read together: `image_response` and `audio_response` are published upstream but have no id here, so they stay `unknown` and are reported as `no_local_capability` instead of being folded into `text.chat`. `text_to_audio` uses the separate diffusion request contract behind `/v1/audio/generate` (no voice, no lyrics, no instructions; `docs/serving/capabilities.md:59-60`), while the *only* `audio.music` adapter in this repository (`VllmOmniMusic`, `integrations/model_adapters.py:573-604`) posts `/v1/audio/speech` with lyrics **and** `instructions`, both required. Upstream says that profile has neither and this repository demands both, so mapping it to `audio.music` would promise a request the deployment never accepted: the profile is reported as `no_local_capability` and `audio.music` is decided by `lyrics_to_music` alone (no evidence → `unknown`). That is the same rule that keeps `caption_to_audio` off `audio.speech`.

**Operation → routes** (`:42-54`) as `(transport, method, path)`, because upstream's `RouteKey` is exactly that and the websocket method literal is `WEBSOCKET`: `chat` → `http POST /v1/chat/completions`; `image_generation` → `http POST /v1/images/generations`; `image_edit` → `http POST /v1/images/edits`; `video_generation` → `http POST /v1/videos`, `http POST /v1/videos/sync`, `websocket WEBSOCKET /v1/realtime/video`; `speech` → `http POST /v1/audio/speech`; `audio_generation` → `http POST /v1/audio/generate`. `DELETE /v1/chat/completions` would be a 405 and a `websocket` declaration on an http route is wrong, so both are `route_mismatch`. `transport` defaults to `http` upstream (`protocol/capabilities.py:16-21`) and an absent transport is not a mismatch; `method` has no default and an absent one cannot be confirmed.

Three schema facts shape the table: the body has only `object`, `schema_version`, `observed_at`, `models`, `stages`, `routes` (`protocol/capabilities.py:73-79`) and is served with `response_model_exclude_none=True` (`api_server.py:2193`) — the top-level `routes[]` is **what upstream aggregates an operation's `exposure` from** (`entrypoints/openai/serving_capabilities.py:383-387`: any `enabled` → `enabled`, else any `unknown` → `unknown`, else `disabled`), and each profile's `routes[]` is a copy of that list, forced `disabled` only for profiles needing video/audio input on `/v1/realtime/video` (`:339-343`). A top-level `disabled` therefore means the operation's HTTP endpoint is closed and **no profile-level `enabled` reopens it**; closing something narrower would semantically have to live on the profile route, but this projection (`43ff7b9`) never rewrites a profile route except for `/v1/realtime/video`, so "top level `enabled` with that profile's route `disabled`" is **not producible today** — it is a forward-compatible consumer branch, not an available control. This module reads the operation's `exposure` — upstream has already aggregated it — instead of re-reading the top-level list, which is why publishing an unowned path there changes no verdict, and **not** because those routes are "display only"; **`exclude_none` drops only `None`-valued optional fields** — in practice the profile's `request` — while `default_factory` lists serialize as `[]` (`profiles: []`, never a missing key), `support`/`reason_code` are required on every operation and profile, `exposure` is required on every operation and top-level route (`protocol/capabilities.py:24-52`), and a profile has **no `exposure` field of its own** (`:36-44`): its reachability is the aggregation of the exposures of the routes it references; and `models[].operations` **must list all six** or pydantic raises (`:60-64`), with `stage_ids` numeric strings, the *same* full list for every model (`entrypoints/openai/serving_capabilities.py:400`).

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
| owned routes all `disabled`, plus an `enabled` route this table cannot place (or one with no `exposure`) | `unknown` | none — a channel that cannot be judged, not a refusal |
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

Two boundaries to keep: one unrecognised route must not void a profile that answered, and must not turn "owned routes all disabled" into `missing` — if that route itself says `enabled` (or omits `exposure`, whose upstream default is `unknown`) a channel exists that this table cannot judge, so `unknown` is the only honest answer; only a route that also says `disabled` leaves all-`disabled` a refusal. And `endpoint` distinguishes "did not answer" (`absent`) from "answered without declaring" (`empty`) from "declared" (`present`).

### Routes without an operation

`/v1/images/segmentations`, `/v1/videos/segmentations` and `/v1/videos/depth` are registered endpoints that no operation owns; upstream's docs state that "segmentation and depth estimation do not acquire one of these operations merely by being present in a registry" (`docs/serving/capabilities.md:41-43`). `image.segment`, `video.matting` and `video.motion_capture` therefore stay `unknown` with `no_upstream_profile` — the endpoint does not publish the ability, so it cannot be judged, and it must never read as `missing`. `audio.score` is `no_upstream_operation`; `image.cutout` is `parameter_only` (a request field of a published operation, granted per adapter rather than per profile); `audio.separate` is `no_local_adapter`. None of these six ids is a value of `OPERATION_PROFILES`, so `unknown` falls out of "no evidence" rather than a special case.

### ASR: an upstream gap, not a missing row

Upstream publishes no recognition operation and omni's router never registers `/v1/audio/transcriptions` (absent from `api_server.py`; its own recipe says the endpoint is "not currently available with `--omni`"). A body naming `asr` gets `unmapped_stage` — the upstream vocabulary has no such operation, this table did not lose a row. That is not a claim that this repository ignores `audio.score`: the `VllmOmniScore` adapter does post to `/audio/transcriptions` (`integrations/model_adapters.py:605-628`，POST 在 `:620`), whose peer is the standalone `tools/sheetsage2_serve.py:124`. But a capabilities body never mentions that path, so `audio.score` can only be `unknown` (`no_upstream_operation`): a route we happen to know is not evidence of a published capability.

### Relationship to the V2 discovery contract (#266)

This table is an input to #266, not a replacement and not a second schema: `domain/omni_capabilities.py` owns the discovery document and matching, this module owns only the `(operation, profile) → capability` layer, under a different file name. It no longer reads `Model.stage_ids` — that is topology, not a capability key — and `declarations()` reads only the published `models[].operations[<op>].profiles[]` shape. It does not modify `domain/omni_capabilities.py`, `integrations/capability_probe.py`, `application/model_availability.py` or `src/**`.

### Feeding `requests_for()`

#266's `application/model_availability.py` currently hard-codes profile names per `(kind, protocol)`; with a table the caller needs only the operation and profile it is about to use:

```python
from opendirector.domain.capability_contract import capabilities_for

capabilities_for('speech', 'lyrics_to_music')   # ('audio.music',)
capabilities_for('speech', 'text_to_speech')    # ('audio.speech',)
capabilities_for('audio_generation', 'text_to_audio')  # () — upstream publishes it, no id here
candidates_for('video.first_frame')                     # (('video_generation', 'image_to_video'),)
candidates_for('audio.separate')                        # () — no profile supplies it
```

The reverse lookup is the same table read backwards (`BY_CAPABILITY`, derived from `OPERATION_PROFILES`, never a second vocabulary): a caller starting from local configuration — `requests_for()` does — holds a capability id and needs to know **which** `(operation, profile)` pairs could supply it. A candidate is not an authorisation: the adapter for the selected configuration still decides the route, the transmitted inputs and the output, and a submission must re-check that the pair it selected is the one admitted. Another profile being `available` does not vouch for it.

`resolve(payload)` returns per-capability states, per-capability `reasons`, `topology` (display only) and `unresolved`; `classified_capabilities()` returns the vocabulary in table order. Whether to wire this into `requests_for()` is #266's decision; this contract only guarantees the lookup is paired, ordered and testable.

`resolve()` is **catalogue-level**: it answers "what does this deployment declare", not "may this request go through". An `available` capability only says that at least one profile declares support with an open route; the caller must still check its own model, inputs, output and route, and `stages[]` describes pipeline topology only — it carries no admission evidence.

### Fixtures and checks

`tests/fixtures/omni-capabilities/{full,partial,absent}.json` are the **evaluated sample** and follow the real response shape — `stages[]` as `{id,type,depends_on}` with numeric-string ids, six complete `operations` per model each with `support`/`exposure`/`reason_code`/`profiles`/`execution`, every profile carrying `support`, `reason_code` and `routes` (possibly `[]`), and `required_inputs`/`outputs` transcribed from upstream's `STANDARD_PROFILES` including order (`image_response`/`audio_response` are `["image"]`/`["audio"]`). `full` is the all-yes deployment, `partial` mixes refusals, a policy-disabled operation and an all-`unknown` body (with the routes stating `unknown` too), and `absent` covers no answer (`absent`), topology only (`empty`) and six operations that declare `profiles: []` (`present`, all `unknown`). `route_disabled` appears only in `malformed.json`: upstream aggregates "all of the operation's routes `disabled`" into `exposure=disabled`, so a sample cannot carry that combination. In `full`, four profiles report `no_local_capability` (`image_response`, `audio_response`, `caption_to_audio`, `text_to_audio`) — `text_to_audio` grants no `audio.music`; `audio.music` is supplied by `lyrics_to_music`.

A fourth file, `malformed.json`, is **defensive input only and not a sample of what upstream can produce**: its bodies are valid pydantic (the structural checks pass) but upstream's projection cannot emit them — a profile pointing at another operation's route, or owned routes all `disabled` beside an `enabled` path this table does not know. Only a proxy, a cache or an older revision can hand us one, so it is read by the defensive, structural and profile-row checks alone, never by the sample oracle.

Shapes upstream can never emit — an `asr` operation key, a profile filed under the wrong operation, a missing required `support` — are built inline in the tests that defend against malformed input, never in the sample fixtures. `test_fixtures_are_schema_valid` asserts only the structural invariants of upstream's model (six keys, `observed_at` parseable and timezone-aware, `reason_code` wherever `support` is, `execution` as `{state,scope,observed_at}`, the enum domains, `profiles` as a list, routes carrying `transport`/`method`/`path`, stage shape with numeric-string ids), not a copy of upstream's pydantic source.

Five regressions keep coverage honest: `test_real_shaped_body_resolves_non_empty_pairs`, `test_route_alone_cannot_distinguish_speech_profiles`, `test_stage_ids_do_not_collapse_capabilities`, `test_capabilities_without_an_upstream_profile_are_unknown_not_missing`, and `test_a_profile_without_support_is_unknown_even_when_its_operation_is_supported`; the route-level exposure, transport/method, chat-modality, `text_to_audio` and missing-reason cases each have their own test, and `test_documented_required_inputs_match_fixtures` pins the twelve `required_inputs`/`outputs` rows against both doc tables and every fixture.

```bash
PYTHONPATH=packages/core/src:apps/api/src python -m pytest tests/test_capability_contract.py -q
```
