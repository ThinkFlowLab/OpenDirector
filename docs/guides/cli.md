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

```bash
opendirector --project PROJECT_UUID generation submit   --spec-id SPEC_UUID   --expected-spec-revision 1   --origin-item-id ITEM_UUID   --expected-version generation_spec:SPEC_UUID:1   --expected-version canvas_item:ITEM_UUID:1
opendirector --project PROJECT_UUID job show JOB_UUID
opendirector --project PROJECT_UUID job wait JOB_UUID --timeout 300
```

业务命令按对象分组，参数名使用短横线。复杂参数可使用 JSON 参数，或通过 `--file command.json` 读取含 `payload`、`expectedVersions` 和可选 `expectedPreview` 的对象。`--file -` 从标准输入读取。命令帮助包含从 Pydantic 业务契约派生的参数说明与示例。`--help-field PATH` 展开帮助中返回的结构化字段路径，例如 `opendirector canvas show --help-field payload.item@image.binding`。

CLI 输出 JSON。修改回执附带对应的 assetId、itemId、specId 及其列表，视频节点创建回执同时返回包含当前版本的下一步提交命令。参数解析错误直接显示该子命令的完整用法。成功退出码为 0，拒绝或执行失败为 1，参数解析错误及等待任务超时为 2。生成接受回执会在 `next.commands` 返回对应的 `job wait` 命令，带入服务地址、工程和任务身份。建议按回执等待；60 秒窗口超时后可以再次执行同一等待命令。`job wait` 超时结束等待，任务继续由后台执行。

修改命令可在子命令前传 `--operation-id UUID`。相同身份及输入重试复用原回执，输入不同则拒绝。文件导入重放也核对登记文件的内容指纹。需要跨进程恢复暂存上传时，预先通过 `--session UUID` 保持相同会话身份。结果未知时先查询回执，再决定后续操作。

普通终端写入申请独立编辑租约，完成后释放。工程已在其他窗口编辑时会返回占用错误。使用 `--session UUID` 表示沿用已有授权会话，CLI 完成后保留该会话。

Agent 的 Shell 通过 PATH 使用同一个 `opendirector`。宿主提供受令牌保护的本轮连接、工程范围、编辑会话和执行目录，文件登记限制在本轮执行目录。每次调用产生业务活动及回执，供聊天与轨迹页展示。


## 紧凑工程索引与生成前预检

多节点工程中，先用紧凑摘要定位目标画布项、对象版本与活动任务，再按 `--item-id` 读取局部对象树，避免在每轮 Agent 上下文中反复装载完整历史与长提示词。批量或长时长提交前，通过 `generation precheck` 执行无副作用预检（不创建任务、不增加版本），复用提交校验提前检查模型协议、音色选择、已缓存能力状态、锁定状态、排队上限、素材可用性，并输出任务数、预计时长、服务类型及尚未检查项（`uncheckedRequirements`），由授权流程决定是否需要额外确认。

```bash
opendirector --project PROJECT_UUID project show --view summary
opendirector --project PROJECT_UUID project show --item-id ITEM_UUID
opendirector --project PROJECT_UUID generation precheck --spec-id SPEC_UUID_1 --spec-id SPEC_UUID_2
```

`generation precheck` 全部通过时退出码为 0，任一配置存在阻断问题时输出完整报告并返回退出码 1。Agent 工具 `read_project`（支持 `view` 与 `itemIds`）和 `query`（`generation.precheck`）共用同一后端查询契约。

### Compact project views and generation precheck

On multi-node projects, inspect `--view summary` first to locate canvas items, object revisions, and active jobs, then scope reads with `--item-id` so Agent turns do not repeatedly load unrelated long prompts and historical results. Before submitting batch or long-duration generations, run `generation precheck` to share submission validation (model rules, voice selection, cached capability availability, locks, queue limits, and reference availability) without creating jobs or commits, returning factual task counts, estimated durations, service types, and any explicit `uncheckedRequirements` while leaving confirmation policy to the authorization flow.

`generation precheck` exits with code 0 when every configuration is ready, or prints the diagnostic report and exits with code 1 when any configuration is blocked. The Agent tools `read_project` (`view`, `itemIds`) and `query` (`generation.precheck`) call the same backend query service.


## 检查已有生成结果

`job show` / `job wait` 在任务成功后返回 `delivery`：已登记的 AssetRef、当前采用状态及展示该素材的画布项。生成成功不等于质量验收；Agent 应检查现有素材。复制到执行目录做媒体探测、抽帧和审看不需要重新发布，也不应为同一次交付新增画布项。编辑产生的新交付文件才需要登记；独立副本展示应有用户要求。


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
