import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { OpenDirectorClient } from '../src/client.js'
import { uuid5 } from '../src/operations.js'

function fixture(loss) {
  const projectId = randomUUID(), modelConfigId = randomUUID()
  const snapshot = { project: { id: projectId }, generationSpecs: [], canvasItems: [], jobs: [], results: [], assets: [] }
  const receipts = new Map(), commands = [], reads = []
  let submits = 0
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    async fetchImpl(url, request) {
      const path = new URL(url).pathname
      reads.push(path)
      if (path === '/api/model-configs') return Response.json([{
        id: modelConfigId, kind: 'image', modelId: 'fixture', protocol: 'openai',
        inputRules: { allowedKinds: ['image'], maxImages: 2, imageOutputs: [{ size: '1024x1024', aspectRatio: '1:1' }] },
      }])
      if (path.endsWith('/open') || (request.method === 'GET' && path.endsWith('/' + projectId))) return Response.json(snapshot)
      if (request.method === 'DELETE') return Response.json({})
      if (path.includes('/receipts/')) {
        const receipt = receipts.get(path.split('/').at(-1))
        return Response.json(receipt ?? {}, { status: receipt ? 200 : 404 })
      }
      assert.ok(path.endsWith('/commands'), path)
      const command = JSON.parse(request.body)
      commands.push(command)
      if (command.type === 'canvas.createGeneration') {
        const { spec, item } = command.payload
        snapshot.generationSpecs.push({ ...spec, revision: 1, currentResultId: null })
        snapshot.canvasItems.push({ ...item, revision: 1 })
        const receipt = { status: 'applied', changed: [{ id: spec.id, revision: 1 }, { id: item.id, revision: 1 }] }
        receipts.set(command.commandId, receipt)
        return Response.json(receipt)
      }
      submits++
      if (submits === 2 && loss === 'before') throw new Error('Connection lost before acceptance')
      const spec = snapshot.generationSpecs.find(spec => spec.id === command.payload.specId)
      const id = uuid5(command.commandId, 'job')
      snapshot.jobs.push({ id, revision: 1, status: 'queued', batchId: command.payload.batchId,
        originItemId: command.payload.originItemId, inputSnapshot: { spec: structuredClone(spec) } })
      const receipt = { status: 'accepted', jobIds: [id] }
      receipts.set(command.commandId, receipt)
      if (submits === 2 && loss === 'after') throw new Error('Acceptance reply lost')
      return Response.json(receipt)
    },
  })
  const input = { projectId, operationId: randomUUID(), kind: 'image', modelConfigId, prompt: 'A quiet studio', candidateCount: 3 }
  return { client, input, snapshot, commands, reads }
}

for (const loss of ['before', 'after']) {
  test('a candidate group reconciles a lost ' + loss + '-acceptance reply and explicitly continues original operations', async () => {
    const { client, input, snapshot, commands, reads } = fixture(loss)
    const first = await client.startCreation(input)
    assert.equal(first.status, 'unknown')
    assert.equal(snapshot.jobs.length, loss === 'before' ? 1 : 2)
    const writes = commands.length
    const beforeRead = reads.length
    const checked = await client.startCreation({
      projectId: input.projectId, operationId: input.operationId, candidateCount: 3, check: true,
    })
    assert.equal(checked.status, 'unknown')
    assert.equal(checked.canContinueGroup, true)
    assert.equal(commands.length, writes)
    assert.ok(reads.slice(beforeRead).every(path => path.includes('/receipts/')))
    const complete = await client.startCreation({
      projectId: input.projectId, operationId: input.operationId, candidateCount: 3, continueGroup: true,
    })
    assert.equal(complete.status, 'accepted')
    assert.equal(complete.groupComplete, true)
    assert.equal(complete.acceptedCount, 3)
    assert.equal(new Set(snapshot.jobs.map(job => job.id)).size, 3)
    assert.equal(snapshot.canvasItems.length, 1)
    assert.equal(snapshot.generationSpecs.length, 1)
    assert.equal(snapshot.generationSpecs[0].currentResultId, null)
    const submits = commands.filter(command => command.type === 'generation.submit')
    assert.equal(new Set(submits.map(command => command.commandId)).size, 3)
    for (const command of submits) {
      assert.equal(command.payload.batchId, input.operationId)
      assert.equal(command.payload.adoptionPolicy, 'candidate_only')
      assert.equal(command.payload.expectedSpecRevision, 1)
    }
    const beforeReplay = commands.length
    const replay = await client.startCreation(input)
    assert.equal(replay.acceptedCount, 3)
    assert.equal(commands.length, beforeReplay)
    // Progress comes from current saved jobs; a failed member does not conceal successful siblings.
    snapshot.jobs.forEach((job, index) => {
      job.status = index === 1 ? 'failed' : 'succeeded'
      job.errorDetails = index === 1 ? { category: 'quota' } : undefined
      if (job.status === 'succeeded') snapshot.results.push({
        id: randomUUID(), jobId: job.id, specId: snapshot.generationSpecs[0].id,
        asset: { assetId: randomUUID(), kind: 'image' },
      })
    })
    const status = await client.creationGroupStatus(input.projectId, input.operationId)
    assert.equal(status.completedCount, 2)
    assert.equal(status.failedCount, 1)
    assert.equal(status.totalCount, 3)
    assert.equal(status.jobs[1].category, 'quota')
    assert.equal(status.results.length, 2)
    assert.equal(status.results.every(result => !result.selected), true)
    assert.equal(commands.length, beforeReplay)
  })
}

test('candidate groups bound task count and stop when the source settings change before continuation', async () => {
  const { client, input, snapshot, commands } = fixture('before')
  for (const candidateCount of [0, 5, 2.5, '3']) {
    await assert.rejects(client.startCreation({ ...input, candidateCount }), { key: 'creation.candidate_count' })
  }
  assert.equal(commands.length, 0)
  await client.startCreation(input)
  snapshot.generationSpecs[0].revision++
  snapshot.generationSpecs[0].prompt = 'Changed in the canvas'
  const reply = await client.startCreation({
    projectId: input.projectId, operationId: input.operationId, candidateCount: 3, continueGroup: true,
  })
  assert.equal(reply.status, 'rejected')
  assert.equal(reply.code, 'revision_conflict')
  assert.equal(snapshot.jobs.length, 1)
})
