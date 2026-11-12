# 开发验证指南

本文件维护可复现的检查入口和证据规则，不保存随版本失效的累计通过数量。启动说明见 [根目录 README](../../README.md)，交付门槛见 [发展路线](roadmap.md)。

## 环境与基本命令

在仓库根目录执行。Node.js 版本见 [`.nvmrc`](../../.nvmrc)，前端依赖见 [`package.json`](../../package.json)，Python 依赖见 [`requirements.txt`](../../requirements.txt)。使用自己的虚拟环境，不依赖其他开发者的绝对路径或相邻仓库。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[test]"
npm exec --no -- opencode --version

npm test
.venv/bin/python -m pytest tests -q
.venv/bin/lint-imports
npm run build
npm run check:i18n
.venv/bin/python scripts/generate_contracts.py --check
```

内置 Agent 安装验证必须实际执行上述 OpenCode 版本命令，不能只检查文件存在。不要跳过 `opencode-ai` 的安装脚本；若依赖安装不完整，在仓库根目录重新执行 `pip install -v -e .`；安装钩子会运行 npm 安装、前端构建和 OpenCode 版本校验。

`tests/test_native_runtime.py` 默认使用 CLI 和技能发现替身检查新会话、恢复会话及工程写入。真实 bundled OpenCode 集成测试需设置 `OPENDIRECTOR_REAL_CLI=1`；它使用模拟模型服务，不调用付费模型，在独立进程中限制运行时间，超时输出阶段和线程堆栈并终止跟踪到的 CLI 进程。Linux 上的故障注入还检查超时后进程已退出，其他平台的进程树清理需要相应平台验证。安装验证仍须运行上述版本命令。

Release checks runs these real CLI cases in a dedicated `Bundled OpenCode model gateway regression` step with `OPENDIRECTOR_REAL_CLI=1`. This uses local mock models and must verify final text, tool-result continuation, request counts, persisted assets and session resumption, not merely HTTP 200 or process startup. Gateway tests must also distinguish a properly terminated HTTP body from interrupted streaming and cancellation. Fresh Default `hello` cases exercise plain and reasoning streams through the actual bundled runtime, require exactly one provider request (including auxiliary calls), no native or business tool calls, and the complete reply on disk. The runtime tool surface remains enabled; model replies are simulated.

Windows 使用对应虚拟环境的 Python 路径。涉及真实媒体探测、工具处理或对应测试时，需要 PATH 中的 `ffmpeg` 和 `ffprobe`；视频处理使用 `libx264` 编码器，可通过 `ffmpeg -encoders` 检查是否包含它。不因纯文档修改而运行全部生成或媒体测试。

macOS 使用 README 中的 `python3.12` 环境准备命令，避免误用系统旧版 `python3`。安装验证需使用全新源码目录、新建 `.venv` 和 `pip install -e .`；构建由 pip 钩子执行，然后通过正式 `serve` 入口检查页面、上传、刷新与服务重启恢复。wheel 与 editable 的隔离验收见 [Python 安装与发布](packaging.md)。实测边界见 [macOS 安装验证记录](macos-install-validation.md)。

前端测试、Python 测试、契约生成检查和构建分别验证不同边界，任意一项不能替代其他相关检查。修改契约时同步更新自动生成文件，再执行一致性检查，不手工维护第二份契约。`scripts/generate_contracts.py` 同时写出 `src/contracts/ruleFacts.generated.ts`。共享的比例、时长、字节上限和菜单推导以 `packages/core/src/opendirector/domain/rule_facts.py` 为准。

Consult the [development lessons](lessons.md) when selecting relevant scenarios, and verify against the current code and tests. For model capability or parameter changes, trace representative input from the entry point through backend validation to the provider request, and check that rejected input does not create a job. For imports, references, navigation, or asynchronous tasks, inspect persisted identities and actual execution inputs after conversion or recovery.

## 按风险选择验证

| 修改范围 | 应核对的重点 |
| --- | --- |
| 业务规则、参考及上传 | 实际类型、字节预算、来源身份、跟随与固定、拒绝后状态不变 |
| 中英界面与后端错误 | 中英文键集合一致、`check:i18n` 通过、切换语言无需刷新、英文界面无中文且中文界面无硬编码英文、新增后端错误与目录项双语、`document.documentElement.lang` 随语言变化 |
| 存储与版本 | 幂等、对象冲突、写入中断、重启恢复、回执与事件一致 |
| 生成与工具任务 | 接受、排队、取消、未知提交、恢复、固定输入和候选采用 |
| 编辑器与时间线 | 结构往返、素材保护、重开续编、真实文件播放及导出 |
| UI 与 Agent 接入 | 相同意图的业务结果一致，交错编辑和草稿保留 |
| 交互与同步 | 真实拖动、缩放、焦点、锁定、重复事件和断线恢复 |
| 性能 | 固定素材和手势下比较帧延迟、长任务、内存或 CPU 数据 |
| 文档 | 链接、命令与文件路径正确，依赖文件随仓库交付 |

## 隔离浏览器验证

[`tests/browser/creation_server.py`](../../tests/browser/creation_server.py) 提供临时项目和模型替身，支持 [`scripts/verify_creation_browser.mjs`](../../scripts/verify_creation_browser.mjs) 等浏览器检查。测试必须使用隔离服务，不指向用户工程或真实付费模型。

分别启动 API 和 Vite：

```sh
# 终端一：夹具自动创建隔离临时目录
.venv/bin/python tests/browser/creation_server.py --port 8019

