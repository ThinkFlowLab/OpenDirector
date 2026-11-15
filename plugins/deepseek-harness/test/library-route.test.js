import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { apply } from '../index.js'
import { OpenDirectorClient } from '../src/client.js'

test('browse saved results without a lease and adopt with a recoverable receipt', async t => {
  const [project, spec, item, original, candidate, audio, originalAsset, candidateAsset, job, operationId] =
    Array.from({ length: 10 }, randomUUID)
  const snapshot = {
    project: { id: project, name: 'Studio' },
    generationSpecs: [{ id: spec, revision: 4, currentResultId: original }],
    canvasItems: [{ id: item, revision: 7, binding: { role: 'generation', objectRef: { id: spec } } }],
    jobs: [{ id: job, status: 'running', inputSnapshot: {
      spec: { kind: 'image', prompt: 'Add a lamp' }, model: { modelId: 'image-01', url: 'http://private-model' },
    } }],
    assets: [{ id: audio, metadata: { durationSeconds: 4.92 } }, { id: candidateAsset, metadata: { width: 512, height: 512 } }],
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
  assert.deepEqual(await projects.json(), { projects: [snapshot.project], scope: 'http://127.0.0.1:' + server.address().port })
  const recent = await library({ url: '/api/opendirector/library?project=' + project })
  const { results } = await recent.json()
  assert.deepEqual(results.map(result => [result.resultId, result.selected, result.prompt]), [
    [audio, false, ''],
    [candidate, false, 'Add a lamp'],
    [original, true, ''],
  ])
  assert.deepEqual(results.map(result => result.details), [{ durationSeconds: 4.92 }, { width: 512, height: 512 }, undefined])
  assert.deepEqual(calls, [['GET', '/api/creation/projects'], ['GET', path]])
  const current = await library({ url: '/api/opendirector/library?' + new URLSearchParams({
    project, kind: 'image', selection: 'current', order: 'oldest',
  }) })
  assert.deepEqual((await current.json()).results.map(item => item.resultId), [original])
  assert.equal((await library({ url: '/api/opendirector/library?' + new URLSearchParams({
    project, after: randomUUID(),
  }) })).status, 409)
  const tasks = await library({ url: '/api/opendirector/library?' + new URLSearchParams({ project, view: 'jobs' }) })
  assert.deepEqual((await tasks.json()).jobs, [{
    jobId: job, kind: 'image', status: 'running', prompt: 'Add a lamp', modelId: 'image-01',
  }])

  const adopt = routes.get('/api/opendirector/adopt')
  const request = (input, headers = { 'X-OpenDirector-Action': '1', 'Sec-Fetch-Site': 'same-origin' }) => new Request(
    'http://localhost/api/opendirector/adopt',
    { method: 'POST', headers, body: JSON.stringify({ projectId: project, resultId: candidate, operationId, ...input }) },
  )
  assert.equal((await adopt(request({}, {}))).status, 403)
  assert.equal((await adopt(request({}, { 'X-OpenDirector-Action': '1', 'Sec-Fetch-Site': 'cross-site' }))).status, 403)
  assert.equal(calls.length, 5)
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

test('library filters the full history before pagination and keeps a stable page boundary', async () => {
  const project = randomUUID()
  const spec = randomUUID()
  const makeResult = kind => ({ id: randomUUID(), specId: spec, asset: { kind, assetId: randomUUID() } })
  const images = Array.from({ length: 15 }, () => makeResult('image'))
  const videos = Array.from({ length: 15 }, () => makeResult('video'))
  const snapshot = {
    project: { id: project, name: 'Studio' }, jobs: [],
    generationSpecs: [{ id: spec, currentResultId: images[0].id }],
    assets: [{ id: videos.at(-1).asset.assetId, metadata: { width: 832, height: 480, durationSeconds: 5.0625 } }],
    results: [...images, ...videos],
  }
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', canvasBaseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    fetchImpl: async (_url, request) => {
      assert.equal(request.method, 'GET')
      return Response.json(snapshot)
    },
  })
  const first = await client.libraryResults(project, { kind: 'image' })
  const video = await client.libraryResults(project, { kind: 'video' })
  assert.deepEqual(video.results[0].details, { width: 832, height: 480, durationSeconds: 5.0625 })
  const order = [...images].reverse().map(item => item.id)
  assert.deepEqual(first.results.map(item => item.resultId), order.slice(0, 12))
  assert.equal(first.nextCursor, order[11])
  snapshot.results.push(makeResult('image'))
  const second = await client.libraryResults(project, { kind: 'image', after: first.nextCursor })
  assert.deepEqual(second.results.map(item => item.resultId), order.slice(12))
  assert.equal(second.nextCursor, null)
  const oldest = await client.libraryResults(project, { kind: 'image', selection: 'other', order: 'oldest' })
  assert.deepEqual(oldest.results.map(item => item.resultId), images.slice(1, 13).map(item => item.id))
})

