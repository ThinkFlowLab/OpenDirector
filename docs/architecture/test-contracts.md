# 测试契约

本文说明测试与生产代码之间的边界。它不是风格建议：同一语义存在两份实现时，改动任意一侧都会让另一侧过期，而这种过期往往在 CI 里表现为"红着没人看见"或"改一处红一片"。

## 测试布局与 CI 层 / Test layout and CI layers

增量采用以下布局，新测试按业务领域归类；现有根目录用例和 helper 暂留原位，移动时同步修改测试发现命令、导入、watchlist 与脚本路径，不一次性重排整棵目录。

Adopt this target layout incrementally, grouping tests by business area. Existing root-level tests and helpers stay in place until a move updates discovery commands, imports, watchlists and script paths together; avoid a whole-tree rewrite. Until discovery supports a new directory, add tests beside their existing peers. In particular, the current frontend command only discovers root-level `tests/*.test.ts`.

该表是增量迁移的目标布局。测试发现尚未支持新目录时，新用例继续放在现有同类用例旁；尤其当前前端命令只发现根目录 `tests/*.test.ts`，首次迁入 `tests/frontend/` 必须同时修改该命令。

| Location / 位置 | Responsibility / 职责 |
| --- | --- |
| `tests/frontend/<area>/*.test.ts` | Frontend unit checks / 前端单元检查 |
| `tests/python/<area>/test_*.py` | Python business and integration checks / Python 业务与集成检查 |
| `tests/python/helpers/` | Shared Python fixtures and helpers / Python 共享夹具与辅助函数 |
| `tests/browser/` | Browser journeys; lanes in `manifest.json` / 浏览器旅程，manifest 管理 lane |
| `tests/fixtures/` | Shared test data / 共享测试数据 |
| `plugins/deepseek-harness/test/` | Plugin-local, path-filtered checks / 插件独立、按路径运行的检查 |

L1 包含单元、静态与构建；L2 是模型替身浏览器 E2E；L3 为 main HEAD 复核、flake 分诊与扩展覆盖；L4 为生产构建、性能与输出。Python ready/merge/nightly 只决定运行时机，不代表测试目录或完整验收层级。具体命令和迁移筛选只维护在[验证指南](../development/validation.md#python-分层与迁移--python-layers-and-transition)。

L1 includes unit/static/build checks; L2 is browser E2E with model stubs; L3 covers main HEAD parity, flake triage and extended journeys; L4 covers production, performance and output verification. Python ready/merge/nightly selects execution timing, not directories or complete acceptance levels. Commands and transitional selection have one owner: the [validation guide](../development/validation.md#python-分层与迁移--python-layers-and-transition).

## 四条规则

### 1. 一个语义只有一个所有者

- 运行时**是否安装**只由 `runtime.installation(name)` 回答。`runtime_available`、`runtime_readiness`、`runtime_status` 与 API 层都通过它，新增引擎不需要在每个调用点各写一次 `shutil.which`。
- 运行时**状态词汇**由 `runtime.runtime_status(name, probe=...)` 拥有；传输层只做序列化，不重新拼 `'not_installed' / 'ready' / 'checking'`。
- 平台差异（例如字节校验策略）用显式参数表达，不在构造函数里按 `os.name` 隐式切换，否则同一份代码在两个平台上跑的是两条未声明的路径。

### 2. 断言从所有者派生，不抄字面量

测试可以写"应该发生什么"，但不该复制一份实现常量：

- 需要限额时导入常量，不要在测试里写魔数。
- 需要"这条规则是否允许"时，用 `input_rules(config)` 的决策表参数化，而不是逐个模型手写期望。
- 需要 CLI 选项名时，从注册后的命令对象取 `params`，不要写死 `--file` / `--model`。
- 需要队列状态时，断言不变量（`status in tool_tasks.ACTIVE` 且未被取消），不要断言依赖调度的瞬时标签。
- 一条语义只留一个 owner test；其余用例引用它，而不是各自复述规则。

### 3. 环境能力显式声明

测试依赖的外部条件写在 `tests/capabilities.py`，用 `requires_ffmpeg()` / `requires_posix()` 这类门禁声明，而不是在测试体内 `shutil.which` 或 `os.name`：

- 能力缺失是**带原因的 skip**（`pytest -ra` 可见），不是一台机器红、另一台绿。
- 需要人工介入的真实 CLI 用例用环境变量开关（`OPENDIRECTOR_REAL_CLI`、`JIUWENSWARM_ENGINE_TEST`），因为它们在 CI 中可能长时间阻塞。
- marker 在 `tests/conftest.py` 注册一次。

### 4. 不对第三方渲染结果做断言

- CLI 帮助的排版、颜色与换行宽度属于 click/typer 与终端，不属于本仓库的契约。要验"命令暴露了哪些参数"，查注册后的 `params`；要验"错误可读"，断言错误消息与命令路径。
- 浏览器脚本不要用本地化文案定位元素；需要稳定定位时补稳定的 `data-*` 标识，句式断言只保留在真正检查 i18n 的用例里。

## 已收敛到单一所有者

- 运行时安装探测与状态词汇：`packages/core/src/opendirector/agent/runtime.py`。
- 环境能力门禁：`tests/capabilities.py` 与 `tests/conftest.py`（仓库此前没有 conftest）。
- 创作规则的共享限额与菜单推导：`packages/core/src/opendirector/domain/rule_facts.py`。浏览器只读生成结果 `src/contracts/ruleFacts.generated.ts`。断言这些菜单或限额时导入该模块或对照生成向量，不要再抄一份比例表或字节上限。

## 待迁移

- `backendBlocker` 与 `validate_generation`、`backendReferences` 与 `reference_policy` 的过程分支仍各写一处。限额已经共用；在把其余谓词收进同一模块或校验接口之前，不要在第三处再写一份。
- `tests/` 中仍有数十处内联 `shutil.which` 门禁，应逐步替换为 `capabilities` 中的声明。
- 浏览器脚本仍以文案定位元素；下一步是固定测试用的 `locale` 或给关键控件补稳定标识。
- 真实 CLI 用例（native / jiuwenswarm / deepseek / runtime_catalog）在 Windows 上失败属平台差异，应按 `requires_posix()` 声明，而不是逐条改断言。