# 终端二：将前端请求代理到夹具
OPENDIRECTOR_API_URL=http://127.0.0.1:8019 npm run dev -- --port 5179
```

然后运行检查：

```sh
CREATION_WEB_URL=http://127.0.0.1:5179 CREATION_API_URL=http://127.0.0.1:8019 \
  node scripts/verify_creation_browser.mjs
```

同一套隔离服务下的浏览器检查：

```sh
node scripts/verify_creation_browser.mjs       # UI/API 主流程与重载
node tests/browser/reference_reconnect.mjs     # 参考连线删除后重连
node tests/browser/context_menu_dismissal.mjs  # 右键菜单关闭
node tests/browser/mp4_export.mjs              # 合成 MP4（WebCodecs + 软件 AAC）
node tests/browser/new_image_node_outputs.mjs  # 新建图片节点采用所选适配器的比例与尺寸
```

`mp4_export.mjs` 以 640x360 渲染：没有 GPU 的无头浏览器只在该尺寸暴露 H.264
编码能力，1080p 导出仍需在桌面浏览器人工验收。

脚本需要可导入的 Playwright 模块和 Chromium。按脚本约定通过 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 指定本机安装；它们不是所有环境中默认可用的项目依赖。以上环境变量语法适用于 POSIX shell，其他终端使用对应设置方式。测试使用的工程入口和前置条件以脚本为准。

每个浏览器脚本都用 `browser.newPage({ locale: "en-US" | "zh-CN" })` 固定页面语言：界面在没有保存偏好时跟随浏览器语言，不固定就会在英文 CI 环境里等中文文案。`npm run check:browser-locale` 检查这条约定，CI 在启动浏览器任务前执行。`npm run test:browser` 按固定顺序运行整套浏览器清单，单个脚本失败也会继续执行其余脚本，最后集中报告失败项。

页面语言也可以用 `addInitScript` 写入 `opendirector.locale.v1` 偏好：应用优先使用已保存的偏好，语言同样确定，`check:browser-locale` 认可这种写法。

等待异步保存时，不要用会改名的按钮判断编辑器是否关闭：保存中的按钮会变成 `Processing…` 或 `Applying…`，locator 匹配不到元素时 `waitFor({ state: "hidden" })` 立即满足，测试会在确认回执到达前继续，随后 reload 恢复未确认的草稿。改为等编辑器对话框 detach 或服务端回执出现；图层编辑器的这一等待封装在 [tests/browser/layerApply.mjs](../../tests/browser/layerApply.mjs)。

AI 多会话检查使用同一隔离 API，但启动 `creation_server.py` 时额外传入 `--assistant-fixture`，再运行 `node tests/browser/assistant_sessions.mjs`。该检查通过真实 UI、接口与项目文件验证新建、历史搜索、切换、草稿和附件恢复、刷新、失败重试及输入撤销隔离；仅模型回复使用可暂停的替身，不调用真实模型。同一环境下运行 `node tests/browser/assistant_run_navigation.mjs`，验证回复进行中切换项目只断开当前视图：Agent 继续运行，返回后重新接入并收到完整回复，全程不调用停止接口；切走再返回后显式停止仍然有效。

聊天与辅助面板共存检查运行 `node tests/browser/assistant_auxiliary_panels.mjs`，同样需要 `--assistant-fixture`。它通过真实界面切换中英文，在宽窄窗口和助手调整宽度后检查资产列表、生成历史的可操作性与聊天展开状态，并验证草稿、对话和执行中的回复／生成任务保持。可设置 `CREATION_SCREENSHOTS` 保存代表性截图。此检查会控制隔离服务的模型替身 gate，应与其他使用同一 gate 的浏览器用例顺序运行。

Release checks 的 `Assistant auxiliary panels` 阶段自动运行此检查，使用独立的隔离 API 与前端端口；失败时输出对应服务日志。

## Nightly 检查

[`nightly.yml`](../../.github/workflows/nightly.yml) 在 `main` HEAD 上按 `0 18 * * *` UTC（次日凌晨 02:00 Asia/Shanghai）运行，支持 `workflow_dispatch` 手动触发；发布前可对候选 SHA 手动重跑同一套。它与 PR 门禁共用可复用的 [`release-checks.yml`](../../.github/workflows/release-checks.yml)（Release checks 唯一实现，PR 与 nightly 不允许出现第二份漂移副本）；其中各检查步骤相互独立，一条检查失败不会掩盖其余检查的结果。

### 五级测试体系

自动化检查按级别分层：每个级别明确范围与重点、触发频率、时间预算和实现位置。新增检查先选择级别再进入对应工作流；超出预算时先调整级别或拆分，而不是让某个级别无限增长。

| 级别 | 范围与重点 | 频率 | 预算 | 实现 |
| --- | --- | --- | --- | --- |
| L1 单元、静态与构建 | 前端单元测试、Python 单元套件、双语词条检查、浏览器清单检查、分层导入检查、契约一致性、生产构建 | 每个 PR；push 到 main | 整个 job ≤30 min | Release checks 中浏览器阶段之前的各检查步骤 |
| L2 浏览器 E2E（模型替身） | 隔离服务与模型替身下的核心旅程：画布、参考、导出、助手、时间线 | 每个 PR；push 到 main | 与 L1 同一 job | Release checks 浏览器阶段（含 Assistant auxiliary panels 独立 fixture 阶段） |
| L3 main HEAD 复核与扩展覆盖 | 与 L1+L2 相同门槛在 main HEAD 重跑（gate parity）；Python 套件失败分类与已知时序敏感用例观测（flake triage）；PR 门禁未覆盖的全部浏览器脚本（extended） | 每晚定时；发布前可手动触发 | gate parity 与 L1+L2 相同；extended ≤60 min | nightly 的 gate-parity、pytest-flake-triage、browser-extended |
| L4 生产构建、性能与输出 | 以生产构建（`vite preview` 服务 `dist`）运行核心旅程；MP4 落盘后 ffprobe 校验时长、流与帧数；帧延迟、长任务诊断采样与 CPU profile。同一次 nightly 之后另跑固定可对比基准（存储微基准 + 复用上述采样） | 每晚定时；发布前对候选 SHA 手动触发 | production ≤45 min；perf ≤30 min；daily benchmark ≤30 min | nightly 的 browser-production、perf-outputs、daily-benchmark |
| L5 稳定性与恢复（规划中） | 进程中断重启、工程重开恢复、长时运行稳定性；需要新的场景编写 | 每周；发布前 | 待定 | 未建设，作为后续工作跟踪 |

L1–L4 的自动检查不调用付费模型、不依赖真实服务；真实凭证与真实模型的验收属于需要明确授权的范围，不纳入本体系的自动执行。建议性结论与阻断性结论的边界见下节；已知失败模式的解读见 [CI 失败模式](ci-failures.md)。

### 发布决策与 lane 政策

- Gate parity 绿色是候选 `v0.1.x` 的发布门槛；nightly 不自动打 tag，也不以任何结果自动触发发布动作。
- Extended、production、perf 与 daily benchmark lane 当前为建议性（advisory）：失败需登记跟进，但不单独阻断发布。某条 lane 连续两周稳定绿色后，由发布协调人决定是否升级为阻断项。
- 每次运行产出 `nightly-summary`（各 lane 结果 + SHA + 基准一行摘要）与 `nightly-perf`（渲染探针与拖拽采样）artifact；发布看板与失败通知按 summary artifact 对接，通知通道由发布协调人约定。`lanes.dailyBenchmark.notify` 只在超阈回归、基准套件本身失败或必填测量缺失（样本解析成功但缺少 `--ui-required` 时应有的帧采样，或 storage 样本缺少必填字段）时为 true，改善和阈值内波动不通知。
- `flaky-watchlist.txt` 一行一个 pytest node id，`#` 为注释；用例稳定后应删除条目，而不是长期静默重试。triage 结论写入 `flake-report` artifact 与 Actions summary。

