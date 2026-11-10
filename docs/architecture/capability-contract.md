# Capability mapping contract / 能力映射表契约

## 中文

`GET /v1/omni/capabilities` 只说明部署「自述了什么」；产品要回答的是「这个部署能不能做某件事」。`packages/core/src/opendirector/domain/capability_contract.py` 是唯一把上游 stage 名与路由翻译成 `opendirector.domain.capabilities` id 的地方。它不发起 HTTP，不持有界面文案，也不创建第二套 operation 常量。

### 键必须是 (stage, route) 成对

一个路径可以同时服务两种能力。`/v1/audio/speech` 既是 TTS 也是音乐生成，`/v1/audio/transcriptions` 既是扒谱（`score`）也是语音识别（`asr`）。只按路径匹配，会让「只声明了 TTS」的服务看起来能生成音乐，反过来也一样；部署级 `exposure` 若按 `(method, path)` 单键下发，关闭语音合成会连带关闭音乐。因此 `STAGE_ROUTES` 的键是成对的 `(upstream stage, upstream route)`，落表后经 `capabilities_for(stage, route)` 查找；`/v1/chat/completions` 这类独占路径同样按对匹配，不为单键开后门。

`asr` 目前**不在表里**：能力词表（`domain/capabilities.py`）还没有识别能力 id，把 `/v1/audio/transcriptions` 在 `asr` 下读成 `audio.score` 是错的。它会被如实报成 `unmapped_stage`，等词表有了 `audio.transcribe` 再补一行。

### 三种降级状态，含义不同

| 状态 | 含义 | 修的地方 |
| --- | --- | --- |
| `unknown_route` | 路径本身不在表里（例如 `/v1/videos/track`、`/v1/embeddings`） | 表或适配器缺这条路径 |
| `unmapped_stage` | 路径认识，stage 不认识（例如 `asr` 打 `/v1/audio/transcriptions`，或 `stage_ids` 是数字 id） | 表缺这个 stage，或上游 stage 名没对齐 |
| `stage_route_mismatch` | stage 与路径都认识，但这一对不成立（例如 `image` 声明 `/v1/videos`） | 部署声明的配对写错了 |

三者都进 `unresolved`，不被丢弃 —— 调用方可以解释「为什么这个 stage 不可用」，而不是静默隐藏。

能力状态另有三档：`available`（有成对声明）、`missing`（部署答了，但没有这一对）、`unknown`（没有足够信息）。请求失败、404、没有 `stages`、空列表、stage 没有名字，全部返回 `endpoint=absent` 与全 `unknown`：**「服务没说」不是「服务不能」**。另有四个能力（`video.first_frame`、`video.edit`、`image.cutout`、`audio.separate`）根本无法由路由表达，它们永远是 `unknown`，并在 `UNROUTED` 里写明原因。

### 与 V2 发现契约（#266）的关系

这份表是 #266 的**输入**，不是替代品，也不是第二套 schema：

- #266 的 `domain/omni_capabilities.py` 定义发现文档与匹配；本模块只提供 `(stage, route) → capability` 这一层。两者文件名不同，互不覆盖。
- #266 的 `Model.stage_ids` 目前没有任何读取方（只有测试夹具填 `['0']`）。两条路：(a) 删掉该字段；(b) 接上 —— 让 `stage_ids` 与每个 operation profile 的 `routes` 交叉出成对声明。本模块的 `declarations()` 已经能读 `models[].stage_ids` × `operations.*.profiles[].routes[]` 这种形状，供 (b) 直接使用；若 `stage_ids` 里是数字 id，结果会如实报 `unmapped_stage`，不会被猜成某个 stage。
- 本模块不改 `domain/omni_capabilities.py`、`integrations/capability_probe.py`、`application/model_availability.py`。

### 如何作为 `requests_for()` 的输入

`application/model_availability.py` 现在按 `(kind, protocol)` 硬编码 profile 名，ASR/扒谱因此拿到空列表。表驱动后，调用方只需要自己正在执行的 stage 与将要 POST 的路径：

```python
from opendirector.domain.capability_contract import capabilities_for

capabilities = capabilities_for('music', '/v1/audio/speech')   # ('audio.music',)
```

`resolve(payload)` 返回逐能力状态、逐 stage 状态与 `unresolved` 列表；`classified_capabilities()` 按表顺序给出词表，展示层据此排列，不再自己排序。是否接进 `requests_for()` 由 #266 一侧决定，本契约只保证查找是成对的、稳定的、可测的。

### 三档 fixture 与验证

`tests/fixtures/omni-capabilities/{full,partial,absent}.json` 是共享样本：`full` 覆盖表里的全部配对与两条共享路径，`partial` 覆盖混合可用、`stage_route_mismatch` 与两种未知，`absent` 覆盖 404、缺字段、空列表。`tests/test_capability_contract.py` 逐档比对期望块，并单独覆盖共享路径不互相覆盖、`asr` 不等于 `score`、`absent` 全 `unknown`、表顺序即输出顺序、`models[]` 文档形状。

