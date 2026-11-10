import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { apply } from '../index.js'

test('browse saved results without a lease and adopt with a recoverable receipt', async t => {
  const [project, spec, item, original, candidate, audio, originalAsset, candidateAsset, job, operationId] =
    Array.from({ length: 10 }, randomUUID)
  const snapshot = {
    project: { id: project, name: 'Studio' },
    generationSpecs: [{ id: spec, revision: 4, currentResultId: original }],
    canvasItems: [{ id: item, revision: 7, binding: { role: 'generation', objectRef: { id: spec } } }],
    jobs: [{ id: job, inputSnapshot: { spec: { prompt: 'Add a lamp' } } }],
    results: [
      { id: original, specId: spec, asset: { kind: 'image', assetId: originalAsset } },
      { id: candidate, specId: spec, jobId: job, asset: { kind: 'image', assetId: candidateAsset } },
      { id: audio, asset: { kind: 'audio', assetId: audio } },
    ],
  }
  const calls = []
  const path = '/api/creation/projects/' + project
  let blocked = true
  let receiptUnavailable = true
  let command
  const server = createServer(async (request, response) => {
    calls.push([request.method, request.url])
    function reply(status, value) {
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    }
    if (request.url === path) return reply(200, snapshot)
    if (request.url === '/api/creation/projects') return reply(200, { projects: [snapshot.project] })
    if (request.url === path + '/open') {
      return blocked ? reply(409, { code: 'storage_busy' }) : reply(200, snapshot)
    }
    if (request.url === path + '/commands') {
      let body = ''
      for await (const chunk of request) body += chunk
      command = JSON.parse(body)
      snapshot.generationSpecs[0].currentResultId = candidate
      // The command commits, but the response is lost.
      request.socket.destroy()
      return
    }
    if (command && request.url === path + '/receipts/' + command.commandId) {
      return receiptUnavailable ? reply(503, {}) : reply(200, { status: 'applied' })
    }
    if (request.method === 'DELETE') return reply(200, {})
    reply(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })

  const routes = new Map()
  apply({
    tools: { register() {} },
    get() {},
    inject(_services, configure) {
      configure({
        effect(register) { register() },
        connection: { fetch: { register(value) { routes.set(value.path, value.fetch) } } },
      })
    },
  }, { baseUrl: 'http://127.0.0.1:' + server.address().port })
  const library = routes.get('/api/opendirector/library')
  const projects = await library({ url: '/api/opendirector/library' })
  assert.deepEqual(await projects.json(), { projects: [snapshot.project] })
  const recent = await library({ url: '/api/opendirector/library?project=' + project })
  const { results } = await recent.json()
  assert.deepEqual(results.map(result => [result.resultId, result.selected, result.prompt]), [
    [candidate, false, 'Add a lamp'],
    [original, true, ''],
  ])
  assert.deepEqual(calls, [['GET', '/api/creation/projects'], ['GET', path]])

  const adopt = routes.get('/api/opendirector/adopt')
  const request = (input, headers = { 'X-OpenDirector-Action': '1', 'Sec-Fetch-Site': 'same-origin' }) => new Request(
    'http://localhost/api/opendirector/adopt',
    { method: 'POST', headers, body: JSON.stringify({ projectId: project, resultId: candidate, operationId, ...input }) },
  )
  assert.equal((await adopt(request({}, {}))).status, 403)
  assert.equal((await adopt(request({}, { 'X-OpenDirector-Action': '1', 'Sec-Fetch-Site': 'cross-site' }))).status, 403)
  assert.equal(calls.length, 2)
  const busy = await adopt(request({}))
  assert.equal((await busy.json()).code, 'storage_busy')
  assert.equal(command, undefined)
  blocked = false
  const unknown = await adopt(request({}))
  assert.equal((await unknown.json()).status, 'unknown')
  assert.deepEqual(command.payload, { specId: spec, resultId: candidate })
  assert.deepEqual(command.expectedVersions, [
    { objectType: 'generation_spec', id: spec, revision: 4 },
    { objectType: 'canvas_item', id: item, revision: 7 },
  ])
  const unavailable = await adopt(request({ check: true }))
  assert.equal((await unavailable.json()).status, 'unknown')
  receiptUnavailable = false
  const checked = await adopt(request({ check: true }))
  assert.equal((await checked.json()).status, 'applied')
  assert.deepEqual(calls.at(-1), ['GET', path + '/receipts/' + command.commandId])
  assert.equal(calls.filter(([, url]) => url === path + '/commands').length, 1)
})