### 脚本登记与 lane 归属

[`tests/browser/manifest.json`](../../tests/browser/manifest.json) 是浏览器脚本 lane 归属与运行要求的唯一来源：`gate`（PR 门禁）、`extended`（nightly 普通隔离服务）、`extendedFixture`（nightly 独立 fixture 服务）、`production`（生产构建，要求 `previewSafe`）、`perf`（性能与输出验证）、`manual`（需要可见桌面或独立平台 wheel 的人工触发验收）。`npm run check:browser-manifest`（Release checks 独立步骤）校验磁盘与清单一一对应、fixture 与 previewSafe 声明与源码一致、manifest 的 gate 集合与 release-checks.yml 实际调用一致；nightly 从清单派生各 lane 列表。新增浏览器脚本登记清单即可，不修改工作流列表。

`mp4_render_probe.mjs` 与 `reference_drag_performance.mjs` 需要导入 `/src/*.ts`，只在 dev server 上运行；`vite preview` lane 只运行不导入 `/src` 的脚本。需要 `--assistant-fixture` 的浏览器脚本不属于普通隔离服务阶段。

### 每日可对比基准

`daily-benchmark` 在同一次 nightly 的 `perf-outputs` 之后运行，不重跑浏览器，也不进入发布门槛。固定场景与阈值在 [`scripts/nightly/benchmark.json`](../../scripts/nightly/benchmark.json)：

