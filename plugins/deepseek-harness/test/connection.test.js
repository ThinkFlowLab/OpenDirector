import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply } from '../index.js'
import manifest from '../package.json' with { type: 'json' }
import { connectionStatus } from '../src/connection.js'
import { NetworkError, RequestTimeoutError } from '../src/errors.js'

test('connection route reads counts and capabilities without exposing model or project data', async () => {
  let mode = 'ready'
  const calls = []
  const secret = 'private-provider-key-and-project-name'
  const server = createServer((request, response) => {
    calls.push([request.method, request.url])
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/creation/projects') {
      response.end(JSON.stringify({ projects: [{ id: 'private-id', name: secret }] }))
    } else if (request.url === '/api/model-configs') {
      if (mode === 'denied') {
        response.writeHead(403).end(JSON.stringify({ detail: secret }))
      } else if (mode === 'malformed') {
        response.end(JSON.stringify({ detail: secret }))
      } else {
        response.end(JSON.stringify(mode === 'empty' ? [] : [
          { id: secret, kind: 'image', modelId: secret, apiKey: secret, inputRules: { allowedKinds: ['image'], maxImages: 2 } },
          { kind: 'video', apiKey: secret, inputRules: { allowedKinds: ['image'], maxImages: 1,
            videoModes: ['first_frame', 'continuation'], videoCapabilities: { outputs: [] } } },
          { kind: 'audio', apiKey: secret, protocol: 'minimax_speech' },
          { kind: 'audio', apiKey: secret, protocol: 'vllm_omni_music' },
        ]))
      }
    } else response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    let route
    const baseUrl = 'http://127.0.0.1:' + server.address().port
    apply({
      tools: { register() {} }, get() {},
      inject(_services, configure) {
        configure({ effect(register) { register() }, connection: { fetch: { register(value) {
          if (value.path === '/api/opendirector/connection') route = value
        } } } })
      },
    }, { baseUrl, canvasBaseUrl: 'http://localhost:5173', requestTimeoutMs: 700 })
    assert.deepEqual(route.methods, ['GET'])
    const check = () => route.fetch(new Request('http://localhost/api/opendirector/connection'))
    let response = await check()
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    let value = await response.json()
    assert.equal(value.apiUrl, baseUrl)
    assert.equal(value.canvasUrl, 'http://localhost:5173')
    assert.equal(value.version, manifest.version)
    assert.deepEqual(value.projects, { status: 'ok', count: 1 })
    assert.deepEqual(value.models, { status: 'ok', count: 3, capabilities: {
      image: 1, imageEdit: 1, imageToVideo: 1, videoContinuation: 1, voiceover: 1,
    } })
    assert.ok(!JSON.stringify(value).includes(secret))

    mode = 'empty'
    value = await (await check()).json()
    assert.equal(value.models.status, 'ok')
    assert.equal(value.models.count, 0)
    assert.ok(Object.values(value.models.capabilities).every(count => count === 0))

    mode = 'denied'
    value = await (await check()).json()
    assert.deepEqual(value.projects, { status: 'ok', count: 1 })
    assert.deepEqual(value.models, { status: 'access' })
    assert.ok(!JSON.stringify(value).includes(secret))

    mode = 'malformed'
    value = await (await check()).json()
    assert.deepEqual(value.models, { status: 'response' })
    assert.ok(calls.every(([method, path]) => method === 'GET'
      && ['/api/creation/projects', '/api/model-configs'].includes(path)))
    assert.equal(calls.length, 8)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('connection check distinguishes service timeout, network failure and caller cancellation', async () => {
  const controller = new AbortController()
  const client = {
    async listProjects({ signal }) { assert.equal(signal, controller.signal); throw new RequestTimeoutError(5000) },
    async creationModels({ signal }) { assert.equal(signal, controller.signal); throw new NetworkError('private-url', new Error('private-details')) },
  }
  const config = { baseUrl: 'http://localhost:8000', canvasBaseUrl: 'http://localhost:5173' }
  const report = await connectionStatus(client, config, '0.1.0', { signal: controller.signal })
  assert.deepEqual(report.projects, { status: 'timeout' })
  assert.deepEqual(report.models, { status: 'network' })
  assert.ok(!JSON.stringify(report).includes('private-'))
  controller.abort(new Error('closed'))
  await assert.rejects(connectionStatus(client, config, '0.1.0', { signal: controller.signal }), /closed/)
})
