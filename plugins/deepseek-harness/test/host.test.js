import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createMessages } from '../src/i18n.js'
import { renderToolResult } from '../src/presentation.js'

test('real DSH Loader and Native executor preserve nullable backend facts, localization, and unload', async () => {
  const projectId = randomUUID()
  const jobId = randomUUID()
  const resultId = randomUUID()
  const specId = randomUUID()
  const asset = { assetId: randomUUID(), revision: 1, fingerprint: `sha256:${'a'.repeat(64)}`, kind: 'image' }
  const snapshot = {
    project: { id: projectId, revision: 1, name: 'Studio' },
    generationSpecs: [{ id: specId, currentResultId: null }],
    jobs: [{ id: jobId, revision: 3, status: 'succeeded', originItemId: null, errorDetails: null,
      cancelRequested: false, remoteCancellation: 'not_requested' }],
    results: [{ id: resultId, specId, jobId, asset }],
  }
  const server = createServer((request, response) => {
    assert.equal(request.headers['x-opendirector-request'], '1')
    response.setHeader('Content-Type', 'application/json')
    if (request.url === `/api/creation/projects/${projectId}`) response.end(JSON.stringify(snapshot))
    else { response.statusCode = 404; response.end('{}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeExecutor)
    await ctx.plugin(Loader)
    await ctx.loader.create({
      id: 'opendirector', name: new URL('../index.js', import.meta.url).href,
      config: { baseUrl, locale: 'en-US' },
    })
    await ctx.loader.await()
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'opendirector')
    assert.ok(entry)
    const names = () => ctx.tools.schemas().filter(tool => tool.name.startsWith('opendirector_'))
    assert.equal(names().length, 8)
    const generation = names().find(tool => tool.name === 'opendirector_create_generation').parameters
    assert.deepEqual(generation.required, ['projectId', 'operationId', 'kind', 'modelConfigId', 'prompt', 'parameters', 'position'])
    assert.deepEqual(generation.properties.position.required, ['x', 'y'])
    assert.equal(Object.hasOwn(generation.properties.projectId, 'required'), false)
    const cancel = names().find(tool => tool.name === 'opendirector_cancel').parameters
    assert.deepEqual(cancel.required, ['projectId', 'operationId', 'jobId', 'expectedJobRevision'])
    const definition = ctx.tools.definitions().find(tool => tool.name === 'opendirector_create_generation')
    assert.deepEqual(definition.output.schema.required,
      ['projectId', 'canvasUrl', 'operationId', 'receipt', 'specId', 'itemId', 'referenceIds'])
    async function readJob() {
      const batch = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: randomUUID(), name: 'opendirector_job', arguments: JSON.stringify({ projectId, jobId }) }],
        signal: new AbortController().signal,
      })
      const result = batch.results[0].result
      assert.equal(result.isError, false, JSON.stringify(result))
      return result
    }
    const english = await readJob()
    assert.equal(english.value.job.originItemId, null)
    assert.equal(english.value.job.errorDetails, null)
    assert.match(english.content[0].text, /Candidate saved in this project/)
    assert.match(english.content[0].text, /^revision: 3$/m)
    assert.match(english.content[0].text, /cancelRequested: false/)
    assert.match(english.content[0].text, /remoteCancellation: not_requested/)
    assert.ok(english.content[0].text.includes(JSON.stringify(asset)))
    assert.match(english.content[0].text, new RegExp(`/ai-canvas/${projectId}`))
    assert.doesNotMatch(english.content[0].text, /"jobs"|"generationSpecs"|"models"/)
    await entry.update({ disabled: true })
    await ctx.loader.await()
    assert.equal(names().length, 0)
    await entry.update({ config: { baseUrl, locale: 'zh-CN' }, disabled: false })
    await ctx.loader.await()
    assert.equal(names().length, 8)
    const chinese = await readJob()
    assert.match(chinese.content[0].text, /候选已保存到此工程/)
    assert.doesNotMatch(chinese.content[0].text, /Candidate saved|Status:|Project:/)
  } finally {
    await ctx.fiber.dispose()
    await new Promise(resolve => server.close(resolve))
  }
})

test('cancellation summaries distinguish an applied request from a no-op', () => {
  const t = createMessages('en-US')
  const jobId = randomUUID()
  const applied = renderToolResult('cancel', { jobId, receipt: { status: 'applied' } }, t)
  const noop = renderToolResult('cancel', { jobId, receipt: { status: 'noop' } }, t)
  assert.ok(applied.includes(t('summary.cancelRequested')))
  assert.ok(noop.includes(t('status.noop')))
  assert.ok(noop.includes(jobId))
  assert.ok(!noop.includes(t('summary.cancelRequested')))
})