- `cold-open` 与 `delete`：`--commits 600 --nodes 200`（#180 验收规模）。
- `catalog`：`--projects 200`，每个额外工程 3 个节点，使 `list_projects` 测的是目录成本而不是再放一份 600 提交历史。
- UI：复用本 run 的 `nightly-perf`（`reference_drag_performance.mjs` 的 pan/node `frameP95`，以及渲染探针采样）。[`ui-performance.md`](ui-performance.md) 的 100 ms / 500 ms 预算只作阅读对照，不是这条 lane 的失败线。

比较规则：每个指标越低越好。已写入 `baseline.metrics` 时，相对基线判断回归，一行摘要仍同时给出相对上一次的百分比；基线为空时，以上一次 nightly 的 `daily-benchmark` artifact 为参照（距本次 12–36 小时记为 yesterday，否则记为 previous）。只有同时超过 `regressionRatio`（1.5）和该指标的 `minDeltaMs` 才算回归。套件跑不起来同样 `notify: true`。渲染探针的通过与否仍由 perf-outputs 负责，不在这里重复失败。

不要把开发机计时抄进 `baseline.metrics`。基线应来自 nightly 的 `ubuntu-22.04` artifact。在基线写入之前，摘要写明 `baseline unseeded`。

产物为 artifact `daily-benchmark`（`daily-benchmark.json`）。`nightly-summary.json` 的 `lanes.dailyBenchmark` 带上同一行 `summary` 和 `notify`，供现有 summary 通知路径使用。

## 证据记录

在 PR 或专题验收记录中写明：

- 所验证的代码版本、变更范围和运行环境。
- 实际执行的命令、场景、退出结果及必要日志。
- 使用模型替身还是真实服务，是否验证真实媒体文件。
- 未覆盖范围、已知限制和失败原因。
- If a relevant check also fails on the baseline, record the baseline revision and comparison result, and link an existing issue or create one when appropriate. A baseline failure does not mean the check passed.
- 性能比较的素材、操作、基线及测量方式；没有可比测量时不报告提升比例。

“节点出现”“引用标签显示”“文件下载成功”不能单独证明执行输入正确、结构已保存或媒体可用。关键检查应关联持久化对象、输入快照和实际输出。日志不得包含密钥、用户私有素材或开发机临时路径作为他人的必需依赖。

## v0.1.0 已验证范围与已知限制

以下结论来自 `main` 上的实际执行，未验证的部分明确列出，不用推测代替证据。

**已验证**

- Linux（Ubuntu 22.04.5）、Python 3.12、Node 24.22.1、FFmpeg N-128227：`npm ci`、
  `npm run build`、`serve`、`pytest tests`（937 passed）、`npm test`（411 passed）。
