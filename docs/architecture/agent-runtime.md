# Agent 运行机制

本文描述 runtime 适配、技能发现和单次运行的实现机制。业务分层与公共语义见 [统一项目架构](unified-project.md#agent-runtime-与业务执行)，需求与验收见 [Agent 协作开发文档](../development/agent-collaboration.md)。

## Runtime 与模型来源

Harness 指承担模型调用、工具执行和上下文管理的 Agent 执行程序；runtime 是 OpenDirector 对该程序的接入入口。

| Runtime | 执行程序 | 模型与认证来源 |
| --- | --- | --- |
| Default | 固定版本的 bundled OpenCode | OpenDirector 模型配置，经本地模型代理访问服务 |
| OpenCode CLI | opencode，优先 PATH，再查找常见 CLI 安装目录 | CLI 原生配置与模型目录 |
| Codex | 优先 PATH 中的 codex，再查找常见桌面版与 CLI 安装目录 | 原生认证与模型目录；隔离启动前解析所选模型或默认模型 |
| Claude Code | claude，优先 PATH，再查找常见 CLI 安装目录 | 原生认证、环境变量与初始化模型目录 |
| JiuwenSwarm | jiuwenswarm-process，优先 PATH，再查找常见 CLI 安装目录，通过 stdin/stdout JSONL 直接调用 | 本机 Jiuwen 模型目录、配置与环境变量 |
| DeepSeek Harness | dsh，优先 PATH，再查找常见 CLI 安装目录，以 acp profile 运行标准 JSON-RPC | CLI 原生 profile、模型目录与认证 |

Default 与 OpenCode CLI 分别配置。外部 CLI 不读取 OpenDirector 保存的模型凭证。进程继承服务端环境，包括 PATH 和第三方 API 配置。

会话保存 runtime、模型和推理强度，浏览器偏好用于辅助恢复选择。适配层不指定固定迭代轮数，沿用 harness 的预算和停止机制。

## 执行链路

```text
会话消息、素材引用、技能选择
              ↓
       Runtime 适配层
              ↓
 Harness 执行循环与原生工具
              ↓ Shell 调用 opendirector
         ToolGateway
              ↓
    共用业务命令与应用服务
              ↓
     工程回执与界面状态刷新
```

适配层为每轮创建 `agent-runs/<turn-id>/work/`，启动 harness 并注入本轮 CLI 执行入口。子进程 cwd、PWD 和 ACP 工作区始终指向本轮执行目录；会话身份单独持久化。原生工具以此目录为工作目录，通过继承的 PATH 查找 FFmpeg、ffprobe 等程序。

业务入口使用 Typer CLI，通过 `opendirector --help` 和子命令的 `--help` 渐进发现操作。查询、编辑及生成命令调用共用业务服务。Agent 通过受令牌保护的本轮连接继承工程范围、编辑会话、执行目录和操作回执；CLI 子进程退出不终止已接受的后台任务。普通终端通过现有 HTTP API 连接服务，写入申请独立编辑会话并遵守工程锁，查询不申请租约。`--session` 可使用已有授权会话。`--operation-id` 提供稳定修改身份，同身份相同输入重放返回原回执，不同输入拒绝。

接受轮次时，服务端校验画布的工程会话，并为本轮签发独立的工程写入租约。运行期间服务端负责续租，画布关闭或断线后仍可执行本轮已授权的写入。运行结束或停止后释放租约。工程路径、对象锁和预期版本仍由共享业务服务校验，重新打开画布后用户可以继续编辑。

The server validates the canvas session when it accepts a turn and grants the turn its own project write lease. The server renews that lease while the turn runs, including after the canvas closes or disconnects, and releases it when the turn completes or stops. The shared services still check the project path, object locks and expected revisions. A reopened canvas can edit concurrently.

新文件通过 `opendirector asset import` 登记，再根据需要调用 `opendirector canvas add-material` 展示。发布回执、素材登记和画布展示分别表达，不以创建节点代替文件交付。

## Skill 加载与媒体输入

技能发现范围包括工程和工作空间的 `.opendirector/skills/`，以及内置的 `packages/agent/skills/`。发现阶段调用 bundled OpenCode 的原生加载器；执行阶段将发现的技能复制到本轮目录，向所选 harness 提供目录和显式选择信息，由其加载正文与资源。

Default 将模型配置中的输入模态传入 bundled OpenCode。外部 harness 使用自身的模型能力配置。媒体引用和前端预览不直接构成模型视觉输入，实际观察能力取决于模型/API 以及原生工具传入的内容。

## 运行生命周期

Search citations keep their native markers in the original reply and trace. Completed Codex MCP web-search results supply validated source IDs, HTTP(S) URLs and titles through `sources` events; the conversation retains this metadata with the reply. The UI splits tool activities using raw text offsets before formatting prose citations as source links, and uses the same formatting for copying. Code examples remain literal. Missing sources and incomplete final markers have a localized fallback. For saved Codex replies without source metadata, queries derive it from the matching turn's project-local trace without rewriting the conversation; a bounded metadata cache is invalidated by trace modification time and size. Reading a trace never requests a model call.

同一工程同时只执行一个回复。运行期间仍可提交补充消息：`POST /assistant/messages` 在空闲时直接开始一轮，在运行中返回 202 并按 `queueSeq` 把消息排入投递队列，本轮结束后依次运行。`end` 事件带 `nextTurnId` 时事件流不关闭，客户端因此能在同一条连接上接着收到下一轮；断线重连用 `GET /turns/{turn_id}/events?after=<seq>` 从已收到的最后一帧续读；链已经推进到下一轮时，客户端手里上一轮的 turn id 同样能找到这条链，不必等页面刷新。排队消息立即出现在会话里并可读；停止时整条链一起停止，排队消息标记为 `cancelled` 并保留下来供用户重新发送。运行事件转换为回复正文和工具活动，保存到对应会话；原生事件与业务工具事件追加到 `agent-runs/<turn-id>.<runtime>.jsonl`。Default 使用 `opencode` 作为轨迹文件的 runtime 名称。

Default 的模型网关在 `agent-runs/<turn-id>.model.jsonl` 记录实际转发的请求体，包括生效的系统消息、会话上下文、工具 Schema 与模型参数。请求 ID 关联上游 HTTP 状态、响应头等待耗时和传输错误。该文件仅供本地调试，创建权限为 `0600`，不记录 HTTP 鉴权头。回复片段、工具结果和 token 用量仍见原生轨迹。

停止或流连接断开时，适配层终止进程组，Gateway 关闭新调用入口并等待已接受操作结束；API 保存部分回复并释放运行占用。业务操作以各自回执确认，远端生成任务仍通过任务取消命令处理。

## Agent 来源追溯

Agent 的 `generation.submit` 接受任务时，把本轮标识和工具调用标识写入 Job 自身：

| 字段 | 含义 |
| --- | --- |
| `agentRunId` | 提交该任务的 Agent 轮次（turn）ID |
| `agentCallId` | 该轮内的工具调用 ID，CLI 调用形如 `cli:<id>` |

两个字段同时存在或同时缺失，缺失时不出现在序列化结果中，旧数据的序列化不变。命令 ID 仍由 `agent_command_id(agentRunId, agentCallId)`（即 UUID5）推导，也是幂等键；Command 本身没有新增字段，指纹和幂等规则不变。来源与 Job、回执、快照、事件在同一次提交中落盘，经提交日志恢复后仍在。`job.cancel`、`job.recover` 不改写来源。

两个方向的查询都只读取已提交的工程数据，不读取 Agent 轨迹：

- Job → 轮次：`job.get` 或工程快照中的 `agentRunId`、`agentCallId`。
- 轮次 → Job：`GET /api/creation/projects/{project_id}/assistant/turns/{turn_id}/jobs`，返回该轮提交的 Job（按创建时间、ID 排序）：`jobId`、`callId`、`commandId`、`status`、`phase`、`recovery`、`resumeAllowed`、`cancelRequested`、`remoteCancellation`、`errorDetails`、`asset`、`adopted`。工程不存在按既有错误语义返回 404；轮次没有任务返回空列表。该路由与轨迹路由一样不申请编辑会话，不执行、不重放命令，也不启动 Provider。

兼容性：

- 此前创建的 Job 没有来源，只能通过 Agent 轨迹追溯；不回填。
- 旧工程在新版本中可正常打开。
- 含来源字段的工程不能被更早的 OpenDirector 版本打开：Job 模型禁止未知字段，旧版会以存储不可用拒绝该工程。项目格式没有版本号或降级机制，按 [AGENTS.md](../../AGENTS.md) 的约定不静默忽略字段，也不提供兼容层。需要回退版本时，先备份工程目录。
- Agent 轨迹是调试文件，不是业务事实来源，删除它不影响上述查询。

English summary: a Job created by an Agent `generation.submit` records `agentRunId` (turn) and `agentCallId` (tool call), both or neither, and omits them when absent so existing jobs serialize unchanged. The command ID is still `uuid5(run id, call id)` and no Command field was added. Job to turn uses `job.get` or the snapshot. Turn to jobs uses the read-only `GET .../assistant/turns/{turn_id}/jobs`, which reads the committed snapshot, needs no editing session, never replays a command and does not read the Agent trace. Jobs created before this change have no origin and remain traceable only through the trace. Older OpenDirector builds reject a project containing these fields because Job forbids unknown fields; the project format has no version or downgrade mechanism, so back up a project before opening it with an older build.

## 原生工具权限

| Harness | 执行约束 |
| --- | --- |
| OpenCode | 工具权限配置开放 Shell、文件读取、已发现技能和业务 CLI |
| Codex | workspace-write 沙箱，开放 Shell 和业务 CLI |
| Claude Code | 明确允许 Skill、Bash、Read 和业务 CLI |
| JiuwenSwarm | 明确允许 skill_tool、list_skill、read_file、bash 和业务 CLI |
| DeepSeek Harness | 沿用原生工具与权限；Skill 限于本轮快照，业务操作通过 Shell 调用 opendirector，未承接的审批不自动批准 |

工具允许列表与操作系统沙箱提供不同约束。业务工具独立校验工程范围和输入；原生文件访问权限不授予直接改写工程存储的业务权限。

Windows 上的 Codex 启动显式设置 `windows.sandbox="elevated"`，避免隔离启动忽略用户配置后，`workspace-write` 降为只读并拦截 Shell。保留沙箱约束，不绕过审批或沙箱。PowerShell 使用 `Get-Command opendirector` 发现 CLI，POSIX Shell 使用 `command -v opendirector`。

On Windows, Codex explicitly sets `windows.sandbox="elevated"` so ignoring user configuration does not downgrade `workspace-write` to read-only and block Shell execution. Sandbox restrictions remain enabled. Discover the CLI with `Get-Command opendirector` in PowerShell or `command -v opendirector` in POSIX shells.

CLI 通过环境变量中的本轮本地 Socket 地址连接业务网关，不使用连接令牌或凭据文件。网关继续校验工程范围、轮次生命周期及业务输入。

## 对话轨迹页 / Conversation trace page

轨迹页 `/?traceProject=…&conversation=…&turn=…` 在一页内按顺序列出一个对话的全部已执行轮次，每轮可独立展开，展开时才读取该轮日志与关联 Job；“下载原始轨迹”是用户显式触发的例外，见下。轮次索引来自只读接口 `GET .../assistant/conversations/{conversation_id}/trace`，它解析当前对话、已归档对话和 `reusedCreateIds` 别名，只返回轮次元数据（序号、用户输入摘要、运行时、状态），不读取日志正文，不激活对话，不获取编辑租约。轮次由持久化的身份关系确定：用户消息与 id 为 `uuid5(用户消息 id, 'assistant')` 的助手消息成对才算已执行的一轮；没有该助手记录的用户消息（例如排队中、未执行）不出现。每轮使用自己记录的运行时选择日志源和解析器，仅 Default（opencode）显示模型原始请求。`GET .../traces/{turn_id}/conversation` 供旧的单轮链接查找所属对话；找不到时保持原单轮页面。

English summary: the trace page lists every executed turn of a conversation, expanded one at a time, and reads a turn's logs and linked Jobs only when it is opened; the user-triggered original trace download is the one exception (below). The turn index comes from the read-only `GET .../assistant/conversations/{conversation_id}/trace`, which resolves current, archived and aliased (`reusedCreateIds`) conversation ids and returns metadata only (number, input summary, runtime, status). It never reads log bodies, activates a conversation or takes a lease. A turn is a user message paired with the assistant message whose id is `uuid5(user id, 'assistant')`, so queued or never executed user messages are not listed. Each turn uses its own recorded runtime for the log source and parser, and raw model requests are offered for the Default (opencode) runtime only. `GET .../traces/{turn_id}/conversation` lets old single-turn links find their conversation; when none is found the single-turn page remains.

### 原始轨迹归档 / Original trace archive

“下载原始轨迹”由前端完成，不新增或修改后端接口，复用 `src/canvas/zipArchive.ts` 的 `createZip()`（`compress: false`，保留原始字节）与 `downloadFile()`。流程：先重新请求 `GET .../conversations/{conversation_id}/trace`，任何轮次为 `streaming` 即拒绝；随后对每轮按其运行时逐个请求 `GET .../traces/{turn_id}/{source}`（404 记为 `missing`，其他非 2xx、超时、响应提前结束、超限一律失败），读完后再次校验轮次状态，不一致则失败。任何失败都不产出 ZIP。因此归档是逐来源读取的结果，不是跨文件原子快照，`manifest.json` 的 `snapshot` 字段如实说明。容量上限为 64 MiB，含每个条目的本地头、中央目录项、结束记录和 manifest，没有单文件上限，超限时错误指出轮次与来源。每个请求和整个导出都有超时，用户可取消，读取流在失败、超限、取消时被取消并释放。内容不脱敏，`model.jsonl` 原样包含；`manifest.json` 区分 Job 为空（`jobs: []`）与查询失败（`jobs: null`、`jobsStatus: "unavailable"`）。

English summary: the download is built in the frontend with no backend change, reusing `createZip()` (`compress: false`, original bytes) and `downloadFile()`. It re-fetches the conversation trace index and refuses when any turn is `streaming`, reads each source sequentially (404 becomes `missing`; any other non-2xx, timeout, early end or cap overrun fails), then re-checks turn status and fails on any difference. No failure produces a ZIP, and the archive is explicitly a per-source read, not an atomic snapshot across files (`manifest.json` says so). The 64 MiB cap covers raw bytes plus ZIP headers, central directory, end record and manifest; there is no per-file cap, and an overrun names the turn and source. Requests and the whole export are time-bounded, the user can cancel, and streams are cancelled and released on failure, overrun or cancel. Content is not redacted (`model.jsonl` included). The manifest separates no linked Jobs (`jobs: []`) from a failed lookup (`jobs: null`, `jobsStatus: "unavailable"`).
