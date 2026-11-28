#!/usr/bin/env node
// Prepare one frozen package locally. npm and GitHub publishing are separate.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises'
import { dirname, resolve, relative, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!['--tarball', '--output', '--published-at'].includes(key) || !process.argv[i + 1]) {
    throw new Error('Usage: npm run release:prepare -- --tarball <tested.tgz> --output <new-directory> [--published-at <ISO date>]')
  }
  options[key.slice(2)] = process.argv[i + 1]
}
if (!options.tarball || !options.output) throw new Error('--tarball and --output are required')
const tarball = resolve(options.tarball)
const output = resolve(options.output)
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 })
const listing = run('tar', ['-tzf', tarball]).toString().trim().split(/\r?\n/)
if (listing.some(name => !name.startsWith('package/') || name.split('/').includes('..'))) throw new Error('Expected an npm package archive')
const readEntry = name => run('tar', ['-xOzf', tarball, 'package/' + name])
const manifest = JSON.parse(readEntry('package.json'))
if (manifest.name !== '@opendirector/dsh-plugin' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) {
  throw new Error('Unexpected package name or version')
}
const commit = run('git', ['rev-parse', 'HEAD']).toString().trim()
const repoRoot = run('git', ['rev-parse', '--show-toplevel']).toString().trim()
const packagePath = relative(repoRoot, root).replaceAll('\\', '/')
for (const name of listing.filter(name => !name.endsWith('/'))) {
  const path = name.slice('package/'.length)
  const committed = run('git', ['show', commit + ':' + packagePath + '/' + path], repoRoot)
  if (!readEntry(path).equals(committed)) throw new Error('The tested tarball differs from the committed file: ' + path)
}
try {
  await stat(output)
  throw new Error('Choose a new output directory to keep an earlier publication candidate intact')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const repository = manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
const tag = 'dsh-plugin-v' + manifest.version
const releaseUrl = repository + '/releases/download/' + tag
const filename = basename(tarball)
if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(filename)) throw new Error('Use an npm tarball filename')
const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
const publishedAt = options['published-at'] ?? new Date().toISOString()
const publishTimestamp = Math.floor(Date.parse(publishedAt) / 1000)
if (!Number.isSafeInteger(publishTimestamp) || publishTimestamp < 0) throw new Error('Invalid publication time')
const locale = language => JSON.parse(readEntry('locale/' + language + '.json')).meta
const index = {
  format: 1,
  title: { en: 'OpenDirector plugins', zh: 'OpenDirector 插件' },
  description: { en: 'Media creation in shared OpenDirector projects.', zh: '在共享的 OpenDirector 工程中创作素材。' },
  plugins: [{
    name: manifest.name,
    title: { en: locale('en').title, zh: locale('zh').title },
    description: { en: locale('en').description, zh: locale('zh').description },
    icon: 'data:image/svg+xml;base64,' + readEntry(manifest.icon.slice(2)).toString('base64'),
    homepage: manifest.homepage,
    repository: { url: repository, directory: manifest.repository.directory },
    metadata: { keywords: manifest.keywords },
    versions: [{ version: manifest.version, publishTimestamp, source: { type: 'npm' }, engines: { dsh: manifest.engines.dsh } }],
  }],
}
const guide = repository + '/tree/' + tag + '/' + packagePath
const notes = `# OpenDirector for DeepSeek Harness ${manifest.version}

Create images, video and voiceover in DSH. Compare candidates, refine a saved result, choose a version and return to the same OpenDirector project.

- Generate 1–4 candidates, inspect the output and adopt the version you prefer.
- Edit with ordered image references, animate an image, or continue a supported clip.
- Reopen saved work after a reload and check an unconfirmed submission before retrying.
- Create a character action pack, refine individual actions and export the selected media as a ZIP.
- Start with a ready-made description, and check the service connection from the composer.

## Install

Download [${filename}](${releaseUrl}/${filename}) and its [SHA-256 file](${releaseUrl}/${filename}.sha256).
In DSH, choose **Plugins → Add plugin**, enter the local tarball path and enable OpenDirector.
For the CLI, run:

\`\`\`sh
dsh plugin --profile studio add ./${filename}
\`\`\`

Start OpenDirector first. See the [setup guide](${guide}) for connection settings.
DSH requirement: \`${manifest.engines.dsh}\`; Node.js: \`${manifest.engines.node}\`.

## Package

SHA-256: \`${sha256}\`
Source: [\`${commit.slice(0, 7)}\`](${repository}/commit/${commit})

## Validation to complete before publication

Add the tested host version, media source, checks and hands-on acceptance evidence for this package.
The index file is a publication draft; publish the exact npm version before making that entry available.

---

在 DSH 中生成图片、视频和配音，对比候选，调整已保存的结果，再回到同一个 OpenDirector 工程继续编辑。

支持成组候选、参考图改图、图片转视频、工程找回和角色动作素材包导出。创作表单提供可填入的示例，输入框旁可检查服务连接。

下载本页安装包后，在 DSH 的「插件 → 添加插件」中输入本地路径并启用 OpenDirector。先启动 OpenDirector；连接配置见上方安装说明。发布前请补齐这个安装包对应的实际验收记录。
`
const presentationFiles = ['icon.svg', 'README.md', 'README.zh-CN.md', 'docs/showcase.html', 'docs/showcase.md',
  'docs/media/walkthrough.mp4', 'docs/media/walkthrough.gif', 'docs/media/workflow.png']
const presentation = presentationFiles.map(path => ({
  path, bytes: run('git', ['show', commit + ':' + packagePath + '/' + path], repoRoot),
}))
await mkdir(output)
for (const file of presentation) {
  const target = join(output, file.path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, file.bytes)
}
await copyFile(tarball, join(output, filename))
await writeFile(join(output, filename + '.sha256'), sha256 + '  ' + filename + '\n')
await writeFile(join(output, 'plugin-index.json'), JSON.stringify(index, null, 2) + '\n')
await writeFile(join(output, 'release-notes.md'), notes)
await writeFile(join(output, 'release.json'), JSON.stringify({
  status: 'local publication draft', name: manifest.name, version: manifest.version, sourceCommit: commit,
  package: filename, sha256, tag, repository, presentation: 'docs/showcase.html', proposedPublishTimestamp: publishTimestamp,
  indexSource: 'npm; publish the exact version before distributing the index',
  commands: {
    npm: 'npm publish ' + filename + ' --access public',
    github: 'gh release create ' + tag + ' ' + filename + ' ' + filename + '.sha256 docs/media/walkthrough.mp4 docs/media/walkthrough.gif docs/media/workflow.png --repo ' +
      repository.replace('https://github.com/', '') + ' --target ' + commit + ' --title "OpenDirector DSH ' + manifest.version + '" --notes-file release-notes.md --draft',
  },
}, null, 2) + '\n')
console.log(JSON.stringify({ output, version: manifest.version, commit, sha256, status: 'prepared locally; nothing published' }))
