# 运行中插入补充消息：设计记录

状态：设计记录。P0 已按本文落地，排队、撤回、手动继续的行为见第 6.1 节；进度与待办以 issue #379 为准，P1 仍待实测（第 5 节）
记录时间：2026-11-17（实现前检查用当时的工作分支 `fix/agent-wait-progress-131` @ `9d08bf5a`，实现基于 `origin/main` @ `729b49bc`）
范围：`src/canvas/`、`src/backend/chat.ts`、`src/i18n/messages/*/assistant.ts`、`apps/api/src/opendirector_api/agent.py`、`packages/core/src/opendirector/agent/`
关联：issue #379；路线图 #261；停止后编辑重发 #375；会话管理 #247

## 1. 背景

实现之前，对话是一问一答：发送之后，输入框的发送按钮被换成停止按钮，必须等这一轮回完才能再说话。用户真正的需要是「做这件事的时候，再补一句」——想起漏掉的约束、追加一个素材、纠正方向。等 3 分钟再说，产出的东西已经错了；点停止再说，这一轮的工作全丢。

Codex、DSH 这类 harness 的交互是可以中途插话的，所以这个差距是明显的体验落差，不是偏好问题。

本文回答三件事：

1. 现在为什么插不进去——是少了一个按钮，还是协议层就没有位置；
2. 如果要补，语义应该是什么（排队续跑 / 同轮注入 / 打断重开，三者代价不同）;
3. 具体怎么改，哪些必须先实测再承诺。

## 2. 实现前的现状检查

下面这一段是动手之前的事实，保留下来是因为它解释了为什么会这样设计；当前的接口语义见 [agent runtime](../architecture/agent-runtime.md) 的「运行生命周期」一节。

复现方式：用当时的 `disconnect_turn` 把一轮回复保持在运行状态（SSE 断开后 run 继续跑），运行期间再提交一次。基线 `9d08bf5a`，实测输出：

```text
PROBE second turn -> 409 {'detail': '当前工程已有回复正在执行。', 'code': 'operation_rejected'}
PROBE draft save -> 200
PROBE messages before/after -> 2 2
PROBE queued markers -> ['complete', 'streaming']
PROBE follow-up routes -> []
```

读法：第二次提交被拒；草稿能存（正文没丢）；对话消息数没变（补充内容没有进入对话）；消息状态只有 `complete`/`streaming`（没有「待执行」）；路由表里没有任何承接入口。四条合起来说明：**补充内容既没有落地位置，也没有排队位置，只是留在草稿里。**

### 2.1 前端：运行中把「发送」换成了「停止」

`src/canvas/AssistantPanel.tsx:729-746`：`chat.sending` 为真时，提交按钮整体替换成停止按钮；否则才是 `type="submit"`、`disabled={!chat.canSend || locked || !value.draft.trim()}` 的发送按钮。也就是说运行中根本没有提交入口，不是提交后失败。

同一状态下 `AgentPicker`（`:703`）、`SkillPicker`（`:712`）、`ModelPicker`（`:719`）都被 `chat.sending` 禁用，避免运行中改配置。

### 2.2 按 Enter 为什么没反应

`src/canvas/useAssistantChat.ts:436`：

```ts
if (!loaded || switching.current || submitting.current || uploading.current || !canSend || !current.current.draft.trim()) return;
```

`submitting.current` 在 `follow()` 开始时置真，直到这一轮 `end` 才在 `finally` 里复位。所以运行中按 Enter 是一条静默 `return`：文字留在草稿里，没有任何提示，用户会以为键盘坏了。这是比「按钮变灰」更糟的一种状态——按钮至少是可见的。

值得注意的是输入框本身是可写的：`ChatReferenceEditor.tsx:801` 的 `contentEditable={!disabled && !busy}`，而 `AssistantPanel.tsx:593` 只传了 `disabled={locked}`，`busy` 是组件内部用于引用解析的 `useState`。所以能打字、不能发，落差全落在提交这一步。

### 2.3 服务端：单轮互斥是设计，不是疏漏

`apps/api/src/opendirector_api/agent.py:291-297`：

```python
async with admission.setdefault(project_id, asyncio.Lock()):
    if project_id in active:
        raise ProjectError('当前工程已有回复正在执行。', 409)
    ...
    task = asyncio.create_task(produce())
    active[project_id] = (value.id, task, events)
```