- 隔离浏览器检查：`verify_creation_browser.mjs`、`reference_reconnect.mjs`、
  `context_menu_dismissal.mjs`、`mp4_export.mjs`，Chromium 145 与 Chrome 156 均通过。
- MP4 合成产物经 `ffprobe` 复核：`h264 640x360` + `aac 48000 Hz stereo`，2.0 秒
  时间线输出 2.027 秒。
- 本地服务边界：仅监听 `127.0.0.1`；缺少 `X-OpenDirector-Request` 的请求返回 403。

**已知限制**

- **1080p MP4 导出需要桌面浏览器人工验收**。无 GPU 的无头浏览器只暴露
  640x360 的 H.264 编码能力（`VideoEncoder.isConfigSupported` 在 1280x720 与
  1920x1080 均为 false），自动化检查因此固定为 640x360。
- **真实模型端到端验收未执行**：需要可访问的模型端点或 GPU 授权，当前环境不具备。
- **本节历史验收仅覆盖 Linux + Chromium/Chrome**；后续 Apple Silicon macOS 的安装与基础使用验证见 [独立记录](macos-install-validation.md)，不能据此推断 Intel Mac、Firefox 或 Safari 已验证。
- **故障注入未覆盖**：进程级重启打断进行中的生成、浏览器写盘失败，仅有测试替身级别的覆盖。
- 模型密钥以明文保存在本地 `models.json`（POSIX 下目录 `0700`、文件 `0600`），
  接口响应不返回密钥；这是本地优先的取舍，不是加密存储。

### MiniMax 官方视频适配

```sh
python -m pytest tests/test_minimax_video.py tests/test_vllm_omni_h3.py tests/test_generation_errors.py -q
node --test tests/creationParameters.test.ts
node tests/browser/minimax_h3.mjs
node tests/browser/first_last_frame_connections.mjs
```

浏览器用例沿用本文的隔离 API／Vite 环境，只验证模型配置、真实图片、首尾帧引用、槽位修改及重载，不调用官方服务。`first_last_frame_connections.mjs` 不操作首尾帧选择器，只在画布上依次拖线连接两张图片，核对声明尾帧的模型自动填入首帧与尾帧、项目保存对应的引用角色，并在重载后保持。Python 用例使用真实素材和 HTTP 替身验证协议、冻结输入、恢复不重复提交、错误回执和无鉴权 CDN 下载，不能代替真实账户生成验证。

### 提供商与模型设置

Kling 4.0 protocol and bilingual workflow checks:

```sh
.venv/bin/python -m pytest tests/test_kling_video.py tests/test_generation_errors.py tests/test_model_http_logging.py -q
node --test tests/providerPresets.test.ts tests/modelResolution.test.ts tests/generationFailureText.test.ts
node tests/browser/kling_video.mjs
```

The browser check uses the isolated creation API and Vite described above. It verifies both locales, optional provider setup, preserved model selections, frame slots, image references, persisted project objects, and fixture-generated video adoption. It uses the generic fixture provider and does not exercise Kling's HTTP adapter. Python protocol tests exercise the actual adapter with mocked HTTP and real image/video bytes. Neither check calls Kling or proves account access, billing, or creative quality. Real-service acceptance requires a valid account and a recorded submit/query/download/adopt workflow, including the model ID, API family and exact endpoint, remote task ID, output video, and screenshots or a recording. Do not record API keys.

```sh
python -m pytest tests/test_model_configs.py -q
node --test tests/providerPresets.test.ts
node tests/browser/provider_settings.mjs
```

浏览器用例使用隔离服务验证提供商预设、手动添加、逐模型图片输入能力、保存不推理、已有连接复用及取消草稿。不会向外部提供商发送请求或保存真实密钥。

## 定时文字与可移植时间线

```sh
node tests/browser/timeline_text_editing.mjs   # UI/共用命令、保存重启、冲突/锁、双语与输入草稿
node tests/browser/timeline_text_render.mjs    # 真实字体、像素/时序、文字片尾与音频、取消
node tests/browser/timeline_text_archive.mjs   # UI↔CLI 跨工程包、重启续编、MP4 与交换拒绝
node tests/browser/timeline_text_desktop.mjs   # 独立可见 Chrome：横竖 1080p、2000 条/10 分钟与进程 RSS 采样
node tests/browser/timeline_workflow.mjs      # 原有无文字时间线与真实媒体行为
```

