# 在 DeepSeek Harness 中使用 OpenDirector

[English](README.md)

直接在 DSH 对话中生成素材、跟踪任务，再打开同一个 OpenDirector 工程继续编辑。生成的文件、可编辑的提示词与参数、参考素材和候选结果都保存在该工程中。

## 安装并连接

使用 **DSH 0.2.2-rc.1** 和 **Node.js 24.9.0 或更新版本**。先按[安装指南](../../docs/guides/installation.zh-CN.md)启动 OpenDirector，再从本插件目录打包，并创建带对话界面的 Web profile：

```sh
npm pack
dsh --profile studio --from-default-profile web --dump-config
dsh plugin --profile studio add ./opendirector-dsh-plugin-0.1.0.tgz
dsh --profile studio
```

打开启动时打印的 DSH Web 地址即可对话。先从 `web` 初始化才能得到聊天界面；直接向全新 profile 安装插件只会创建基础组合。已有 Web profile 则只需将安装命令中的名称换成它。

默认 OpenDirector 地址为 `http://127.0.0.1:8000`，普通本地安装无需额外配置。插件行名为 `opendirector`，DSH 在自己的对话与规划流程中调用它提供的八个原生工具。

开发时，也可以先安装本检出的依赖，再链接到已有 profile：

```sh
npm install
dsh plugin --profile studio add /absolute/path/to/OpenDirector/plugins/deepseek-harness
```

包内 JavaScript 可直接运行，无需构建。压缩包安装会安装依赖；链接源码目录则使用该目录自己的 `node_modules`。两种方式都不依赖 npm 发布或市场收录。

## 试一次完整创作

先在 OpenDirector 的**设置 → 模型连接**中配置一个图片模型。[使用指南](../../docs/guides/user-guide.zh-CN.md)介绍了连接方式，下面的示例会使用该服务。

可以这样告诉 DSH：

> 新建一个叫“月光工作室”的 OpenDirector 工程，用我已经配置好的图片模型生成一个有电影感的月光房间。先给我看候选和生成状态，再给我链接回到 OpenDirector 接着编辑。

DSH 可以发现工程和已配置模型，创建可见的生成节点，提交任务并查询进度。任务完成后，候选已经保存到工程中；将它选为画布当前结果则通过 `opendirector_adopt_result` 单独完成。这样可以先查看候选，再决定是否替换当前内容。

工程相关结果带有 `/ai-canvas/<projectId>` 链接。打开后可以修改提示词、查看参考、切换候选，并继续编辑同一个工程。

## 配置

需要不同的 API 地址、Vite 前端地址或中文工具文字时，在 profile 的 `cordis.patch.yml` 或 `--patch` 文件中覆盖该行：

```yaml
- id: opendirector
  config:
    baseUrl: http://127.0.0.1:8000
    canvasBaseUrl: http://127.0.0.1:5173
    locale: zh-CN
    requestTimeoutMs: 30000
```

覆盖会替换整份行配置。插件加载时会校验配置，不会因此访问 OpenDirector。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8000` | OpenDirector API 地址；支持 HTTP/HTTPS，不带账号密码、查询参数或片段。 |
| `canvasBaseUrl` | 与 `baseUrl` 相同 | OpenDirector 前端地址，工程链接会追加到此地址后。 |
| `locale` | `en-US` | 工具描述、摘要和错误支持 `en-US`、`zh-CN`。 |
| `requestTimeoutMs` | `30000` | 单次请求的超时；超时不会取消已接受的生成任务。 |

## 启用、停用和卸载

在 profile 中增加以下覆盖即可停用插件：

```yaml
- id: opendirector
  disabled: true
