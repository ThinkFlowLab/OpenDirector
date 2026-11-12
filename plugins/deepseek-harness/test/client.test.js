import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenDirectorClient } from '../src/client.js'
import { HttpError, UnknownOperationError } from '../src/errors.js'

const baseUrl = 'http://127.0.0.1:8000'
const projectId = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'
const modelConfigId = '33333333-3333-4333-8333-333333333333'
const specId = '44444444-4444-4444-8444-444444444444'

function config(overrides = {}) {
  return {
    baseUrl,
    canvasBaseUrl: 'http://127.0.0.1:5173',
    locale: 'en-US',
    requestTimeoutMs: 1000,
    ...overrides,
  }
}

function response(value, { status = 200, headers = {} } = {}) {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers(headers),
    async text() {
      return text
    },
  }
}

function snapshot() {
  return {
    format: 'opendirector-project',
    formatVersion: 2,
    project: { id: projectId, revision: 1, name: 'Demo' },
    assets: [],
    generationSpecs: [{ id: specId, revision: 1 }],
    references: [],
    canvasItems: [],
    editorDocuments: [],
    jobs: [],
    results: [],
    eventCursor: 1,
    undoClearedThrough: 0,
  }
}

function receipt(status = 'applied') {
  return {
    commandId: operationId,
    projectId,
    inputFingerprint: 'a'.repeat(64),
    status,
    changed: [],
    jobIds: [],
    issues: [],
    eventCursor: 2,
  }
}

function generationArgs(extra = {}) {
  return {
    projectId,
    operationId,
    kind: 'image',
    modelConfigId,
    prompt: 'A lighthouse',
    parameters: { size: '2K' },
    position: { x: 120, y: 80 },
    references: [{
      binding: 'follow_current',
      role: 'reference',
      sourceItemId: '55555555-5555-4555-8555-555555555555',
    }],
    ...extra,
  }
}

test('request carries local headers, a random session, and never follows redirects', async () => {
  const calls = []
  const client = new OpenDirectorClient(config(), {
    heartbeatIntervalMs: 1_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return response([{ id: projectId, name: 'Demo', path: '/tmp/demo' }])
    },
  })
  const projects = await client.listProjects()
  assert.equal(projects.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(calls[0].init.headers['X-OpenDirector-Request'], '1')
  assert.match(calls[0].init.headers['X-OpenDirector-Session'], /^[0-9a-f-]{36}$/)
  assert.equal(calls[0].init.headers['Accept-Language'], 'en-US')
  assert.equal(calls[0].url, `${baseUrl}/api/creation/projects`)
})

test('queries never open or release an edit session', async () => {
  const calls = []
  const client = new OpenDirectorClient(config(), {
    heartbeatIntervalMs: 1_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith(`/api/creation/projects/${projectId}`)) return response(snapshot())
      if (url.endsWith('/api/model-configs')) return response([])
      throw new Error(`unexpected URL ${url}`)
    },
  })
  await client.project(projectId)
  await client.models()
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.init.method === 'GET'))
  assert.ok(calls.every((call) => !call.url.includes('/open')))
  assert.ok(calls.every((call) => !call.url.includes('/sessions/')))
  assert.ok(calls.every((call) => !call.url.endsWith('/commands')))
})

test('a write opens one session, uses it for the command, and releases it', async () => {
  const calls = []
  const client = new OpenDirectorClient(config(), {
    heartbeatIntervalMs: 1_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/open')) return response(snapshot())
      if (url.endsWith('/commands')) return response(receipt())
      if (url.includes('/sessions/')) return response({ ok: true })
      throw new Error(`unexpected URL ${url}`)
    },
  })
  const value = await client.createGeneration(generationArgs())
  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, `${baseUrl}/api/creation/projects/${projectId}/open`)
  assert.equal(calls[1].url, `${baseUrl}/api/creation/projects/${projectId}/commands`)
  assert.equal(calls[2].url.startsWith(`${baseUrl}/api/creation/sessions/`), true)
  assert.equal(calls[2].init.method, 'DELETE')
  const session = calls[0].init.headers['X-OpenDirector-Session']
  assert.equal(calls[1].init.headers['X-OpenDirector-Session'], session)
  assert.equal(calls[2].init.headers['X-OpenDirector-Session'], session)
  const command = JSON.parse(calls[1].init.body)
  assert.equal(command.type, 'canvas.createGeneration')
  assert.equal(command.commandId, operationId)
  assert.equal(command.payload.spec.id, value.specId)
  assert.equal(command.payload.item.id, value.itemId)
  assert.ok(calls.every((call) => !String(call.init.body).includes('job.cancel')))
})