运行中的 `active[project_id]` 是 $(turnId, task, RunEvents)$。同一状态下 `POST /conversations` 也拒绝（`请先停止或等待当前回复结束，再切换对话。`），`GET /turns/{turn_id}/events` 只对当前运行轮有效，其余 404。

`docs/architecture/agent-runtime.md` 明写「同一工程同时只接受一个回复运行」。这条约束值得保留：它让 runtime 会话、`active`、`conversation.json` 和工具账本之间只有一个写者，一旦放开并发，重连、停止、落盘的语义都要重做。

所以缺的不是一个判断，而是**「运行期间来的输入放在哪里」这个位置**。

### 2.4 Runtime：每轮只有一个 prompt 入口

`packages/core/src/opendirector/agent/` 下所有适配器都是一次性启动：

| Runtime | 启动方式 | 运行中能再送话吗 |
| --- | --- | --- |
| Default / OpenCode | `opencode run --dir … --pure --format json --agent opendirector` | 不能，`run` 是单次任务 |
| Codex | `codex exec --json --skip-git-repo-check … --sandbox workspace-write` | 不能，`exec` 是单次任务 |
| Claude Code | `claude -p … --output-format stream-json …`（`native.py:120-135`） | 当前不能：没有 `--input-format stream-json`，stdin 不是消息通道 |
| JiuwenSwarm | 自定义 JSONL 进程，stdin/stdout | 待实测：stdin 常开，但协议是否接受运行中的追加帧未知 |
| DeepSeek Harness | ACP JSON-RPC，`session/prompt` 一次，取消用 `session/cancel` | 不能，ACP 这一版没有 steer 方法 |

结论：**任何「真·同轮注入」都要落到具体 harness 的原生能力上，逐个实测**，不能靠应用层「重发一遍」假装做到了。这决定了方案必须分层。

## 3. 三种可选语义

| 语义 | 用户看到什么 | 代价 | 能覆盖的 runtime |
| --- | --- | --- | --- |
| A. 排队续跑 | 消息立刻出现在对话里，标「本轮结束后执行」，当前轮结束后自动接着跑 | 应用层就能做；补充内容不进入正在跑的上下文，用户要知道「这句下一轮才生效」 | 全部 |
| B. 同轮注入（steering） | 补充内容进入正在跑的循环，当前回复后半段就体现出来 | 需要各 harness 原生输入通道 + 输入合并语义；失败面大 | 逐个实测 |
| C. 打断重开 | 取消当前轮，把「原消息+补充」合成一条新的从头跑 | 已产出的内容和工作作废，最贵 | 全部，但不建议 |

建议：**A 作为通用底线（P0）**，先让「插不进去」这个硬伤消失；**B 作为按 runtime 开放的能力（P1）**，没有实测就不显示；C 不做，避免让用户为一句补充付掉整轮成本。

A 的语义要诚实地告诉用户：这条补充**不改变正在生成的这一轮**，它会在这一轮结束后立刻以同一对话继续执行，并且能看到上一轮的产出。这样用户的预期和实际行为一致，不会误以为当前回复已经听取了补充。

## 4. P0：排队 + 自动续跑

### 4.1 数据

消息状态在现有 `complete | streaming | stopped | interrupted` 之外增加两个：

- `queued`：已接受、未执行。带 `queueSeq`（会话内单调递增）与提交时的 `runtime`/`model` 快照。
- `cancelled`：排队后被撤回或被停止取消，保留正文以便用户重发。

队列本身不另建文件：直接复用 `conversation.json` 的 `messages`，`status == 'queued'` 且 `queueSeq` 递增即队列。好处是刷新、重连、重开工程天然一致；坏处是每次取队首要做一次读改写，但这本来就在 `Conversations.update` 的事务里。

「链」是运行时概念，链 id 取首轮 turn id；`active` 从「一个 turn」升级为「一条链」：

```python
@dataclass
class Chain:
    id: UUID                  # 首轮 turn id
    conversation_id: UUID
    events: RunEvents         # 整条链共用，事件带 seq
    turn: UUID | None         # 当前在跑的 turn
    task: asyncio.Task | None
    seq: int = 0
```

