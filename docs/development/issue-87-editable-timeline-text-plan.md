# 可编辑字幕与文字叠加 Implementation Plan

**交付状态 / Delivery status（2026-11-08）：** 本计划的已交付步骤由后续整合与收尾记录关账，
最终源码为 `97edaf4e`，main 基线 `c54d78eb`。`733001a2` 的桌面/1080p/性能及 `1799464f` 的补验证据
保留原版本；最终范围、命令、失败处理、跳过项和剩余限制见[验收记录](issue-87-validation.md)
及[收尾计划](issue-87-post-windows-plan.md)。原建议命令和提交标题保留作实施约定，
复选框表示对应交付能力已完成，不表示在 Windows 逐字执行过 POSIX 示例命令。
Historical planning and evidence are preserved; this completion notice does not relabel prior runs as new tests.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在原生时间线中交付 UI 与 Agent 均可编辑的定时文字，完成保存、重开、预览、MP4 导出、成片版本追溯及可移植续编。

**Architecture:** 在现有 `TimelineData` 中增加独立的文字集合及字体资源集合，保留一个顺序视觉轨和多音轨。正式写入复用 `editor.create` / `editor.save`、版本校验、项目历史和素材依赖；预览覆盖画布与 MP4 共用文字排版和绘制器。原生可编辑包由共用后端服务封装一个确定版本的时间线及其实际资源，UI 与 CLI 使用同一导入导出契约。

**Tech Stack:** Python 3.11+ / Pydantic、React / TypeScript、Canvas 2D / FontFace、现有 Mediabunny / WebCodecs、FFmpeg / ffprobe、pytest / Node test / Playwright。

