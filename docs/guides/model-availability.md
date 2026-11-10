# Model availability / 模型可用状态

## 中文

模型接入可以读取服务的可选能力声明。自托管连接默认自动检查，其他连接默认关闭；服务级 `capabilityAutoCheck` 可以覆盖默认值。省略该字段会保留已有设置，旧配置无需转换。共享同一 `providerId` 的模型使用相同设置和查询缓存。独立服务及旧的独立配置保留自己的归属，相同 URL 和密钥不会合并它们。自动检查只查询能力接口，不生成内容、不唤醒模型。

“检查服务能力”可以检查未保存的表单。草稿检查不会保存配置，也不会更新已保存模型的状态。显式刷新已保存模型可以检查关闭自动检查的服务。

在“设置 → 模型接入”选择模型类别，展开服务卡片的“服务能力”，即可查看每种操作的状态和检查时间。编辑服务时，可在高级连接设置中调整“自动检查服务能力”。输入过程中不会查询；保存后在后台检查。生成按钮和助手会说明明确不可用的原因，并保留当前输入和选择。暂停观察到期后会解除该观察产生的禁用，提交时仍执行后端检查。

状态有三种：`available` 表示该请求具有匹配声明；`unavailable` 表示服务明确不支持或暂停当前执行入口；`unknown` 表示没有足够信息。旧服务没有接口、超时、断网、鉴权失败和无法理解的版本都保留手动配置与现有请求路径。错误原因分别显示，响应正文与凭据不进入状态数据。

声明按精确 Model ID、输入模式、输出类型和实际 HTTP 路由匹配。一个模型支持聊天协议，不能证明它会返回助手需要的文字。音乐适配器通过 `/audio/speech` 发送歌词 `input`、风格 `instructions` 和音频帧数 `max_new_tokens`；其 `lyrics_to_music` 模式独立于普通 TTS 的 `text_to_speech`。`/audio/generate` 的通用音频生成声明不会启用现有音乐适配器。

提交时还会核对该模式声明的必要输入。例如图生视频声明同时需要图片和音频，只提供图片会在接受任务前被拒绝；补充实际传输的音频后可以提交。仅作为上下文的素材不计入传输输入。目录没有具体任务输入，不会因此禁用整个模型；无法理解的必要输入名称保留 `unknown`。

声明在内存中保留 30 秒；可信部署暂停状态最多保留 5 秒。内部使用本地单调时钟计算有效期，系统时钟调整和服务时钟偏差不改变到期规则；对外时间用于界面展示。单次查询或一次多服务刷新共用 2 秒总等待预算，包含等待已有共享请求的时间。独立服务通过同一个最多 4 个线程的查询池并发读取，排队数量和缓存均有容量限制。失败可以短时间后重试，进程重启后重新获得观察。目录读取不会访问模型服务，到期会改变目录版本。

生成、工具和使用设置模型的助手共享接受规则。服务查询位于项目存储事务之外，接受新任务时再次核对连接身份。明确拒绝不会创建生成任务，也不会调用生成接口。工具的本地操作和可选翻译保留原有行为。已接受任务的快照、恢复、下载、取消和同一命令重放继续使用原有规则；最新能力状态不会重新拒绝它们。能力状态不会清除音色或替换用户选择。

## English

Model connections can read an optional service capability declaration. Self-hosted connections check automatically by default; other connections require explicit enablement or a manual check. The optional service-level `capabilityAutoCheck` preference and query cache are shared by models with the same `providerId`. Independent providers and legacy standalone configuration IDs stay isolated even at the same URL with the same credential. Checks query declarations without inference or wake-up requests.

The unsaved form check uses an isolated draft identity. It saves neither configuration nor observations for saved connections. Explicit refresh can check selected saved connections even when automatic checks are disabled.

In Settings → Model connections, select a category and expand Service capabilities on a connection card to see operation states and check times. Advanced connection settings contain Automatically check service capabilities. Typing does not query the service; saving starts a background check. Generation and assistant controls explain explicit unavailability while retaining inputs and selections. Pause observations expire locally; submission still runs the backend check.

`available`, `unavailable`, and `unknown` describe evidence for a specific request. Matching requires the exact model, operation profile, consumed output and actual HTTP route. Unknown or failed discovery preserves manual configuration and the existing request path. Authentication, connection, timeout, unsupported-version and invalid-response reasons are distinct; credentials and response bodies are never included in observations.

Text responses and image responses on Chat Completions are distinct. Music uses the `lyrics_to_music` profile on `/audio/speech`, with lyrics, style and an audio-frame budget; ordinary TTS uses `text_to_speech`. Generic `/audio/generate` declarations do not create a consumer for that API in OpenDirector.

