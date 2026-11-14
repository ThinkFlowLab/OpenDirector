import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
const packageSpecifier = name => `${manifest.name}/${name}`

async function readExportedFile(specifier) {
  const path = require.resolve(packageSpecifier(specifier))
  return { path, contents: await readFile(path, 'utf8') }
}

async function assertFile(path, label) {
  const info = await stat(path)
  assert.ok(info.isFile(), `${label} must resolve to a file: ${path}`)
}

test('package exports expose locale entries and a local icon', async () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.icon, './icon.svg')
  assert.ok(manifest.files.includes('locale/*.json'))
  assert.ok(manifest.files.includes('icon.svg'))

  for (const [name, target] of Object.entries(manifest.exports)) {
    if (!target.includes('*')) await assertFile(resolve(packageRoot, target), `exports[${name}]`)
  }
  await assertFile(resolve(packageRoot, manifest.main), 'main')
  await assertFile(resolve(packageRoot, manifest.icon), 'icon')

  const localeFiles = await readdir(resolve(packageRoot, 'locale'))
  for (const name of ['en.json', 'zh.json']) assert.ok(localeFiles.includes(name), `locale/${name} must ship`)
})

test('locale metadata identifies OpenDirector with matching user-facing descriptions', async () => {
  const en = JSON.parse((await readExportedFile('locale/en.json')).contents)
  const zh = JSON.parse((await readExportedFile('locale/zh.json')).contents)

  assert.deepEqual(Object.keys(en), Object.keys(zh))
  assert.deepEqual(Object.keys(en.meta).sort(), Object.keys(zh.meta).sort())

  for (const locale of [en, zh]) {
    assert.equal(locale.meta.title, 'OpenDirector')
    assert.equal(typeof locale.meta.description, 'string')
    assert.ok(locale.meta.description.trim().length > 0)
  }

  const english = en.meta.description
  assert.match(english, /^[A-Z]/)
  assert.ok(english.endsWith('.'))
  assert.doesNotMatch(english, /\n/)

  const chinese = zh.meta.description
  assert.match(chinese, /[\u4e00-\u9fff]/)
  assert.ok(chinese.endsWith('。'))
  assert.notEqual(chinese, english)
})

test('icon is small, self-contained, and the package points at real project resources', async () => {
  const { path, contents } = await readExportedFile('icon')
  const bytes = Buffer.byteLength(contents)
  assert.ok(bytes < 3 * 1024, `icon must stay under 3KB, got ${bytes} bytes`)
  assert.match(contents, /^<svg\b/)
  assert.match(contents, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(contents, /viewBox="0 0 64 64"/)
  assert.doesNotMatch(contents, /<image\b|<script\b|<foreignObject\b|<text\b|@import\b|url\(|font-family/i)
  assert.doesNotMatch(contents, /\b(?:href|xlink:href)\s*=/i)
  await assertFile(path, 'icon export')

  assert.equal(manifest.repository.type, 'git')
  assert.equal(manifest.repository.url, 'git+https://github.com/ThinkFlowLab/OpenDirector.git')
  assert.equal(manifest.repository.directory, 'plugins/deepseek-harness')
  assert.equal(manifest.homepage, 'https://github.com/ThinkFlowLab/OpenDirector/tree/main/plugins/deepseek-harness')
  assert.equal(manifest.bugs.url, 'https://github.com/ThinkFlowLab/OpenDirector/issues')
  for (const keyword of ['deepseek-harness', 'dsh-plugin', 'opendirector', 'media']) {
    assert.ok(manifest.keywords.includes(keyword), `keywords must include ${keyword}`)
  }
})
