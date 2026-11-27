# Assistant 轮次计时

[English](turn-timing.md)

Issue #468。本文记录 Assistant“轮次耗时”的含义（Slice A，已实现）和 Trace 计时概览的设计（Slice B，仅设计，未实现）。Slice A 以 `apps/api/src/opendirector_api/agent.py`（`Conversations.update`、`Conversations.trace`）和 `src/canvas/turnTiming.ts` 的代码为准。

## Slice A：已记录的计时

### 字段

`agent-runs/conversation.json` 中的每条 assistant 消息可包含：

| 字段 | 含义 |
| --- | --- |
| `startedAt` | UTC ISO-8601 时间，精度为毫秒，在构建 assistant 占位消息时生成，并由首次（begin）写入持久化。它表示接受时间，不是 `durationMs` 窗口的起点：单调时钟起点在该次写入成功之后才取得，因此略晚于它。 |
| `finishedAt` | 轮次以 `complete`、`stopped` 或 `interrupted` 结束时写入的 UTC 时间。 |
| `durationMs` | 非负整数，使用单调时钟测得。 |

`GET /api/creation/projects/{project_id}/assistant/conversations/{conversation_id}/trace` 为每个轮次返回 `startedAt`、`finishedAt` 和 `durationMs`。未记录或格式无效的值为 `null`。客户端不得用 `finishedAt - startedAt` 自行计算时长，`durationMs` 是唯一的时长。

### 测量边界

- **起点：**在 `Conversations.update` 的 `begin` 事务内，`durable_json` 成功持久化 begin 之后立即取得。不包含 begin 写入，因此首次持久化的延迟（磁盘慢、等锁、2 秒写入）不会计入 `durationMs`。只有已持久化的轮次才算被接受，且该时刻不依赖写入耗时。写入抛出异常时不记录起点，该轮次也不被接受。重复 begin 会在触碰任何时钟之前以 409 拒绝，因此不会重置运行中轮次的起点。
- **终点：**进入 `finish` 更新时，在 finish 写入之前。不包含 finish 写入。finish 写入失败时保留起点，重试仍可记录时长。
- Job 完成不会延长该窗口。轮次启动的生成 Job 可以比轮次存活更久。
- 浏览器时钟从不作为依据，界面只格式化后端保存的值。
- 单调起点保存在 `Conversations` 实例的内存中（`_started`）。计时只在 `Conversations.update` 中记录，`produce()` 和 `turn()` 不受影响。任何接受或结束轮次的改动（例如 #381、#402 的队列与 steer 工作）都必须继续经过 `Conversations.update(begin/finish)`，否则会无声地丢失计时。

### 状态

| 状态 | `startedAt` | `finishedAt` / `durationMs` | 聊天行 | Trace 页面 |
| --- | --- | --- | --- | --- |
| 完成 | 有 | 有 | “已完成 · 12.4 s” | 状态徽标和时长 |
| 用户停止 | 有 | 有 | 原有“已停止”行加“3.1 s” | 状态徽标和时长 |
| 提供方或运行时失败 | 有 | 有（轮次以 `interrupted` 结束） | 原有“已中断”行加时长 | 状态徽标和时长 |
| 进行中（streaming） | 有 | 无 | 不显示计时行 | 仅状态徽标，无时长 |
| 因重启或崩溃中断 | 有 | 无 | 不显示计时行 | 状态徽标和“不可用” |
| 本功能之前的旧轮次 | 无 | 无 | 不显示计时行 | 状态徽标和“不可用” |
| 未被接受的轮次（在 `begin` 之前被拒绝） | 无 assistant 消息 | 无 | 不适用 | 不列出 |

`durationMs` 是单调时钟上的 `终点 - 起点`，不是 `finishedAt - startedAt`。重启后内存中的起点丢失，因此运行中的轮次保留 `startedAt`，但永远没有时长。不是当前实时轮次的 `streaming` 消息，`trace()` 会报告为 `interrupted`。已知限制：轮次进行中重启会使时长未知，系统不会估算。

### 显示

`src/canvas/turnTiming.ts` 是唯一的格式化入口：`820 ms`、`12.4 s`、`2m 5s`、`1h 2m`。`AssistantReply.tsx` 仅在存在时长时显示“状态 · 时长”。`AssistantTracePage.tsx` 对每个非进行中的轮次显示时长或“不可用”。

## Slice B 设计：Trace 计时概览

状态：仅设计。Slice B 不新增后端字段、接口或事件时间戳。

### 选择：逐轮耗时对比

概览是**逐轮耗时对比**（Per-turn Duration Comparison），不绘制挂钟时间线。一个轮次结束到下一条用户消息之间的间隔是用户阅读或输入的时间，不是 agent 工作，因此不绘制，也不显示空闲时间。

### 组件分层