```bash
PYTHONPATH=packages/core/src python -m pytest tests/test_capability_contract.py -q
```

## English

`GET /v1/omni/capabilities` reports what a deployment says about itself; the product needs to know what that deployment can do. `packages/core/src/opendirector/domain/capability_contract.py` is the only place that translates upstream stage names and routes into `opendirector.domain.capabilities` ids. It performs no HTTP, holds no display text, and introduces no second set of operation constants.

### The key is the pair

One path can serve two capabilities. `/v1/audio/speech` carries both speech synthesis and music generation; `/v1/audio/transcriptions` carries both score transcription (`score`) and recognition (`asr`). A path-only key makes a TTS-only deployment look able to generate music, and the reverse; a deployment-level `exposure` published per `(method, path)` disables music when it disables speech. `STAGE_ROUTES` is therefore keyed by the pair `(upstream stage, upstream route)` and read through `capabilities_for(stage, route)`. Paths that happen to be exclusive, such as `/v1/chat/completions`, are matched as pairs too, so there is no second rule to keep in sync.

`asr` is deliberately absent from the table: the vocabulary in `domain/capabilities.py` has no recognition id yet, and reading `/v1/audio/transcriptions` under `asr` as `audio.score` would be wrong. It is reported as `unmapped_stage` until an `audio.transcribe` capability exists.

### Three degradation states, three different fixes

| State | Meaning | What to fix |
| --- | --- | --- |
| `unknown_route` | The path is not in the table (`/v1/videos/track`, `/v1/embeddings`) | The table or an adapter is missing the path |
| `unmapped_stage` | The path is known, the stage is not (`asr` on `/v1/audio/transcriptions`, or a numeric `stage_ids` entry) | The table is missing the stage, or the upstream stage name is not aligned |
| `stage_route_mismatch` | Both are known, but not as this pair (`image` declaring `/v1/videos`) | The deployment declared a wrong pairing |

All three land in `unresolved` instead of being dropped, so a caller can explain why a stage is unavailable rather than hiding it.

Capability states are separate: `available` (a matching pair was declared), `missing` (the deployment answered without that pair), `unknown` (not enough information). A failed request, a 404, a body without `stages`, an empty list, or an entry without a stage all return `endpoint=absent` with everything `unknown`: **"the service did not say" is not "the service cannot"**. Four capabilities (`video.first_frame`, `video.edit`, `image.cutout`, `audio.separate`) cannot be expressed by any route; they stay `unknown` forever and `UNROUTED` states why.

### Relationship to the V2 discovery contract (#266)

This table is an input to #266, not a replacement and not a second schema:

- `domain/omni_capabilities.py` in #266 owns the discovery document and matching; this module owns only the `(stage, route) → capability` layer. Different file names, no overwrite.
- `Model.stage_ids` in #266 currently has no reader (tests only fill `['0']`). Either (a) delete the field, or (b) connect it: cross `stage_ids` with the routes of each operation profile to produce paired declarations. `declarations()` already reads the `models[].stage_ids` × `operations.*.profiles[].routes[]` shape, so (b) can use it as is; numeric ids surface as `unmapped_stage` instead of being guessed at.
- This module does not modify `domain/omni_capabilities.py`, `integrations/capability_probe.py`, or `application/model_availability.py`.

### Feeding `requests_for()`

`application/model_availability.py` currently hard-codes profile names per `(kind, protocol)`, which is why ASR and score get an empty request list. With a table, the caller needs only the stage it executes and the path it posts to:

```python
from opendirector.domain.capability_contract import capabilities_for

capabilities = capabilities_for('music', '/v1/audio/speech')   # ('audio.music',)
```

`resolve(payload)` returns per-capability states, per-stage states and the `unresolved` list; `classified_capabilities()` returns the vocabulary in table order, so presentation stops sorting on its own. Whether to wire this into `requests_for()` is #266's decision; this contract only guarantees the lookup is paired, ordered and testable.

### Fixtures and checks

`tests/fixtures/omni-capabilities/{full,partial,absent}.json` are the shared samples: `full` covers every pair in the table and both shared paths, `partial` covers mixed availability, a `stage_route_mismatch` and both unknown kinds, `absent` covers a 404, a missing field and an empty list. `tests/test_capability_contract.py` compares each tier against its expected block and separately covers shared paths not overwriting each other, `asr` not being `score`, `absent` being all `unknown`, table order as output order, and the `models[]` document shape.

```bash
PYTHONPATH=packages/core/src python -m pytest tests/test_capability_contract.py -q
```