Admission also checks a matched profile's required inputs against the actual adapter request. An image-to-video profile requiring audio rejects a submission without transmitted audio, while the catalog remains selectable. Context-only references are not transmitted inputs. Unrecognized required-input names remain unknown.

Declarations expire after 30 seconds. A proven deployment-wide pause expires after at most 5 seconds. Internal expiration uses a local monotonic clock; service timestamps identify observations, and wall-clock timestamps are presentation data. Each query or multi-service refresh shares one two-second wait budget, including existing shared requests. Independent services use the same four-worker pool with bounded pending requests and cache. Concurrent reads are coalesced and failures permit short retries. Catalog reads never contact providers; expiration changes their revision.

Generation, tools and settings-backed assistant turns share acceptance rules. Network reads occur outside project transactions; connection identity is checked again when accepting work. Explicit rejection creates no job and submits no inference. Local tools and optional translation retain their behavior. Accepted snapshots, recovery, downloads, cancellation and idempotent replay do not undergo new capability admission. Observations never clear voice selections or silently choose another model.

## HTTP, CLI and Agent interfaces

| Interface | Behavior |
| --- | --- |
| `GET /api/model-configs/availability` | Current observations without network access |
| `POST /api/model-configs/availability` | Refresh eligible services; accepts optional `configIds` and `manual` |
| `POST /api/model-configs/availability/check` | Check an unsaved model form with existing connection/authentication fields; optional `configId` reuses a key only at its saved URL |
| `GET /api/model-configs` | Saved models with an optional current `availability` projection |
| Agent `model_availability` | Same read/refresh service; accepts `refresh`, `configIds`, `manual` |

Manual refresh requires explicit `configIds`. The existing `/api/model-configs/capabilities` endpoint retains its video-output specification behavior.

```sh
opendirector model availability
opendirector model availability --refresh
opendirector model availability --refresh --manual --model MODEL_CONFIG_UUID
```

Responses include a `revision` and model observations containing `identity`, `status`, `reasonCode`, `checkedAt`, `expiresAt` and exact operation decisions. Times use Unix milliseconds. `configId` is null for drafts. `capabilityAutoCheck` and runtime observations are excluded from accepted job execution snapshots.

The remote protocol is `GET <API_BASE>/omni/capabilities`, with `object="omni.capabilities"` and `schema_version=1`. Missing models, profiles, routes or output information remain unknown. A worker-only pause does not prove that another request will use that worker. No result implies that every possible parameter combination or GPU resource requirement has been verified.

## Development checks / 开发验证

### Input constraints and region editing / 输入限制与选区编辑

图片能力分别显示文字生图、单图编辑和多图编辑。已知限制会说明图片数量、选区蒙版及独立参考图；缺失数量声明不会被解释为无限数量。服务能力与应用处理限制分别显示，临时检查不会修改保存的配置。

`profile.request` 描述模型输入；`profile.routes[].request` 是对应请求路径的完整有效约束。消费者只使用实际调用路径的声明，不将模型级约束外推到没有声明的路径。`inputs` 描述角色、支持情况及最少/最多数量，`required_any_of` 表示至少提供其中一种输入，`parameters` 描述明确的枚举或数值限制。字段缺失保持未知。默认参数不代表唯一支持值。

字符串枚举可以声明 `enum_normalization`：`lower` 忽略大小写，`title` 按服务使用的标题大小写比较，`strip_lower` 同时忽略首尾空白与大小写；缺失或 `null` 保持精确比较。规则只用于比较，不改写用户输入或已接受任务。未知规则或非字符串枚举会使该次发现结果保持未知。应用原有的音色身份等输入规则仍然有效；空音色占位值不会显示为可选音色。

只有 `content` 参考计入实际媒体输入。文字生成中的音视频素材信息使用 `metadata`，H3 接续来源使用 `latent`；二者不会满足上传音视频的要求。接续请求保留上一任务的远端标识；没有匹配的接续能力声明时保持未知，同时仍检查实际 `/videos` 路径的部署暂停。

普通生成与工具都按最终发送的图片校验数量；主图和普通参考图合计，蒙版及独立标注参考分别统计。商品替换会先合成场景与商品，因此两个来源对应一张模型输入。超量输入会被拒绝，不会截取图片列表。Z-Image-Turbo 支持一张图片的编辑请求。

选区、消除、扩图和商品替换会在服务明确支持、输入与尺寸符合要求时使用原生蒙版。蒙版为灰度 PNG，白色表示修改，黑色表示保留；图片、蒙版与请求尺寸一致。当前请求不适用时使用原有编辑方式，保留用户指定输出尺寸。原生请求失败不会自动再发送普通编辑请求。结果仍经过原有选区合成，消除和商品替换保留已有的边缘柔化。