`chains: dict[UUID, Chain]` 取代 `active: dict[UUID, tuple[...]]`，`release` 从「任务结束就 pop」改为「链结束才 pop」。这一步是必需的：现在任务一结束就 `active.pop`，如果自动续跑放在 `finally` 里，中间会有一个窗口让新的 `POST /turns` 插进来，变成并发两轮。

### 4.2 接口

新增一个入口，语义是「发一条消息，能跑就跑，跑不了就排」：

```text
POST /api/creation/projects/{project_id}/assistant/messages
body: 与 /turns 相同（Turn），另加 deliver?: 'auto' | 'queue' | 'steer'，默认 auto

无运行轮 → 200 text/event-stream（与 /turns 完全一致，客户端可用同一套处理）
有运行轮 → 202 {"queued": {"id", "text", "queueSeq", "position"}, "chainId": "...", "turnId": "..."}
        （deliver=steer 且该 runtime 不支持 → 202 回退为排队，并带 "steered": false 与原因）
```

配套：

```text
DELETE /assistant/messages/{message_id}      # 仅 queued 可撤回，已开始执行返回 409
POST   /assistant/queue/dispatch             # 失败/重启后由用户显式继续队列
POST   /assistant/turns/{turn_id}/stop?scope=chain|turn   # 默认 chain
GET    /assistant/chains/{chain_id}/events?after=<seq>    # 断线重连，从游标续读
```

`POST /turns` 保留原样（运行中仍 409），老客户端行为不变；新客户端走 `/messages`。等 P0 稳定后再讨论是否让 `/turns` 内部转调。

事件流加两个字段，并允许一轮结束后接着下一轮：

```text
{"type":"start","seq":1,"turnId":"A","conversation":{...}}
{"type":"delta","seq":2,"text":"..."}
{"type":"queued","seq":9,"message":{...},"position":1}      # 新增：排队变化（加入/撤回）
{"type":"end","seq":20,"turnId":"A","nextTurnId":"B","conversation":{...},"error":null}
{"type":"start","seq":21,"turnId":"B","conversation":{...}}  # 同一 HTTP 流继续
```

规则很简单：`end` 带 `nextTurnId` 表示链未结束，客户端**不要**关流；没有 `nextTurnId` 才是终点。`seq` 让重连可幂等去重（老客户端忽略未知字段，`end` 仍是终止信号，不会被误导）。

### 4.3 服务端改造骨架

把现在的 `produce()` 从「一轮」改成「一条链里的若干轮」，每轮只负责产出正文与收尾：

```python
async def produce_one(chain, message) -> tuple[str, dict | None]:
    """跑一轮：begin → stream → finish。返回 (status, error)。"""
    saved = await asyncio.to_thread(conversations.update, project_id, session,
                                   begin={**message, 'status': 'complete'},
                                   conversation_id=chain.conversation_id)
    chain.events.put({'type': 'start', 'turnId': str(message['id']), 'conversation': saved})
    ...  # 与现有 produce() 的上下文构造、runtimes.stream、finish 落盘一致
    return status, error

async def run_chain(chain):
    while True:
        message = await asyncio.to_thread(take_next_queued, project_id, chain.conversation_id)
        if message is None:
            chain.events.put({'type': 'end', 'nextTurnId': None, 'conversation': last, 'error': last_error})
            return
        status, error = await produce_one(chain, message)
        nxt = await asyncio.to_thread(peek_next_queued, project_id, chain.conversation_id)
        if status == 'complete' and nxt is not None:
            chain.events.put({'type': 'end', 'turnId': ..., 'nextTurnId': str(nxt['id']), 'conversation': ..., 'error': None})
            continue                      # 同一条流继续，不释放 chain
        if status != 'complete' and nxt is not None:
            # 出错不自动续跑：留队，等用户点「继续」
            chain.events.put({'type': 'end', 'nextTurnId': None, 'conversation': ..., 'error': error})
            return
        chain.events.put({'type': 'end', 'nextTurnId': None, 'conversation': ..., 'error': error})
        return
```

要点：

- `take_next_queued` 与 `begin` 在同一把 `admission` 锁内完成，避免「取到队首但另一个请求也取到」。
- 队列里的消息 `begin` 时状态从 `queued` 改为 `complete`（表示已执行），助手占位仍按现有逻辑插入；如果客户端在这中间撤回，`take_next_queued` 要先校验 `status == 'queued'`。
- `nextTurnId` 必须在 `end` 之前确定（`peek_next_queued`），否则客户端会先关流再重连，出现可见的断档。
- 链的 `finally` 才 `chains.pop(project_id)`，并释放 `admission`。

