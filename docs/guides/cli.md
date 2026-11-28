# OpenDirector CLI

在仓库根目录通过 `pip install -e .` 安装统一 Python 包后使用 `opendirector`。安装自动构建前端并校验内置 Agent；已发布 wheel 携带对应资源。

```bash
pip install -e .
opendirector --help
opendirector serve --port 18000
opendirector dev --port 18000 --web-port 5173
opendirector canvas --help
opendirector canvas create-generation --help
```

`serve` 和 `dev` 在数据目录存在 `.opendirector/video-gateway.yaml` 时一并启动[视频转发层](video-gateway.zh-CN.md)，也可用 `--video-gateway FILE` 指定配置文件。 / `serve` and `dev` also start the [video gateway](video-gateway.md) when `.opendirector/video-gateway.yaml` exists in the data directory, or when `--video-gateway FILE` names a configuration.

普通终端默认连接 `http://127.0.0.1:18000`。使用 `--url` 或 `OPENDIRECTOR_API_URL` 指定服务，使用 `--project` 或 `OPENDIRECTOR_PROJECT_ID` 选择工程。全局选项放在子命令前。

```bash
opendirector project list
opendirector --project PROJECT_UUID project show
opendirector model list --kind video --search H3-Lite
opendirector model show MiniMax-H3-Lite
opendirector --project PROJECT_UUID asset import ./after.png --kind image
opendirector --project PROJECT_UUID canvas add-material --asset ASSET_UUID --x 0 --y 0
opendirector --project PROJECT_UUID video create   --model MODEL_CONFIG_UUID   --prompt "人物缓缓转头"   --duration 5   --first-frame SOURCE_CANVAS_ITEM_UUID
```

`canvas add-material` 和 `video create` 通过必填的 `--x`、`--y` 明确创建位置。Agent 先读取画布对象的位置、尺寸及分组，再安排新元素布局。`video create` 创建可编辑的生成节点与参考关系，返回 `specId` 和 `itemId`。所有画布修改命令以及批量事务通过共用返回层提供 `canvasItems`，包含元素身份、版本、位置、尺寸、父级、坐标系及可见性。位置未变化的操作也返回目标元素的几何信息，供后续布局判断。几何信息读取失败时，回执保留已提交状态并返回 `geometryReadError`。模型可通过配置 UUID 或唯一匹配的完整模型名指定。重名配置返回候选 UUID 和端点，由调用者明确选择。模型的输入模式必须支持所选参数。`--reference-item` 支持重复指定参考节点。提交生成时使用创建回执中的对象版本，后台任务由服务端继续执行。

### Run 自动布局 / Run auto-layout

在画布中右键顶层分组，选择「加入 Run 自动布局」。通过 CLI 或 Agent 新建 Run 时，在 `canvas.show` 的 group 对象设置 `autoLayout: "run"`，并将本轮的计划、片段和时间线节点的 `parentId` 设为该分组 ID。同批新增或改变尺寸的节点会在保存时统一排布。各轮以稳定顺序换行，锁定的 Run 和普通顶层节点作为固定占位。不同 Run 可复用已登记素材，各自保存生成配置和编辑文档。要重新整理，右键画布空白处选择「整理 Run」，或运行 `opendirector canvas layout-runs`。通过 `canvas update --item-id ID --auto-layout free --expected-version canvas_item:ID:REV` 恢复手动布局。

On the canvas, right-click a top-level group and select **Include in Run layout**. From the CLI or Agent, set `autoLayout: "run"` on the group in `canvas.show`, then set `parentId` on its plan, clip, and timeline nodes to that group ID. New and resized nodes are arranged in the same save. Runs wrap in a stable order around locked Runs and ordinary top-level nodes. Runs can reuse registered assets, and each Run owns its own generation configurations and editor documents. To arrange Runs explicitly, right-click the canvas background or run `opendirector canvas layout-runs`. Use `canvas update --item-id ID --auto-layout free --expected-version canvas_item:ID:REV` to return a group to manual layout.

