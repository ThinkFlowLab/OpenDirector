# Desktop application

[中文](desktop.zh-CN.md)

See [Desktop architecture](../architecture/desktop.md) for the processes, project storage, and shutdown behavior.

## Build and check

Build on the target OS and architecture. Build prerequisites are Node.js from `.nvmrc`, npm, uv, and standalone FFmpeg/ffprobe binaries. End users do not need those development tools.

```bash
npm ci --prefix apps/desktop
npm test --prefix apps/desktop
OPENDIRECTOR_FFMPEG_DIR=/absolute/path/to/standalone-media npm run prepare:runtime --prefix apps/desktop
npm run pack --prefix apps/desktop
node apps/desktop/scripts/smoke.mjs /absolute/path/to/packaged/OpenDirector
```

The runtime preparation builds the Python wheel using the existing build backend, including Web assets, skills and the actual OpenCode executable. It installs the wheel and dependencies into a private standalone Python distribution, validates CLI help and both media binaries, and records the target in `runtime/manifest.json`. It never modifies system Python. Supply media binaries with their redistribution licenses for the target; system package-manager binaries with external shared-library dependencies are not portable.

The smoke check launches the actual packaged executable with isolated temporary data, opens the canvas, drops local MP4, PNG, and WAV files and verifies their assets and nodes persist across launches, checks authenticated health and project queries, verifies renderer isolation and both locales, hides the window without stopping the Host, and reopens the same project after quitting. It makes no provider calls. It does not establish Agent-assisted creation, export quality, signing, or support on an untested platform.

## Terminal command

Use **Manage terminal command** in the application menu to install the launcher in `~/.local/bin`. Add that directory to PATH if needed. The app preserves existing entries. To uninstall or repair an old installation, check the path shown in the app and manually remove the OpenDirector entry. To repair it, run Install again. `opendirector desktop` opens this installation; `opendirector serve` runs the ordinary standalone API. Business CLI commands retain their existing `--url`, project, session and revision rules. Automatic attachment of an external CLI to the private desktop Host is not available.

## Delivery boundary

This is the shared application for #363. Platform installers, signing and distribution are #364–#366; automatic updates are #367. Browser rendering still requires the application process. Closing the application cannot finish a browser export in the background. Microphone access is not enabled in this initial shell.

Before release, run the complete clean-machine acceptance in #363 on each declared platform: Agent-assisted creation and tool use, editing, export, reopen, failure recovery, duplicate launch and locks. A successful smoke check alone is insufficient. OS/architecture support and signing status must be recorded with each platform's acceptance evidence.

## Release packages

The desktop release workflow builds an Apple Silicon DMG with an ad-hoc signed App and an unsigned Windows x64 NSIS installer. Each platform uploads its installer and SHA-256 file to the shared draft release after its native checks pass. The macOS job verifies the installed App signature before and after the smoke test.
