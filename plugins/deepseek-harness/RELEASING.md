# Preparing a plugin release

The plugin tarball is the release unit. Keep the tested tarball, screenshots and recording together; use the same bytes for npm and the GitHub Release.

## Prepare the files

From this package directory:

~~~sh
npm test
npm pack --pack-destination /absolute/path/to/candidates
npm run release:prepare -- \
  --tarball /absolute/path/to/candidates/opendirector-dsh-plugin-0.1.0.tgz \
  --output /absolute/path/to/release-candidate
~~~

Commit package changes locally before preparing the release. The script checks every packaged file against the current commit and creates a new output directory containing:

- The tested .tgz and its SHA-256 file.
- Bilingual release-notes.md, with versioned installation links.
- plugin-index.json, using DSH's format 1 and the package's exact npm version and DSH requirements.
- release.json, with the source commit, checksum, release tag and proposed publishing commands.

The script only writes local files. If a candidate already exists, choose another output directory. The Linux plugin check also prepares these files in its downloadable workflow artifact.

## Review and publish

Choose the version in package.json and package-lock.json before packaging. Confirm access to the @opendirector npm scope and the target repository. Review the release text, screenshots, host version and hands-on results for this exact tarball.

Run the command in release.json from the prepared directory to publish the tarball to npm. Create the draft GitHub Release with the same package and checksum, then attach the demo assets and finish the release description. The command pins the release tag to the tested source commit.

An index can install an exact npm version or a pinned Git commit and package path. Publish the npm version before making the prepared npm entry available. Set publishTimestamp to the actual publication time, or regenerate with --published-at <ISO date>. Add the entry to a community index, or host the generated JSON at a stable URL and add that source in DSH's **Custom plugin indexes**.

DSH owns installation and compatible-version updates. A tarball remains useful for PR trials; a registry package provides a simpler update path.

[DSH index format](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/util/plugin-market-index/README.md) · [Plugin guide](README.md)

---

## 中文

先固定并验证安装包，再准备发布材料。运行上面的命令，会一起生成安装包、SHA-256、双语 Release 文案、插件索引和发布记录；脚本只在本地生成文件，不执行发布。

打包前确定版本，并将包内文件提交到本地。脚本逐个核对安装包与当前提交，避免演示、校验文件和发布代码对不上。已有候选目录会保留，新一轮使用另一个目录。

发布前核对 npm 作用域与仓库权限，检查实际宿主版本、媒体来源和手动验收记录。npm 与 GitHub Release 使用同一个安装包；Release 标签固定到相应源码提交。工作流也会提供这些材料，供 PR 试用。

插件索引支持明确的 npm 版本或固定 Git 提交及包目录。生成的 npm 条目应在对应版本发布后再提供给用户，并填写实际发布时间。可以提交到社区索引，也可以托管自己的索引，让用户在 DSH 的「自定义插件索引」里添加。后续安装和升级沿用 DSH 的入口。