```bash
opendirector --project PROJECT_UUID generation submit   --spec-id SPEC_UUID   --expected-spec-revision 1   --origin-item-id ITEM_UUID   --expected-version generation_spec:SPEC_UUID:1   --expected-version canvas_item:ITEM_UUID:1
opendirector --project PROJECT_UUID job show JOB_UUID
opendirector --project PROJECT_UUID job wait JOB_UUID... --timeout 300
opendirector --project PROJECT_UUID job wait --all --timeout 300
```

`job wait` 接受多个任务身份，`--all` 等待当前工程全部未结束任务，并在一次等待窗口内用一次服务端查询回答整组任务；返回每个任务的 `status`、`phase` 和成功后已登记的 `delivery`。需要减少等待调用次数时优先用 `--all`，不要为每个任务分别启动一次等待。等待组在第一次回答时确定并保持不变，因此等待期间结束的任务仍会被报告：失败任务计入 `failed`、携带 `errorDetails` 与 `recovery`，并以退出码 1 结束；整组结束时报错信息不会被静默省略。工程内没有未结束任务时返回 `jobs: []` 并在 `note` 中明确说明，不再让空结果看起来像全部成功；此时可用 `project show --summary` 查看每个任务最终状态。

`opendirector capabilities` 一次输出全部业务命令、摘要与必填字段（含未由命令契约生成、但已注册的 `job wait`、`query`、`model`、`asset import`、`timeline`、`voice` 等命令），`--compact` 省略非必填字段名与非必填选项。Agent 用它替代逐条执行 `--help` 的发现过程；仅在单个字段结构不清楚时用 `--help-field` 展开。`opendirector project show --summary` 输出对象身份、版本与状态而不含完整记录，工程较大时可避免结果被截断以及重复读取。

业务命令按对象分组，参数名使用短横线。复杂参数可使用 JSON 参数，或通过 `--file command.json` 读取含 `payload`、`expectedVersions` 和可选 `expectedPreview` 的对象。`--file -` 从标准输入读取。命令帮助包含从 Pydantic 业务契约派生的参数说明与示例。`--help-field PATH` 展开帮助中返回的结构化字段路径，例如 `opendirector canvas show --help-field payload.item@image.binding`。

CLI 输出 JSON。修改回执附带对应的 assetId、itemId、specId 及其列表，视频节点创建回执同时返回包含当前版本的下一步提交命令。参数解析错误直接显示该子命令的完整用法。成功退出码为 0，拒绝或执行失败为 1，参数解析错误及等待任务超时为 2。生成接受回执会在 `next.commands` 返回一条覆盖本次全部任务的 `job wait` 命令，带入服务地址、工程和任务身份。建议按回执等待；等待窗口超时后可以再次执行同一命令。`job wait` 超时结束等待，任务继续由后台执行。

修改命令可在子命令前传 `--operation-id UUID`。相同身份及输入重试复用原回执，输入不同则拒绝。文件导入重放也核对登记文件的内容指纹。需要跨进程恢复暂存上传时，预先通过 `--session UUID` 保持相同会话身份。结果未知时先查询回执，再决定后续操作。

读取类查询 `job.get`、`object.get`、`canvas.status` 与 `job.status` 不占用本轮执行锁，因此等待任务不会阻塞同轮其他工具调用。`job.status` 是 `job wait` 使用的批量查询：一次快照读取回答整组任务，并按需等待终态。

普通终端写入申请独立编辑租约，完成后释放。工程已在其他窗口编辑时会返回占用错误。使用 `--session UUID` 表示沿用已有授权会话，CLI 完成后保留该会话。

Agent 的 Shell 通过 PATH 使用同一个 `opendirector`。宿主提供受令牌保护的本轮连接、工程范围、编辑会话和执行目录，文件登记限制在本轮执行目录。每次调用产生业务活动及回执，供聊天与轨迹页展示。

## 在 Agent 命令中使用聊天引用

在 Agent 会话中，`project show` 按消息中的顺序返回 `turnReferences`。选择画布节点时，每项记录节点 ID 和提交时选中的 `AssetRef`。直接上传到聊天的文件只携带 `AssetRef`。创建生成节点时，可重复传入 `--turn-reference` 来固定引用版本。视频裁切需要画布视频节点，会发布一个新节点并在编辑快照中保存来源和裁切时间。

```bash
opendirector canvas create-generation --file plan.json --turn-reference IMAGE_REFERENCE_ID
opendirector video trim --turn-reference VIDEO_REFERENCE_ID --start 1.2 --end 1.7 --name clip.mp4
```

