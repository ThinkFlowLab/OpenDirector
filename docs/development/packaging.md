# Python 统一安装与发布

根目录 `pyproject.toml` 定义唯一的 `opendirector` 发行包，包含 `opendirector` core/CLI 与 `opendirector_api`，源码职责仍分别位于 `packages/core/src` 和 `apps/api/src`。不再单独安装 core/API 子项目。

## 安装和构建

在 Python 3.11+ 虚拟环境和满足 `.nvmrc` 的 Node.js 环境中，从仓库根目录运行：

```sh
pip install -v -e .
opendirector serve
```

`build_backend.py` 实现 PEP 517/660 构建入口，普通 wheel 与 editable 构建共用资源准备：依次执行 `npm ci`、`npm run build` 和 OpenCode `--version`。某一步失败立即停止，`pip -v` 展示完整输出。不要跳过 npm 安装脚本。

构建结果写入忽略的 `packages/core/src/opendirector/_bundled/`，包括前端、内置技能、当前平台 OpenCode 可执行文件及其许可证。wheel 使用 `py3-none-<platform>` 标签，不能将某个平台的二进制标为通用 wheel。发布应在每个支持的系统和架构分别构建、验证；本机产物不证明其他平台已经通过。

```sh
pip install build
python -m build
```

sdist 包含重建所需的前端源码与 npm 锁文件，不携带当前机器二进制；从 sdist 构建时同样需要 Node.js 和网络。安装已构建 wheel 无需 Node.js，也不触发 npm。当前没有自动上传 PyPI 的发布动作。

## 运行资源与数据

`serve` 只启动已安装 API 并提供前端产物，不运行 pip/npm。缺少产物时提示重新安装。`dev` 仅适用于源码安装，启动 Vite。

- editable：前端取 checkout 的 `dist/`，技能取 `packages/agent/skills/`，默认数据根目录为 checkout。
- wheel：读取包内 `_bundled/` 资源，默认数据根目录为 `~/.opendirector/`。
- `OPENDIRECTOR_ROOT` 显式指定数据根目录，包含 `projects/` 与 `.opendirector/`；它不改变静态资源路径。
- Agent 创建的临时 CLI 入口调用当前解释器的 `-m opendirector.cli`，不依赖仓库脚本。

Python 源码修改在 editable 安装中直接生效。修改前端后使用 `opendirector dev` 或重新运行 `pip install -e .` 更新生产产物。FFmpeg/ffprobe 仍为媒体功能的外部前置条件；用户自选外部 Harness 仍需单独安装并登录。

## 隔离验收

分别使用全新虚拟环境安装 wheel 和 editable，执行：

```sh
python -m pip check
python scripts/verify_install.py --python /absolute/path/to/venv/bin/python
```

Windows 对应传入 `venv/Scripts/python.exe`。验证脚本在临时工作目录运行，移除 `PYTHONPATH` 并收窄 PATH，检查部署命令帮助、全部配方、分段下载器计划、内置 OpenCode、技能、正式 serve 入口、健康接口、首页与静态资源、CLI 创建和重读工程，最后清理自己启动的进程。它不调用真实模型，也不覆盖媒体处理或所有平台验收。
