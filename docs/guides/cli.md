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


## 检查已有生成结果

`job show` / `job wait` 在任务成功后返回 `delivery`：已登记的 AssetRef、当前采用状态及展示该素材的画布项。生成成功不等于质量验收；Agent 应检查现有素材。复制到执行目录做媒体探测、抽帧和审看不需要重新发布，也不应为同一次交付新增画布项。编辑产生的新交付文件才需要登记；独立副本展示应有用户要求。


## 更新生成配置

`generation-spec update` 替换完整配置，不是局部补丁。先用 `opendirector query object.get --object-id <spec-id>` 读取当前配置，修改需要调整的字段后，将完整对象放入命令文件的 `payload.spec`，并携带当前 `expectedVersions`。

`--spec` 接收 JSON 对象，不接收配置 UUID；它会覆盖 `--file` 中的整个 `payload.spec`。命令文件已经包含配置时只需 `opendirector generation-spec update --file update.json`。保留 `purpose`、`modelConfigId`、`prompt`、`promptContent`、`parameters` 和 `currentResultId`；清空可空字段时显式使用 `null`。

素材查询使用 `query object.get`；获取预览访问使用 `query asset.preview`。不存在 `query asset` 类型。

### Updating generation configurations

`generation-spec update` replaces the complete configuration. Read it with `opendirector query object.get --object-id <spec-id>`, edit the intended fields, and submit the complete object as `payload.spec` with its current `expectedVersions`. Keep `purpose`, `modelConfigId`, `prompt`, `promptContent`, `parameters`, and `currentResultId`; use explicit `null` to clear nullable fields.

`--spec` accepts a JSON object, not a UUID, and overrides the entire `payload.spec` from `--file`. If the file already contains the configuration, use `opendirector generation-spec update --file update.json` without `--spec`. Query assets with `query object.get` and obtain preview access with `query asset.preview`; `query asset` is not supported.


## Voice library

`opendirector voice list --model MODEL_CONFIG_UUID` reads the full library and returns the selected model's connection identity, voices and adapter requirements. For a large MOSS library, request up to 150 voices per page.

```sh
opendirector voice list --model MODEL_CONFIG_UUID --page-size 150
opendirector voice list --model MODEL_CONFIG_UUID --page-size 150 --after "NEXT_CURSOR" --connection "CONNECTION_ID"
```

Use the previous response's `nextCursor` and `connectionId` for each following page. Stop when `nextCursor` is `null`. The Agent tool `voice_list` accepts `pageSize`, `after`, and `connectionId` for the same workflow.

MOSS 音色较多时，首次查询加上 `--page-size 150`。下一页沿用该参数，把上一页返回的 `nextCursor` 和 `connectionId` 分别传给 `--after` 和 `--connection`。当 `nextCursor` 为 `null` 时，已经读到最后一页。

To register an authorized recording, run the following command.

```sh
opendirector voice create recording.wav --model MODEL_CONFIG_UUID --connection CONNECTION_ID --name Narrator --consent CONSENT_RECORDING_ID --ref-text "Words spoken in the recording"
```

Use the returned `voiceId` as the speech parameter `voice`, and preserve the returned selection fields as `voiceSelection` when updating the audio generation specification. Use `opendirector generation-spec update --help-field payload.spec@audio.parameters.voiceSelection` to inspect the current typed fields. Do not copy voice identities across connections. `opendirector voice delete VOICE_ID --model MODEL_CONFIG_UUID --connection CONNECTION_ID` deletes only provider-supported uploaded voices; obtain authorization before deleting. These commands use the same services as the UI and Agent tools.

音色库命令同样适用于中文工作流：先用 `voice list` 读取当前模型的连接身份及要求，再用 `voice create` 上传已获授权的录音；Drama3 等适配器必须填写 `--ref-text`。保存生成配置时同时保留服务端 `voiceId` 和返回的音色选择信息。不同服务之间不能直接复用音色 ID。`voice delete` 仅删除服务支持的上传音色，执行前应取得删除授权。