1. `traceTiming.ts`：纯模型。输入为 trace 响应中的 `turns`，输出每个轮次一行：`id`、`number`、`runtime`、`status`、`durationMs | null`、`ratio | null`。不含 React 和请求，带单元测试。
2. `TraceTimingOverview`：渲染在 `AssistantTracePage` 内的展示组件。接收行数据和 `reveal(turnId)` 回调，不发起请求。
3. `AssistantTracePage` 继续负责数据加载以及现有的滚动与展开逻辑。不修改 `AssistantPanel.tsx`。

### 数据来源

只使用现有的 `GET .../conversations/{id}/trace` 响应。概览不读取会话 JSONL、事件或完整日志，开销与轮次数量成正比，而不是与日志大小成正比。

### 条形计算

- `ratio = durationMs / max(durationMs)`，范围是已加载会话中有时长的轮次，所有条形共用同一比例尺。
- 横轴是时长刻度，只有相对长度可靠。条形不对应具体时刻，并排的两个条形也不表示一个在另一个结束后才开始。
- 只有一个有时长的轮次时显示满宽条形。时长为 0 时显示最小宽度条形，使该轮次仍可见。
- 每个条形显示 `formatTurnDuration` 格式化后的时长。

### 进行中与未知

- **进行中**（`streaming`，实时）：条形没有终点，使用动画或斜纹。已用时间仅用于显示，由 `startedAt` 计算并标注为近似值，且不计入 `max`，不会使其他条形重新缩放。
- **未知**（没有 `durationMs`，包括旧数据和重启中断的轮次）：斜纹占位并标注“不可用”，不计入 `max`。

### 交互

- 点击条形，或在条形上按 Enter 或 Space，调用 `reveal(turnId)`，沿用现有逻辑滚动到并展开该轮次。
- 条形是列表中的 `button` 元素，`aria-label` 形如“Turn N，运行时，状态，时长”。方向键漫游焦点为可选项。
- 窄屏：条形堆叠在摘要行下方，标签截断，永远不需要横向滚动。

### Jobs

轮次的 Job 来自现有的 `/turns/{turn_id}/jobs` 接口，仅在展开某个轮次时按需请求，概览从不请求。Job 数据不参与条形长度，与上文的测量边界一致。

### 与其他工作的边界

- #449（首次动作时间、完成时间、工具开销）：这些指标需要新的事件时间戳。Slice B 不新增，也不声称提供它们。
- #422（Markdown 导出）：导出复用同样的轮次字段，本工作不包含导出逻辑。

### 与 #469（Agent 计时账本）的关系

PR #469（issue #449）记录一个轮次的时间花在哪里。两项功能度量的对象不同，不共享状态。

| | #469 `turnSeconds` | 本工作 `durationMs` |
| --- | --- | --- |
| 目的 | 离线分析工具调用与启动开销占比 | Chat 与 Trace 中面向用户的轮次时长 |
| 起点 | `produce()` 入口，早于轮次被接受 | 接受轮次时，位于 `Conversations.update` 的 `begin` 事务内 |
| 终点 | `produce()` 的 `finally` 开头，发出 finish 更新之前 | 进入 `finish` 更新时 |
| 单位与命名 | 秒，`turnSeconds` | 整数毫秒，`durationMs` |
| 存放位置 | `agent-runs/timing/<turn>.json`（不进入对话历史） | `agent-runs/conversation.json` 中的助手消息 |
| 读取方 | `scripts/bench_turn_timing.py` | Trace API、Chat 与 Trace 界面 |

两个窗口的终点几乎相同，起点相差 `produce()` 中接受前的工作（校验、模型可用性检查、`begin` 写入），通常为毫秒级，数值不要求完全一致，也不互相推导。各自保留单调时钟：#469 的时钟在 `produce()` 和工具事件账本中，本工作的时钟在 `Conversations.update`，那里是唯一同时看到接受与 finish 写入的位置。持久化不冲突：#469 写独立文件，本工作写消息。UI 不展示 `turnSeconds`，账本不读取 `durationMs`。

### Trace 耗时概览

对话 Trace 页面在轮次列表上方显示紧凑的耗时概览。每个轮次对应一个按钮行，包含编号、状态、条形和耗时。条形长度相对已结束轮次中最长的一个按线性比例绘制。概览只读取各轮已持久化的 `durationMs`，不使用 `startedAt`/`finishedAt`，也不加载任何 Trace 日志。

- 运行中的轮次显示“运行中”，不绘制条形。`durationMs` 缺失或无效时显示“不可用”，不绘制条形。
- 已停止和已中断的轮次在 `durationMs` 有效时显示状态与条形。
- 耗时为零时显示细标记而不是条形，其他条形有最小可见宽度。
- 有两个及以上带耗时的轮次时，最慢的一轮以强调色、符号和无障碍文本标出。
- 选中某行（点击、Enter、空格）复用现有的定位逻辑：展开该轮、懒加载其 Trace 并滚动到位。
- 若没有任何轮次有有效耗时，概览显示“暂无耗时数据”，轮次列表照常可用。

逻辑位于 `src/canvas/traceTimingOverview.ts`。概览不引入 #449 的任何指标。