```

改为 `disabled: false` 可重新启用。支持热重载的 profile 会在重载时应用变更，其他 profile 需要重启。卸载命令：

```sh
dsh plugin --profile <profile> remove @opendirector/dsh-plugin
```

停用插件或停止等待不会中断 OpenDirector 已接受的任务。重新启用后，用 `opendirector_job` 可以继续查询已保存的结果。

## 原生工具

| 工具 | 用途 |
| --- | --- |
| `opendirector_projects` | 列出工程，或用名称、`projectId`、`operationId` 创建工程。 |
| `opendirector_project` | 读取工程、已配置模型、当前对象版本和工程链接。 |
| `opendirector_create_generation` | 在指定画布位置保存可编辑的文字、图片、视频或音频生成节点及参考。 |
| `opendirector_submit` | 以 `candidate_only` 提交生成，返回已接受的 `jobIds`。 |
| `opendirector_job` | 查询状态、已保存的候选，以及结果是否已选为当前内容。 |
| `opendirector_adopt_result` | 用 `expectedSpecRevision` 和对应的 `expectedCanvasVersions` 选择候选。 |
| `opendirector_cancel` | 用当前 `expectedJobRevision` 请求取消；再查任务确认最终状态。 |
| `opendirector_operation` | 回包丢失或结果未知时，按 `operationId` 查询已提交回执。 |

从 `opendirector_project` 或 `opendirector_job` 读取版本。`expectedCanvasVersions` 填入绑定到目标生成配置的画布对象 `{id, revision}`。服务端检查版本和锁定；插件不会静默换用新版本覆盖中途发生的修改。

每个修改调用显式传入 UUID `operationId`，创建工程还需显式传入 UUID `projectId`。相同输入重放时保留原有身份和版本；先确认旧操作结果，再为变化后的输入使用新操作。子对象身份由操作 UUID 确定性派生。

## 编辑权与任务归属

查询不占用编辑会话。写入时，插件短暂打开自己的 OpenDirector 会话，按需续期，最后只释放自己的会话。工程被其他窗口占用时，工具会报告 `storage_busy`；先保存并关闭该工程窗口，再交给 DSH 编辑。只读查询仍然可用。

写请求丢失回包时，错误会给出原 `operationId` 和 `opendirector_operation` 查询指引。先核对回执与工程，再决定是否重放；暂时没有回执不能证明原请求没有被接受。

取消任务必须明确调用 `opendirector_cancel`。中止工具请求或停用插件只停止本地等待，不会发送 `job.cancel`。已接受的任务、提供方取消、文件和工程历史由 OpenDirector 管理；对话与规划由 DSH 管理。

## 结果展示

工具返回结构化 JSON，供程序继续操作。提交、进度、候选选择和取消会展示简短中文或英文摘要，说明工程名称、必要身份、下一步和工程链接；需要检查详细工程或模型时再读取完整数据。

本插件提供原生工具。DSH 内置 Web 客户端使用通用工具展示，本包不包含专用 Web 卡片或内嵌画布。

## 开发检查

```sh
npm install
npm test
npm pack --dry-run
```

客户端测试使用可注入的 HTTP 传输替身；宿主测试使用真实 Cordis Loader、DSH 工具和 Native 执行器连接隔离 HTTP 夹具，覆盖可空结果、中英文摘要、停用和重新启用。这些检查不会调用真实模型提供方。

若要同时检查真实 OpenDirector 工程接口，在另一个终端从仓库根目录启动已有图片提供方夹具（先安装 OpenDirector 的 Python 依赖）：

```sh
PYTHONPATH=packages/core/src:apps/api/src python tests/browser/creation_server.py --port 8019
```

然后在本插件目录完成 `npm install` 后运行：

```sh
node test/creation.integration.mjs
```

这会检查创建工程、PNG候选落盘、采用与重放、编辑会话冲突，以及停用插件期间已接受任务继续完成。脚本先检查隔离夹具标记再写入；用 `OPENDIRECTOR_FIXTURE_URL` 可选择其他夹具端口。图片来自测试夹具，不调用模型服务。

本包将 DSH 兼容版本固定为 `0.2.2-rc.1`。DSH 仍在开发预览阶段，升级宿主前应重新确认兼容性。OpenDirector 自身的运行环境要求以安装指南为准。
