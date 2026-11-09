<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="src/assets/opendirector-header-dark.png" />
    <source media="(prefers-reduced-motion: reduce)" srcset="src/assets/opendirector-header-light.png" />
    <source media="(prefers-color-scheme: dark)" srcset="src/assets/opendirector-header-dark.gif" />
    <img src="src/assets/opendirector-header-light.gif" alt="OpenDirector — animated logo" width="660" />
  </picture>
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

# OpenDirector

**From an idea to a downloadable short film: generate through chat, organize on a canvas, edit media, and export from a timeline.**

OpenDirector is an AI video creation workspace that runs locally and is accessed through your browser. Discuss ideas with the assistant and generate assets, organize and iterate on them on the canvas, edit images, video, and audio, then arrange your material on a timeline and export an MP4.

Use it to explore visual ideas, refine assets, and make short films. Projects stay on your machine; generation uses the provider APIs or self-hosted model services you choose.

[News](#news) · [Example film](#example-film-we-can-still-win) · [Quick start](#quick-start) · [Documentation](#documentation) · [Community](#community) · [Contributing](#contributing)

## News

- [2026/11/06] We released [v0.1.0](https://github.com/ThinkFlowLab/OpenDirector/releases/tag/v0.1.0), the first OpenDirector release, bringing AI-assisted generation, canvas asset management, media editing, and timeline export into one local workspace. See the release notes for highlights and installation instructions.

## What you can do

- **Work with AI**: Describe what you want to create, reference canvas assets, and ask the assistant to save text or generate content with your configured models.
- **Canvas and reference assets**: Upload files, connect nodes, or use `@` to add references. Organize assets in one place and review generation history.
- **Media editing**: Crop, adjust colors, and work with layers and clips. AI tools such as image extension, erasing, and background removal depend on the connected models' capabilities.
- **Image presets**: Select an image, choose Character three-view, Face three-view, Product three-view, Storyboard, or Multi-camera from **Presets**, then click **Generate** in the single-row panel. Three-view presets produce one reference sheet each; Storyboard and Multi-camera produce four separate images each, using landscape layouts and retaining a connection to the source.
- **Timeline editing**: Arrange assets, adjust start and end points, speed, and volume, then preview and render an MP4. You can also export JSON, FCPXML, and asset bundles.
- **Local projects, your choice of models**: The canvas saves automatically to your machine. Configure multiple models for a service and switch between them as needed.

If image generation repeatedly times out or disconnects through a system proxy, open **Settings → Model connections → Edit service → Advanced connection** and set **Network connection mode** to **Direct (no proxy)**. This affects that service's model requests and result downloads without changing the system proxy. Check the provider's records before starting another attempt when request acceptance is unknown.

## Example film: We Can Still Win

*We Can Still Win* (《我们还能赢》) is a 60-second short about a middle-aged Dota 2 player.

The screenshot shows the script, video shots, timeline, and finished film. Video generation used FastH3 served through [vLLM-Omni](https://github.com/vllm-project/vllm-omni).

[![The We Can Still Win project in OpenDirector, showing its script, six shots, timeline, and rendered film](docs/guides/assets/dota2-short-film-canvas.jpg)](docs/guides/assets/dota2-short-film-canvas.jpg)

*Actual OpenDirector canvas; click the image to view it at full resolution.*

**Finished film**

https://github.com/user-attachments/assets/11babc03-e35c-40e7-b5f6-7d476b6bf11a

[Download the original film (MP4, 15.7 MiB)](docs/guides/assets/dota2-short-film.mp4?raw=true) · 60 seconds · 1280 × 720 · 24 fps · Music: 《岁月神偷》.

## Quick start

### Install with AI

Send this prompt to your AI assistant:

```text
Install and start OpenDirector for me by following this skill: https://github.com/ThinkFlowLab/OpenDirector/blob/main/.agents/skills/install-opendirector/SKILL.md
```

### Manual installation

Source installation requires Python **3.11+**, Node.js **24.22.1+** with npm, Git, and FFmpeg/ffprobe with `libx264`. We recommend a virtual environment to avoid dependency conflicts.

For macOS/Linux, using a `python3` that meets the version requirement:

```sh
git clone https://github.com/ThinkFlowLab/OpenDirector.git
cd OpenDirector
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
opendirector serve
```

Open <http://127.0.0.1:8000>. Installation builds the frontend automatically; no separate npm commands are needed. See the [installation guide](docs/guides/installation.md) for Windows, macOS prerequisites, and updates.

Configure a model service in **Settings → Model connections** to use AI chat and generation, or upload local media to start editing. The workflow is **connect models → generate assets → edit → arrange a timeline → export**. See [Make your first short film](docs/guides/user-guide.md#make-your-first-short-film).

Use Chrome or Edge for MP4 export, and keep the page and editor open while rendering.

## Documentation

- [Installation and updates](docs/guides/installation.md): Prerequisites, platform instructions, startup, and updates.
- [User guide](docs/guides/user-guide.md): Model connections, AI collaboration, canvas, media editing, and export.
- [Troubleshooting](docs/guides/user-guide.md#troubleshooting): Installation, generation, saving, and export issues.
- [Business CLI (Chinese)](docs/guides/cli.md): Work with projects through a terminal or Agent Shell.
- [Documentation index (Chinese)](docs/README.md): Architecture, development, and validation documents.

## Community

Join the **OpenDirector with vLLM-Omni (2)** WeChat group to discuss OpenDirector and share your creations. Scan the QR code below in WeChat, or click the image to view it at full resolution.

<p align="center">
  <a href="docs/guides/assets/opendirector-wechat-group-2.png">
    <img src="docs/guides/assets/opendirector-wechat-group-2.png" alt="QR code for the OpenDirector with vLLM-Omni (2) WeChat group" width="360" />
  </a>
</p>

If OpenDirector is useful to you, [give it a star on GitHub](https://github.com/ThinkFlowLab/OpenDirector) to support the project and help others discover it.

<p align="center">
  <a href="https://github.com/ThinkFlowLab/OpenDirector">
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcset="docs/guides/assets/star-opendirector.png" />
      <img src="docs/guides/assets/star-opendirector.gif" alt="Illustrated guide: open ThinkFlowLab/OpenDirector on GitHub and click Star" width="800" />
    </picture>
  </a>
</p>

## Contributing

We welcome bug reports and suggestions through [Issues](https://github.com/ThinkFlowLab/OpenDirector/issues), and code and documentation contributions through pull requests. See the [validation guide (Chinese)](docs/development/validation.md) for development checks.

## License

OpenDirector is released under the [Apache License 2.0](LICENSE). See
[NOTICE](NOTICE) for the third-party components distributed with this
application and for the artwork under `src/assets`.