### 4.4 前端改造

`src/canvas/useAssistantChat.ts`：

- `send()` 拆成两条路径：空闲 → 现有 `follow()`；`sending` 为真 → `POST /messages` 拿 202，把返回的排队消息与 `queueSeq` 落进 `messages`，清空草稿与素材/技能选择（与正常发送一致），并显示一条「已排队」的轻提示。同一个 `submitting.current` 仍用于防连击，但不再因为「正在运行」而整段 return。
- `follow()` 的循环在 `end` 处判断：`nextTurnId` 存在则更新 `turnId.current` 继续读同一流（不清 `sending`、不重读对话），否则按现在的方式收尾。
- 新增 `retractQueued(id)` 调 `DELETE`；`continueQueue()` 调 `queue/dispatch`。
- 断线重连走 `GET /chains/{chainId}/events?after=<最后 seq>`；`resume()` 保留现有「读对话 + 附加运行轮」的兜底。

`src/canvas/AssistantPanel.tsx`：

- 运行中**同时**保留停止按钮与发送按钮，发送按钮文案为「排队」，`title` 说明「本轮结束后自动发送」；草稿非空即可点，不再依赖 `canSend`。
- 排队消息在对话中渲染为带「等待执行 · 第 N 位」标记的用户气泡，右侧给「撤回」；`cancelled` 渲染为带「已取消」标记并提供「重新发送」。
- 输入框下方一行状态提示（运行中才出现）：`当前回复仍在执行，这条消息会在结束后自动发送`。
- 选择器保持运行中禁用（P0 不改），排队消息的 runtime/模型在排入时快照。

`src/backend/chat.ts`：`ChatMessage.status` 增加 `queued`/`cancelled`，`ChatEvent` 增加 `queued` 类型与 `seq`、`nextTurnId`、`turnId` 字段；新增 `queueMessage` / `retractQueued` / `dispatchQueue` / `attachChain` 四个薄封装。

i18n 新增键（中英同时交付，`pnpm check:i18n` 校验）：`assistant.panel.queue`、`assistant.panel.queueHint`、`assistant.message.queued`、`assistant.message.cancelled`、`assistant.queue.retract`、`assistant.queue.resend`、`assistant.queue.continue`。

### 4.5 停止、失败、重启

- **停止**默认作用于整条链：取消当前轮，把剩余 `queued` 改为 `cancelled`，`end` 不带 `nextTurnId`。理由：点停止时的心理预期是「都停下」，悄悄继续跑下一轮会让用户失去控制感。需要只停当前轮的人可以用 `scope=turn`，此时链在停止落盘后继续。
- **失败**不自动续跑：保留队列、`end` 收尾、界面给「继续执行排队消息」。自动重试会把一次配置错误放大成三连失败。
- **重启**：`chains` 是进程内状态，重启即消失；`queued` 消息留在 `conversation.json` 里，`GET ''` 时随对话返回，界面给「继续执行」。这与现在 `streaming` 占位被标成 `interrupted` 的处理一致，不做自动重放。
- **撤回 vs 已执行**：一旦 `take_next_queued` 取走并 `begin`，撤回返回 409（`这条消息已开始执行，不能撤回。`），避免「界面显示已撤回、实际已经跑了」。

### 4.6 与 #375（停止后编辑重发）的关系

#375 处理的是「停下之后改那条消息再发」；本方案处理「不停下也能补一句」。两者共用同一份消息状态与队列骨架：#375 可以把被停止的消息复位成可编辑，本方案把排队消息做成可撤回/可重发。实现顺序建议本方案先行，因为队列是 #375「重发」的落点。

## 5. P1：同轮注入（按 runtime 能力开放）

P1 不改变 P0 的排队语义，只是在能力允许时提供「并入本轮」。是否显示由 runtime 声明决定，不由前端猜。