### Using chat references in Agent commands

Inside an Agent turn, `project show` returns `turnReferences` in message order. A selection from the canvas carries its source node ID and the `AssetRef` captured at submission. A file uploaded directly to chat carries only an `AssetRef`. Repeat `--turn-reference` on `canvas create-generation` to pin selected versions. `video trim` requires a video canvas node and publishes a new node with an edit snapshot recording its source and time range.

## 分段续接的导帧约束

用 `group configure-assembly` 保存 H3 分段计划，设置 `requireTimelineGuides: true`。只有 `guideExemptItemId` 指定的起跑节点可以省略导帧。其余片段在 `generation submit` 时指定计划中的 `originItemId`，并提供导帧引用与两个源帧号。修改裁切范围、调整成片顺序或移动节点时，已确认的导帧规则继续生效。恢复使用提交时保存的素材版本，组装也会核对本次采用的上游版本。

### Timeline guides for segment continuation

Save an H3 segment plan with `group configure-assembly` and set `requireTimelineGuides: true`. Only the starting node named by `guideExemptItemId` may omit the guide. Each other step submits with its planned `originItemId`, a guide reference and two source frame indices. Trimming, reordering and moving nodes preserve the confirmed guide policy. Recovery uses the submitted source version, and assembly checks it against the adopted upstream result.

## 发布与执行分段 Run / Publish and execute a segmented Run

在顶层分组中准备视频生成节点和时间线。生成节点使用 FastH3 的参考模式，设置随机种子，固定源片和参考图版本。时间线使用工作源片帧率，包含画面轨和一条覆盖整个交付区间的原声音轨。`plan.entries` 按成片顺序覆盖每个源帧，可保留原片，也可引用生成段。每个声明的镜头有一个锚点，续接段指定上游节点和两个取帧索引。`assembly.clips` 保存各生成段反转后的保留区间。计划可以用 `planLocale` 指定中文或英文并用 `planNotes` 补充说明。

Prepare the video generation nodes and timeline in a top-level group. Use FastH3 in Reference mode with a sampling seed and pinned source and image versions. Match the timeline to the working source frame rate with a visual track and one original soundtrack covering the delivery range. In playback order, `plan.entries` covers every source frame with retained footage or a generated segment. Each declared shot has one anchor. Continuations name their upstream node and two frame indices. `assembly.clips` supplies the retained ranges after any reversal. Set `planLocale` for the display language and `planNotes` for review notes.

```bash
opendirector group publish-run --help-field payload
opendirector group publish-run --file run.json --expected-version canvas_item:RUN_ID:REV
opendirector group start-run --group-id RUN_ID
opendirector query run.execution.get --object-id EXECUTION_ID
opendirector group pause-run --group-id RUN_ID
opendirector group resume-run --group-id RUN_ID
```

发布回执中的 `planItemId` 指向画布计划。启动回执的 `runExecutionId` 可用来查询每段任务和成片素材。关闭画布或结束 Agent 会话后，后端仍会继续执行。

The publication receipt points to the visible plan via `planItemId`. Query `runExecutionId` from the start receipt for segment jobs and the finished asset. The service continues after the canvas or Agent session closes.

暂停请求会阻止下一段生成或组装。已受理的步骤会先完成，状态从 `pausing` 转为 `paused`。继续时沿用原执行 ID 和已完成步骤。重新打开画布后，也可以用 `opendirector query run.groupExecution.get --object-id RUN_ID` 找到当前执行。

Pause stops the Run from starting its next generation or assembly step. An admitted step can finish before the status changes from `pausing` to `paused`. Resume keeps the execution ID and completed steps. Use `opendirector query run.groupExecution.get --object-id RUN_ID` to find the latest execution after reopening the canvas.

### 单步运行和重新生成 / Step and regenerate

`group step-run` 放行下一段生成或最后的组装。首次单步可以省略 `--execution-id`。`group restart-run` 从发布的计划创建新一轮运行。`group regenerate-run-step` 基于已保存的执行，只为所选片段生成新版本并等待采用。`group adopt-run-candidate` 选择该版本，沿导帧依赖继续执行。旧成片可从运行历史打开，新成片组装成功后才更新画布上的成片。

