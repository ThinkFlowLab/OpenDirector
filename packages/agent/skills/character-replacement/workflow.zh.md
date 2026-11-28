# OpenDirector 画布工作流

用 `generation-spec update --file` 时，把完整生成配置放在 `payload.spec`，在 `expectedVersions` 提供当前版本。修正无效请求后使用新的操作 ID。

原生 Agent 的登录 shell 如果选中了另一套 OpenDirector CLI，优先使用当前轮次自带的 `./.opendirector-bin/opendirector`（Windows 使用 `.opendirector-bin/opendirector.cmd`）。该入口使用服务端同一套 Python 环境。

## 1. 选择项目和模型

使用当前项目，复用已有的源视频和肖像节点。运行 `opendirector project show` 和 `opendirector model list --kind video`。用 `opendirector model show <configuration-id>` 查单个配置，用 CLI 的 `--help-field payload` 查命令参数。准备分段分组前，通过 `opendirector capabilities` 确认当前 CLI 提供 `group publish-run` 和 `group start-run`（以及按需使用的 `group step-run`、`group regenerate-run-step`、`group adopt-run-candidate`、`group reconcile-run`）。核心发布或执行命令缺失时，停在计划阶段并报告版本不匹配。

准备片段前，确认 Agent 能打开一张肖像。素材只在项目里时，用 `opendirector query asset.preview --object-id <portrait-asset-id>` 取得 `preview.path`，再用看图工具打开。无法查看时，暂停并请用户选择支持图像输入的 Agent 模型。

从 `inputRules` 核对参考模式、输入限制、时长、分辨率和音频。换用兼容模型需要用户同意时，在修改画布前确认。

发布分段 Run 要求使用 `fasth3-omni` 部署（`inputRules.profile: fasth3-omni`）和 `videoMode: reference`；包含 `continuation` 续接段时还须声明 `inputRules.videoCapabilities.timelineGuides: true`。`group.publishRun` 当前会拒绝其他 profile（包括 `vllm-omni-h3`）。无法确认兼容的 FastH3 部署时保留草稿。

