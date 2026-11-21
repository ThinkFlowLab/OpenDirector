# OpenDirector website

[中文](#中文)

## Preview

Run these commands from the repository root. The build reads public GitHub Releases and needs network access. Run `npm ci` first if Vite is missing.

```sh
preview=$(mktemp -d)
bash scripts/build-website.sh "$preview/dist/OpenDirector"
node_modules/.bin/vite preview "$preview" --host 127.0.0.1 --port 8780 --strictPort
```

Open <http://127.0.0.1:8780/OpenDirector/>. Vite supports the byte-range requests the player uses to jump to a shot.

## Set up GitHub Pages

1. In `ThinkFlowLab/OpenDirector`, a repository maintainer or admin opens **Settings > Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**. The repository supplies the [Website workflow](../.github/workflows/website.yml) and its deployment permissions. It uses GitHub's built-in token.
2. Merge the website changes into `main`. The Website workflow builds the site and runs its Chromium checks. When they pass, the workflow deploys to the `github-pages` environment. Pull requests run the checks only. To deploy the current `main` manually, open **Actions > Website > Run workflow**, select `main`, and click **Run workflow**.
3. Open the URL in the successful `deploy` job. The default address is <https://thinkflowlab.github.io/OpenDirector/>. Switch languages and check that each download points to the expected Release asset. To roll back a site change, revert it on `main`.

## Publish a desktop release

1. Follow the [release guide](../docs/development/release.md). Check that Release checks and the latest nightly `gate-parity` passed. After the version-bump PR merges, push a new `vMAJOR.MINOR.PATCH` tag on that merge commit to the official repository. The tag must match the version in `apps/desktop/package.json`.
2. The [Desktop release workflow](../.github/workflows/desktop-release.yml) creates or reuses a draft for that tag. macOS and Windows each build and test their installer, then attach it and its `.sha256` file to the draft. For a release that ships both platforms, expect an Apple Silicon DMG, a Windows x64 EXE, and two checksum files.
3. Complete the [desktop acceptance checks](../docs/development/desktop.md#delivery-boundary) for each platform you plan to publish. In **Releases**, open the draft, verify its assets, review the English release notes, and click **Publish release**. Retry failed packaging jobs while the release is still a draft.
4. Publishing the release triggers a Website build on `main`. For each platform, the build selects the highest official version with an uploaded installer for that architecture. The download URL, version label and release notes come from that release. If you add an installer after publication, run **Actions > Website > Run workflow** on `main` to refresh the site.

A Windows-only release updates the Windows download. Mac users keep the latest available Mac package. Until a platform has an official installer, its download points to the [tested desktop preview](https://github.com/FayeSpica/OpenDirector/releases/tag/v0.1.4-desktop-test.23) and carries a test-build label. If the GitHub API request fails, the build stops and the previous deployment stays online.

OpenDirector includes the version in each installer filename. GitHub's `releases/latest/download/<filename>` looks for that exact file in the repository's latest release. Resolving the assets at build time keeps both downloads usable even when they come from different tags. Updating an installed desktop app is tracked in [#367](https://github.com/ThinkFlowLab/OpenDirector/issues/367).

## 中文

### 本地预览

在仓库根目录运行上面的命令。构建时需要联网读取公开的 GitHub Releases。如果缺少 Vite，先运行 `npm ci`。打开 <http://127.0.0.1:8780/OpenDirector/>。Vite 支持分段读取视频，可以直接跳到所选镜头。

### 首次配置 GitHub Pages

1. 具有 Maintain 或 Admin 权限的维护者打开官方仓库 `ThinkFlowLab/OpenDirector` 的 **Settings > Pages**，在 **Build and deployment** 中将 **Source** 设为 **GitHub Actions**。仓库提供了 [Website 工作流](../.github/workflows/website.yml)，其中已声明部署权限，使用 GitHub 内置令牌。
2. 将网站改动合入 `main`。Website 会构建网站并运行 Chromium 检查，通过后部署到 `github-pages` 环境。PR 只运行检查。需要手动部署时，打开 **Actions > Website > Run workflow**，选择 `main`，点击 **Run workflow**。
3. 打开成功的 `deploy` 任务给出的网址，默认地址是 <https://thinkflowlab.github.io/OpenDirector/>。切换语言，确认两个平台的下载链接指向预期的 Release 附件。如需回退网站，在 `main` 撤销对应改动。

### 发布桌面版

1. 按[版本发布指南](../docs/development/release.md)确认 Release checks 和最近一次 nightly 的 `gate-parity` 均已通过。版本号 PR 合入 `main` 后，在该合入提交上打新的 `vMAJOR.MINOR.PATCH` 标签并推到官方仓库。标签中的版本号须与 `apps/desktop/package.json` 一致。
2. [Desktop release 工作流](../.github/workflows/desktop-release.yml)会为该标签创建或复用 Release 草稿。macOS 和 Windows 各自打包，通过本机安装和启动检查后，把安装包和对应的 `.sha256` 文件上传到同一份草稿。两个平台都发布时，草稿应包含 Apple Silicon DMG、Windows x64 EXE 和两份校验文件。
3. 维护者在各发布平台完成[桌面版验收](../docs/development/desktop.zh-CN.md)，再到 **Releases** 打开草稿，核对附件和英文发布说明，点击 **Publish release**。如果打包任务失败，在草稿状态下重跑。
4. 公开 Release 后，Website 会在 `main` 上重新构建。对每个平台，构建脚本选取包含对应架构安装包的最高正式版本，并从该 Release 读取下载地址、版本号和发布说明。如果在公开后补传了安装包，到 **Actions > Website > Run workflow** 选择 `main` 刷新网站即可。

如果本次只发 Windows 包，Windows 下载会更新，Mac 用户仍能下载已有的最新 Mac 包。某个平台首次发布正式安装包前，网站提供[已验证的桌面测试版](https://github.com/FayeSpica/OpenDirector/releases/tag/v0.1.4-desktop-test.23)，并标明「测试版」。如果请求 GitHub API 失败，本次构建停止，线上继续使用上一次成功部署的页面。

OpenDirector 的安装包文件名含版本号。GitHub 的 `releases/latest/download/<文件名>` 只在仓库最新 Release 中查找该文件。构建时按平台查找附件，即使两个安装包来自不同标签，也能给出各自的下载地址。已安装桌面应用的升级由 [#367](https://github.com/ThinkFlowLab/OpenDirector/issues/367) 跟进。