test('task history filters and pages saved jobs without creating an editing session', async () => {
  const projectId = randomUUID()
  const makeJob = (kind, status) => ({
    id: randomUUID(), status,
    inputSnapshot: { spec: { kind, prompt: 'Studio' }, model: { modelId: 'fixture' } },
  })
  const images = Array.from({ length: 15 }, () => makeJob('image', 'running'))
  const snapshot = { project: { name: 'Studio' }, jobs: [...images, makeJob('video', 'failed')] }
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    fetchImpl: async (url, request) => {
      assert.equal(new URL(url).pathname, '/api/creation/projects/' + projectId)
      assert.equal(request.method, 'GET')
      return Response.json(snapshot)
    },
  })
  const first = await client.libraryJobs(projectId, { kind: 'image' })
  const order = [...images].reverse().map(job => job.id)
  assert.deepEqual(first.jobs.map(job => job.jobId), order.slice(0, 12))
  snapshot.jobs.push(makeJob('image', 'succeeded'))
  const next = await client.libraryJobs(projectId, { kind: 'image', after: first.nextCursor })
  assert.deepEqual(next.jobs.map(job => job.jobId), order.slice(12))
  assert.equal(next.nextCursor, null)
  const video = await client.libraryJobs(projectId, { kind: 'video', order: 'oldest' })
  assert.equal(video.jobs[0].status, 'failed')
  await assert.rejects(client.libraryJobs(projectId, { after: randomUUID() }), { key: 'library.cursor_expired' })
})

