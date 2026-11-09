# Model availability / 模型可用状态

## 中文

模型接入可以读取服务的可选能力声明。自托管连接默认自动检查，其他连接默认关闭；服务级 `capabilityAutoCheck` 可以覆盖默认值。省略该字段会保留已有设置，旧配置无需转换。共享同一 `providerId` 的模型使用相同设置和查询缓存。独立服务及旧的独立配置保留自己的归属，相同 URL 和密钥不会合并它们。自动检查只查询能力接口，不生成内容、不唤醒模型。

“检查服务能力”可以检查未保存的表单。草稿检查不会保存配置，也不会更新已保存模型的状态。显式刷新已保存模型可以检查关闭自动检查的服务。

状态有三种：`available` 表示该请求具有匹配声明；`unavailable` 表示服务明确不支持或暂停当前执行入口；`unknown` 表示没有足够信息。旧服务没有接口、超时、断网、鉴权失败和无法理解的版本都保留手动配置与现有请求路径。错误原因分别显示，响应正文与凭据不进入状态数据。

声明按精确 Model ID、输入模式、输出类型和实际 HTTP 路由匹配。一个模型支持聊天协议，不能证明它会返回助手需要的文字。音乐适配器通过 `/audio/speech` 发送歌词 `input`、风格 `instructions` 和音频帧数 `max_new_tokens`；其 `lyrics_to_music` 模式独立于普通 TTS 的 `text_to_speech`。`/audio/generate` 的通用音频生成声明不会启用现有音乐适配器。

声明在内存中保留 30 秒；可信部署暂停状态最多保留 5 秒。内部使用本地单调时钟计算有效期，系统时钟调整和服务时钟偏差不改变到期规则；对外时间用于界面展示。查询和等待共享请求的总预算为 2 秒，失败可以短时间后重试。缓存有容量限制，进程重启后重新获得观察。目录读取不会访问模型服务，到期会改变目录版本。

生成、工具和使用设置模型的助手共享接受规则。服务查询位于项目存储事务之外，接受新任务时再次核对连接身份。明确拒绝不会创建生成任务，也不会调用生成接口。工具的本地操作和可选翻译保留原有行为。已接受任务的快照、恢复、下载、取消和同一命令重放继续使用原有规则；最新能力状态不会重新拒绝它们。能力状态不会清除音色或替换用户选择。

## English

Model connections can read an optional service capability declaration. Self-hosted connections check automatically by default; other connections require explicit enablement or a manual check. The optional service-level `capabilityAutoCheck` preference and query cache are shared by models with the same `providerId`. Independent providers and legacy standalone configuration IDs stay isolated even at the same URL with the same credential. Checks query declarations without inference or wake-up requests.

The unsaved form check uses an isolated draft identity. It saves neither configuration nor observations for saved connections. Explicit refresh can check selected saved connections even when automatic checks are disabled.

`available`, `unavailable`, and `unknown` describe evidence for a specific request. Matching requires the exact model, operation profile, consumed output and actual HTTP route. Unknown or failed discovery preserves manual configuration and the existing request path. Authentication, connection, timeout, unsupported-version and invalid-response reasons are distinct; credentials and response bodies are never included in observations.

Text responses and image responses on Chat Completions are distinct. Music uses the `lyrics_to_music` profile on `/audio/speech`, with lyrics, style and an audio-frame budget; ordinary TTS uses `text_to_speech`. Generic `/audio/generate` declarations do not create a consumer for that API in OpenDirector.

Declarations expire after 30 seconds. A proven deployment-wide pause expires after at most 5 seconds. Internal expiration uses a local monotonic clock; service timestamps identify observations, and wall-clock timestamps are presentation data. Each query, including waiting for an existing query, has a two-second budget. The bounded process-local cache coalesces concurrent reads and permits short failure retries. Catalog reads never contact providers; expiration changes their revision.

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

```sh
.venv/bin/python -m pytest tests/test_model_availability.py tests/test_capability_acceptance.py -q
.venv/bin/python -m pytest tests/test_model_configs.py tests/test_model_catalog.py tests/test_creation_generation_service.py tests/test_tool_tasks.py tests/test_assistant_conversations.py tests/test_cli.py -q
```

These tests use isolated configuration/project directories, model doubles and a local HTTP server. They cover identity changes, draft isolation, operation matching, TTL expiration, coalescing, errors, zero-job rejection, local tools and replay. They do not validate real model outputs. See [development validation](../development/validation.md) for browser, contracts and import-layer checks.