`group step-run` admits one segment or the final assembly. Omit `--execution-id` for the first step of a new Run. `group restart-run` starts a new execution from the published plan. `group regenerate-run-step` generates one new version of the selected segment and waits for adoption. `group adopt-run-candidate` adopts the selected version and continues through its guide dependencies. Earlier films remain accessible in the execution history. The canvas switches to the new film after assembly succeeds.

```bash
opendirector group step-run --group-id RUN_ID --execution-id EXECUTION_ID
opendirector group restart-run --group-id RUN_ID --execution-id EXECUTION_ID
opendirector query run.groupExecutions.list --object-id RUN_ID
opendirector group regenerate-run-step --group-id RUN_ID --execution-id BASE_ID --item-id SEGMENT_ID --expected-execution-id CURRENT_ID
opendirector group adopt-run-candidate --group-id RUN_ID --execution-id NEW_ID --job-id CANDIDATE_JOB_ID
```

### 核对任务 / Reconcile jobs

Run 显示待核对时，可用 `group reconcile-run` 读取已保存的原任务结果。供应商已确认任务结束或不存在时，会开放重新生成。

When a Run needs review, `group reconcile-run` checks the original job receipt. Regeneration becomes available after the provider confirms that the job has ended or no longer exists.

```bash
opendirector group reconcile-run --group-id RUN_ID --execution-id EXECUTION_ID
```


## 检查已有生成结果

`job show` / `job wait` 在任务成功后返回 `delivery`：已登记的 AssetRef、当前采用状态及展示该素材的画布项。生成成功不等于质量验收；Agent 应检查现有素材。复制到执行目录做媒体探测、抽帧和审看不需要重新发布，也不应为同一次交付新增画布项。编辑产生的新交付文件才需要登记；独立副本展示应有用户要求。

## 下载原始素材

从 `project show` 获取素材 ID 和版本，用 `asset download` 将指定版本的原始字节写入新文件。下载无需编辑租约，与项目登记分开。Agent Shell 使用当前项目，输出路径须位于本轮执行目录内。

```bash
opendirector --project PROJECT_UUID asset download --id ASSET_UUID --revision 1 --output ./source.mp4
```

### Download original assets

Use `project show` to get the asset ID and revision. `asset download` copies the original bytes of that revision to a new file. This read requires no editing lease or asset registration. In Agent Shell the active project is already selected, and the output path must stay inside the current execution directory.

## 更新生成配置

`generation-spec update` 替换完整配置，不是局部补丁。先用 `opendirector query object.get --object-id <spec-id>` 读取当前配置，修改需要调整的字段后，将完整对象放入命令文件的 `payload.spec`，并携带当前 `expectedVersions`。

`--spec` 接收 JSON 对象，不接收配置 UUID；它会覆盖 `--file` 中的整个 `payload.spec`。命令文件已经包含配置时只需 `opendirector generation-spec update --file update.json`。保留 `purpose`、`modelConfigId`、`prompt`、`promptContent`、`parameters` 和 `currentResultId`；清空可空字段时显式使用 `null`。

素材查询使用 `query object.get`；获取预览访问使用 `query asset.preview`。不存在 `query asset` 类型。

### Updating generation configurations

`generation-spec update` replaces the complete configuration. Read it with `opendirector query object.get --object-id <spec-id>`, edit the intended fields, and submit the complete object as `payload.spec` with its current `expectedVersions`. Keep `purpose`, `modelConfigId`, `prompt`, `promptContent`, `parameters`, and `currentResultId`; use explicit `null` to clear nullable fields.

`--spec` accepts a JSON object, not a UUID, and overrides the entire `payload.spec` from `--file`. If the file already contains the configuration, use `opendirector generation-spec update --file update.json` without `--spec`. Query assets with `query object.get` and obtain preview access with `query asset.preview`; `query asset` is not supported.

## 可编辑时间线文字与跨工程包

时间线文字与媒体使用同一 `editor.create` / `editor.save` 文档，正文、时间、样式、层次和字体资产均保存在工程中。先通过 `query object.get` 读取文档，保留完整文档结构并携带当前 `editor_document` 版本提交；不要直接修改项目文件。`editor save --help` / `--help-field payload.document` 提供正式契约。正文来源是可选的不可变文本资产引用，不会随着来源后续变化自动改写文字。

