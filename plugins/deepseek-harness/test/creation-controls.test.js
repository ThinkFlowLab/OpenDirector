import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { OpenDirectorClient } from '../src/client.js'
import { uuid5 } from '../src/operations.js'

test('a direct edit pins the saved asset and recovers the original submission', async () => {
  const [projectId, operationId, sourceResultId, assetId, modelConfigId, jobId, priorItemId] =
    Array.from({ length: 7 }, () => randomUUID())
  const commands = []
  const receipts = new Map()
  const snapshot = {
    project: { id: projectId },
    generationSpecs: [],
    canvasItems: [{ id: priorItemId, parentId: null, position: { x: 40, y: 0 }, width: 352 }],
    results: [{ id: sourceResultId, asset: { assetId, kind: 'image', revision: 1, fingerprint: 'a'.repeat(64) } }],
  }
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    async fetchImpl(url, request) {
      const path = new URL(url).pathname
      if (path === '/api/model-configs') {
        return Response.json([{
          id: modelConfigId, kind: 'image', protocol: 'openai', modelId: 'fixture',
          inputRules: { allowedKinds: ['image'], maxImages: 1, imageOutputs: [{ size: '1024x1024', aspectRatio: '1:1' }] },
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
    projectId, operationId, sourceResultId, kind: 'image', modelConfigId, prompt: 'Add a lamp',
    output: { size: '1024x1024', aspectRatio: '1:1' },
  }
  await assert.rejects(client.startCreation({ ...input, output: { size: '2048x2048', aspectRatio: '1:1' } }),
    { name: 'InputError', key: 'creation.output' })
  assert.equal(commands.length, 0)
  await assert.rejects(client.startCreation(input), { name: 'UnknownOperationError' })
  const [draft, submit] = commands
  assert.equal(draft.payload.references[0].source.assetId, assetId)
  assert.equal(draft.payload.item.position.x, 440)
  assert.equal(submit.payload.adoptionPolicy, 'candidate_only')
  assert.equal(submit.commandId, uuid5(operationId, 'creation.submit'))
  assert.deepEqual(await client.startCreation({ ...input, check: true }), { status: 'accepted', jobId, code: undefined })
  assert.deepEqual(await client.startCreation(input), { status: 'accepted', jobId, code: undefined })
  assert.equal(commands.length, 2)
})
