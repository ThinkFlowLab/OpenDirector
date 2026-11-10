# PR #193 Windows 补验后审查与后续计划

## 当前Windows验收已完成：阻断冲突整合与0.1.2补验（2026-11-09）

源码冻结 `a71d3b1e179385ee6a50ee320fd02c8a0921816f`，固定 main `e0b411f151dfe48250c4651c0d820e05179f41ce`。
源码七模块 **154 passed / 0 failed / 0 skipped**，422.54秒；最新0.1.2 wheel相关 **308 passed / 0 failed / 0 skipped**。
11安装、12清理原生窗口和真实CLI均执行，权限/沙箱校验保留。源码CI [Release checks](https://github.com/ThinkFlowLab/OpenDirector/actions/runs/42735681008) **SUCCESS（1578 Python通过/98跳过，744 Node，19/19标准浏览器，wheel、音色与助手检查均通过）**。
886项Windows运行输入SHA-256 `36ec56252d87ada89d1de6feac19830ac77cfd77e9e232906e44d67a74926fb0`；本次四份纯证据文档不属于运行输入，不因其提交再跑Windows。

本批仅因5d5895fd实际不可合并而整合上述固定main；保留两侧字幕/音色、原生安全和merge历史。
默认模型时序修复有中英正例/旧前端负例，音色生产预览及最新wheel中英通过；最终Node744、相关后端337、build/契约/双语/边界均通过。
最新wheel SHA-256 `8ae498f7748edbcbdb46a9945fbaf14f7934e11d858d751e3fcfb6791736007c`。首次原生153/1/0、隔离通过与最终154/0/0均保留；不扩大60秒watchdog。
文件symlink新探针仍1314，真实模型调用和历史媒体/性能结论不扩大。
完整命令、输入、证据、skip及复审见[最新验收记录](issue-87-validation.md#2026-11-09-阻断冲突整合后的最终-windows-交付a71d3b1e)。
正常签名/推送及最终头CI由同一执行者关账，交付SHA见PR回执；继续Draft，保留CHANGES_REQUESTED。
以下d0/c197记录是历史阶段，不是重新打开的待办；其“仅文档变化”不适用于本节的实际阻断冲突整合。

## 2026-11-09 后续项完成状态

**最终CI收尾补充：**`3b1bcc21`首次交付CI仅音色重开等待失败；已定点复现有界冷启动期限问题，
完成浏览器测试修复、强身份/指纹/重开播放断言及正常/冷启动/媒体缺失负例，冻结 `c19781ae22828c003d68457490591f9177aef3f0`。
独立只读复审通过。产品与原生输入未变；原生154/0/0仍标d0d89993，不重复其他Windows套件或wheel。
[失败过程和新输入清单](issue-87-validation.md#2026-11-09-最终-ci-的音色重开等待修复)保留原始边界；
同一执行者继续签名证据、同步upstream、正常推送、最终CI与PR回执，不留为用户下一轮正常步骤。


最新用户安排由 Windows 执行者独立负责本批收尾。固定源码 `d0d89993ce60eed5989292db4cef734dfb1b190d`
已整合 main `63100975`，此前 autosave 修复与 Linux CI 结果保留原边界。本次七模块 **154 passed / 0 failed / 0 skipped**，
11 安装与 12 清理 WinAPI 矩阵、真实 CLI、会话恢复及独立只读复审完成。主机协调目录 ACL 前置阻塞经用户授权
备份/精确收紧解决；生产代码、测试、锁和打包输入未变，未新增 Windows 全量/媒体/wheel 验收任务。
[最终原生记录](issue-87-validation.md#2026-11-09-windows-七模块原生收尾d0d89993)列出失败、修复过程、输入和命令。
本批文档提交、正常推送、最终头 CI 及 PR 描述由同一执行者连续完成，以最终 PR 交付回执关账，不留为新的用户待办。
继续保持 Draft；维护者 review 状态不由本批撤销。
English: the focused native assignment is complete; documentation-only delivery retains the tested source inputs.
The original allocation below is historical and does not supersede the latest user ownership instruction.

### 原交付后续项（已完成，保留分工历史）

`83b341e6` 已完成上一轮交接。随后 main 的 #210/#229 带来三处真实冲突；复审另确认 ACL 安装重试的旧记录在外部回写后可能误删拒绝规则。用户要求继续处理，当前 Mac 会话负责本批代码与 CI，Windows 仅负责[安装冲突定点验收](issue-87-windows-handoff.zh-CN.md#本次定点验收已完成2026-11-09)。下面 2026-11-08 的完成状态与责任表属于原批次。

1. 整合固定 main `63100975`，保留会话目录验证与缺失 rollout 恢复；同时保留两侧 localization 和 lessons。
2. 先复现再修复安装回执后的归属不确定性：明确停止初始化，保留外部 ACL，不靠 ACE 数量推断归属；保留写入前重试及既有清理合同。
3. 对本批差异独立复审；运行相关后端/原生控制流、Node、契约、i18n、边界、build，正常推送并处理 Linux CI。
4. 处理 `3cb30b64` CI 暴露的浏览器发布重试：保留真实过期自动保存回调复现版本回滚，修复编辑事务前的自动保存失效，并隔离、清理投影测试钩子。由 Mac 完成回归和 CI，不增加 Windows 媒体验收。
5. Windows 运行 handoff 指定七个模块，记录新安装矩阵与既有清理、续聊结果；不重做未变媒体和性能验收。旧 wheel 不冒充新源码结果。

English: the previous Windows assignment is complete. This follow-up integrates main 63100975 and rejects uncertain post-ack ACL installations. Mac owns implementation/CI; Windows owns only the focused seven-module native handoff. Historical evidence retains its original revision. Mac also owns the CI-discovered stale-autosave regression and the projection-test cleanup; this adds no Windows media rerun.

## 上一批执行状态

**执行状态（2026-11-08，Windows）：Task 2、Task 1、独立复审及最终源码验收已完成。**
最终源码冻结 `97edaf4e0b932cb1085d6d5dcb8b7c59def98749`，main 基线 `c54d78eb`；ACL 两个最终窗口的真实反例已修复，
CI 额外暴露的异步 projection 竞态已定点修复并复审。最终 Windows/wheel 与 Linux 门禁及准确版本边界见
[验收记录](issue-87-validation.md#2026-11-08-windows-最终整合与原生窗口验收97edaf4e)。
本页的 Task 4 复选框记录**证据文档形成时**的状态；PR 描述、最终证据提交 SHA、正常推送和最终头 CI
随后由本执行者完成，并以 PR 最终交付回执及最终回复关账，避免在提交内容中虚构自身 SHA。保持 Draft。
English status: the source work and scoped acceptance are complete at 97edaf4e; delivery evidence,
normal push and final-head CI are tracked by this same Windows executor. Historical evidence remains revision-bound.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to execute the tasks. 用户已要求完整分配剩余工作并提供执行指令。按下述责任表连续执行；发布本计划不代表产品修复或验收已完成。

**Goal:** 处理 Windows 补验后剩余的 ACL 并发边界和主分支冲突，使同一个最终版本具备可复核的代码、平台和 CI 证据。

**Architecture:** 沿用共享工程命令、既有 Windows 权限边界和测试宿主。先整合主分支音色库与依赖更新，再在统一代码上验证最后一次 guard 检查与原生写入之间的边界；不以重复检查次数代替原子性或明确的冲突语义。

**Tech Stack:** Python/WinAPI、TypeScript/React、pytest、Node、真实隔离 Chromium、平台 wheel。

**Spec:** [Issue #87](https://github.com/ThinkFlowLab/OpenDirector/issues/87)、[既有修复计划](issue-87-final-review-plan.md)、[验收记录](issue-87-validation.md)、[Windows 补验指令](issue-87-windows-handoff.zh-CN.md)。

English summary: Windows evidence covers the requested follow-up, but review reproduced a residual ACL check/write control-flow window. Native scheduling needs a targeted Windows regression. Seven conflicts with newer main also prevent PR CI. Resolve these before final integration validation; retain historical evidence with its original revision.

Execution ownership: Windows Codex is the sole remaining product-code writer and owns integration, native diagnosis/repair, pre-freeze review, final validation and delivery. This Mac chat prepares the handoff and performs a read-only final audit; Linux CI runs against the delivered revision. Freeze relevant source/test/build/dependency inputs before broad acceptance. Pure status/evidence document changes do not invalidate unchanged runtime evidence.

## 审查时的基线与结论

- 本轮审查的产品代码头：`1799464f1d6ba5f721521c474c4dd96c3a254ed7`；相对 `d5c6b3a1d4aa249f034a8d7e79be67c99bc59b4c` 仅新增 5 个文件的改动，其中生产代码只改 `agent/owner_rights.py`。发布本计划的文档提交会改变 PR 头，但不改变这份代码证据。
- 最新获取的 main：`c54d78eb5314d7068b6bf465dbbb2cf199ab1df9`，共同祖先 `2f35c78ee3b4d7ba389bf62686762b5c849c0062`；新增 #218 音色库与 #232 benchmark 门禁两个提交。
- Windows 报告覆盖全部既定补验：ACL **77 passed / 0 skipped**，相关模块 **184 passed / 3 skipped**，完整 Python **1378 passed / 17 skipped**，Node **721 passed**，新 wheel 相关模块 **195 passed / 3 skipped**，源码 editing/render 和 installed 浏览器通过。
- Windows 的源码冻结清单、wheel 哈希、安装内容审计、失败过程、skip 原因和真实媒体结果有记录。原始 ignored 日志不在本 Mac checkout；这是对已提交证据的审计，不冒充独立 Windows 重跑。
- 本机独立执行四个 ACL 模块：**25 passed / 52 Windows skips**。现有回归均通过，但下述额外控制流反例仍存在。
- 审查时 GitHub 为 Draft、CONFLICTING / DIRTY、CHANGES_REQUESTED；该源码头没有 check runs。`git merge-tree --write-tree origin/main HEAD` 确认 **7 个**冲突路径。GitHub 的 `pull_request` 工作流不会在合并冲突时运行，见[官方说明](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#triggering-event-conditions)。

## 发现与证据边界

### P2：最后一次 guard 检查与原生写入仍是两个操作

`packages/core/src/opendirector/agent/owner_rights.py:192–193` 先调用 `before_write()`，再执行
`NtSetSecurityObject`。若单个外部 writer 在这两步之间打破 guard，并排队提交先前读取的 ACL，
本次原生写入仍可能成功。`on_write` 立即消费清理 delta；随后 post-write 检查重试时 delta 已空，
外部 writer 回放的临时 owner READ ACE 可以留下，而 `close()` 正常返回。

独立反例调用真实 `_Windows.set_acl`、`_Projection.edit` 和 `close`，只控制 WinAPI 与 guard
调度边界：描述符准备阶段冲突时残留 **0** 条；最后检查后冲突时残留 **1** 条；两者均保留
外部 deny。根审查独立复跑得到相同结果。它证明控制流缺口，不是本机实际 WinAPI 调度或沙箱
逃逸证明。先前 Windows 记录已确认“失效 guard 下原生写入仍成功”的准备阶段场景；新增的更窄
窗口必须在 Windows 定点验证。[MS-FSA 的 oplock 算法](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/306239fb-cb60-49fe-b293-df4d1a5f757a)
是调度语义的参考，不能代替运行证据。

### 合并阻塞与状态过期

7 个冲突路径见 Task 2。PR 描述仍把 `d5c6b3a1` 作为当前版本并将已完成的三项 Windows 补验列为
待办。旧计划和 handoff 也缺少最新完成/替代说明。应保留历史结果，补当前状态，不改写旧测试事实。

## Global Constraints

- 保留已有提交、用户改动、同一 PR 分支和 Draft 状态；不强推、不直接合并 PR，不自行发送 reviewer/聊天消息。
- Windows 补验通过不等于任意并发时序都正确；控制流模拟通过也不等于 WinAPI 已验收。
- 不取消原生成功回执，不简单恢复所有已消费 delta；否则会重新引入删除外部同字节 deny 的旧缺陷。
- 锁、版本、共享 UI/Agent 命令、依赖保护、保存续编及旧成片来源均必须保留；中英文内容同步。
- 不为通过而删断言、扩大 skip/xfail 或放宽权限；不引入后台渲染、付费模型、远控配置或新交换格式。
- 每个最终结果标明准确源码版本。原 `733001a2` 的七组/1080p/性能及 `1799464f` 的 Windows 补验保留原范围。

## 责任分配与交接合同

| 执行方 | 负责范围 | 完成输出 |
| --- | --- | --- |
| 当前 Mac 会话 | 整理已审查证据、冲突处理方案、完整任务和双语启动指令，发布文档 | Windows 可直接取得的本计划与 handoff；本轮不再交替修改产品代码 |
| Windows Codex 主执行者 | Task 2 → Task 1 → 冻结前复审 → Task 3 → Task 4；同一分支全部剩余代码、必要修复、证据、正常推送、CI 失败处理 | 稳定源码版本、完整交付记录、当前 CI 和剩余事项；无需等待 Mac 再给一轮测试指令 |
| Windows 上的独立审查者 | 冻结前只读检查本轮全部差异及 ACL 时序矩阵，核对测试是否命中真实阶段 | 一次收敛的发现清单和逐项处置；有证据的必要缺陷在最终验收前处理 |
| Linux GitHub Actions | 当前交付版本的跨平台测试、契约/build、wheel 和浏览器门禁 | 当前提交的 Release checks 结论，由 Windows 主执行者跟踪并处理可归因失败 |
| 当前 Mac 会话（交付后） | 只读核对最终差异、证据覆盖、来源版本、CI 和 PR 状态 | 区分已确认缺陷、缺失证据、新假设；新假设先定点复现，不自动重开整套 Windows 验收 |
| 用户 | 将启动指令发送到原 Windows Codex 对话；必要时处理真实凭证/权限或产品取舍阻塞 | 不需要手工串联各组测试或在两台机器间反复分派补丁 |

主执行者可以并行派只读审查/证据核对，但只由一个执行者写共享代码、Git index 和分支。
开始执行时记录 PR 与 main 的完整 SHA，并将当时的 main 合入；冻结后不因 main 普通前进而无限追赶。
只有出现真实冲突、明确的合并门禁要求或相关缺陷，才重新整合并标明受影响范围。

### 冻结与复验规则

1. 开发阶段只运行能回答具体问题的回归。先完成合并、原生问题处置和独立复审，再开始完整验收。
2. 冻结点记录 Git SHA、生产代码/测试/构建配置/依赖锁/CI 配置与打包资源的文件清单和哈希；技能、契约、字体等运行时资源也属于输入。只排除不参与构建和运行的状态/验收文档及生成证据。
3. 冻结源码提交可先正常推送，使 Linux CI 与 Windows 最终检查并行。追加证据提交时，验证上述输入未变，并在最终头记录其对应的源码冻结点；不使用尚不存在的自身 SHA。
4. 新假设先做定点反例，记录是否真实可达和影响。确认问题需要改代码时，记录新冻结点，重跑受影响回归；共享规则/权限基础或依赖变化才扩大检查范围。不得隐去先前失败来维持“一次通过”。
5. 仅修改不参与运行的 PR 说明、计划状态或验收文档时，不重跑 Windows 功能/性能验收；GitHub 自动触发的 CI 仍由执行者核对。
6. 收尾前没有已确认且未处理的范围内缺陷，冻结输入对应的最终检查通过，原生疑点已用证据解决。无法确认时明确报告阻塞及所缺条件，不循环补全量测试。

## Review Focus

1. 单个 writer 恰在最终检查后到达：不能静默报告清理成功并留下本次临时授权（Task 1）。
2. 外部同字节 deny 与真实成功回执：不得因修复新窗口而重复扣除权限（Task 1）。
3. 音色连接身份和字幕/字体依赖并存：投影、保存重开和归档不能丢任一字段（Task 2/3）。
4. 合并后的依赖和生成契约：不能丢失 Pydantic 下限、fonttools 或 main 新依赖/错误码（Task 2/3）。
5. 旧 wheel、旧 CI 或普通 creation fixture：不能冒充最终版本安装验证或独立 voice fixture（Task 3）。

## Tasks

### Task 1：原生确认并处理 ACL 最终写入窗口

**Files:** `packages/core/src/opendirector/agent/owner_rights.py`、必要时 `agent/windows_acl_guard.py`；`tests/test_owner_rights_journal.py`、`tests/test_owner_rights_lifecycle.py`、验收记录。

**Interfaces:** 保留 `_Windows.set_acl(..., before_write, on_write)` 的原生成功事实；`_Projection.close()` 必须区分已确认完成和无法确认完成。输出为原生反例结果、修复或有证据的否定结论及回归。

- [x] 将额外反例加入正式测试，命名明确覆盖 `after_final_check`；保留准备阶段、成功写后冲突、setter 异常和外部同字节 deny 的全部既有断言。
- [x] 在 Windows 使用真实独立 writer，在 `before_write` 返回后、调用原始 `NtSetSecurityObject` 前定点启动。确认 writer 真正打破 oplock 且等待释放，记录原生成功回执、最终完整 ACL、owner、外部 deny、线程/句柄释放和租约重获。
- [x] 先运行新用例，保存失败或内核拒绝该时序的原始证据。若原生不允许该时序，解释模拟中不成立的假设，更新审查结论；不得仅以概率低或旧测试通过关闭问题。
- [x] 若原生复现，调整提交/冲突/清理状态语义：只有可确认结果才报告完成；无法安全归属的并发变化明确失败并保留诊断，不能静默变成空操作成功。具体回滚策略依据原生结果确定，不再靠增加一次 pre-check 宣称原子性。
- [x] 一次核对完整时序矩阵：未写入/准备阶段冲突、最后检查后原生调用前冲突、成功回执后冲突/异常、外部旧 ACL 回放、正常清理/初始化失败/取消/续聊。每个场景标明实际写入、回执、最终 ACL 和外部同字节 deny 的身份；不以函数名或检查次数代替阶段证据。
- [x] 在 Windows 运行 `python -m pytest tests/test_owner_rights.py tests/test_owner_rights_journal.py tests/test_owner_rights_lifecycle.py tests/test_owner_rights_resume.py -q -ra`。新反例按合同通过，原外部 deny、失败初始化、取消/续聊和权限保护回归不退化。确定性用例同时由 Linux CI 覆盖并明确跳过原生项；不依赖 Mac 另行执行才能继续本批次。
- [x] 将 Task 1 与 Task 2 的全部最终差异交独立审查者，一次核对上述矩阵和整合边界，处理确认的问题并定点复核；之后提交源码冻结点。若需要改变既有成功/失败合同，必须明确解释，不伪装成测试修补。审查中仍有明确新证据时不能为限制轮数而忽略。

### Task 2：整合最新 main，保留两侧完整功能

**Files and decisions:**

| 冲突文件 | 明确处理 |
| --- | --- |
| `docs/guides/cli.md` | 保留音色库、时间线包及 POSIX 导出失败说明的双语章节 |
| `packages/core/src/opendirector/agent/tools.py` | 同时保留 voice 与 timeline package schema/dispatch、VoiceLibrary 初始化和执行目录/session 范围 |
| `pyproject.toml` | 保留 `pydantic>=2.12,<3`、`fonttools==4.68.0`，纳入 main 的 `starlette>=1.8,<2`、`python-multipart>=0.0.33,<1` |
| `requirements.txt` | 从合并后 pyproject 重新生成，审核 transitive diff，避免无关升级 |
| `src/canvas/model.ts` | 同时保留 VoiceSelection、AssetRef/TimelineTextOverlay imports 与对应字段 |
| `src/contracts/generated.ts` | 从合并后后端契约生成，不能任选一侧或手改 union |
| `tests/test_cli.py` | 保留 VoiceLibrary/ProjectError imports、音色分页上传与字体错误码/英文诊断回归 |

**Interfaces:** 同一个工程能表达音色 connection/selection 与 timeline fonts/overlays/sourceAsset；生成文件来自合并后的后端。输出为可合并、通过契约检查的整合提交。

- [x] Windows 主执行者先 fetch PR 与 main，核对并保留本机改动；使用当前合适 checkout，将本次记录的 main 合入 PR 分支并保留已发布历史。以上七个路径是当前清单，执行时按实际新增冲突更新，不直接选择整侧。
- [x] 按表解决冲突；同时检查自动合并的 projection/dataBoundary、CLI、routes/localization、creation commands/schema、browser manifest 和 Release checks，保留 #232 缺失必要 measurement 时失败的语义。
- [x] 执行 `uv pip compile pyproject.toml --extra test --universal --output-file requirements.txt`；保留兼容锁定值，逐项解释必要变化。
- [x] 先同步生成器依赖，再生成契约：从新 requirements 创建只移除精确 `-e .` 条目的临时依赖文件，使用当前项目 Python 执行 `python -m pip install -r <临时依赖文件>`，保持其他锁定值/平台条件不变。显式设置当前源码 PYTHONPATH，执行 `python scripts/generate_contracts.py` 后 `--check`，核对 schema、generated.ts、ruleFacts.generated.ts。临时文件不替代或提交为正式锁文件。
- [x] 生成文件冲突解除后，执行 `python -m pip install -r requirements.txt` 和 `python -m pip check`，将 editable 安装指向当前 checkout。项目 build_backend 会执行 `npm ci` 与 production build；不能在 generated.ts 仍有冲突时提前触发完整安装。复用现有 Python/Node 运行时，记录实际解析版本和源码导入路径。
- [x] 聚焦执行 CLI、Agent voice、voice library、MOSS、daily benchmark、timeline text/fonts/packages 及 creation 契约/归档/参数测试；类型检查同时保留双方字段。
- [x] `git diff --name-only --diff-filter=U` 为空，`git diff --check` 通过；提交整合结果。main 已有但非本次整合新增的问题单独记录，不扩展为无关整改。

### Task 3：对最终源码做一次一致的交付验证

**Files:** 验收记录及必要回归；沿用 `scripts/verify_install.py`、browser manifest/fixtures、现有测试。

**Interfaces:** 消费 Task 1/2 的最终源码，输出准确版本、命令、退出码、skip、wheel 哈希和 CI 结论。

- [x] Windows 在冻结源码上集中运行一次完整 Python/Node、production build、四项 import 边界、contracts `--check`、i18n、browser locale/manifest；源码 PYTHONPATH 指向当前 checkout，保留既有真实 CLI 门禁并列明 skip 原因。Linux 标准套件由当前提交的 CI 覆盖。
- [x] Windows 运行 timeline editing/render/archive；额外使用 `voice_library_server.py` 与其 health route 执行 voice library fixture，不能用普通 creation fixture 替代。核对保存对象、连接身份、跨工程包和真实 MP4。标准浏览器工作流及助手面板同时由 Linux CI 验证。
- [x] 最终 Windows 复验集中执行 Task 1 ACL 用例、受影响 native/host 回归、上述时间线浏览器与 voice fixture；复用已有环境。依赖和打包内容改变后重建 wheel，装进全新 venv，执行 `pip check`、`verify_install.py --python <wheel-python>` 与 installed 浏览器，确认无源码导入和后台 Node PATH。
- [x] 若解决冲突或 ACL 修复影响更广的宿主/资源边界，扩大对应测试；否则不机械重跑历史七组、1080p 或 2,000 cue 性能。可在同一最终 Windows 源码批次完成原生和包验证，减少中间版本反复验收。
- [x] 正常推送同一 PR，推送前按既有仓库规则同步 configured upstream 并保留 merge 历史，禁止为绕过冲突强推。确认冲突解除且新头的 Release checks 全绿；CI 可归因失败由 Windows 主执行者继续处理，按冻结规则复验，不交回用户逐项调度。保留失败与修复过程，不能引用 d5c6 的旧绿灯代替。

### Task 4：同步交付状态，准备维护者复审

**Files:** 本计划、final-review-plan、原 feature plan、双语 Windows handoff、验收记录及 PR 描述。

**Interfaces:** 消费最终检查结果，输出可准确审阅的 PR 状态和剩余事项清单。

- [x] 将 Windows 已完成项与新发现的 ACL 边界项分开，标明 `1799464f` 已完成的范围；旧计划添加替代说明，保留历史事实。关闭确已交付的计划步骤。
- [ ] PR 描述更新到最终头，附当前 CI、原生/wheel 结果、限制和 Issue #87 五项验收映射。
- [x] 准备对原 reviewer 各项建议的处理说明；发送评论或请求复审前遵守既有对外消息授权边界。当前 CHANGES_REQUESTED 需维护者重新审阅，不能自行当作批准。
- [ ] 输出一次完整交接：源码冻结 SHA、最终交付 SHA 及文件一致性、main 基线、ACL 结论/真实回归、逐项检查与 skip、wheel 哈希、CI URL/结论、剩余阻塞。Mac 最终核对只读进行。ACL 结论明确、无真实合并冲突、当前 CI 通过、最终平台证据和状态一致后，才建议转为 Ready；继续保持 Draft，本计划不授权合并 PR。

## 执行顺序与停止条件

Windows 在同一个工作批次按 **Task 2 整合 → Task 1 原生处置与独立复审 → 源码冻结 → Task 3 最终验证 → Task 4 交付** 连续执行；Mac 在此期间不并行推送产品代码。正常步骤之间无需再次向用户索取确认。
若原生证据仍不能判定 ACL 窗口，就保持 Draft 并明确该项待确认；不反复增加检查次数或重复整套媒体测试来代替确认。
