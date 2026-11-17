# 安装与更新

[English](installation.md) · [简体中文](installation.zh-CN.md) · [返回首页](../../README.zh-CN.md)

### 1. 准备环境

| 依赖 | 要求 |
| --- | --- |
| Git | 用于克隆源码；也可下载仓库 ZIP 并解压 |
| Node.js 与 npm（仅源码构建） | Node.js `24.22.1` 或更新版本，附带 npm；wheel 安装无需此项 |
| Python | `3.11` 或更新版本 |
| FFmpeg | 用于媒体处理；终端中需可运行包含 `libx264` 编码器的 `ffmpeg` 和 `ffprobe` |
| 模型服务（AI 功能需要） | 准备可用的服务地址、Model ID，以及服务要求的 API Key 或其他鉴权信息 |

安装依赖和调用远程模型需要网络。自部署模型服务需另外准备，启动本应用不会自动安装或部署模型。

Linux NVIDIA 模型主机的配置与验证参见 [vLLM-Omni 本地部署](vllm-omni.zh-CN.md)。

尚未接入模型也可以安装、打开应用、上传本地素材和编辑工程。AI 对话和生成需要配置模型服务；使用远程服务时，运行本应用的 Mac 无需本地 GPU 推理环境。

#### macOS 环境准备

打开“终端”。没有 Homebrew 时，先按[官方安装说明](https://docs.brew.sh/Installation)安装，并执行安装结束显示的 **Next steps**，将 `brew` 加入 PATH。如果 `git --version` 提示安装 Apple 命令行工具，请先完成安装。

安装运行时和媒体工具：

```sh
brew install node@24 python@3.12 ffmpeg
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version
npm --version
python3.12 --version
ffmpeg -version
ffprobe -version
ffmpeg -hide_banner -encoders 2>/dev/null | grep libx264
```

确认 Node.js 不低于 `24.22.1`、Python 为 `3.12.x`，最后一条命令列出 `libx264`。Homebrew 的 [Node.js 24](https://formulae.brew.sh/formula/node@24) 需要上面的 PATH 设置；新开终端后，构建前端或使用依赖 Node.js 的助手引擎前应再次执行。下文明确使用 `python3.12`，因为 Mac 默认的 `python3` 可能仍是 Apple 提供的旧版本。已经通过其他方式安装合适运行时的用户，可直接使用现有版本并核对版本号。

合成 MP4 需要浏览器提供 H.264 的 WebCodecs 编码器。Chrome 与 Edge 具备该能力，
Firefox 不具备：Firefox 可用于画布、生成与编辑，但最终导出需在 Chrome 或 Edge 中完成。

先确认媒体工具可用：

```sh
ffmpeg -version
ffprobe -version
```

### 2. 安装并启动

推荐使用 Python 3.11+ 虚拟环境安装，避免与其他项目的依赖冲突。以下示例使用 `.venv`，从克隆仓库开始按顺序执行。

macOS（使用上面安装的 Python 3.12）：

```sh
git clone https://github.com/ThinkFlowLab/OpenDirector.git
cd OpenDirector
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
opendirector serve
```

Linux（确认 `python3 --version` 为 3.11 或更新版本）：

```sh
git clone https://github.com/ThinkFlowLab/OpenDirector.git
cd OpenDirector
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
opendirector serve
```

Windows PowerShell：

```powershell
git clone https://github.com/ThinkFlowLab/OpenDirector.git
cd OpenDirector
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
opendirector serve
```

Windows 示例使用 Python 3.12；如果安装了其他受支持版本，请将 `py -3.12` 替换为对应版本。使用虚拟环境时，安装和启动前请先激活对应环境；wheel 安装也推荐使用虚拟环境。

安装过程会明确执行 `npm ci`、前端构建和内置 OpenCode 校验，无需手动重复这些步骤。源码构建需要 Node.js 24.22.1+、npm 和网络；使用 `python -m pip install -v -e .` 查看完整构建日志。`serve` 仅启动服务，不在启动时下载依赖或构建。

同一个 Python 包支持 wheel 安装，wheel 已包含前端、技能和当前平台的内置 OpenCode，无需 Node.js。发布后可使用 `python -m pip install opendirector`；发布前从项目可信发布渠道取得匹配系统及架构的 wheel，再用 `python -m pip install <wheel路径>` 安装。此说明不表示该版本已上传 PyPI。

### 3. 打开与更新

打开 <http://127.0.0.1:8000>；按 `Ctrl+C` 停止，再次运行 `opendirector serve` 启动。更换端口使用 `opendirector serve --port 8001`，排查问题使用 `--log-level debug`。

新开终端后，先进入仓库目录并重新激活虚拟环境：macOS/Linux 执行 `source .venv/bin/activate`，Windows PowerShell 执行 `.\.venv\Scripts\Activate.ps1`，然后运行 `opendirector serve`。已有虚拟环境无需每次重新创建。

源码安装默认将 `projects/` 和 `.opendirector/` 保存在源码目录；wheel 安装默认使用用户主目录下的 `.opendirector/`。可通过 `OPENDIRECTOR_ROOT` 指定数据目录；安装目录只用于读取应用资源。

更新源码后重新运行 `python -m pip install -e .`，再启动服务。修改 Python 源码即时生效；修改前端时使用 `opendirector dev`，或重新安装以构建供 `serve` 使用的产物。开发检查见[验证指南](../development/validation.md)。