test('a 409 project lease is reported without taking over another session', async () => {
  const calls = []
  const client = new OpenDirectorClient(config(), {
    heartbeatIntervalMs: 1_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/open')) {
        return response({ detail: 'project is busy', code: 'storage_busy' }, { status: 409 })
      }
      throw new Error(`unexpected URL ${url}`)
    },
  })
  await assert.rejects(
    client.createGeneration(generationArgs()),
    (error) => error instanceof HttpError && error.status === 409 && error.code === 'storage_busy',
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[1].init.method, 'DELETE')
  assert.equal(calls[1].init.headers['X-OpenDirector-Session'], calls[0].init.headers['X-OpenDirector-Session'])
})

test('a result reference is pinned from the same open snapshot used for its write', async () => {
  const resultId = '55555555-5555-4555-8555-555555555555'
  const source = { assetId: '66666666-6666-4666-8666-666666666666', revision: 2, fingerprint: `sha256:${'a'.repeat(64)}`, kind: 'video' }
  const methods = []
  let submitted
  const client = new OpenDirectorClient(config(), {
    fetchImpl: async (url, init) => {
      methods.push(init.method)
      if (url.endsWith('/open')) return response({ ...snapshot(), results: [{ id: resultId, asset: source }] })
      if (url.endsWith('/commands')) {
        submitted = JSON.parse(init.body)
        return response(receipt())
      }
      if (url.includes('/sessions/')) return response()
      throw new Error(`unexpected URL ${url}`)
    },
  })
  await client.createGeneration(generationArgs({
    kind: 'video', parameters: { videoMode: 'continuation' }, sourceResultId: resultId, references: undefined,
  }))
  assert.deepEqual(methods, ['POST', 'POST', 'DELETE'])
  assert.deepEqual(submitted.payload.references[0].source, source)
  assert.equal(submitted.payload.references[0].role, 'continuation')
})

test('a transport failure during a write is an unknown operation and is not retried', async () => {
  const calls = []
  const client = new OpenDirectorClient(config(), {
    heartbeatIntervalMs: 1_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/open')) return response(snapshot())
      if (url.endsWith('/commands')) throw new TypeError('socket closed')
      if (url.includes('/sessions/')) return response({ ok: true })
      throw new Error(`unexpected URL ${url}`)
    },
  })
  await assert.rejects(
    client.submit({
      projectId,
      operationId,
      specId,
      expectedSpecRevision: 1,
    }),
    (error) => error instanceof UnknownOperationError
      && error.operationId === operationId
      && error.message.includes('opendirector_operation'),
  )
  const commands = calls.filter((call) => call.url.endsWith('/commands'))
  assert.equal(commands.length, 1)
  assert.equal(commands[0].init.body.includes('job.cancel'), false)
  assert.equal(calls.at(-1).init.method, 'DELETE')
})

test('a write returning 503 can still have a committed receipt', async () => {
  let committed
  let submissions = 0
  const client = new OpenDirectorClient(config(), {
    fetchImpl: async (url, init) => {
      if (url.endsWith('/open')) return response(snapshot())
      if (url.endsWith('/commands')) {
        submissions++
        committed = receipt()
        return response({ code: 'storage_unavailable' }, { status: 503 })
      }
      if (url.includes('/sessions/')) return response()
      if (url.endsWith(`/receipts/${operationId}`)) return response(committed)
      throw new Error(`unexpected URL ${url} (${init.method})`)
    },
  })
  await assert.rejects(client.submit({ projectId, operationId, specId, expectedSpecRevision: 1 }),
    error => error instanceof UnknownOperationError && error.operationId === operationId)
  assert.deepEqual(await client.receipt(projectId, operationId), committed)
  assert.equal(submissions, 1)
})

test('aborting a write does not send job.cancel', async () => {
  const calls = []
  const controller = new AbortController()
  let started
  const commandStarted = new Promise((resolve) => {
    started = resolve
  })
  const client = new OpenDirectorClient(config(), {
    heartbeatIntervalMs: 1_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/open')) return response(snapshot())
      if (url.endsWith('/commands')) {
        started()
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      }
      if (url.includes('/sessions/')) return response({ ok: true })
      throw new Error(`unexpected URL ${url}`)
    },
  })
  const pending = client.submit({
    projectId,
    operationId,
    specId,
    expectedSpecRevision: 1,
    signal: controller.signal,
  })
  await commandStarted
  controller.abort()
  await assert.rejects(pending, (error) => error instanceof UnknownOperationError)
  assert.equal(calls.some((call) => String(call.init.body).includes('job.cancel')), false)
  assert.equal(calls.at(-1).init.method, 'DELETE')
})

test('an unfollowed redirect is a clear HTTP failure', async () => {
  const calls = []
  const client = new OpenDirectorClient(config(), {
    heartbeatIntervalMs: 1_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return response('', { status: 302, headers: { location: 'http://example.invalid' } })
    },
  })
  await assert.rejects(
    client.listProjects(),
    (error) => error instanceof HttpError && error.status === 302 && error.code === 'redirect_not_followed',
  )
  assert.equal(calls.length, 1)
})
