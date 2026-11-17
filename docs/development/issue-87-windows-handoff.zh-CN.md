# Issue #87 Windows 收尾执行指令

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

## 本次定点验收已完成（2026-11-09）

**最终 CI 后续：**首次证据交付 `3b1bcc21` 的CI仅在音色重开响应等待超时，其余门禁通过；
已完成有界导航/媒体期限分离及更强的重开身份、指纹和真实播放断言，正常、17秒冷启动与媒体缺失负例验证闭环。
浏览器测试冻结 `c19781ae22828c003d68457490591f9177aef3f0`，产品、Python、依赖及原生测试未变；原生154/0/0保留在下述d0d89993。
详见[CI修复及新冻结点](issue-87-validation.md#2026-11-09-最终-ci-的音色重开等待修复)。
最终证据提交、正常推送、新头CI及PR回执由同一执行者连续完成；不把首次失败写成成功，不重做其他Windows验收。


测试源码 `d0d89993ce60eed5989292db4cef734dfb1b190d`（main `63100975`）：七模块 **154 passed / 0 failed / 0 skipped**，
十一安装、十二清理原生窗口与真实 OpenCode fresh/resume/watchdog 全部执行，完整 ACL/owner、同字节 deny、资源释放及租约重获通过。
首轮 101/53/0 的主机协调目录 ACL 阻塞经用户授权、完整备份和精确收紧后消除；代码白名单、沙箱、测试和依赖未变。
独立只读复审完成，没有新增确认的产品缺陷。完整命令、原生矩阵、失败过程、输入哈希和边界见
[最终原生验收记录](issue-87-validation.md#2026-11-09-windows-七模块原生收尾d0d89993)。
本批仅提交证据和状态文档，提交/正常推送/最终 CI 由同一 Windows 执行者连续关账，最终 SHA 以 PR 交付回执为准。
不重做历史全量/浏览器/媒体/性能/wheel；保持其原 SHA。继续 Draft，等待维护者复审。

English: all seven focused Windows modules passed at the source above, with zero skips and no source/test/dependency changes.
The explicitly authorized host ACL restriction retained product security checks. The original instructions below are historical.

### 原定点交接（已完成，保留复核）

`83b341e6` 交付后的复审发现 main 新增 #210/#229 的三处冲突，以及 ACL **安装**成功后发生并发回写时，旧记录可能误删外部同字节拒绝规则。Mac 负责本批整合、修复和 CI；此前 Windows 已完成约定任务。本节替代下面的历史启动指令。

新合同：原生安装成功回执之后，若无法确认 guard 正常结束，停止初始化，不启动 Agent、不重试安装、不删除该对象上归属不明的 ACE；释放句柄/租约并报告 `InstallationUnconfirmedError`。数量相同不能证明归属未变。若 setter 包装层报错但 guard 的检查和释放均正常，保留原异常并正常回滚；写入前重试、既有清理成功回执后的确认机制也保留。

将下面内容发送到原 Windows Codex 对话：

```text
完成 PR #193 安装冲突修复的 Windows 定点验收。
项目：C:\Users\Qing Peng\OpenDirector
分支：codex/issue-87-timeline-text

保留本机工作并安全同步远端，记录完整源码 SHA；复用已有环境和真实 CLI 门禁。
阅读 AGENTS.md、适用安全规则、issue-87-validation.md 最新章节和本文件当前待办。
确认已整合 main 63100975，包含 InstallationUnconfirmedError 及新安装冲突原生测试。
设置 PYTHONPATH 指向本 checkout 的 packages/core/src 与 apps/api/src。
将 OPENDIRECTOR_ACL_EVIDENCE 设置为本轮证据目录内 JSONL 文件的绝对路径，保留原生逐项记录。
运行：
python -m pytest tests/test_owner_rights.py tests/test_owner_rights_journal.py tests/test_owner_rights_lifecycle.py tests/test_owner_rights_resume.py tests/test_native_runtime.py tests/test_native_sessions.py tests/test_directory_links.py -q -ra --tb=short --junitxml=<本轮证据目录>/native.xml

重点核对 test_installation_guard_failure_preserves_the_independent_writer_policy：
真实 writer 命中安装前最后检查后、成功回执后、最终检查后释放前等窗口；
旧 ACL 回放、相同数量替换、新增同字节 deny 均不得被后续清理误删。
记录原始 NtSetSecurityObject 状态、一次安装回执、完整 ACL/owner、body 未进入、
操作句柄/事件释放，以及 fixture 恢复已知策略后的租约重获。
安装后冲突必须明确失败；写入前冲突仍可重试；原十二项清理窗口回归继续通过。
同时核对 Codex 缺失 rollout 后完整历史恢复、验证后的原目录复用和其他引擎续聊。

发现失败先定点定位，必要修复在本批完成；不删断言、不扩大 skip、不关闭沙箱。
如果原生时序不成立，记录实际行为，不伪造通过。只重跑受影响检查。
不重跑整套字幕、MP4、1080p、2000 cue、完整 Python/Node；字幕/时间线渲染实现未改变。
历史 wheel/媒体证据保留原 SHA，不改标为本轮结果。

追加源码 SHA、命令/退出码、pass/skip、原生阶段和失败过程到验收记录，
更新本节状态和 PR 描述，提交证据/必要修复，保留 merge 历史并正常推送同一分支。
纯证据文档不重跑 Windows；跟踪最终头 CI。保持 Draft，不强推、不合并 PR、
不发送 reviewer/外部聊天消息。最后统一返回结果与剩余阻塞。
```

## 历史交接（已完成）

**上一轮交接已执行完成（2026-11-08）。** 最终源码冻结 `97edaf4e`（main `c54d78eb`），
原生窗口、main 整合、独立复审、Windows scoped checks、新 wheel 和 Linux 门禁已完成。
本文件下方启动指令保留作历史复核，不是新的重复验收待办；原版本结果不改标。
完整结果、最终交付回执和限制见[验收记录](issue-87-validation.md)及 PR 描述。保持 Draft，等待维护者复审。
English: this handoff is executed; retain its original instructions and revision boundaries for audit.

[English](issue-87-windows-handoff.md) · [完整分工与验收计划](issue-87-post-windows-plan.md)

**原交接时的背景：** `1799464f` 已完成上一轮约定的 Windows 补验，结果继续有效。本次剩余的是 ACL 最终检查/写入窗口、最新 main 整合和最终交付。发布本计划只改变文档，不改变该版本的产品代码，不触发重复功能验收。

Windows Codex 是剩余产品代码的唯一写入方，连续负责整合、原生验证/必要修复、冻结前独立复审、最终验收、证据、正常推送及 CI 问题处理。当前 Mac 会话负责任务准备与交付后的只读核对；Linux GitHub Actions 负责当前提交的跨平台门禁。

将下面内容发送到 Windows 原来的 Codex 对话：

```text
继续完成 OpenDirector Draft PR #193 的全部剩余工作。
项目：C:\Users\Qing Peng\OpenDirector
仓库/分支：Qing7364/OpenDirector，codex/issue-87-timeline-text

你是本批次唯一的产品代码写入方。复用现有环境，保留本机工作，安全同步远端；
阅读 AGENTS.md、适用安全规则、docs/development/issue-87-post-windows-plan.md
和 issue-87-validation.md 最新 Windows 记录。责任表、冻结规则和门槛是本次执行依据。

按 Task 2 → Task 1 → 源码冻结 → Task 3 → Task 4 连续执行：

1. 记录 PR/main 完整 SHA，将本次 main 合入现有 PR 分支，保留历史。
   按计划解决冲突，保留音色库与字幕两侧能力，重新生成依赖锁和契约，核对自动合并区域。
   将现有项目环境同步到合并后的 Python/npm 锁定依赖，记录实际版本，无需重装运行时。

2. 用真实 WinAPI writer 验证最后一次 before_write 返回后、原始 NtSetSecurityObject
   调用前的窗口。一次核对完整权限生命周期/并发矩阵及外部同字节 deny。
   原生复现则修复并证明有效；若内核不允许该时序，提供证据说明模拟假设为何不成立。
   Mac 反例只证明控制流；不得只增加检查次数、删除断言、扩大 skip 或放宽权限。

3. 完整验收前安排独立只读复审，集中处理确认的范围内缺陷；新假设先定点复现。
   之后提交源码冻结点，记录生产代码、测试、构建/CI 配置、依赖锁和打包资源哈希。
   正常推送冻结版本，让 Linux CI 与 Windows 最终检查并行。

4. 在稳定源码上集中完成完整 Python/Node、build、contracts、i18n、browser locale/manifest、
   四项 import 边界；保留已有真实 CLI 门禁并核对 skip。Windows 跑 timeline
   editing/render/archive 和独立 voice fixture。重建 Windows wheel，装进全新 venv，
   运行 pip check、verify_install.py --python <wheel-python>、受影响原生模块和
   timeline_text_installed.mjs，核对实际文件/帧、无源码导入和后台 PATH 无 Node。
   Linux CI 覆盖标准浏览器工作流/助手面板及完整门禁，由你跟踪到最终结论。

5. 确认失败在本批次内定位、修复，按影响范围复验；共享基础或依赖改变才扩大范围。
   代码变动记录新冻结点；纯状态/验收文档变化不重跑 Windows 功能测试。
   保留历史 1080p/2000 cue 证据，除非实际相关改动要求更新。

6. 更新验收记录、旧计划/handoff 状态和 PR 描述；区分源码冻结 SHA 与最终证据提交 SHA，
   证明相关运行输入未变。推送前同步 configured upstream 并保留 merge 历史，正常推送
   同一分支。保持 Draft，不强推、不合并 PR、不自行发送 reviewer/外部聊天消息。

正常步骤之间不需要再让我逐项确认。真实凭证/权限缺失、超出范围的产品取舍或原生证据
仍无法判定时，明确报告阻塞和所缺条件；不要通过反复全量测试掩盖不确定性。

最后统一返回：main 基线、源码冻结 SHA、最终 SHA/输入一致性、ACL 结论与原生证据、
逐项检查/失败/skip、wheel 哈希、CI 链接和结论、PR 状态及剩余阻塞。
```

安装验证的 `--python` 参数不能省略。将 `OPENDIRECTOR_INSTALLED_PYTHON` 设置为新 wheel venv 的 Python 绝对路径，沿用已有 Playwright/Chrome 配置：

```powershell
& $env:PYTHON scripts/verify_install.py --python $env:OPENDIRECTOR_INSTALLED_PYTHON
node tests/browser/timeline_text_installed.mjs
```

本批次不需要 SSH/远控配置、付费模型或系统安全策略修改。
