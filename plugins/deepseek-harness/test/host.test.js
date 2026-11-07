import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'

test('real DSH Loader and Native executor preserve nullable backend facts, localization, and unload', async () => {
  const projectId = randomUUID()
  const jobId = randomUUID()
  const resultId = randomUUID()
  const specId = randomUUID()
  const snapshot = {
    project: { id: projectId, revision: 1, name: 'Studio' },
    generationSpecs: [{ id: specId, currentResultId: null }],
    jobs: [{ id: jobId, revision: 3, status: 'succeeded', originItemId: null, errorDetails: null }],
    results: [{ id: resultId, specId, jobId }],
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