**Spec:** [Issue #87](https://github.com/ThinkFlowLab/OpenDirector/issues/87)、[开发指导](../../AGENTS.md)、[统一项目架构](../architecture/unified-project.md)、[双语要求](i18n.md)。本计划的实现决策见第 2 节；它们是建议采用的首版方案，不表示功能已经实现。

**分析日期与基线:** 2026-11-05；分析时 HEAD `2579ce58`，2026-11-06 开始执行时基线为 `28f30454`。Issue 的原始核对基线为 `5581f19f`。本文件记录实施约定；实际运行结果和限制见[验收记录](issue-87-validation.md)。

**执行记录（2026-11-06）：** T0–T7 的功能实现、审查和本机验收已完成，包括真实 UI/CLI 往返、服务重启、双语、横竖 1080p、干净 wheel 安装及浏览器进程 RSS 采样。下方步骤保留原计划；执行结果与基线失败、平台边界以验收记录为准，不能将“预期通过”当成实际结果。改动保留在 `codex/issue-87-timeline-text` 工作区，尚未暂存、提交或推送；各任务中的提交步骤尚未执行。

**后续平台补验（2026-11-06）：** 用户另行授权原生 arm64 环境安装与验证，已在独立源码快照中完成原生工具链、源码及 wheel 安装、621 项 Node / 269 项相关 Python 和七组浏览器验收。原生 wheel、字体、横竖 1080p、包往返和资源清理均有实际证据；Windows 仍未验证。详见验收记录的原生 arm64 章节。

## Global Constraints

- “UI与Agent使用相同的类型化契约、命令与校验，遵守锁定、对象版本和撤销/重做规则”。
- “本项不扩展为通用多视觉轨编辑器或后台渲染引擎”。
- 工程后端持有权威状态；编辑器本地状态仅为可丢弃草稿，正式保存以业务回执为准。
- 无字幕工程保持现有行为；不新增旧工程迁移任务，不改写历史命令、回执、输出文件或凭证。
- 相同操作 ID 的重试保留原输入；冲突或未知提交不能通过换 ID、换版本自动覆盖。
- 新增界面、错误、工具说明及下载提示同时提供 `zh-CN` / `en-US`；执行 `npm run check:i18n` 并实际切换语言。
- 执行代码改动前遵守本机安全基线及 Python / JS 规则；仓库内说明必须自足，不让本机规则路径成为其他开发者的构建依赖。
- 当前工作区有其他任务改动；不得重置、覆盖、暂存或提交无关文件。实施时按实际重叠情况决定是否使用隔离工作树。
- 真实导出测试使用隔离工程；模型替身、真实媒体和真实模型调用分别报告。

## Review Focus

1. **已有工程重开：** 新增带默认值的字段不能改变旧命令的指纹，导致旧提交被判损坏；T0/T1 用改动前的持久化 fixture 验证。
2. **浏览器已加载字体但缺少字形：** 不得悄悄使用系统字体；T2/T4 覆盖缺字、字体加载失败及同名字体不同字节。
3. **片尾或仅文字的时间段：** 没有视觉片段时仍应绘制文字，成片时长应包含文字；T1/T4/T5 覆盖。
4. **编辑后另一方锁定或修改：** 本地草稿、正式保存、撤销/重做和发布均不能覆盖新状态；T3/T5/T7 覆盖。
5. **跨工程导入可编辑包：** 不能沿用源工程 UUID、blob URL 或本机字体；T6/T7 必须在新工程登记资源、重开并再次导出。

---

## 1. 交付范围与现有基础

### 必须交付

- 手动和 Agent 创建、修改、移动、删除定时文字，控制起止时间、内容、位置、字号、颜色、背景、描边和叠放顺序。
- 多项文字同时显示；中文、英文及中英混排；显式换行及有限宽度自动换行。
- 正式保存、服务重启后重开、草稿撤销/重做、项目历史撤销/重做。
- MP4 实际成片与预览在文字内容、位置、布局、层次和显示帧上保持一致。
- 字体为真实固定资源；从已有文本素材创建文字时保留来源资产引用，后续改字不会修改来源文件。
- 修改后产生新成片，旧成片仍能查询到精确的编辑文档版本和资源。
- 原生可编辑包可在新工程恢复当前时间线；不支持文字的交换导出明确拒绝，提供可用替代入口。

### 本轮边界

字幕与通用标题共用同一种定时文字对象，以默认位置和编辑方式区分，不建设两套业务模型。外部 SRT/ASS/VTT 的时间码解析、自动听写、翻译、逐字高亮、动画、富文本、字体商城、通用多视觉轨和后台渲染均不计入本计划。

首版允许读取现有**纯文本素材**的正文创建一条文字，并记录 `sourceAsset`；`.srt/.ass/.vtt` 不自动当成已解析字幕。需要这些格式时另加共用解析服务，不能只在 UI 解析后声称 Agent 等价。

### 可直接复用与必须扩展

| 部分 | 已有能力 | 本轮扩展 |
| --- | --- | --- |
| 编辑契约 | `TimelineData`、`EditorDocument`、生成 TS / JSON Schema | 文字和字体字段、时长与限制 |
| 写入 | `editor.create/save`、`creation.batch`、`CreationEditorSession` | 双向投影及文字字段变化识别 |
| 历史 | 持久化快照、`object.get` 的 `revision` 参数、撤销重做 | 文字恢复时锁定校验和旧输出依据验证 |
| 依赖 | `asset_references()` 递归 `AssetRef`、`asset.usage` / 删除保护 | 字体与文本来源引用、发布来源集合 |
| 预览和渲染 | DOM 图片/视频预览、Canvas MP4 合成 | 共享文字排版、字体准备、每帧叠加 |
| 资源归档 | `.canvas` 已有画布格式、资源上传登记与文件校验 | 共用后端时间线包、UI/CLI 等价入口；既有画布归档的文字能力门禁 |

**已核对的关键实现点：** `copyTimeline` 和 `sameNodeData` 显式列举字段；`renderTimelineMp4` 在无视觉片段时提前返回；`_publish_render` 只从媒体片段计算时长和来源；现有 FCPXML ZIP 只有 XML、媒体和说明，不是完整的原生时间线续编包。

## 2. 首版实现决策

### 2.1 数据与身份

在 `domain/creation/editors.py` 中定义以下契约，由脚本生成前端类型。以下名称是后续任务共同使用的接口，实施中更名必须同步修改本计划及所有调用方。

| 契约 | 字段与含义 |
| --- | --- |
| `TimelineTextStyle` | `fontSize`（输出像素）、`color`、`align: left/center/right`、`lineHeight`（字号倍数）、可选 `background` / `stroke` |
| `TimelineTextBackground` | `color`、`opacity`、`padding`（输出像素） |
| `TimelineTextStroke` | `color`、`width`（输出像素） |
| `TimelineFontResource` | `id`、`title`、`asset: AssetRef`；`asset.kind` 必须为 `file` 且通过字体探测 |
| `TimelineTextOverlay` | `id`、`start`、`end`、`text`、`x`、`y`、`maxWidth`、`fontId`、`style`、可选 `sourceAsset: AssetRef` |
| `TimelineData` 新字段 | `overlays`、`fonts`；空集合在服务端序列化时省略，以保持旧命令指纹 |

- `overlays` 数组从底到顶表达叠放顺序，不另存第二份 `zIndex`；重排改变数组顺序，保持文字 ID。
- 文字是编辑文档内的稳定子对象，沿用整个 `editor_document` 的版本；首版不做逐条并发合并或逐条权限模型。
- 字体和文本来源不进入只允许图片/视频/音频的 `importedAssets`。`sourceAsset` 是创建时来源，不是自动跟随来源正文的绑定。
- 既有字段不改名；新增空值采用仓库已有的 `exclude_if` 方式，不靠重写历史记录实现兼容。
- 前端投影的字体/来源资源可带 `src` / MIME 等临时读取信息，正式契约仅保存 `AssetRef`；禁止把 blob URL 写进项目。

前端 `model.ts` 使用明确的展示类型，避免归档只保存裸 `sourceAsset` 而漏掉文本字节：`TimelineFontView = {id, title, asset?: AssetRef, src, mimeType}`；`TimelineTextSourceView = {title, asset?: AssetRef, src, mimeType}`；`TimelineTextOverlayView` 保留业务文字字段，但将 `sourceAsset` 换成可选的 `source: TimelineTextSourceView`。本地 `TimelineData.fonts/overlays` 使用这些 View 类型。`asset` 只在已有项目素材上存在，新导入草稿可以只有受控 `src`；提交时先登记并得到真实 `AssetRef`，再组装业务契约。不得用跨工程传来的旧 `assetId` 跳过登记。

### 2.2 时间和画面语义

- 时间保存为有限的绝对秒，满足 `0 <= start < end`；修改 FPS 不重写已有秒数。拖动及时间输入确认时可按当前 FPS 吸附；关闭磁吸不改变逐帧渲染规则。
- 定义 `timeline_text_frame_range(start, end, fps)` / `timelineTextFrameRange(start, end, fps)` 返回 `[first, endExclusive]`：`ceil(start * fps - 1e-9)`、`ceil(end * fps - 1e-9)`。预览与 MP4 都按这两个帧边界查询；拒绝不覆盖任何采样帧的区间。
- 默认新增时长为 3 秒，起点为当前播放头所处帧；媒体剪辑、重排和变速不自动移动文字。
- `timelineDuration` 和服务端同名语义取媒体终点与文字终点的最大值。纯文字时间线允许保留空视觉轨，以黑色背景输出；文字结束后无其他内容则成片结束。
- `x/y` 为文字框左上角在输出画面的归一化位置；`maxWidth` 为画面宽度比例。预览 Canvas 使用实际输出像素尺寸，CSS 仅缩放显示。
- 字号、描边、内边距是输出像素；修改输出分辨率保持这些数值，位置比例保持不变，不隐式重排用户配置。
- 默认 `x=0.1`、`y=0.82`、`maxWidth=0.8`、居中对齐、白字、字号为输出高度的 5%（取整并限制到字号范围）、行高 1.2、黑色半透明背景。标题可直接调整位置和样式。
- 允许文字框延伸到画面下方，渲染按画面裁切；编辑器显示越界提示，不静默缩字或截断工程正文。

### 2.3 初始输入限额

以下为首版工程决策，不是性能实测结论。T0 固化边界测试，T7 测量后如需调整，应同时更新契约、UI、文档和测试。

- 每时间线最多 2,000 条文字，每条最多 4,096 个 Unicode 码点，总正文最多 200,000 个码点；空白正文可保留在未提交输入中，但不能作为正式文字保存。
- 最多 16 个字体资源；单字体最多 32 MiB，实际使用字体总量最多 64 MiB；首版仅静态 TTF / OTF。
- 字号 `[1,512]`、行高 `[0.8,3]`、描边 `[0,32]` 像素、背景内边距 `[0,128]` 像素、不透明度 `[0,1]`；颜色沿用 `#RRGGBB`。
- 坐标 `x/y` 在 `[0,1]`、宽度在 `(0,1]`，且 `x + maxWidth <= 1`；ID 非空且文档内唯一，所有 `fontId` 必须可解析。
- 正文将 CRLF/CR 规范为 LF；拒绝 NUL 及非排版控制字符。不解释 HTML、ASS 标签或可执行标记。
- Python 与 JS 对正文长度统一按 Unicode 码点计数，不能把 JS UTF-16 `length` 直接当同一口径。

### 2.4 字体策略

默认字体选用 Noto Sans CJK SC Regular。T2 从[官方仓库](https://github.com/notofonts/noto-cjk)固定一个发布版本，记录来源、精确版本及 SHA-256，随应用带入原始[许可证](https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE)。不在本计划中编造未经下载核验的 hash。

- 放置于 `public/fonts/`，Vite 构建和现有 wheel 的 `dist → _bundled/web` 复制机制一同带入。UI 第一次添加文字时将固定字体字节通过既有上传 / `asset.import` 登记到工程，成功后才引用；不修改只读安装资源。
- Agent 可用普通 `asset import --kind file` 登记同一文件；补一个只读 `opendirector timeline default-font` 辅助命令返回当前安装的文件路径、版本与 hash，供发现资源。它不创建工程、申请写会话或登记资产。
- 默认字体重复登记使用稳定操作 ID/已确认资产缓存；中断后可以重试同一次登记，不把失败描述为文字已经保存。
- 自定义字体通过同一上传探测及项目资产路径使用，UI 只列已验证可用的字体；不扫描用户系统字体目录，不依赖机器字体名字。
- 后端使用成熟字体解析库检查格式、必要表、字形覆盖及可变/集合限制；计划采用 `fontTools.ttLib.TTFont`，T2 加依赖前确定精确版本并固定到 `pyproject.toml`。不自写字体二进制解析器。
- 按指纹缓存字体解析结果，不能每次拖动、每帧渲染重新读取文件。正文更改时验证所选字体覆盖实际字符；首版支持横排中文、英文和常用标点，对缺字、emoji 组合等未覆盖字符给出具体错误。
- 浏览器按字体指纹分配内部 family，明确完成 `FontFace.load()` 后再布局；加载失败不能退回 `system-ui`。移除/取消后释放本次拥有的资源，不撤销其他消费者仍在使用的字体或 URL。

### 2.5 操作、历史和输出

- 文字 CRUD / 批量修改通过完整 `editor.save` 文档提交；Agent 从当前工程查询版本后调用相同命令，无须新增一组仅 Agent 使用的字幕写接口。
- 草稿内部一次拖动、一次输入确认、一次顺序变更对应一个撤销步骤；中文 IME 组合输入期间不自动提交或触发删除快捷键。
- 项目历史撤销/重做必须重新检查受影响编辑文档所有当前 owner 及父分组锁定；必要修复放在共享历史服务，而非文字入口绕过。
- 已打开草稿遇到 Agent/后台正式更改时保留草稿和版本依据；提供重新加载/取消路径，不能自动用新 revision 保存旧草稿。未改动草稿可重新获取权威状态。
- 导出先保存并获得确定版本，捕获完整文字、字体及素材快照。发布继续走 `timeline.publishRender`；版本已经变化时保留已生成文件并明确发布冲突，不把新版本标成旧 MP4 的依据。
- 旧成片通过已有 `object.get(objectId=editorDocumentId, revision=editorRevision)` 查询精确文档；新成片使用新资产 ID。先复用已有查询，不新增平行的版本 API。
- 本项保留客户端 MP4 渲染条件；Agent 可编辑文字不意味着已经具备关闭浏览器后后台导出能力。

### 2.6 可编辑包与交换格式

- 新增“导出可编辑包 / 导入可编辑包”，使用 `.timeline.zip`，由 Python 共用服务负责读取和生成；UI 和 `opendirector timeline export/import` 调用同一服务。采用标准库 `zipfile`，复用既有资源上传、登记、指纹和业务命令，不建设通用归档平台。
- 执行修订：导出与导入均采用现有上传边界的 **512 MiB** 上限；不新增独立的大文件上传模式，以免生成本应用无法重新导入的包。包契约放在独立的 `domain/creation/timeline_packages.py`，由同一生成脚本输出 Schema / TypeScript。
- 包格式 `opendirector-timeline-bundle` v1 包含 `manifest.json`、`timeline.json`、`assets/<fingerprint>.<ext>` 和默认字体许可证。`timeline.json` 保存正式 `TimelineData`；manifest 列出资源条目、kind、MIME、字节数、SHA-256、原资源引用和 `requiredCapabilities: ['timeline.text.v1']`。原引用仅作包内映射键，不是目标工程身份。
- 包内可以按指纹去重文件字节，但不能因此合并不同逻辑资源身份；导入子操作 ID 依据包内逻辑资源键生成，映射保留每个来源的身份。同名或同内容不证明来源相同。
- 导出指定 `editorId + revision`，只读获取该精确版本并打包；UI 有未保存草稿时先按既有规则保存，再请求确定版本的包。Agent 无需打开时间线面板即可导出。
- 导入采用已有上传暂存边界接收 ZIP，先完整校验格式、条目、指纹和契约，再登记资源，最后以 `creation.batch` 原子提交编辑文档与必要画布项。默认创建新时间线；替换现有时间线必须显式提供目标 ID 和预期版本。
- 导入是可恢复的组合操作：固定 `operationId`、包 hash、目标及版本依据；每个资源登记使用确定性子操作 ID，重试复用原回执。最终写入失败时保留已登记资源清单及原因，不能把部分登记称为完整导入，也不能换版本自动覆盖。
- 原生包的承诺是恢复**本次导出的时间线版本**，不迁移整个工程历史或所有旧成片。来源工程不需要保持在线；实际资源重新登记到目标工程后仍可编辑与导出。
- 含文字的独立 timeline JSON 使用新版格式/必需能力标记；现有无文字 v1 继续读取。JSON 不含资源字节时明确标为同工程结构交换；跨设备完整续编使用原生包。
- 保留既有 `.canvas` 全画布入口；含新文字能力时提升其格式版本并完整收集字体/正文来源资源，避免旧客户端接受后丢字。只保证当前画布文档的已有语义，不在本项扩展为全部输出历史迁移。未知版本/能力明确拒绝。
- 首版不实现 FCPXML 标题模板映射：含文字时阻止 FCPXML 和旧 FCPXML ZIP 导出，并提示使用 MP4 或原生可编辑包；无文字工程保持原行为。

## 3. 文件职责与任务依赖

下列“新建”是计划文件，不表示已经存在。现有大组件只增加组合和入口，文字专用交互拆到独立组件。

| 层次 | 主要文件 | 职责 |
| --- | --- | --- |
| 领域契约 | `packages/core/src/opendirector/domain/creation/editors.py`、`src/contracts/{generated.ts,creation.schema.json}` | 字段、约束、默认值、Schema |
| 后端时间线辅助（新） | `packages/core/src/opendirector/application/creation_timeline.py` | 实际字体/文本引用校验、来源收集、共享时长 |
| 字体探测（新） | `packages/core/src/opendirector/media/fonts.py` | TTF/OTF 探测、覆盖检查、缓存 |
| 上传与历史 | `infrastructure/creation_uploads.py`、`application/creation_canvas.py`、`application/creation_history.py` | 字体登记、保存/发布、锁及依赖保护 |
| 安装资源 | `public/fonts/`（新）、`pyproject.toml`、`installation.py`、`cli.py` | 固定字体、解析依赖、CLI 发现路径 |
| 投影与数据边界 | `src/canvas/model.ts`、`dataBoundary.ts`、`src/backend/creationProjection.ts`、`creationEditorSession.ts` | 前后端往返、深拷贝、变化识别、版本依据 |
| 文字操作（新） | `src/canvas/timelineText.ts` | 纯数据 CRUD、层次、帧范围及活动文字查询 |
| 文字渲染（新） | `src/canvas/timelineTextLayout.ts`、`timelineTextRenderer.ts` | 排版结果、字体加载、Canvas 共享绘制 |
| 文字 UI（新） | `src/canvas/TimelineTextInspector.tsx`、`TimelineTextLane.tsx`、`TimelineTextPreview.tsx` | 属性、时间条、画面定位与预览 |
| 编辑/渲染集成 | `TimelineEditor.tsx`、`timeline.ts`、`timelineRender.ts`、`timeline-editor.css` | 接入既有时间线，不改编码架构 |
| 原生包（新） | `packages/core/src/opendirector/application/creation_timeline_packages.py`、`infrastructure/timeline_package_imports.py`、`src/backend/timelinePackages.ts` | 共用导入导出、可恢复登记、前端适配 |
| 原生包入口 | `apps/api/src/opendirector_api/creation.py`、`packages/core/src/opendirector/cli.py` | UI/CLI 同一请求与回执 |
| 既有导出与归档 | `timelineExport.ts`、`canvasArchive.ts`、`zipArchive.ts`、`storage.ts` | 交换格式门禁、现有画布包的新能力保护 |
| 文案/说明 | 两种语言的 `timeline.ts` / `errors.ts`、API `localization.py`、两种语言使用指南 | 对等文案、错误及明确能力边界 |

依赖关系：`T0 → T1 → (T2 与 T3 的基础部分) → T4`；`T5` 依赖 T1/T2；`T6` 依赖 T1/T2/T3；`T7` 验证全部。T2 与 T3 可在类型冻结后并行，但同时修改 `creationProjection.ts` 的部分必须由同一负责人集成。

## 4. 实施任务

### T0：固定验收样例和改动前证据（0.5–1 人日）

**Files:** 新建 `tests/fixtures/timeline-text/`；复用 `tests/test_creation_storage.py`、`tests/browser/timeline_workflow.mjs`。本阶段不改产品行为。

**Interfaces:** 产出可追溯到基线 SHA 的无文字工程持久化 fixture（含实际 command / receipt / fingerprint）、固定小媒体样例和验收场景说明；后续任务直接复用。

- [x] 在修改契约前，用现有公开服务创建并保存无文字时间线，固化必要的提交记录；注明基线，不包含用户项目或凭证。
- [x] 固定 24 fps / 640×360 场景：两段视觉素材、两个音频片段；文字 A 为 `[1,3)` 的两行中文，B 为 `[2,4)` 的中英混排且覆盖 A，片尾文字延伸到媒体结束后 1 秒。
- [x] 固定纯文字、无文字、字体缺字/损坏、Agent 与 UI 交错、导出期间修改五组额外场景；使用同一组 ID 和预期时刻供所有任务验证。
- [x] 在基线运行相关现有测试，记录真实结果；已存在失败单列，不能当新功能通过。建议命令：`node --test tests/canvasTimeline.test.ts tests/canvasTimelineExport.test.ts` 及 `.venv/bin/python -m pytest tests/test_creation_timeline_render.py tests/test_creation_storage.py -q`。
- [x] 检查 fixture 是最小且可再分发的；作为后续 T1 提交的一部分保存，不提交本地运行日志或用户素材。

### T1：文字契约、时序与完整保存链路（2–3 人日）

**Files:** 修改 `domain/creation/editors.py`、`src/canvas/model.ts`、`dataBoundary.ts`、`timeline.ts`、`src/backend/creationProjection.ts`；新建 `src/canvas/timelineText.ts`；生成 `src/contracts/generated.ts` / `creation.schema.json`。

**Tests:** 新建 `tests/test_creation_timeline_text.py`、`tests/timelineText.test.ts`；扩展 `tests/test_creation_contracts.py`、`tests/test_creation_storage.py`、`tests/creationContracts.test.ts`、`tests/creationEditorSession.test.ts`。

**Interfaces:**

- 产生第 2.1 节所有契约；前端投影将 `fonts` 映射为带 `AssetRef` 和临时 `src` 的专用字体资源，不扩大 `CanvasResource` 对普通媒体的允许范围。
- Python `timeline_text_frame_range(start: float, end: float, fps: int) -> tuple[int, int]`、`timeline_duration(data: TimelineData) -> float` 放在领域编辑器模块；TypeScript `timelineTextFrameRange(start: number, end: number, fps: number): readonly [number, number]` 放在 `timelineText.ts`。
- `activeTimelineText(timeline: TimelineData, frame: number): readonly TimelineTextOverlayView[]` 返回保留叠放顺序的当前文字；`timelineDuration` 包含文字结束时间。

- [x] 先写失败测试：空文字集合不进入旧文档序列化；T0 历史 fixture 原样重开/重放；重复 ID、未知字体、非法时间、非法颜色/范围/超限正文拒绝。
- [x] 明确断言：`timelineTextFrameRange(1, 3, 24)` 等于 `[24,72]`；帧 23/72 不显示，24/71 显示；仅文字 `[2,4)` 的总时长为 4；FPS 24→30 保持秒数。
- [x] 运行上述新增测试，确认失败原因是缺失功能；再实现契约与前后端对应逻辑。
- [x] 覆盖 `copyTimeline` 深拷贝、`sameNodeData` 对纯文字/字体变更的识别、投影双向映射、JSON 读取、节点复制及保存后的重开。仅靠 TypeScript 类型编译不视为覆盖。
- [x] `nodeResources`、跨工程复制及文本来源 hydration 同步处理 View 资源；字体留在专用资源集合，不能为接入字体而放宽普通媒体剪辑规则。正文来源缺失时保留可解释的来源信息并拒绝依赖该来源的保存/导出，不自动清空引用。
- [x] 执行 `.venv/bin/python scripts/generate_contracts.py`，再执行同脚本 `--check`；生成器若不能保留 `exclude_if` 字段可选性，修复生成规则并补对应测试，禁止手改生成文件。
- [x] 运行 `.venv/bin/python -m pytest tests/test_creation_timeline_text.py tests/test_creation_contracts.py tests/test_creation_storage.py -q` 和 `node --test tests/timelineText.test.ts tests/creationContracts.test.ts tests/creationEditorSession.test.ts`，预期全部通过。
- [x] 审查本任务差异后按明确路径提交：`feat: add retained timeline text contracts`。

### T2：固定字体、文本来源与实际依赖（2–3 人日）

**Files:** 新建 `media/fonts.py`、`application/creation_timeline.py`、`public/fonts/NotoSansCJKsc-Regular.otf`、`public/fonts/LICENSE.txt`、`public/fonts/manifest.json`；修改 `infrastructure/creation_uploads.py`、`application/creation_canvas.py`、`pyproject.toml`、`installation.py`、`cli.py`；必要时扩展 `creationProjection.ts`。

**Tests:** 新建 `tests/test_timeline_fonts.py`；扩展 `tests/test_creation_assets.py`、`tests/test_creation_history_service.py`、`tests/test_cli.py`、`tests/test_installation.py`。

**Interfaces:**

- `inspect_font(path: Path) -> FontInspection`：返回验证后的 MIME、family、字体范围/覆盖信息；错误使用稳定错误语义。
- `require_font_characters(path: Path, fingerprint: str, text: str) -> None`：按指纹缓存解析，拒绝未覆盖的实际字符；换行等布局符号单独处理。
- `validate_timeline_resources(data: TimelineData, snapshot: ProjectSnapshot, assets: CreationAssets) -> None`：校验字体、正文来源及已有媒体可用性；供保存和发布共用。
- `timeline_source_refs(data: TimelineData) -> tuple[AssetRef, ...]`：汇总实际使用的媒体、字体、文字来源并确定性去重。
- `default_timeline_font() -> Path`：安装层返回只读资源路径；CLI `timeline default-font` 返回路径、版本、指纹 JSON。

- [x] 先写失败测试：后缀伪装、损坏字体、超限、集合/可变字体、错误 kind、缺字、相同 family 不同指纹、丢失正文来源均按约定拒绝。
- [x] 固定官方字体文件和解析库版本，记录 hash/许可证；验证从源码和 wheel 中均可读取，运行期间不下载字体。字体覆盖检查只承诺当前明确支持的文本范围。
- [x] 扩展 `inspect_file` 的字体分支，实际内容验证后登记为 `file` 和字体 MIME；使用原有上传事务和 `asset.import`，不新增私有文件写入口。
- [x] UI 默认字体和 Agent 导入同一资源后调用 T1 文档写入；从纯文本素材创建时读取固定版本正文，保存 `sourceAsset`。源正文之后变化不会自动替换文字。
- [x] 验证当前文档、可撤销历史及旧成片 provenance 中引用的字体/来源都能被 `asset.usage` 查到，删除预览和实际删除均保护；未引用资源按已有规则处理。
- [x] 运行 `.venv/bin/python -m pytest tests/test_timeline_fonts.py tests/test_creation_assets.py tests/test_creation_history_service.py tests/test_cli.py tests/test_installation.py -q`；预期通过且不访问真实模型。
- [x] 按明确路径提交：`feat: retain timeline fonts and text source assets`。

### T3：文字编辑交互与 UI/Agent 交错（3–4 人日）

**Files:** 新建 `TimelineTextInspector.tsx`、`TimelineTextLane.tsx`、`TimelineTextPreview.tsx`；扩展 `timelineText.ts`、`TimelineEditor.tsx`、`timeline-editor.css` 和双语时间线词条。必要的宿主回调集中在 `CanvasWorkspace.tsx`，修改前核对其他任务差异。

**Tests:** `tests/timelineText.test.ts`、`tests/creationEditorSession.test.ts`；新建 `tests/browser/timeline_text_editing.mjs`。

**Interfaces:**

- `addTimelineText(timeline: TimelineData, overlay: TimelineTextOverlayView): TimelineData`、`updateTimelineText(timeline: TimelineData, id: string, patch: TimelineTextPatch): TimelineData`、`removeTimelineText(timeline: TimelineData, id: string): TimelineData`、`reorderTimelineText(timeline: TimelineData, orderedIds: readonly string[]): TimelineData` 均返回新值，并执行同一客户端预检。
- `TimelineTextPatch` 只包含可编辑正文/时间/位置/宽度/fontId/style；顺序仅通过 reorder 修改。
- Inspector/Lane 接收选中 ID 和操作回调，不直接持久化；Preview 的最终绘制由 T4 接入，临时占位不算交付。

- [x] 先写失败测试：CRUD 不丢其他轨道、重排不换 ID、一次拖动只增加一次撤销、删除已选文字清理选择；媒体裁剪与速度变化不移动文字。
- [x] 新增“添加文字”和“从文本素材创建”；文字时间条采用专用区域，重叠条目按叠放顺序分行，编辑器选择用 `{kind: 'clip'|'text', id}`，避免与媒体选择混淆。
- [x] 属性面板支持完整第 2.1 节样式，预览支持拖动定位；指针移动仅更新临时预览，结束后形成一次草稿变更，取消拖动不留历史。
- [x] 中文组合输入结束/字段确认后再建立一次正文编辑；文本框内 Delete、空格和撤销键优先交给输入控件。
- [x] 保存沿用 `CreationEditorSession`；新增资源导入失败、保存未知、版本冲突、节点/父组锁定均保留草稿及原版本依据。不能刷新 revision 后自动重试旧内容。
- [x] 用同一后端命令让 Agent 创建的文字在 UI 可见可改，再从 UI 保存结果经 Agent 修改；验证面板关闭不丢正式状态，面板未改草稿能刷新，已改草稿提示冲突。
- [x] 运行 `node --test tests/timelineText.test.ts tests/creationEditorSession.test.ts` 及 `node tests/browser/timeline_text_editing.mjs`；脚本自建隔离 API/Vite/工程，预期保存重启后数据一致。
- [x] 按明确路径提交：`feat: edit timed text in the native timeline`。

### T4：共享布局、预览和真实 MP4（2–3 人日）

**Files:** 新建 `timelineTextLayout.ts`、`timelineTextRenderer.ts`；修改 `TimelineTextPreview.tsx`、`timelineRender.ts`，沿用 `mp4Export.ts` 编码入口。

**Tests:** 新建 `tests/timelineTextLayout.test.ts`、`tests/browser/timeline_text_render.mjs`；复用 `tests/browser/mp4_export.mjs`。

**Interfaces:**

- `layoutTimelineText(overlay: TimelineTextOverlayView, size: {width:number;height:number}, measure: (text:string)=>number): TimelineTextLayout`；返回行文本、基线位置、背景矩形、描边参数及越界信息，不访问工程状态。
- `prepareTimelineFonts(timeline, signal): Promise<TimelineFontSession>`；session 提供按 `fontId` 取 family 的函数及 `dispose()`。
- `drawTimelineText(ctx, timeline, frame, fonts): void`；预览与 MP4 的唯一文字绘制入口。

- [x] 先写确定性布局失败测试：显式空行、中文换行、中英混排、不同对齐、背景内边距、描边和层次。换行按 Unicode grapheme 分段：保留显式换行，优先英文词边界，超宽单词才按 grapheme 拆分；不拆开组合字符。
- [x] 保持一个排版实现，使用加载完成后的真实字体测量；缓存键包含文字/样式/宽度/字体指纹，时间或播放头变化不重复计算未变排版。
- [x] 预览画布使用输出分辨率，播放头映射为 `floor(time*fps + 1e-9)`；文字与视觉内容使用同一输出画面边界。
- [x] 修改 MP4 draw：清黑底、可选绘制视觉、最后无条件查询并绘制当前帧文字；移除会跳过纯文字/片尾文字的提前返回。
- [x] 在 24 fps 样例中解码 MP4 的 23/24/47/48/71/72/95/96 帧，检查首末帧、重叠顺序、文字区域及片尾；不得用整帧缩成一个像素来证明中文正确。
- [x] 比较预览原尺寸文字区域与解码帧：帧边界必须准确，文本框定位偏差不超过 1 个输出像素；颜色/边缘允许 H.264 压缩误差。中文字形、换行及层次另保留人工对照截图，不能仅以像素阈值宣称文字正确。
- [x] 验证字体加载失败、缺字、取消导出、关闭编辑器和重复打开时资源可释放，不能产生缺字成片或泄漏对象 URL。
- [x] 运行 `node --test tests/timelineTextLayout.test.ts tests/timelineText.test.ts`、`node tests/browser/timeline_text_render.mjs` 和现有 MP4 脚本；预期真实文件及音频回归通过。
- [x] 按明确路径提交：`feat: render timeline text consistently in preview and MP4`。

### T5：发布依据和历史锁定（0.5–1.5 人日）

**Files:** `application/creation_canvas.py`、`creation_timeline.py`、`creation_history.py`、`src/backend/timelinePublication.ts`；版本查看入口仅复用现有 `object.get`。

**Tests:** 扩展 `tests/test_creation_timeline_render.py`、`tests/test_creation_history_service.py`、`tests/creationEditorSession.test.ts`。

**Interfaces:** 发布调用 T1 `timeline_duration`、T2 `validate_timeline_resources/timeline_source_refs`；provenance 仍使用现有 `editorDocumentId/editorRevision/sources`，不另建执行台账。

- [x] 先写失败测试：文字延长总时长的合法视频可发布；错误时长/缺字体拒绝；改字后第二次发布使用新资产且旧输出、旧文档依据均不变。
- [x] 断言 `object.get` 指定旧 `revision` 返回原正文和字体引用，即使当前时间线已修改；不允许返回最新文档冒充旧版本。
- [x] 保存后开始渲染，再由另一写入者修改/锁定时间线，发布必须返回冲突/锁定拒绝，原生成文件可以下载，不能伪造成功。
- [x] 增加“编辑文字→锁定节点或父组→项目 undo/redo”测试；在共享历史恢复路径验证目标文档的 owner 锁。测试合法的解锁操作自身仍可按既有语义撤销，避免阻断正常历史。
- [x] 运行 `.venv/bin/python -m pytest tests/test_creation_timeline_render.py tests/test_creation_history_service.py -q` 及相关 TS 会话测试；预期来源、版本、锁定与重放一致。
- [x] 按明确路径提交：`fix: preserve timeline text publication and history constraints`。

### T6：UI/Agent 共用可编辑包与交换门禁（4–5 人日）

**Files:** 新建 `application/creation_timeline_packages.py`、`infrastructure/timeline_package_imports.py`（均位于 `packages/core/src/opendirector/`）、`src/backend/timelinePackages.ts`；修改 API `creation.py`、CLI `cli.py`、`domain/creation/editors.py`（包请求/manifest 类型）、`canvasArchive.ts`、`timeline.ts`、`timelineExport.ts`、`TimelineEditor.tsx`、`storage.ts` 及相关双语词条。

**Tests:** 新建 `tests/test_timeline_packages.py`、`tests/timelinePackages.test.ts`；扩展 `tests/test_cli.py`、`tests/canvasArchive.test.ts`、`tests/canvasTimelineExport.test.ts`；新建 `tests/browser/timeline_text_archive.mjs`。

**Interfaces:**

- `CreationTimelinePackages.export(project_id: UUID, editor_id: UUID, revision: int) -> Path`：在受控临时目录生成包并交给流式响应，响应完成/取消后清理；不修改工程或申请写会话。
- `TimelinePackageImportRequest`：`operationId`、`uploadHandle`、`mode: create/replace`、稳定 `editorId`、创建模式的 `itemId`、替换模式的 `expectedVersions`；目标项目由路由提供。
- `CreationTimelinePackages.import_package(project_id: UUID, request: TimelinePackageImportRequest, *, session, source) -> TimelinePackageImportReceipt`：调用上传/资产/编辑业务服务；最终文档和画布项仅由一个 `creation.batch` 写入。
- `TimelinePackageImportReceipt`：`operationId`、状态 `registered/applied/rejected`、`editorId`、已登记资源 ID、最终业务回执或失败原因。可恢复记录固定原请求和包指纹；失败重试不能替换输入。
- API：`GET /api/creation/projects/{projectId}/timelines/{editorId}/package?revision=...`、`POST /api/creation/projects/{projectId}/timeline-package-imports`，以及按 `operationId` 查询导入记录；遵循既有请求、会话和错误约定。
- CLI：`timeline export --editor-id ID --revision N --output FILE`；`timeline import FILE --operation-id ID` 默认创建新时间线，显式 `--replace-editor ID --expected-revision N` 才替换。CLI 负责上传文件并调用相同 API，不另写包解析器。
- 前端 `exportTimelinePackageFile(client, editorId, revision, signal): Promise<Blob>`、`importTimelinePackageFile(client, file, request, signal): Promise<TimelinePackageImportReceipt>` 只适配传输和进度；不重建业务规则。

- [x] 先写失败测试：包有真实字体/来源字节；导入后正文、时间、样式和层次不变；缺资源、重复路径、错误 CRC/hash、未知能力或跨项目伪引用拒绝。
- [x] 建立 v1 manifest 和正式时间线契约，拒绝任意其他业务对象。限额：归档最大 512 MiB、条目最多 4,096、声明及实际解压总量最大 2 GiB；单资源按现有媒体上限及 T2 字体上限检查。使用受控暂存目录和流式读取，解压前及过程中限制总量，不信任路径、链接或 ZIP 头。
- [x] 导出只读获取精确 revision，包含该版字体与来源；默认字体许可证随包交付。导入先验证全部清单和资源再进行登记，不能把输入包的来源描述当成真实本地执行记录。
- [x] 实现导入记录及确定性子操作 ID；复用 `CreationProjects.receipt`、上传与 `asset.import` 回执。覆盖“第 N 个资源登记后进程退出”“最终批次已成功但响应丢失”两种故障：重试不重复创建资源/时间线，同 ID 异输入拒绝。
- [x] 替换模式在最终提交时再次检查目标 revision、节点/父组锁；失败保留已有项目及可解释的已登记资源状态。创建模式不切换当前工程；取消、失败和部分登记不能显示完整成功。
- [x] UI 导出先保存草稿再指定版本；UI 导入成功后读取正式快照继续编辑。Agent 通过相同 API/CLI 能在面板关闭时完成包操作。
- [x] 含文字的 FCPXML / 旧 ZIP 明确拒绝；timeline JSON 提升版本。既有全画布 `.canvas` 含文字时提升能力/格式并收集 View 资源，旧客户端应拒绝，当前客户端往返不丢字。
- [x] 真实执行 UI 导出 A→CLI 导入 B，及 CLI 导出 B→UI 导入 C；关闭源工程后重开目标、改一字并再次导出 MP4。检查目标资源 ID 合法、字节指纹相同且不依赖源临时 URL。
- [x] 运行 `.venv/bin/python -m pytest tests/test_timeline_packages.py tests/test_cli.py -q`、`node --test tests/timelinePackages.test.ts tests/canvasArchive.test.ts tests/canvasTimelineExport.test.ts`、`node tests/browser/timeline_text_archive.mjs`；预期共用服务、故障恢复及真实往返全部通过。
- [x] 按明确路径提交：`feat: share editable timeline packages across UI and CLI`。

### T7：端到端验收、双语和交付证据（2–3 人日）

**Files:** 汇总前三个新增浏览器脚本；更新 `docs/guides/user-guide.zh-CN.md` / `user-guide.md`、`docs/guides/cli.md`、`docs/development/validation.md`，必要时更新架构的对象语义。只在功能实际实现后修改“已支持”的说明。

**Interfaces:** T0 场景贯穿 UI→正式项目→Agent→实际 MP4→原生包→新工程；证据记录代码 SHA、环境、命令和可复查文件。

- [x] 先按下方验收矩阵列明预期，运行代表场景；失败必须归入所属任务修复，不能靠删减验收范围结束。
- [x] 完成 UI 创建→Agent 改字→UI 改时间/样式→保存重开→导出→再改字发布新成片，并核对两份成片和各自编辑版本。
- [x] 实际切换 `zh-CN/en-US`，检查属性面板、错误、字体名称显示、导出提示、长英文布局及中文 IME；用户正文和业务 ID 不随语言改变。
- [x] 跑契约检查、全部相关单元/服务测试、前端构建和双语检查；最后跑既有时间线/MP4 浏览器回归，覆盖视觉剪辑和音频混音。
- [x] 在桌面 Chrome/Edge 实际验证 1080p 横屏和竖屏输出；无头 640×360 通过不能替代该项。若宣称跨平台，至少增加 Windows 的字体/编码/归档往返样例。
- [x] 记录 2,000 条文字、10 分钟时间线的编辑响应、峰值内存、导出时间及相对无文字样例的差异；字体布局应按需缓存，播放头拖动不逐条重新读文件。此项提供测量，不预先承诺倍速。
- [x] 检查默认字体随构建/wheel 分发且离线可用；记录来源许可证与解析依赖。运行库版本不得只写“latest”。
- [x] 审阅本次全部差异，保留失败处理和未验证平台的明确说明；按明确路径提交测试/文档，之后再准备 PR。不得关闭 Issue 直到全部必要验收有证据。

## 5. 最终验收矩阵

| 场景 | 必须观察的业务事实 | 归属 |
| --- | --- | --- |
| UI 与 Agent 编辑 | 双方读取并修改同一 editor ID；正文、样式、时间及回执一致 | T1/T3/T7 |
| 保存与重开 | 服务重启后正式项目保留全部文字、字体、层次及引用 | T1/T3/T7 |
| 旧无文字工程 | 固化旧提交可载入，重放指纹不变，原导出仍可用 | T0/T1/T7 |
| 撤销重做与锁 | 草稿手势一步撤销；正式历史遵守当前版本和节点/父组锁 | T3/T5 |
| 中文与时间边界 | 真实 MP4 首末帧、换行、字形和层次与预览一致 | T4 |
| 纯文字与片尾 | 无视觉片段时黑底文字仍出现，时长及发布校验一致 | T1/T4/T5 |
| 字体/来源依赖 | 查询能找到实际资产；删除受保护；缺失或缺字有可读错误 | T2/T5 |
| 新旧成片 | 两个不同输出资产；各自精确文档版本可查询；修改不覆写旧依据 | T5/T7 |
| 可编辑包 | UI 导出由 CLI 导入，反向也成立；目标无需源工程在线即可重开、改字并再导出 | T6/T7 |
| 不支持的交换格式 | 不产生静默丢字的 FCPXML；明确可用导出方式 | T6 |
| 未知提交和并发 | 同 ID 同输入重放；不同输入拒绝；冲突保留草稿与文件 | T3/T5 |
| 无字幕回归 | 视觉顺序、剪切、变速、音频混音、原生 MP4 行为保持 | T7 |

## 6. 工期、里程碑与设备

上述任务合计约 **16–24 人日，单人全职约 4–5 周**。这是熟悉现有架构的开发者、现有环境可用、无新增字幕格式解析/后台渲染的估计，不是运行时长承诺。与上一轮 12–18 人日粗估相比，增加了明确的旧指纹、历史锁，以及 UI/Agent 共用可编辑包和导入恢复工作。

| 里程碑 | 完成条件 | 单人累计工作日参考 |
| --- | --- | --- |
| M1 数据闭环 | T0/T1；UI/Agent 契约可保存、查询、重开，旧工程可读 | 第 3–4 个工作日 |
| M2 可编辑闭环 | T2/T3；固定字体、依赖保护、文字编辑与版本冲突可用 | 第 8–11 个工作日 |
| M3 成片闭环 | T4/T5；真实 MP4 正确，旧成片依据固定 | 第 10–16 个工作日 |
| M4 完整交付 | T6/T7；UI/Agent 跨工程续编、双语、回归和证据齐全 | 第 16–24 个工作日 |

建议四组可审阅提交/PR：① T0/T1；② T2/T3；③ T4/T5；④ T6/T7。中间阶段可合入基础能力，但不能在仅完成编辑 UI 时把 #87 标为完成。两位开发者可以在 T1 冻结后分工字体/后端与 UI/布局，集成测试仍需共同执行；工期不能简单除以二。

当前已识别设备为 **Apple M4 Pro / 24 GiB**，可作为开发和桌面导出验收机；实际吞吐由 T7 测量。准备 Node.js ≥24.22.1、Python ≥3.11、FFmpeg/ffprobe、桌面 Chrome/Edge 和可运行 Playwright 的环境。无需新增本地大模型服务器；Agent 对话验收可使用现有远程模型，自动测试优先使用隔离替身。若交付声明包含 Windows，则需可用的 Windows 测试机或同事的等价验收环境。

## 7. 实施完成时执行的检查

以下命令是实施后的检查清单，本次编写计划没有执行这些功能测试：

```sh
.venv/bin/python scripts/generate_contracts.py --check
.venv/bin/python -m pytest tests -q
npm test
npm run build
npm run check:i18n
node tests/browser/timeline_text_editing.mjs
node tests/browser/timeline_text_render.mjs
node tests/browser/timeline_text_archive.mjs
node tests/browser/timeline_workflow.mjs
```

新增浏览器脚本沿用现有时间线脚本的自建隔离服务模式，支持 `PYTHON`、`PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 和独立端口设置。现有 `mp4_export.mjs` 按[验证指南](validation.md)要求连接隔离 API/Vite 后单独运行。运行前检查环境和端口；不得连接用户真实工程凑测试结果。

交付说明必须包含：实际完成范围、执行命令/结果、真实 MP4 与预览对照、旧版本来源检查、原生包在新工程的往返结果、中英文截图、设备与浏览器版本，以及尚未验证的平台或格式。

## 8. 执行中的取舍

以下按作出决定的顺序记录，连同相应限制保留供后续审阅：

1. 沿用当时干净的检出并新建功能分支，没有另建 worktree。这样可复用现有环境；代价是缺少与同时写入此目录的其他任务之间的文件隔离。
2. 按计划拆分子任务并分别审查。这样可检查共享契约与真实输出；代价是增加上下文、协调和审查成本。
3. 不在本功能中修改最初复现的两个存储缓存基线失败。这样控制共享存储的改动范围；代价是完整测试套件仍不能报告全绿。
4. 前端拒绝显式 `null` 的文字/字体集合，与后端非空集合类型一致。代价是旧的非正式 `null` 输入不会被自动规范为空集合。
5. 原生包导出和导入统一采用现有上传边界的 512 MiB 上限，替代原先建议的 1 GiB。代价是更大的包需要独立的大文件上传方案。
6. 保留原定范围，不增加整工程历史迁移、字幕格式解析、自动转写、通用多视觉轨和后台渲染。代价是这些能力仍需后续明确任务。
7. 首轮只报告实际 macOS x86_64 / Rosetta 安装证据。代价是 Windows 和原生 arm64 安装须分别验收；后续用户授权的原生 arm64 补验现已通过，Windows 仍未验证。
8. 不扩展修复其余已在原始基线复现的 Python 失败，也不把停滞后终止的原生 Agent 集成算作通过。代价是这些既有问题和环境限制仍需独立处理。
9. 保留既有 Pydantic 依赖下限；本项目在此功能之前已使用 `exclude_if`。代价是没有新增针对早期 2.x 版本的兼容性保证。
10. 并行编辑期间不暂存共享文件；交付时仍保留未提交的工作区改动，不代替用户暂存或提交。代价是尚无按任务分组的 Git 提交，后续提交前需审阅完整差异。
