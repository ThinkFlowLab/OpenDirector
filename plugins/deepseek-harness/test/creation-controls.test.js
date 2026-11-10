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

test('direct video uses published durations and pins the exact source for each mode', async () => {
  const [projectId, modelConfigId, imageId, videoId, imageAssetId, videoAssetId] =
    Array.from({ length: 6 }, () => randomUUID())
  const commands = []
  const snapshot = {
    generationSpecs: [], canvasItems: [],
    results: [
      { id: imageId, asset: { assetId: imageAssetId, kind: 'image', revision: 1, fingerprint: 'a'.repeat(64) } },
      { id: videoId, asset: { assetId: videoAssetId, kind: 'video', revision: 1, fingerprint: 'b'.repeat(64) } },
    ],
  }
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    async fetchImpl(url, request) {
      const path = new URL(url).pathname
      if (path === '/api/model-configs') return Response.json([{
        id: modelConfigId, kind: 'video',
        inputRules: { allowedKinds: ['image', 'video'], maxImages: 1, videoModes: ['first_frame', 'continuation'],
          videoCapabilities: {
            defaultDuration: 5, defaultResolution: '768P',
            outputs: [{ resolution: '480P', durations: [5, 6] }, { resolution: '768P', durations: [5, 7] }],
          } },
      }])
      if (path.endsWith('/open')) return Response.json(snapshot)
      if (request.method === 'DELETE') return Response.json({})
      assert.ok(path.endsWith('/commands'))
      const command = JSON.parse(request.body)
      commands.push(command)
      if (command.type === 'generation.submit') return Response.json({ status: 'accepted', jobIds: [randomUUID()] })
      const { spec, item } = command.payload
      return Response.json({ status: 'applied', changed: [{ id: spec.id, revision: 1 }, { id: item.id, revision: 1 }] })
    },
  })
  const first = { projectId, operationId: randomUUID(), kind: 'video', modelConfigId, prompt: 'Pan left',
    sourceResultId: imageId, videoMode: 'first_frame', durationSeconds: 7 }
  await assert.rejects(client.startCreation({ ...first, videoMode: 'reference' }), { key: 'creation.video_mode' })
  await assert.rejects(client.startCreation({ ...first, durationSeconds: 6 }), { key: 'creation.video_duration' })
  await assert.rejects(client.startCreation({ ...first, sourceResultId: videoId }), { key: 'creation.video_source' })
  assert.equal(commands.length, 0)
  await client.startCreation(first)
  await client.startCreation({
    ...first, operationId: randomUUID(), sourceResultId: videoId, videoMode: 'continuation', durationSeconds: 6,
  })
  assert.deepEqual(commands.filter(command => command.type === 'canvas.createGeneration').map(({ payload }) => [
    payload.spec.parameters, payload.references.map(({ source, binding, role }) => [source.assetId, binding, role]),
  ]), [
    [{ videoMode: 'first_frame', resolution: '768P', durationSeconds: 7 }, [[imageAssetId, 'pinned', 'first_frame']]],
    [{ videoMode: 'continuation', resolution: 'auto', durationSeconds: 6 }, [[videoAssetId, 'pinned', 'continuation']]],
  ])
  assert.deepEqual(commands.filter(command => command.type === 'generation.submit').map(({ payload }) => payload.adoptionPolicy),
    ['candidate_only', 'candidate_only'])
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

test('only a confirmed failed job can start a linked retry on the same node', async () => {
  const [projectId, specId, itemId, jobId, uncertainId, reviewId, nextId] = Array.from({ length: 7 }, randomUUID)
  const quota = {
    id: jobId, inputSnapshot: { spec: { id: specId } }, originItemId: itemId, status: 'failed',
    errorDetails: { category: 'quota' }, recovery: 'retry',
  }
  const jobs = [
    quota,
    { ...quota, id: uncertainId, errorDetails: { category: 'submission_unknown' } },
    { ...quota, id: reviewId, recovery: 'review' },
  ]
  const snapshot = {
    jobs,
    generationSpecs: [{ id: specId, revision: 3, kind: 'image' }],
    canvasItems: [{ id: itemId, revision: 2, binding: { objectRef: { id: specId } } }],
  }
  const commands = []
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    async fetchImpl(url, request) {
      const path = new URL(url).pathname
      if (path.endsWith('/queries')) {
        return Response.json(jobs.find(job => job.id === JSON.parse(request.body).objectId))
      }
      if (path.endsWith('/open')) return Response.json(snapshot)
      if (request.method === 'DELETE') return Response.json({})
      if (path.includes('/receipts/')) return Response.json({}, { status: 404 })
      assert.ok(path.endsWith('/commands'))
      commands.push(JSON.parse(request.body))
      return Response.json({ status: 'accepted', jobIds: [nextId] })
    },
  })
  assert.deepEqual(await client.creationStatus(projectId, jobId), { status: 'failed', category: 'quota', canRetry: true })
  assert.deepEqual(await client.creationStatus(projectId, uncertainId), { status: 'failed', category: 'submission_unknown' })
  assert.deepEqual(await client.creationStatus(projectId, reviewId), { status: 'failed', category: 'quota' })
  const repeat = repeatJobId => client.startCreation({ projectId, operationId: randomUUID(), repeatJobId })
  await assert.rejects(repeat(uncertainId), { name: 'InputError', key: 'creation.repeat_unavailable' })
  await assert.rejects(repeat(reviewId), { name: 'InputError', key: 'creation.repeat_unavailable' })
  assert.equal(commands.length, 0)
  assert.equal((await repeat(jobId)).jobId, nextId)
  const [command] = commands
  assert.equal(commands.length, 1)
  assert.equal(command.type, 'generation.submit')
  assert.equal(command.payload.specId, specId)
  assert.equal(command.payload.originItemId, itemId)
  assert.equal(command.payload.previousJobId, jobId)
  assert.equal(command.payload.adoptionPolicy, 'candidate_only')
})

test('known rejections keep a newly created project and any saved draft identifiable', async () => {
  const [projectId, modelConfigId, operationId] = Array.from({ length: 3 }, () => randomUUID())
  let busy = true
  const commands = []
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    async fetchImpl(url, request) {
      const path = new URL(url).pathname
      if (path === '/api/model-configs') return Response.json([{ id: modelConfigId, kind: 'image', protocol: 'openai' }])
      if (path.endsWith('/open')) return busy
        ? Response.json({ code: 'storage_busy' }, { status: 409 })
        : Response.json({ generationSpecs: [], canvasItems: [], results: [] })
      if (request.method === 'DELETE') return Response.json({})
      assert.ok(path.endsWith('/commands'))
      const command = JSON.parse(request.body)
      commands.push(command.type)
      if (command.type === 'project.create') return Response.json({ status: 'applied' })
      if (command.type === 'canvas.createGeneration') return Response.json({
        status: 'applied', changed: [command.payload.spec.id, command.payload.item.id].map(id => ({ id, revision: 1 })),
      })
      return Response.json({ code: 'revision_conflict' }, { status: 409 })
    },
  })
  const input = { projectId, modelConfigId, operationId, kind: 'image', prompt: 'Studio' }
  assert.deepEqual(await client.startCreation({ ...input, projectName: 'Studio' }), {
    status: 'rejected', code: 'storage_busy', projectCreated: true,
  })
  busy = false
  assert.deepEqual(await client.startCreation({ ...input, operationId: randomUUID() }), {
    status: 'rejected', code: 'revision_conflict', draftSaved: true,
  })
  assert.deepEqual(commands, ['project.create', 'canvas.createGeneration', 'generation.submit'])
})