| Runtime | 候选通道 | 现状判断 | 必须先证明的事 |
| --- | --- | --- | --- |
| Claude Code | `-p` 增加 `--input-format stream-json`，保持 stdin 打开，按 JSONL 写入 `{"type":"user","message":{...}}` | 最有可能，改动局限在 `native.py` 的命令构造与 stdin 写入 | 当前 claude 版本在该模式下仍是多轮输入；`--plugin-dir`、`--allowedTools`、`--permission-mode dontAsk` 与该模式不冲突；追加消息不会打断正在进行的工具调用 |
| JiuwenSwarm | 已有的 JSONL stdin 常开 | 取决于它的进程协议是否接受运行中的用户帧 | 读协议或实测；不接受就保持排队 |
| Codex | `codex exec` 单次；`codex app-server` 的 JSON-RPC 有 thread/turn 概念 | 需要换执行方式，风险高 | app-server 是否有「运行中追加」的公开方法；换启动方式对现有权限沙箱与事件映射的影响 |
| Default / OpenCode | `opencode run` 单次；`opencode serve` 有 HTTP 会话接口 | 需要换执行方式，且 bundled 版本被固定 | 该版本是否有「运行中投递」接口；升级 bundled OpenCode 的成本 |
| DeepSeek Harness | ACP `session/prompt` 单次 | 当前无 steer 方法 | 是否可经 ACP 扩展或上游支持；在此之前明确标为仅排队 |

落地方式：`RuntimeSpec` 增加 `supportsSteering: bool = False`（`packages/core/src/opendirector/agent/runtime.py:18-31`），经 `runtime_catalog()` 出现在 `GET /assistant/runtimes`；前端据此决定是否显示「并入本轮」。默认全为 `false`，**每开一个都要附一份实测记录**（命令、版本、会话 id、追加前后的输出片段），记录落在本文「实施记录」或对应 PR 描述里，不写「文档说支持」。

注入的实现位置固定在 `native.py`/`deepseek.py` 的进程会话层：`RunContext` 增加一个可选输入队列，适配器在 `stream()` 里并发读取它并写入 harness 的 stdin/HTTP 会话；成功注入时向事件流补一条 `{"type":"steered","text":...}`，失败则回退为排队并把原因写进 `end.error`。这样上层（API/前端）不需要知道 harness 差异。

## 6. 取舍清单

下面每项都给了建议。6.1 记录已按建议值落地的部分；其余项仍需要确认后再改。

### 6.1 已按建议默认值实现的部分

第 1、2、3、5 项在实现里用了建议值，改判时需要一起改后端：

- 第 1 项：本轮结束后自动开始下一条排队消息，不额外点按钮；只有队列「停着」（重启、上一轮失败）时才出现「继续执行」提示。
- 第 2 项：一条消息一轮，回复与消息一一对应，链上每轮一个 `end` 帧。
- 第 3 项：停止默认停整条链，排队消息标为 `cancelled` 并保留可读。
- 第 5 项：失败不自动重试，队列保留在 `queued`，由用户点「继续执行」开始。

第 4 项（运行中改模型）与第 6 项（P1 范围）仍按建议值保持未做：运行中 runtime/模型选择器依旧禁用，P1 需要先在有 CLI 的机器上实测。

1. **默认行为**：本轮结束后自动开始排队消息（建议）还是留一个「继续」按钮由用户点？
   自动更符合「插入」的直觉；显式更可控，尤其在长任务上。
2. **多条排队**：一条消息一轮（建议，回复与消息一一对应）还是连续多条合并成一轮（更省 token，但回复归属变模糊）？
3. **停止范围**：默认整条链停、排队消息标为已取消（建议）还是默认只停当前轮、队列继续？
4. **是否允许运行中改 runtime/模型**：P0 保持禁用（建议）还是允许排队消息另选模型？
   允许会带来「后半段用另一个模型」的混淆，收益不明显。
5. **失败后**：保留队列等用户点继续（建议）还是自动重试一次？
6. **P1 范围**：先只做 Claude Code 一条通道验证可行性（建议），通过后再评估 Codex/OpenCode 是否值得换执行方式。
7. **文档落点**：本文留在 `docs/development/`（建议，与 `reference-catalog-preload.md` 同级）还是合并进 `docs/architecture/agent-runtime.md` 的「运行生命周期」一节？
   建议先独立成文，稳定后把语义结论回填到架构文档。