新工具任务保存 `imageExecutionPolicy` 和 `imageExecution`，固定请求方式、输入角色及必要限制。运行状态和期限不写入这些记录。旧任务没有这些字段时沿用已接受的请求行为；恢复或重放不会重新选择编辑方式。

普通编辑与原生选区都使用适配器实际发送的尺寸和参数进行接受检查；批量增强逐张检查，预设使用自身的请求尺寸。模型渲染尺寸与工具最后保存的尺寸可以不同，检查不会修改用户要求的输出尺寸。`imageExecutionPolicy.requestConstraints` 可选保存精确路由的 `RequestConstraints` JSON；执行时只检查这份已接受的限制，不读取最新声明。旧记录缺失该字段时不会追加限制。

The image card distinguishes text-to-image, single-image editing and multi-image editing. Known limits describe image counts, selection masks and independent references. Missing limits remain unknown. Service declarations and application limits are separate and do not rewrite saved settings.

Only the matched `profile.routes[].request` supplies effective request constraints. `profile.request` describes model facts without proving that every route implements them. Input roles carry explicit counts, `required_any_of` describes alternative required inputs, and parameters carry known enums or numeric bounds. Defaults are not allowed-value lists.

String enums may declare `enum_normalization`: `lower`, `title`, or `strip_lower`. Missing or null rules retain exact comparison. Both the supplied value and enum candidates are compared using the declared rule, without rewriting input or accepted tasks. Unknown rules or normalization on a non-string enum make discovery unknown. Existing application input rules, including voice identity validation, still apply. An empty voice placeholder is not presented as a selectable voice.

Only `content` references count as transmitted media. Audio/video metadata in text generation uses `metadata`, and an H3 continuation source uses `latent`; neither satisfies an uploaded-media requirement. Continuation keeps the previous remote job ID. An undeclared continuation profile remains unknown while a deployment pause on the actual `/videos` route still prevents new work.

Generation and tools count the images actually sent. A mask and an independent annotation reference have separate roles. Product replacement combines its two source assets into one model image. Excess images are rejected rather than truncated. Z-Image-Turbo accepts a single-image editing request.

Existing region-editing tools automatically use native masks when the declared route and unchanged requested dimensions allow it. Masks use grayscale PNG: white edits and black preserves. Otherwise the existing editing method remains available. A failed native request never triggers another generation automatically. Existing final compositing and edge feathering are retained. Accepted tools freeze the chosen request policy and input roles; historical tasks and replay retain their original behavior.

Ordinary edits and native selections both check the adapter's actual render dimensions and transmitted parameters before acceptance. Batch enhancement checks each image; presets use their own request geometry. Render dimensions may differ from the tool's final saved dimensions, and validation never changes the requested output size. The optional `imageExecutionPolicy.requestConstraints` stores validated `RequestConstraints` JSON for the exact route. Execution checks this accepted snapshot without querying current declarations. Existing records without the field acquire no additional limits.

Declaration and execution observations have independent expiry fields. Expiring a pause restores the still-valid declaration. The interface displays a shared expiry or query failure once and does not repeat it for every operation.

```sh
.venv/bin/python -m pytest tests/test_model_availability.py tests/test_capability_acceptance.py -q
.venv/bin/python -m pytest tests/test_capability_input_projection.py tests/test_vllm_omni_h3.py -q
.venv/bin/python -m pytest tests/test_image_input_policy.py tests/test_tool_native_mask.py tests/test_request_capability_acceptance.py -q
.venv/bin/python -m pytest tests/test_model_configs.py tests/test_model_catalog.py tests/test_creation_generation_service.py tests/test_tool_tasks.py tests/test_assistant_conversations.py tests/test_cli.py -q
node --test tests/modelAvailability.test.ts
# With the isolated API and Vite running as described in development validation:
node tests/browser/capability_discovery.mjs
```

These tests use isolated configuration/project directories, model doubles and a local HTTP server. They cover identity changes, draft isolation, operation matching, TTL expiration, coalescing, errors, zero-job rejection, local tools and replay. They do not validate real model outputs. See [development validation](../development/validation.md) for browser, contracts and import-layer checks.

The bilingual browser workflow checks editing without queries, stale draft responses, saving an unsupported configuration, zero-job rejection, UI submission, decoding the saved fixture image, pause expiration, project reopening and unchanged historical input. The frontend clock tests include system-clock changes and repeated observations. 浏览器用例实际保存并解码测试图片，模型输出来自测试替身；前端时钟测试包含系统时间变化和重复响应，不能作为真实模型验证结果。
