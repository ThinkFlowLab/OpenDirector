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
npm run build
npm run check:i18n
.venv/bin/python scripts/generate_contracts.py --check
```

内置 Agent 安装验证必须实际执行上述 OpenCode 版本命令，不能只检查文件存在。不要跳过 `opencode-ai` 的安装脚本；若依赖安装不完整，在仓库根目录重新执行 `pip install -v -e .`；安装钩子会运行 npm 安装、前端构建和 OpenCode 版本校验。

Windows 使用对应虚拟环境的 Python 路径。涉及真实媒体探测、工具处理或对应测试时，需要 PATH 中的 `ffmpeg` 和 `ffprobe`；视频处理使用 `libx264` 编码器，可通过 `ffmpeg -encoders` 检查是否包含它。不因纯文档修改而运行全部生成或媒体测试。

macOS 使用 README 中的 `python3.12` 环境准备命令，避免误用系统旧版 `python3`。安装验证需使用全新源码目录、新建 `.venv` 和 `pip install -e .`；构建由 pip 钩子执行，然后通过正式 `serve` 入口检查页面、上传、刷新与服务重启恢复。wheel 与 editable 的隔离验收见 [Python 安装与发布](packaging.md)。实测边界见 [macOS 安装验证记录](macos-install-validation.md)。

前端测试、Python 测试、契约生成检查和构建分别验证不同边界，任意一项不能替代其他相关检查。修改契约时同步更新自动生成文件，再执行一致性检查，不手工维护第二份契约。

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

AI 多会话检查使用同一隔离 API，但启动 `creation_server.py` 时额外传入 `--assistant-fixture`，再运行 `node tests/browser/assistant_sessions.mjs`。该检查通过真实 UI、接口与项目文件验证新建、历史搜索、切换、草稿和附件恢复、刷新、失败重试及输入撤销隔离；仅模型回复使用可暂停的替身，不调用真实模型。同一环境下运行 `node tests/browser/assistant_run_navigation.mjs`，验证回复进行中切换项目只断开当前视图：Agent 继续运行，返回后重新接入并收到完整回复，全程不调用停止接口；切走再返回后显式停止仍然有效。

聊天与辅助面板共存检查运行 `node tests/browser/assistant_auxiliary_panels.mjs`，同样需要 `--assistant-fixture`。它通过真实界面切换中英文，在宽窄窗口和助手调整宽度后检查资产列表、生成历史的可操作性与聊天展开状态，并验证草稿、对话和执行中的回复／生成任务保持。可设置 `CREATION_SCREENSHOTS` 保存代表性截图。此检查会控制隔离服务的模型替身 gate，应与其他使用同一 gate 的浏览器用例顺序运行。

## 证据记录

在 PR 或专题验收记录中写明：

- 所验证的代码版本、变更范围和运行环境。
- 实际执行的命令、场景、退出结果及必要日志。
- 使用模型替身还是真实服务，是否验证真实媒体文件。
- 未覆盖范围、已知限制和失败原因。
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

该脚本自行启动已安装后端，不启动 Vite；后台 PATH 不包含 Node，浏览器仍使用约定的 Playwright/Chrome 安装。实际创建时间线、添加文字、检查预览及缺字诊断/恢复、保存、重启后重开。桌面性能脚本以 500 毫秒间隔采样该隔离 Chrome 实例通过 CDP 报告的进程 PID 及其 `ps` RSS；总和可能重复计算共享页，并非独占内存或精确瞬时峰值，不含 Python/Vite/Node 控制进程。完整逐次采样保存在 `report.json`。