前三个文字脚本各自启动临时项目服务和 Vite，使用独立端口；不要指向真实工程。桌面脚本使用新的测试专用 Chrome profile 和可见窗口，不连接用户浏览器。通过 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 指定已有安装；`TIMELINE_TEXT_EVIDENCE` 可指定桌面输出目录，默认 `test-results/issue87/desktop`。运行前检查脚本顶部的端口环境变量；与其他浏览器用例顺序执行以免相互影响测量。

验收须检查实际 `ffprobe` 编码、尺寸和时长，以及导出帧中的中文、起止帧和重叠层次。640×360 自动化通过不能替代桌面 1920×1080 / 1080×1920。浏览器实际编码能力不足应记录为运行环境限制，不能降尺寸后宣称通过 1080p。2000 条、600 秒测量使用同一媒体、帧率和尺寸的无文字基线，分别报告编辑交互延迟、采样 JS 堆、实际合成耗时及文件大小；JS 堆不是整个浏览器/系统内存，也不是精确的进程峰值。

定时文字验收证据见 [Issue #87 验收记录](issue-87-validation.md)。记录必须明确测试替身、真实文件验证、平台边界和已有基线失败；未完成的桌面、wheel 或跨平台检查不能标为通过。

实际 wheel 验证还须在新的隔离虚拟环境安装构建产物，运行 `scripts/verify_install.py`，然后直接检查已安装服务的 `/fonts/manifest.json`、字体字节和许可证，不能用 Vite 的静态资源代替。可运行：

```sh
OPENDIRECTOR_INSTALLED_PYTHON=/absolute/path/to/wheel-venv/bin/python \
  node tests/browser/timeline_text_installed.mjs
```

该脚本自行启动已安装后端，不启动 Vite；后台 PATH 不包含 Node，浏览器仍使用约定的 Playwright/Chrome 安装。实际创建时间线、添加文字、检查预览及缺字诊断/恢复、保存、重启后重开。桌面性能脚本以 500 毫秒间隔采样该隔离 Chrome 实例通过 CDP 报告的进程 PID：POSIX 使用 `ps` RSS，Windows 使用实际 `GetProcessMemoryInfo` 工作集。总和可能重复计算共享页，并非独占内存或精确瞬时峰值，不含 Python/Vite/Node 控制进程。完整逐次采样保存在 `report.json`；存活进程采样失败会报错，零值仅用于内核确认已退出的 PID。

七组时间线脚本共用仓库中的 `tests/browser/host.mjs` 与 `windows_host.py`，不依赖本机忽略目录副本。源码 `PYTHONPATH` 使用平台分隔符，已安装服务移除源码导入和宿主 PATH；Windows 子进程先挂入本测试的私有 Job Object，再开始执行，清理仅终止该 Job。设置 `PYTHON` 指向 **未打包的 Python.org 虚拟环境**，installed 组另设置 `OPENDIRECTOR_INSTALLED_PYTHON` 指向全新 wheel 环境。Microsoft Store Python 的激活启动器曾在真实检查中留下 Job 外的孙进程，host adapter 会在启动测试应用前明确拒绝该解释器；这是测试宿主的支持边界，不把它改为 skip 或改变产品沙箱。

The seven timeline suites share the tracked host adapter. Source imports use the native path delimiter; installed servers have no source import path or ambient Node PATH. Windows uses a private job and actual kernel working-set samples for CDP PIDs. Set `PYTHON` to an unpackaged Python.org venv and `OPENDIRECTOR_INSTALLED_PYTHON` to a fresh wheel venv. Packaged Microsoft Store Python is explicitly rejected before launching the test application because native tests observed descendants outside job ownership. This is a host prerequisite, not a skipped test or a product sandbox change.

解释器发现顺序为显式 `PYTHON`、工程 `.venv`、PATH 中的 `python3` / `python`。显式路径无效时报错；不会静默换解释器。CI 不必创建 `.venv`，但 PATH 必须提供满足项目版本要求的 Python。

Interpreter discovery uses explicit `PYTHON`, then the project `.venv`, then PATH `python3` / `python`. Invalid explicit overrides fail instead of selecting another interpreter. CI may install Python globally; the interpreter must meet the project's supported version requirement.

MOSS 图像与语音接入使用以下检查。浏览器命令连接本文前述隔离 API 和 Vite；可通过环境变量改用其他端口。

```sh
.venv/bin/python -m pytest tests/test_moss.py tests/test_generation_errors.py -q
CREATION_API_URL=http://127.0.0.1:8019 CREATION_WEB_URL=http://127.0.0.1:5179 node tests/browser/moss_provider.mjs
```

Python 用例使用模拟 HTTP 服务及真实 PNG、MP3，检查请求字段、音色、执行快照、文件探测、工程重开和下载恢复不重复生成。通用错误分类和安全提示由现有错误测试负责。浏览器用例检查两种语言下的提供商及型号列表、获取模型失败的具体原因、音色必填、保存重开和实际音频播放；播放器使用隔离服务的 WAV 替身，不代表 MOSS 已生成语音。真实验收另需有效 MOSS 凭证和音色 ID，并保留实际音频、模型标识及播放器截图。

Zhipu BigModel chat access uses the following checks. Browser commands connect to the isolated API and Vite described earlier in this document. Environment variables can override the ports.

```sh
.venv/bin/python -m pytest tests/test_zhipu.py tests/test_model_configs.py -q
node --test tests/providerPresets.test.ts
CREATION_API_URL=http://127.0.0.1:8019 CREATION_WEB_URL=http://127.0.0.1:5179 node tests/browser/zhipu_provider.mjs
```

The Python cases check how the shared thinking levels map to GLM reasoning_effort. GLM accepts only low, high and max for reasoning_effort. The auto level omits the parameter so the provider default applies, and an unknown level falls back to high as in the DeepSeek branch. Other hosts and the DeepSeek behavior stay unchanged.

The browser case checks both display languages for the provider list and names, canonical URL prefill, GLM model preselection without remote discovery, manual addition of other model IDs, the saved connection reuse hint, save and reopen, key privacy in public model responses, and the assistant agent picker listing and keeping the selected Zhipu model. The browser never contacts open.bigmodel.cn and the API key is always a fixture value. Real streaming conversations, tool call execution and thinking level effects additionally require valid Zhipu credentials. Keep the conversation transcript, tool receipts and screenshots as evidence.

### Voice library / 音色库

The voice browser workflow uses a separate isolated fixture. It runs the real shared voice service, media probing, project storage and generation acceptance with mocked provider HTTP; it does not contact MOSS or a GPU service.

```sh
.venv/bin/python -m pytest tests/test_voice_library.py -q
node --test tests/voiceLibrary.test.ts tests/creationParameters.test.ts
# Terminal 1
.venv/bin/python tests/browser/voice_library_server.py --port 8030
# Terminal 2
OPENDIRECTOR_API_URL=http://127.0.0.1:8030 npm run dev -- --port 5190
# Terminal 3 (Playwright installed as for the other browser checks)
CREATION_API_URL=http://127.0.0.1:8030 CREATION_WEB_URL=http://127.0.0.1:5190 node tests/browser/voice_library.mjs
```

For a slow-response regression, set `VOICE_REOPEN_DELAY_MS=17000` for the browser command. It delays the reopened asset request beyond the ordinary 15-second interaction timeout. Cold navigation, saved-state and reopened-media waits have explicit 45-second limits; HTTP errors still fail immediately with their status. No generation is retried.

慢响应回归：在浏览器命令的环境变量中设置 `VOICE_REOPEN_DELAY_MS=17000`，让重开后的资源请求超过普通交互的 15 秒等待。冷启动导航、保存状态和重开媒体分别有明确的 45 秒上限；HTTP 错误仍立即报告状态并失败，不重试生成。

The bilingual browser workflow covers opening/outside click/Escape, keyboard tabs, four-column and narrow layouts, real previews and unavailable previews, metadata filters, scoped favorites, loading/error/retry, invalid and valid local audio, creation, selection, Drama3 transcript and Nano reference requirements, supported deletion and failure feedback, model/service switching, project reopening and persisted job input. `moss_speech.mjs` is retained as an alias for this integrated workflow. The pagination regression includes a 15,001-voice catalog. With a configured MOSS account, open the library, go to the next page, and return to the first. Verify the page counts and that returning to the first page restores its entries using read-only requests. Python tests verify provider fields, pagination, credentials, account boundaries, actual audio/container/duration validation, and equivalent Agent operations. Actual provider synthesis still requires a configured service, account permission and a recording authorized for use.
