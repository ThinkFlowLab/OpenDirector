import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { OpenDirectorClient } from '../src/client.js'
import { uuid5 } from '../src/operations.js'

test('a direct edit pins saved assets in order and recovers the original submission', async () => {
  const [projectId, operationId, sourceResultId, assetId, modelConfigId, jobId, priorItemId, extraResult, extraAsset] =
    Array.from({ length: 9 }, () => randomUUID())
  const commands = []
  const receipts = new Map()
  const snapshot = {
    project: { id: projectId },
    generationSpecs: [],
    canvasItems: [{ id: priorItemId, parentId: null, position: { x: 40, y: 0 }, width: 352 }],
    results: [
      { id: extraResult, asset: { assetId: extraAsset, kind: 'image', revision: 1, fingerprint: 'b'.repeat(64) } },
      { id: sourceResultId, asset: { assetId, kind: 'image', revision: 1, fingerprint: 'a'.repeat(64) } },
    ],
  }
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    async fetchImpl(url, request) {
      const path = new URL(url).pathname
      if (path === '/api/model-configs') {
        return Response.json([{
          id: modelConfigId, kind: 'image', protocol: 'openai', modelId: 'fixture',
          inputRules: { allowedKinds: ['image'], maxImages: 2, imageOutputs: [{ size: '1024x1024', aspectRatio: '1:1' }] },
        }])
      }
      if (path.endsWith('/open')) return Response.json(snapshot)
      if (request.method === 'DELETE') return Response.json({})
      if (path.includes('/receipts/')) {
        const value = receipts.get(path.split('/').at(-1))
        return Response.json(value ?? {}, { status: value ? 200 : 404 })
      }
      assert.ok(path.endsWith('/commands'))
      const command = JSON.parse(request.body)
      commands.push(command)
      if (command.type === 'canvas.createGeneration') {
        const { spec, item } = command.payload
        snapshot.generationSpecs.push({ ...spec, revision: 1 })
        const receipt = { status: 'applied', changed: [{ id: spec.id, revision: 1 }, { id: item.id, revision: 1 }] }
        receipts.set(command.commandId, receipt)
        return Response.json(receipt)
      }
      receipts.set(command.commandId, { status: 'accepted', jobIds: [jobId] })
      throw new Error('submission response lost')
    },
  })
  const input = {
    projectId, operationId, sourceResultIds: [sourceResultId, extraResult], kind: 'image', modelConfigId, prompt: 'Add a lamp',
    output: { size: '1024x1024', aspectRatio: '1:1' },
  }
  await assert.rejects(client.startCreation({ ...input, output: { size: '2048x2048', aspectRatio: '1:1' } }),
    { name: 'InputError', key: 'creation.output' })
  await assert.rejects(client.startCreation({ ...input, sourceResultIds: [sourceResultId, extraResult, randomUUID()] }),
    { name: 'InputError', key: 'creation.reference_limit' })
  await assert.rejects(client.startCreation({ ...input, sourceResultIds: [sourceResultId, sourceResultId] }),
    { name: 'InputError', key: 'creation.references' })
  await assert.rejects(client.startCreation({ ...input, sourceResultIds: [sourceResultId, randomUUID()] }),
    { name: 'InputError', key: 'result.candidate_missing' })
  assert.equal(commands.length, 0)
  await assert.rejects(client.startCreation(input), { name: 'UnknownOperationError' })
  const [draft, submit] = commands
  assert.deepEqual(draft.payload.references.map(reference => [reference.order, reference.binding, reference.source.assetId]),
    [[0, 'pinned', assetId], [1, 'pinned', extraAsset]])
  assert.equal(draft.payload.item.position.x, 440)
  assert.equal(submit.payload.adoptionPolicy, 'candidate_only')
  assert.equal(submit.commandId, uuid5(operationId, 'creation.submit'))
  assert.deepEqual(await client.startCreation({ ...input, check: true }), { status: 'accepted', jobId, code: undefined })
  assert.deepEqual(await client.startCreation(input), { status: 'accepted', jobId, code: undefined })
  assert.equal(commands.length, 2)
})

test('another candidate reuses the node and reconciles a lost response without another submit', async () => {
  const [projectId, operationId, jobId, repeatId, specId, itemId, firstId, secondId, firstAsset, secondAsset] =
    Array.from({ length: 10 }, () => randomUUID())
  const commands = []
  const prior = { id: jobId, inputSnapshot: { spec: { id: specId } }, originItemId: itemId, status: 'succeeded' }
  const jobs = [prior]
  const snapshot = {
    jobs,
    assets: [{ id: firstAsset, metadata: { width: 512, height: 512 } }],
    generationSpecs: [{ id: specId, revision: 3, kind: 'image', currentResultId: firstId }],
    canvasItems: [{ id: itemId, revision: 2, binding: { objectRef: { id: specId } } }],
    results: [{ id: firstId, specId, jobId, asset: { assetId: firstAsset, kind: 'image' } }],
  }
  let receipt
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    async fetchImpl(url, request) {
      const path = new URL(url).pathname
      if (path.endsWith('/open')) return Response.json(snapshot)
      if (path.endsWith('/queries')) return Response.json(jobs.at(-1))
      if (request.method === 'DELETE') return Response.json({})
      if (path.endsWith('/receipts/' + uuid5(operationId, 'creation.submit'))) {
        return Response.json(receipt ?? {}, { status: receipt ? 200 : 404 })
      }
      if (request.method === 'GET' && path.endsWith('/' + projectId)) return Response.json(snapshot)
      assert.ok(path.endsWith('/commands'))
      commands.push(JSON.parse(request.body))
      jobs.push({ ...prior, id: repeatId })
      snapshot.results.push({ id: secondId, specId, jobId: repeatId, asset: { assetId: secondAsset, kind: 'image' } })
      receipt = { status: 'accepted', jobIds: [repeatId] }
      throw new Error('submission response lost')
    },
  })
  const input = { projectId, operationId, repeatJobId: jobId }
  assert.deepEqual(await client.startCreation({ ...input, check: true }), { status: 'unknown' })
  await assert.rejects(client.startCreation(input), { name: 'UnknownOperationError' })
  assert.deepEqual(await client.startCreation({ ...input, check: true }), { status: 'accepted', jobId: repeatId, code: undefined })
  assert.deepEqual(await client.startCreation(input), { status: 'accepted', jobId: repeatId, code: undefined })
  const [submit] = commands
  assert.equal(commands.length, 1)
  assert.equal(submit.type, 'generation.submit')
  assert.equal(submit.payload.adoptionPolicy, 'candidate_only')
  assert.equal(submit.payload.specId, specId)
  assert.deepEqual(submit.expectedVersions.map(item => [item.id, item.revision]), [[specId, 3], [itemId, 2]])
  assert.deepEqual(await client.creationStatus(projectId, repeatId), {
    status: 'succeeded',
    results: [
      { resultId: firstId, assetId: firstAsset, kind: 'image', selected: true, details: { width: 512, height: 512 } },
      { resultId: secondId, assetId: secondAsset, kind: 'image', selected: false },
    ],
  })
})