```bash
# 离线发现随安装分发的字体；不打开工程或登记素材
opendirector timeline default-font
# 将返回路径作为 file 素材导入目标工程，再在文档 fonts 中引用其 AssetRef
opendirector --project PROJECT_UUID asset import /path/to/NotoSansCJKsc-Regular.otf --kind file

# 从已保存的确定版本导出；输出文件必须尚不存在
opendirector --project SOURCE_PROJECT_UUID timeline export \
  --editor-id EDITOR_UUID --revision 3 --output ./captions.timeline.zip

# 默认创建新时间线，目标工程由 --project 明确指定
opendirector --project TARGET_PROJECT_UUID timeline import ./captions.timeline.zip \
  --operation-id IMPORT_OPERATION_UUID

# 只有显式替换才修改现有文档；需要目标的当前版本
opendirector --project TARGET_PROJECT_UUID timeline import ./captions.timeline.zip \
  --operation-id REPLACE_OPERATION_UUID \
  --replace-editor TARGET_EDITOR_UUID --expected-revision 2
```

包内包含文档保留的实际字体、剪辑及媒体库资源、正文来源和默认字体许可证；目标工程登记自己的资源引用，不依赖源工程地址。包上限为 512 MiB；不接受未知版本、未知能力、不完整资源或指纹不匹配的包。包导入回执区分资源已登记与文档已应用，只有 `applied` 表示时间线已经完成写入。重试使用相同 `--operation-id`、文件和参数；同身份不同输入会拒绝。最终替换仍检查版本、节点和父组锁，已登记资源不会被描述为完整成功。

Agent 在 macOS/Linux 执行目录导出失败时，输出位置可能保留不完整文件。请先检查文件，并选择新的输出文件名重试；既有文件不会被覆盖，也不会因失败清理而删除并发写入者的替换文件。失败回执不表示包已完整导出。

Agent 执行上下文可使用相同命令，路径须位于本轮执行目录。`timeline default-font` 返回安装目录中的只读字体路径；先将该字体复制到本轮授权执行目录，再通过 `asset import` 登记，不能直接以安装路径绕过执行目录边界。不要传入其他工程或会话以绕过当前授权。包导入/导出可在编辑面板关闭时调用，MP4 合成仍需前端浏览器参与。可编辑 JSON 只描述同工程结构；含文字的时间线不能导出为 FCPXML 或旧 XML 媒体包。

### Editable timeline text and portable packages

Text uses the same complete `editor.create` / `editor.save` document as media. Read the current document with `query object.get`, preserve its structure, and submit its current `editor_document` revision. The schema and nested fields are available through `editor save --help` and `--help-field payload.document`. `timeline default-font` finds the bundled offline font without opening a project; import that file into the target project before referencing its AssetRef. Text-source references retain immutable provenance and do not automatically refresh the wording.

The commands above export an exact saved revision, import it as a new timeline, or explicitly replace a target with `--replace-editor` and `--expected-revision`. Export destinations must not already exist. Native `.timeline.zip` packages include all retained font, clip, media-library and text-source resources plus the bundled font license; target resources belong to the target project. The package limit is 512 MiB. Unknown versions/capabilities, missing resources, and fingerprint mismatches reject import. Only an `applied` receipt confirms the completed timeline write; retry incomplete operations with the same operation ID, file, and arguments. Replacement rechecks the current revision and owner/parent locks.

An unsuccessful Agent export to its macOS/Linux execution directory can leave an incomplete file. Inspect the output and choose a fresh filename for retry. Existing files are never overwritten, and failure cleanup does not delete another writer's replacement. A failed receipt does not certify a complete package.

In an Agent execution context, files must remain inside the authorized execution directory and commands remain scoped to that context. `timeline default-font` returns a read-only installation path; copy that font into the authorized execution directory before using `asset import`. The installation path does not bypass that boundary. Package commands do not require an open editor. MP4 rendering requires the browser. Editable JSON describes same-project structure; FCPXML and legacy XML media bundles refuse text overlays.


## Voice library

