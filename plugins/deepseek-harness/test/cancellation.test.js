import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { apply } from '../index.js'
import { OpenDirectorClient } from '../src/client.js'
import { uuid5 } from '../src/operations.js'

test('explicit stop reads the current revision, recovers a lost receipt and preserves provider confirmation', async t => {
  const [projectId, jobId, operationId] = Array.from({ length: 3 }, randomUUID)
  const job = { id: jobId, revision: 7, status: 'running', cancelRequested: false, remoteCancellation: 'not_requested' }
  const snapshot = { project: { id: projectId, name: 'Studio' }, jobs: [job] }
  const root = '/api/creation/projects/' + projectId
  const receipts = new Map()
  const commands = []
  let blocked = false
  let receiptUnavailable = false
  const server = createServer(async (request, response) => {
    assert.equal(request.headers['x-opendirector-request'], '1')
    const reply = (status, value) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    if (request.url === root + '/open') return blocked ? reply(409, { code: 'storage_busy' }) : reply(200, snapshot)
    if (request.method === 'DELETE') return reply(200, {})
    if (request.url.startsWith(root + '/receipts/')) {
      if (receiptUnavailable) return reply(503, {})
      const receipt = receipts.get(request.url.split('/').at(-1))
      return reply(receipt ? 200 : 404, receipt ?? {})
    }
    if (request.url === root + '/queries') return reply(200, job)
    if (request.url === root + '/commands') {
      let body = ''
      for await (const chunk of request) body += chunk
      const command = JSON.parse(body)
      commands.push(command)
      job.cancelRequested = true
      job.remoteCancellation = 'unknown'
      job.status = 'cancelled'
      job.revision += 1
      receipts.set(command.commandId, { status: 'applied' })
      request.socket.destroy()
      return
    }
    reply(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const routes = new Map()
  apply({
    tools: { register() {} }, get() { return undefined },
    inject(_services, configure) {
      configure({
        effect(register) { register() },
        connection: { fetch: { register(route) { routes.set(route.path, route) } } },
      })
    },
  }, { baseUrl })
  const route = routes.get('/api/opendirector/cancel')
  const input = { projectId, jobId, operationId }
  const request = (body, headers = { 'X-OpenDirector-Action': '1' }) => new Request('http://dsh.local/api/opendirector/cancel', {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  assert.equal((await route.fetch(request(input, {}))).status, 403)
  assert.equal((await route.fetch(request(input, { 'X-OpenDirector-Action': '1', 'Sec-Fetch-Site': 'cross-site' }))).status, 403)
  assert.equal((await route.fetch(request('{'))).status, 400)
  assert.deepEqual(await (await route.fetch(request(input))).json(), { status: 'unknown' })
  assert.equal(commands.length, 1)
  assert.equal(commands[0].type, 'job.cancel')
  assert.equal(commands[0].commandId, uuid5(operationId, 'job.cancel:' + projectId + ':' + jobId))
  assert.deepEqual(commands[0].expectedVersions, [{ objectType: 'job', id: jobId, revision: 7 }])
  receiptUnavailable = true
  assert.deepEqual(await (await route.fetch(request({ ...input, check: true }))).json(), { status: 'unknown' })
  receiptUnavailable = false
  assert.deepEqual(await (await route.fetch(request({ ...input, check: true }))).json(), { status: 'applied' })
  const client = new OpenDirectorClient({ baseUrl, requestTimeoutMs: 1000 })
  assert.deepEqual(await client.cancelCreation(input), { status: 'applied' })
  assert.equal(commands.length, 1)
  for (const remoteCancellation of ['requested', 'unknown', 'confirmed']) {
    job.remoteCancellation = remoteCancellation
    assert.deepEqual(await client.creationStatus(projectId, jobId), {
      status: 'cancelled', cancelRequested: true, remoteCancellation, category: undefined,
    })
  }
  job.cancelRequested = false
  job.status = 'succeeded'
  assert.deepEqual(await client.cancelCreation({ ...input, operationId: randomUUID() }), { status: 'noop' })
  assert.equal(commands.length, 1)
  blocked = true
  assert.deepEqual(await (await route.fetch(request({ ...input, operationId: randomUUID() }))).json(),
    { status: 'rejected', code: 'storage_busy' })
  assert.equal(commands.length, 1)
})
