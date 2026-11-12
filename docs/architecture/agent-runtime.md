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

新文件通过 `opendirector asset import` 登记，再根据需要调用 `opendirector canvas add-material` 展示。发布回执、素材登记和画布展示分别表达，不以创建节点代替文件交付。

## Skill 加载与媒体输入

技能发现范围包括工程和工作空间的 `.opendirector/skills/`，以及内置的 `packages/agent/skills/`。发现阶段调用 bundled OpenCode 的原生加载器；执行阶段将发现的技能复制到本轮目录，向所选 harness 提供目录和显式选择信息，由其加载正文与资源。

Default 将模型配置中的输入模态传入 bundled OpenCode。外部 harness 使用自身的模型能力配置。媒体引用和前端预览不直接构成模型视觉输入，实际观察能力取决于模型/API 以及原生工具传入的内容。

## 运行生命周期

同一工程同时只接受一个回复运行。运行事件转换为回复正文和工具活动，保存到对应会话；原生事件与业务工具事件追加到 `agent-runs/<turn-id>.<runtime>.jsonl`。Default 使用 `opencode` 作为轨迹文件的 runtime 名称。

Default 的模型网关在 `agent-runs/<turn-id>.model.jsonl` 记录实际转发的请求体，包括生效的系统消息、会话上下文、工具 Schema 与模型参数。请求 ID 关联上游 HTTP 状态、响应头等待耗时和传输错误。该文件仅供本地调试，创建权限为 `0600`，不记录 HTTP 鉴权头。回复片段、工具结果和 token 用量仍见原生轨迹。

停止或流连接断开时，适配层终止进程组，Gateway 关闭新调用入口并等待已接受操作结束；API 保存部分回复并释放运行占用。业务操作以各自回执确认，远端生成任务仍通过任务取消命令处理。

## 原生工具权限

| Harness | 执行约束 |
| --- | --- |
| OpenCode | 工具权限配置开放 Shell、文件读取、已发现技能和业务 CLI |
| Codex | workspace-write 沙箱，开放 Shell 和业务 CLI |
| Claude Code | 明确允许 Skill、Bash、Read 和业务 CLI |
| JiuwenSwarm | 明确允许 skill_tool、list_skill、read_file、bash 和业务 CLI |
| DeepSeek Harness | 沿用原生工具与权限；Skill 限于本轮快照，业务操作通过 Shell 调用 opendirector，未承接的审批不自动批准 |

工具允许列表与操作系统沙箱提供不同约束。业务工具独立校验工程范围和输入；原生文件访问权限不授予直接改写工程存储的业务权限。

CLI 通过环境变量中的本轮本地 Socket 地址连接业务网关，不使用连接令牌或凭据文件。网关继续校验工程范围、轮次生命周期及业务输入。