规划前检查一次模型可用性。若能力声明因协议未提供而显示 `unknown`，依据兼容配置的 `inputRules` 继续走分组预检。预检或提交拒绝时，报告具体原因。用[实际导帧任务](#使用时间线导帧续接源视频)验证导帧是否送达。复现旧结果时，核对部署、实际使用的换人适配器设置、分辨率和随机种子。

## 2. 搭建画布

按[分段计划](video-segment.zh.md)准备片段。原文件只在项目素材库时，用 `project show` 查素材 ID 和版本，再下载原始文件到尚不存在的路径（扩展名与原文件一致）：

```sh
opendirector asset download --id "$SOURCE_ASSET_ID" --revision "$SOURCE_ASSET_REVISION" --output source.mp4 &&
ffprobe -v error -show_streams -of json source.mp4
```

同一命令也可下载肖像，无需编辑租约。在 Agent Shell 中，把下载文件和检查用文件放在本轮执行目录。普通终端可在 `asset` 前加 `--project` 选择项目。

在 Agent Shell 中，用 `opendirector asset import <file> --kind <video-or-image>` 登记裁切片段或[符合处理条件的肖像衍生图](prompt-writing.zh.md#确定替换范围)。衍生自已有画布节点时，加 `--source-item-id` 和 `--source-asset-id`。把登记后的素材显示为节点，绑定到计划中的视频或肖像位置。每段剪好的源片是该段的 `<Video 1>`。

导入源片段前，用 `ffprobe -v error -show_streams -of json <clip>` 检查[内嵌原声](video-segment.zh.md#源片段保留原声)。核对切点和说话附近同步后，将检查过的片段版本作为 `<Video 1>`。只有需要另一份声音来源时才单独添加音频参考。保持 `generateAudio: true`（FastH3 适配器会拒绝 `generateAudio: false`）；交付音轨由时间线控制。

指定固定引用、输出设置或导帧时，用 `canvas create-generation --file`。固定引用来自画布节点时，`source` 填完整的 `AssetRef` 对象，`sourceVersion` 填画布节点版本。更新已有规格用 `generation-spec update`，传完整规格和当前修订号。

搭建草稿分组须满足以下不变量：

- **分组与生成规格。** 把生成节点和时间线放在一个未锁定、可见的顶层分组中。每段使用独立生成规格：`videoMode: reference`、显式整数 `parameters.seed`（`group.publishRun` 无条件要求固定种子；不要填写模型不支持的采样参数）以及唯一的固定源视频引用。
- **引用与 H3 导帧。** 固定每张外观参考图的版本并保持顺序。发布前清除 `materialOverride`，等待这些规格中尚未结束的任务完成。每个锚点显式保存 `parameters.h3Segment: {}`，续接段保存 `{guideReferenceId, sourceFrames}`。发布前回读规格；如遇视频参考数量超限，先核对 `h3Segment` 及唯一固定源视频引用。
- **时间线与交付音轨。** 每个分组使用独立可见的时间线（用 `creation.batch` 组合 `editor.create` 与 `canvas.show` 创建）和未使用的 `outputItemId`。时间线尺寸设为所选分辨率和宽高比下模型的实际输出尺寸，帧率与标准化源片一致。用 `opendirector editor save --help-field payload.document@timeline` 查看文档格式。先建一条空 `visual` 轨（无叠加字幕）和一条 `audio` 轨，音轨只放一段素材，从时间线零点开始（`inPoint: 0`，`outPoint` 取音轨自然终点与 `frameCount / fps` 的较早值，距画面末尾不超过一帧，`speed: 1`，`volume: 1`，未静音），绑定所选交付音轨的精确素材版本。编辑器 `inputConnections` 的 `sourceId` 填音频画布节点 ID、`slotId` 填该音频片段 ID，且素材版本一致。设置 `outPoint` 前探测未补静音的音轨时长。

### 核对已保存的连线

搭好画布后回读 `project show`。从项目视频节点裁出的片段应有可见素材节点，且 `provenance.sourceItemId` 指向原视频节点。计划中的肖像、源片段和导帧连线都应有指向正确生成规格的有效引用（`follow_current` 看 `source.id`，`pinned` 看 `sourceVersion.id`）。导帧来源出结果后检查实际解析到的素材。

画布缺连线时，先查已保存的引用和两端可见节点，再查**显示连线**开关。流程在发布前停止时，说明最后完成的步骤和缺失的节点或引用。

### 发布并核对计划

用任务名称作为画布分组标题。画布对象称为「分组」，每次执行称为「运行记录」。

用 `group.publishRun` 原子发布分组并生成可见计划节点。准备 `run.json`，填写 `payload.groupId`、`payload.plan`、`payload.assembly`，以及与用户语言或指定语言一致的 `planLocale`（`zh-CN` 或 `en-US`）。将 ASCII 分段图以 Markdown 代码块放在 `planNotes` 开头，其后逐段写明待换人物、实际送模首帧及其可辨认人物、续接段两张导帧的源帧号和可辨认人物，以及镜头分析理由。历史基线操作示例见 [Case03](examples/case03.zh.md)。

发布前必须通过两项检查：

- **帧计划与窗口几何。** 核对每段输入为连续真实源帧（禁止补帧、冻结或循环）、保留同步原声（源片有原声时）、满足 `17k+5` 且 `k >= 6`（至少 107 帧），且不超过 6 秒上限（24 FPS 上限 144 帧，最大对齐帧数 141）。对每段固定引用的输入视频解码数帧，实测帧数必须与请求生成帧数相等。检查每个生成拆点两侧及实际送模首帧（含倒放），避免可见待换人物面部被遮挡。运行 `validate_frame_plan.py`（加 `--enforce-window-limit --inspection shot-inspection.json --normalized-source "$NORMALIZED_SOURCE"`）。
- **人物轨迹与提示词。** 用确认帧沿源片追踪同一人物穿过切镜、换位和遮挡。逐段核对标题人物、已保存提示词映射、`shotSubjects` / `[Shot N]` 行（含空镜头）、`foregroundOccluder` 证据帧和有序固定肖像一致。素材或播放方向变化时，重查源片并重建。先运行下方命令，从检查记录生成提示词。裁片后加 `--check-clips`。用 `trim` / `atrim` 裁同步的真实源片区间，保留源音频自然结束点。送模片段及交付音轨禁止使用补帧、补静音、冻结和循环滤镜。导入并绑定片段后，从 `project show` 保存 `saved-project.json`，加 `--project-snapshot saved-project.json --soundtrack "$SOUNDTRACK"`，发布前核对实际片段、已保存提示词、有序肖像版本和导帧连线。预检报错时先修正。

```sh
opendirector skill-script character-replacement/scripts/check_replacement.py frame-plan.json shot-inspection.json prompt-options.json \
  --normalized-source "$NORMALIZED_SOURCE" --prompt-inputs replacement-prompt-inputs.json > prompts.json
```

按后端契约填写 `run.json`：

- `plan.source` 填标准化完整源片的精确 `AssetRef`，`fps` 和 `frameCount` 取实际解码值。`plan.entries` 用左闭右开 `[sourceStart, sourceEnd)` 按源片顺序覆盖 `[0, frameCount)` 一次（原样保留用 `kind: source`，生成用 `kind: generated`）。
- 每个生成条目指定 `itemId`、连续镜头 `shot` 和 `step`（每个镜头只标记一个 `kind: anchor`，其余为 `kind: continuation` 并填写同镜头内的 `upstreamItemId` 和两个不同的有序原始帧索引 `sourceFrames`）。复用同一生成节点交付多个区间时，沿用相同的 `shot` 和 `step`，并在 `assembly.clips` 中按交付顺序各填一条裁切。省略旧组装字段 `requireTimelineGuides` 和 `guideExemptItemId`。
- `assembly` 填写 `timelineItemId`、未使用的 `outputItemId`，以及按交付顺序排列的生成段 `clips`，每段 `outFrame - inFrame` 等于对应源片区间长度。反转时设置 `reverse: true` 和 `frameLimit`，并填写反转后的保留区间。

每条 `kind: generated` 的 `plan.entries` 都必须填写 `replacementPromptInputs`，值为渲染该节点时使用的结构化片段对象（包含 `shotSubjects`），重复使用同一节点时逐条复制同一个对象。保存渲染器输出的完整纯文本，素材单独绑定为引用。服务端在发布时用内置模板重新渲染并逐字核对，发现差异即拒绝并给出片段及首个差异行。

```sh
opendirector group publish-run --help-field payload
opendirector group publish-run --file run.json --expected-version "canvas_item:$RUN_ID:$RUN_REVISION"
opendirector canvas text show --id "$PLAN_ITEM_ID"
```

从发布回执取 `planItemId` 作为 `PLAN_ITEM_ID`。读取计划节点和 `project show`，确认该节点可见、已关联分组，且与 `runPlan`、组装配置、固定源片/肖像和导帧顺序一致。用户要求先审阅时，等确认后再启动。

## 3. 运行分组并检查输出

启动前将发布请求中的画布节点 ID 填入本地 `frame-plan.json` 各段的 `itemId`，保存最新的 `project show` 快照，然后用 `--project-snapshot saved-project.json --run-id "$RUN_ID"` 重跑 `check_replacement.py`。核对已发布的裁切、导帧索引和上游节点，以及已保存的提示词和引用版本。有差异先修正。

已获生成授权时，按用户要求选择执行模式：

- **自动全流程运行。** 选中已发布分组并点击**运行分组**，或通过 CLI 启动一次。后台按依赖顺序执行、从本次执行的上游结果取导帧，并自动完成组装与发布；关闭画布或结束 Agent 会话后仍会继续。
- **逐段审阅 / 单步执行。** 用户要求每段审核通过后再跑下游时，使用 `group step-run` 而非 `group start-run`。不带 `--execution-id` 调用 `group step-run --group-id "$RUN_ID"` 会以单步模式启动并在首步后自动暂停；审阅通过后再带 `--execution-id "$EXECUTION_ID"` 推进下一步。

```sh
opendirector --operation-id "$START_ID" group start-run --group-id "$RUN_ID"
opendirector query run.execution.get --object-id "$EXECUTION_ID"
opendirector query run.groupExecution.get --object-id "$RUN_ID"
```

为启动分配稳定的 `START_ID`，把回执里的 `runExecutionId` 记为 `EXECUTION_ID`。等待超时或响应丢失时，查询 `run.execution.get`（或 `run.groupExecution.get` / `run.groupExecutions.list`）；仅在启动未确认时用相同操作 ID 和输入重放。已发布分组的分段提交和组装只由分组执行器完成。

- **`failed`**：报告 `issue`，并用 `opendirector job show <job-id>` 查询相关 `steps[].jobId`。
- **`needs_review` 或 `issue.code: submission_unknown`**：保留执行 ID 和任务 ID，先核对供应商是否已受理，禁止另起新任务重提。待原任务状态明确（成功、失败、取消、过期或服务端确认不存在）后，执行对账：

```sh
opendirector --operation-id "$RECONCILE_ID" group reconcile-run \
  --group-id "$RUN_ID" --execution-id "$EXECUTION_ID"
```

- **暂停 / 继续 / 重跑整轮**：点击分组暂停或运行 `opendirector group pause-run --group-id "$RUN_ID"`，待当前已受理步骤结束后进入 `paused`。需要继续时用 `group resume-run --group-id "$RUN_ID"` 沿用已完成步骤；需要从头重跑同一已发布分组时用 `group restart-run --group-id "$RUN_ID" --execution-id "$EXECUTION_ID"`。

### 检查结果与重试

将保留区间与对应源片同速并排对照：检查每个可见动作的起点、方向和结束，确认动作按原顺序只出现一次；检查身份、替换范围和切点；人物交叉或遮挡时，也要核对未选中人物在交叉前、中、后的出入画和外观。

交付范围内每个已检查的镜头记录一行验收结果（源帧范围、生成原片帧范围、分配轨迹、结果）。切镜处对照前一镜末帧和后一镜首帧。特写或部分遮挡时，仍能看出源人物身份即判该镜不通过。拟用导帧来源按实际抽帧位置核对，存在漏换或错镜即弃用。

发现缺陷时，记录执行 ID、任务 ID、首次出错的源片帧和原始输出帧以及期望结果；改动前先读回冻结的提示词、引用版本、导帧和源片区间。按所需改动选择最小的重试路径：

1. **输入不变、仅单段重抽候选（`group.regenerateRunStep` + `group.adoptRunCandidate`）。** 已发布的提示词、引用、导帧和裁切本身无误，只想对失败段换新随机种子重抽并复用未受影响上游时：

```sh
opendirector --operation-id "$REGEN_ID" group regenerate-run-step \
  --group-id "$RUN_ID" --execution-id "$EXECUTION_ID" --item-id "$SEGMENT_ITEM_ID"
```

执行器会复用未受影响的上游结果、为 `SEGMENT_ITEM_ID` 生成新候选，并停在 `awaiting_selection` 返回 `candidates`。审阅候选后，可再次调用 `group regenerate-run-step` 继续抽样，或采纳通过的候选并自动续跑受影响下游及组装：

```sh
opendirector --operation-id "$ADOPT_ID" group adopt-run-candidate \
  --group-id "$RUN_ID" --execution-id "$EXECUTION_ID" --job-id "$CANDIDATE_JOB_ID"
```

检查解码后的首尾保留帧，以及每个接缝和计划切点两侧（含生成片段内部切镜）。记录残留偏移或未通过的区间，交付通过校验的成片节点并注明实测帧数、帧率和交付音轨。