`opendirector voice list --model MODEL_CONFIG_UUID` reads the full library and returns the selected model's connection identity, voices and adapter requirements. For a large MOSS library, request up to 150 voices per page.

```sh
opendirector voice list --model MODEL_CONFIG_UUID --page-size 150
opendirector voice list --model MODEL_CONFIG_UUID --page-size 150 --after "NEXT_CURSOR" --connection "CONNECTION_ID"
```

Use the previous response's `nextCursor` and `connectionId` for each following page. Stop when `nextCursor` is `null`. The Agent tool `voice_list` accepts `pageSize`, `after`, and `connectionId` for the same workflow.

MOSS 音色较多时，首次查询加上 `--page-size 150`。下一页沿用该参数，把上一页返回的 `nextCursor` 和 `connectionId` 分别传给 `--after` 和 `--connection`。当 `nextCursor` 为 `null` 时，已经读到最后一页。

`pageSize` limits MOSS pages only. MiniMax system voices and vLLM-Omni voices return their complete native catalogue in one response with `nextCursor: null`; a supplied page size does not truncate these libraries.

`pageSize` 仅限制 MOSS 的每页数量。MiniMax 系统音色和 vLLM-Omni 音色会在一次响应中返回完整目录，`nextCursor` 为 `null`；传入每页数量不会截断这些音色库。

To register an authorized recording, run the following command.

```sh
opendirector voice create recording.wav --model MODEL_CONFIG_UUID --connection CONNECTION_ID --name Narrator --consent CONSENT_RECORDING_ID --ref-text "Words spoken in the recording"
```

Use the returned `voiceId` as the speech parameter `voice`, and preserve the returned selection fields as `voiceSelection` when updating the audio generation specification. Use `opendirector generation-spec update --help-field payload.spec@audio.parameters.voiceSelection` to inspect the current typed fields. Do not copy voice identities across connections. `opendirector voice delete VOICE_ID --model MODEL_CONFIG_UUID --connection CONNECTION_ID` immediately deletes the uploaded voice if the provider supports deletion. Obtain authorization for that specific voice before invoking the CLI or Agent tool. The composer asks for confirmation in the UI. These commands use the same services as the UI and Agent tools.

音色库命令同样适用于中文工作流：先用 `voice list` 读取当前模型的连接身份及要求，再用 `voice create` 上传已获授权的录音；Drama3 等适配器必须填写 `--ref-text`。保存生成配置时同时保留服务端 `voiceId` 和返回的音色选择信息。不同服务之间不能直接复用音色 ID。`voice delete` 仅删除服务支持的上传音色，CLI 和 Agent 会立即执行，请先取得针对该音色的明确授权。在界面中删除时会弹出确认框。

## Canvas text: Markdown and sizing / 画布文本：Markdown 与尺寸

Double-click a text card (or press Enter with it selected) to edit Markdown source. Outside editing, the card renders headings, lists, quotes, emphasis, links, fenced code and tables. Select the card, then drag its bottom-right handle to resize width and height independently; the UI minimum is 200 × 120 canvas units. Long content scrolls within the card. One resize gesture is one undo step and does not change the source. Locked nodes, including nodes inside a locked group, remain read-only.

Use **Expand editor** for a viewport-filling source/preview window. Both views edit the same node; source selection, caret and scroll position survive switching views and returning to the canvas. **Done**, closing and Escape finish the current surface without discarding the draft, just like inline editing; undo reverses the completed edit. Failed saves preserve the local draft for correction/retry. Links use the same confirmation card as assistant replies.

双击文本卡片（或选中后按 Enter）编辑 Markdown 源码；非编辑状态显示标题、列表、引用、强调、链接、围栏代码及表格。选中卡片后，拖动右下角手柄可独立调整宽高，界面最小尺寸为 200 × 120 画布单位，长内容在卡片内部滚动。一次拖动对应一次撤销，正文不变。节点自身或父分组锁定时只读。

通过「展开编辑」打开铺满应用视口的源码／预览窗口。两个界面编辑同一节点，切换视图和返回画布时保留源码选区、光标及滚动位置。「完成」、关闭和 Escape 与行内编辑一致，结束当前编辑界面但不丢弃草稿；撤销可还原完成的编辑。保存失败时保留本地草稿以便修正、重试。链接使用与助手回复相同的确认卡片。