test('saved-work search covers the full project and combines with paging, adoption and task status', async t => {
  const projectId = randomUUID()
  const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']
  const records = Array.from({ length: 60 }, (_, index) => ({
    specId: randomUUID(), jobId: randomUUID(), resultId: randomUUID(), assetId: randomUUID(),
    prompt: 'x'.repeat(180) + (index % 2 ? ' afternoon' : ' DeepFocus 青瓷'),
    status: statuses[index % statuses.length], title: 'Reviewed studio ' + index,
  }))
  const snapshot = {
    project: { id: projectId, name: 'Saved work' }, assets: [],
    generationSpecs: records.map((row, index) => ({ id: row.specId, prompt: 'Changed current description', currentResultId: index === 28 ? row.resultId : null })),
    canvasItems: records.map(row => ({ title: row.title, binding: { role: 'generation', objectRef: { id: row.specId } } })),
    jobs: records.map(row => ({ id: row.jobId, status: row.status, inputSnapshot: {
      spec: { id: row.specId, kind: 'image', prompt: row.prompt },
      model: { modelId: 'studio-image-01', url: 'http://private-model', apiKey: 'private-key' },
    } })),
    results: records.map(row => ({ id: row.resultId, specId: row.specId, jobId: row.jobId, asset: { kind: 'image', assetId: row.assetId } })),
  }
  const calls = []
  const server = createServer((request, response) => {
    calls.push([request.method, request.url])
    assert.equal(request.method, 'GET')
    assert.equal(request.url, '/api/creation/projects/' + projectId)
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(snapshot))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  const routes = new Map()
  apply({
    tools: { register() {} }, get() {},
    inject(_services, configure) {
      configure({ effect(register) { register() }, connection: { fetch: { register(value) { routes.set(value.path, value.fetch) } } } })
    },
  }, { baseUrl: 'http://127.0.0.1:' + server.address().port })
  const read = async (filters = {}) => {
    const response = await routes.get('/api/opendirector/library')({
      url: '/api/opendirector/library?' + new URLSearchParams({ project: projectId, ...filters }),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const query = { q: 'ＤＥＥＰＦＯＣＵＳ 青瓷', kind: 'image' }
  const first = await read(query)
  const expected = records.filter((_, index) => index % 2 === 0).reverse().map(row => row.resultId)
  assert.deepEqual(first.results.map(row => row.resultId), expected.slice(0, 12))
  assert.equal(first.results[0].prompt, 'x'.repeat(160))
  assert.doesNotMatch(JSON.stringify(first), /private-model|private-key/)
  const second = await read({ ...query, after: first.nextCursor })
  const third = await read({ ...query, after: second.nextCursor })
  assert.deepEqual([...first.results, ...second.results, ...third.results].map(row => row.resultId), expected)
  assert.equal(third.nextCursor, null)
  const selected = await read({ ...query, selection: 'current' })
  assert.deepEqual(selected.results.map(row => row.resultId), [records[28].resultId])
  assert.equal(selected.results[0].title, 'Reviewed studio 28')
  assert.deepEqual((await read({ q: 'reviewed studio 28' })).results.map(row => row.resultId), [records[28].resultId])
  assert.deepEqual((await read({ q: records[3].resultId })).results.map(row => row.resultId), [records[3].resultId])
  assert.deepEqual((await read({ q: 'Changed current description' })).results, [])
  assert.deepEqual((await read({ q: 'not in this project' })).results, [])
  const active = await read({ view: 'jobs', q: 'STUDIO-IMAGE-01 青瓷', status: 'active', order: 'oldest' })
  assert.deepEqual(active.jobs.map(row => row.jobId), records.filter((row, index) => index % 2 === 0 && row.status === 'queued').map(row => row.jobId))
  const failed = await read({ view: 'jobs', status: 'failed', q: 'afternoon' })
  assert.deepEqual(failed.jobs.map(row => row.jobId), records.filter(row => row.status === 'failed').reverse().map(row => row.jobId))
  const invalid = await routes.get('/api/opendirector/library')({
    url: '/api/opendirector/library?' + new URLSearchParams({ project: projectId, view: 'jobs', status: 'imaginary' }),
  })
  assert.equal(invalid.status, 400)
  const tooLong = await routes.get('/api/opendirector/library')({
    url: '/api/opendirector/library?' + new URLSearchParams({ project: projectId, q: 'x'.repeat(201) }),
  })
  assert.equal(tooLong.status, 400)
  const beforeCompare = calls.length
  const compareRequest = ids => routes.get('/api/opendirector/library')({
    url: '/api/opendirector/library?' + new URLSearchParams({ project: projectId, compare: ids.join(',') }),
  })
  const pair = [records[28].resultId, records[0].resultId]
  const compared = await compareRequest(pair)
  assert.equal(compared.status, 200)
  const comparison = await compared.json()
  assert.deepEqual(comparison.images.map(image => [image.resultId, image.selected]), [[pair[0], true], [pair[1], false]])
  assert.equal(comparison.images[0].title, records[28].title)
  assert.equal(calls.length, beforeCompare + 1)
  assert.doesNotMatch(JSON.stringify(comparison), /private-model|private-key/)
  assert.equal((await compareRequest([pair[0], pair[0]])).status, 400)
  assert.equal((await compareRequest([pair[0]])).status, 400)
  assert.equal(calls.length, beforeCompare + 1)
  snapshot.results[0].asset.kind = 'audio'
  assert.equal((await compareRequest(pair)).status, 400)
  snapshot.results[0].asset.kind = 'image'
  assert.equal((await compareRequest([pair[0], randomUUID()])).status, 400)
  assert.ok(calls.length > 10)
  assert.equal(snapshot.generationSpecs[28].currentResultId, records[28].resultId)
})
