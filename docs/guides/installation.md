# Installation and updates

[English](installation.md) · [简体中文](installation.zh-CN.md) · [Back to README](../../README.md)

### 1. Prepare your environment

| Dependency | Requirement |
| --- | --- |
| Git | For cloning the source; alternatively, download and extract the repository ZIP |
| Node.js and npm (source builds only) | Node.js `24.22.1` or later, with npm; not required for wheel installs |
| Python | `3.11` or later |
| FFmpeg | `ffmpeg` with the `libx264` encoder and `ffprobe` must be available in your terminal for media processing |
| Model service (for AI features) | A working service URL, Model ID, and any API key or other authentication information required by the service |

Installing dependencies and calling remote models require a network connection. Prepare self-hosted model services separately; starting this application does not install or deploy models.

For a Linux NVIDIA model host, see [local vLLM-Omni deployment](vllm-omni.md).

You can install and open the application, upload local media, and edit projects before connecting a model. AI chat and generation require a configured service; running the application does not require a local GPU when using a remote service.

#### macOS prerequisites

Open Terminal. If you do not have Homebrew, follow the [official installation instructions](https://docs.brew.sh/Installation), including the printed **Next steps** for adding `brew` to your PATH. If `git --version` asks for Apple's Command Line Tools, finish that installation first.

Install the runtimes and media tools:

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

Check that Node.js is at least `24.22.1`, Python is `3.12.x`, and the last command lists `libx264`. Homebrew's [Node.js 24](https://formulae.brew.sh/formula/node@24) needs the PATH line above; repeat it in a new terminal when building or using Node-based assistant engines. Use `python3.12` explicitly below: macOS's default `python3` may still be an older Apple-provided version. If you already have compatible runtimes from another installer, use those instead and verify their versions.

MP4 export needs a browser with an H.264 WebCodecs encoder. Chrome and Edge
provide one; Firefox does not, so Firefox can be used for the canvas, generation
and editing, but the final export must run in Chrome or Edge.

First, check that the media tools are available:

```sh
ffmpeg -version
ffprobe -version
```

### 2. Install and start

We recommend installing in a Python 3.11+ virtual environment to avoid dependency conflicts with other projects. The examples below use `.venv`; run the commands in order, starting with the checkout.

macOS (using Python 3.12 installed above):

```sh
git clone https://github.com/ThinkFlowLab/OpenDirector.git
cd OpenDirector
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
opendirector serve
```

Linux (check that `python3 --version` is 3.11 or later):

```sh
git clone https://github.com/ThinkFlowLab/OpenDirector.git
cd OpenDirector
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
opendirector serve
```

Windows PowerShell:

```powershell
git clone https://github.com/ThinkFlowLab/OpenDirector.git
cd OpenDirector
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
opendirector serve
```

The Windows example uses Python 3.12; replace `py -3.12` with your installed supported version if needed. When using a virtual environment, activate it before installing or starting the application. A virtual environment is also recommended for wheel installs.

Installation explicitly runs `npm ci`, builds the web application, and verifies bundled OpenCode. No separate npm commands are needed. Source builds require Node.js 24.22.1+, npm, and network access. Use `python -m pip install -v -e .` for full build logs. `serve` only starts the application; it does not download dependencies or build resources.

The same Python distribution supports wheels containing the web application, skills, and platform-specific OpenCode binary, so wheel users do not need Node.js. Once published, install with `python -m pip install opendirector`; until then, obtain a wheel matching your OS and architecture from a trusted project release and run `python -m pip install <wheel-path>`. This does not claim the version is already available on PyPI.

### 3. Open and update

Open <http://127.0.0.1:8000>. Press `Ctrl+C` to stop; run `opendirector serve` again to restart. Use `opendirector serve --port 8001` for another port or add `--log-level debug` for diagnostics.

In a new terminal, enter the checkout and reactivate the virtual environment: run `source .venv/bin/activate` on macOS/Linux or `.\.venv\Scripts\Activate.ps1` in Windows PowerShell, then run `opendirector serve`. You do not need to recreate the environment each time.

Editable installs store `projects/` and `.opendirector/` in the checkout by default. Wheel installs default to `.opendirector/` in your home directory. Set `OPENDIRECTOR_ROOT` to choose a data directory; application resources are read from the installation.

After updating source, run `python -m pip install -e .` again before starting. Python source edits take effect directly. For web edits, use `opendirector dev` or reinstall to rebuild the application served by `serve`. See the [validation guide](../development/validation.md) for development checks.