```bash
opendirector --project PROJECT_UUID canvas text --help
opendirector --project PROJECT_UUID --operation-id OPERATION_UUID canvas text create \
  --file notes.md --title Notes --item-id ITEM_UUID --x 20 --y 40 --width 480 --height 320
opendirector --project PROJECT_UUID canvas text show --id ITEM_UUID
opendirector --project PROJECT_UUID --operation-id UPDATE_UUID canvas text update \
  --id ITEM_UUID --file - --expected-version canvas_item:ITEM_UUID:1 < revised.md
opendirector --project PROJECT_UUID --operation-id RESIZE_UUID canvas text resize \
  --id ITEM_UUID --width 640 --height 400 --expected-version canvas_item:ITEM_UUID:2
```

`--file` is UTF-8 Markdown, not a JSON command document; `-` reads stdin without shell escaping. The asset limit is 1 MiB (1,048,576 UTF-8 bytes); the `manualText` field also has a 1,048,576-character schema bound. `show` returns JSON with the **complete** `text`, stable `itemId`, `revision`, dimensions and `expectedVersion`, without opening an edit session. Width and height are positive canvas coordinate units independent of zoom; the shared backend permits smaller values than the UI handle minimum. Creation defaults to 352 × 198; `--x` and `--y` are required.

Updates and resizes require the `canvas_item` revision returned by `show`. Receipts include `status`, `itemId` and `canvasItems` with committed revisions and dimensions. Locks and stale revisions are rejected with exit 1 and an issue code/message; usage errors exit 2. Keep your source file, read the latest text and merge before a new attempt. Agent Shell and ordinary HTTP CLI use the same business services. Text registration and canvas publication are separate commits: if publication fails, the registered asset may remain unbound. Use the same global operation ID and identical file/options to retry without registering a duplicate; do not reuse it for a changed edit. A geometry read failure is reported as `geometryReadError` alongside the committed receipt.

`--file` 接收 UTF-8 Markdown 而非 JSON 命令文档，`-` 从标准输入读取，无须对引号或代码围栏进行 Shell 转义。文本资产限制为 1 MiB（1,048,576 个 UTF-8 字节）；`manualText` 字段另有 1,048,576 字符的契约限制。`show` 不申请编辑会话，返回包含完整 `text`、稳定 `itemId`、`revision`、宽高及 `expectedVersion` 的 JSON。宽高为与缩放无关的正数画布单位，共用后端允许小于界面手柄最小尺寸的数值。创建默认 352 × 198，必须提供 `--x`、`--y`。

更新和缩放必须携带 `show` 返回的 `canvas_item` 版本。回执包含 `status`、`itemId` 及带已提交版本和尺寸的 `canvasItems`。锁定或旧版本冲突返回退出码 1 及错误码、说明，参数用法错误返回 2。保留源码文件，重新读取最新正文并合并后再尝试。Agent Shell 与普通 HTTP CLI 复用相同业务服务。文本登记和画布采用是两个提交：采用失败时，已登记资产可能尚未绑定。使用相同全局操作 ID 和完全相同的文件、选项重试可复用资产，修改输入后应使用新的 ID。几何回读失败通过已提交回执中的 `geometryReadError` 单独报告。

`canvas text show` reads `/api/creation/projects/{projectId}/assets/{assetId}/content` through a bounded HTTP stream on both CLI transports, retaining UTF-8 BOM and CRLF. Its cap is `MAX_CREATION_TEXT_BYTES` (1,048,576 bytes); the shared agent `read` tool still uses its original 64 KiB budget. The API address comes from `--url` or `OPENDIRECTOR_API_URL`, which the application launcher supplies to Agent Shell.

`canvas text show` 在两种 CLI 传输方式下都通过有界 HTTP 流读取 `/api/creation/projects/{projectId}/assets/{assetId}/content`，保留 UTF-8 BOM 和 CRLF。上限为 `MAX_CREATION_TEXT_BYTES`（1,048,576 字节）；共用 Agent `read` 工具仍保留原有的 64 KiB 预算。API 地址来自 `--url` 或 `OPENDIRECTOR_API_URL`，应用启动器会将该环境变量传给 Agent Shell。