## 7. 影响文件

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/opendirector_api/agent.py` | `/messages`、`/queue/dispatch`、`/chains/{id}/events`、stop 的 `scope`；`Chain` 取代 `active`；`Conversations` 增加排队读写与 `queued`/`cancelled` 状态；事件加 `seq`/`nextTurnId` |
| `packages/core/src/opendirector/agent/runtime.py` | `RuntimeSpec.supportsSteering`，进入 `runtime_catalog()` |
| `packages/core/src/opendirector/agent/native.py` | P1：Claude 的 `--input-format stream-json` 与 stdin 写入；其余 runtime 的注入入口 |
| `packages/core/src/opendirector/agent/context.py` | P1：`RunContext` 的追加输入队列 |
| `src/canvas/useAssistantChat.ts` | 运行中提交、排队状态、链内续读、撤回/继续 |
| `src/canvas/AssistantPanel.tsx` | 运行中保留发送、排队气泡、状态提示 |
| `src/backend/chat.ts` | 新事件与状态、四个请求封装 |
| `src/i18n/messages/{zh-CN,en-US}/assistant.ts` | 新增 7 个键，中英同交付 |
| `docs/README.md` | 登记本文（若保留在 `docs/development/`） |
| `tests/test_assistant_queue.py`、`tests/test_assistant_retract.py`（新增）、`tests/test_assistant_conversations.py`（扩展） | 队列、链、撤回的事件级测试 |

## 8. 验收与验证

后端（沿用 `tests/test_assistant_conversations.py` 的 fixture 与 `disconnect_turn` 手法，把「一轮不结束」变成稳定前提）：

- 运行中 `POST /messages` 返回 202，对话里出现 `queued` 消息，消息数 +1，`GET /turns/{当前}` 仍可续读。
- 当前轮结束后自动 `start` 下一轮，`end.nextTurnId` 指向它，队列消息恰好执行一次（消息数、turn 数、`agent-runs/` 目录数三者一致）。
- 同一 message id 重复提交只产生一条排队记录与一轮执行。
- 撤回在 `queued` 阶段成功，在已执行阶段 409；撤回后不会再有该轮的运行时调用。
- `scope=chain` 停止：当前轮 `stopped`，剩余消息 `cancelled`，不再自动起轮；`scope=turn`：队列继续。
- 失败一轮：队列保留、不自动续跑；`queue/dispatch` 能接着跑。
- 链内断线后 `GET /chains/{id}/events?after=N` 只补发 N 之后的事件，客户端不重复渲染。
- 重启后 `queued` 消息仍在，且不会被自动执行。

前端：`pnpm test`（node --test，覆盖 reducer 的排队/撤回/续读）、`pnpm check:i18n`、`pnpm build`（`tsc --noEmit`）；交互按 `docs/development/validation.md` 的要求给出实际截图或录屏证据（运行中排队、结束后自动续跑、撤回、停止）。

命令示例：

```bash
.venv/bin/python -m pytest tests/test_assistant_queue.py tests/test_assistant_retract.py tests/test_assistant_conversations.py -q
pnpm test && pnpm check:i18n && pnpm build
```

## 9. 风险与不做的事

- **长任务上排队会积压**：一轮可能跑很久，排队消息等的时间比用户预期长。缓解：气泡上显示当前轮仍在执行、允许随时撤回；不承诺「马上生效」。
- **自动续跑放大错误**：如果上一轮已经跑偏，下一轮会带着跑偏的结果继续。缓解：失败不自动续跑；运行中提示明确「下一轮才生效」，用户可在结束时撤回。
- **事件契约变化**：`end` 不再是绝对终点。用 `nextTurnId` 表达，老客户端忽略该字段即退化为原有行为；`seq` 同样是增量字段。
- **不做的事**：不并发跑两轮；不做多项目并行；不改写 harness 为双工协议；不支持编辑正在执行的 prompt；不在 P0 阶段自动重放重启前的队列。

## 10. 实施顺序

1. 后端链与队列（`Chain`、`/messages`、`/queue/dispatch`、事件 `seq`/`nextTurnId`）+ 测试，先不接前端。
2. 前端运行中提交与排队气泡、自动续读、撤回；补齐双语。
3. 停止/失败/重启三种异常的端到端验证与证据。
4. （P1）Claude Code 单通道注入实测，写实施记录；按结论决定是否继续其他 runtime。
