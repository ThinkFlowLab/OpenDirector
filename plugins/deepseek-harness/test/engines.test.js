import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

/** Mirrors DSH app-boot `evaluatePluginCompatibility` for the engines.dsh path:
 * `semver.satisfies(runtime, range, { includePrerelease: true })`.
 * Official source: deepseek-ai/deepseek-harness packages/boot/app-boot/src/plugin-compatibility.ts
 */
function enginesCompatibility(manifest, runtimeVersion) {
  const range = manifest.engines?.dsh
  if (typeof range !== 'string') throw new Error('engines.dsh must be a string')
  if (semver.valid(runtimeVersion) === null) {
    throw new Error(`Invalid dsh runtime version: ${JSON.stringify(runtimeVersion)}`)
  }
  const ok = range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
  return ok ? undefined : { 'engines.dsh': range }
}

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
)
const RANGE = '>=0.2.2-rc.1 <0.3.0-0'

test('engines.dsh requires a 0.2 minimum rather than an exact DSH version', () => {
  assert.equal(manifest.engines.dsh, RANGE)
  assert.equal(manifest.engines.node, '>=24.9.0')
})

test('the published exact pin rejects the newer host from the bug report', () => {
  const exact = { engines: { dsh: '0.2.2-rc.1' } }
  assert.deepEqual(enginesCompatibility(exact, '0.2.2-rc.5'), { 'engines.dsh': '0.2.2-rc.1' })
  assert.equal(enginesCompatibility(exact, '0.2.2-rc.1'), undefined)
})

test('the declared range admits 0.2.2-rc.1 and later 0.2 hosts, including 0.2.2-rc.5', () => {
  const admitted = ['0.2.2-rc.1', '0.2.2-rc.5', '0.2.2', '0.2.3', '0.2.3-rc.1', '0.2.9-alpha.0']
  const rejected = ['0.2.1', '0.2.1-rc.5', '0.2.2-rc.0', '0.3.0-rc.1', '0.3.0', '1.0.0']
  for (const version of admitted) {
    assert.equal(enginesCompatibility(manifest, version), undefined, `should admit ${version}`)
  }
  for (const version of rejected) {
    assert.deepEqual(
      enginesCompatibility(manifest, version),
      { 'engines.dsh': RANGE },
      `should reject ${version}`,
    )
  }
})
