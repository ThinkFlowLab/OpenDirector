import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { actionPackRequest, actionPackArchive, packState } from '../src/action-packs.js'
import { UnknownOperationError } from '../src/errors.js'
import { uuid5 } from '../src/operations.js'

function fixture() {
  const projectId = randomUUID(), sourceId = randomUUID(), modelId = randomUUID()
  const asset = { assetId: randomUUID(), revision: 1, fingerprint: 'a'.repeat(64), kind: 'image' }
  const snapshot = { project: { id: projectId, name: '角色' }, canvasItems: [], generationSpecs: [],
    references: [], jobs: [], results: [{ id: sourceId, asset }], assets: [] }
  const commands = [], receipts = new Map()
  let loseNext = false, catalogs = 0
  const io = {
    async read() { return structuredClone(snapshot) },
    async models() { catalogs++; return [{ id: modelId, modelId: 'test', kind: 'image', maxImages: 1,
      imageOutputs: [{ size: '1024x1024', aspectRatio: '1:1' }] }] },
    async receipt(id) { return receipts.get(id) },
    canRetry: job => job.status === 'failed' && job.errorDetails?.category === 'quota',
    async media(id) { return { body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(id)); controller.close()
    } }) } },
    async edit(fn) { return fn(structuredClone(snapshot), async command => {
      commands.push(command)
      let receipt
      if (command.type === 'creation.batch') {
        for (const { type, payload } of command.payload.operations) {
          if (type === 'canvas.show') snapshot.canvasItems.push({ revision: 1, ...payload.item })
          if (type === 'generationSpec.create') snapshot.generationSpecs.push({ revision: 1, ...payload.spec })
          if (type === 'reference.add') snapshot.references.push(payload.reference)
        }
        receipt = { status: 'applied' }
      } else if (command.type === 'generationSpec.update') {
        const index = snapshot.generationSpecs.findIndex(spec => spec.id === command.payload.spec.id)
        snapshot.generationSpecs[index] = { ...command.payload.spec, revision: command.payload.spec.revision + 1 }
        receipt = { status: 'applied' }
      } else {
        const spec = snapshot.generationSpecs.find(spec => spec.id === command.payload.specId)
        const job = { id: randomUUID(), status: 'succeeded', inputSnapshot: {
          spec: structuredClone(spec), model: { modelId: 'frozen-model', apiKey: 'PRIVATE' },
        } }
        snapshot.jobs.push(job)
        receipt = { status: 'accepted', jobIds: [job.id] }
      }
      receipts.set(command.commandId, receipt)
      if (loseNext) { loseNext = false; throw new UnknownOperationError({ projectId, operationId: command.commandId }) }
      return receipt
    }) },
  }
  const input = { action: 'prepare', projectId, operationId: randomUUID(), modelConfigId: modelId,
    sourceResultId: sourceId, title: '角色动作', sharedPrompt: 'same character',
    actions: [{ name: '待机', prompt: 'standing' }, { name: '挥手', prompt: 'waving' }] }
  return { io, input, snapshot, commands, receipts, lose: () => { loseNext = true }, catalogs: () => catalogs }
}

test('action plan is one atomic project batch with separate specs and one pinned reference per action', async () => {
  const f = fixture()
  const result = await actionPackRequest(f.input, f.io)
  assert.equal(result.status, 'applied')
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0].type, 'creation.batch')
  const { group, children } = { group: f.snapshot.canvasItems[0], children: f.snapshot.canvasItems.slice(1) }
  assert.deepEqual(group.tags, ['dsh-action-pack'])
  assert.deepEqual(children.map(item => item.title), ['待机', '挥手'])
  assert.ok(children.every(item => item.parentId === group.id))
  assert.notEqual(children[0].binding.objectRef.id, children[1].binding.objectRef.id)
  assert.deepEqual(f.snapshot.generationSpecs.map(spec => spec.prompt), ['same character\n\nstanding', 'same character\n\nwaving'])
  assert.ok(f.snapshot.references.every(ref => ref.binding === 'pinned' && ref.role === 'reference'
    && ref.source.assetId === f.snapshot.results[0].asset.assetId))
  assert.equal(packState(f.snapshot, group.id, f.io.canRetry).actions[0].reference.assetId, f.snapshot.results[0].asset.assetId)
  const before = f.catalogs()
  await actionPackRequest(f.input, f.io)
  assert.equal(f.catalogs(), before)
  assert.equal(f.commands.length, 1)
  const query = await actionPackRequest({ action: 'check', projectId: f.input.projectId, operationId: f.input.operationId }, f.io)
  assert.equal(query.status, 'applied')
  assert.equal(query.actions.length, 2)
  assert.equal(f.commands.length, 1)
  f.snapshot.canvasItems[1].visible = false
  assert.equal(packState(f.snapshot, group.id, f.io.canRetry).actions.length, 2)
})

test('an action pack keeps the chosen image size and only uses automatic sizing when none was requested', async () => {
  const f = fixture()
  const output = { size: '2048x2048', aspectRatio: '1:1' }
  const model = (await f.io.models())[0]
  f.io.models = async () => [model]
  model.imageOutputs = []
  await assert.rejects(actionPackRequest({ ...f.input, output }, f.io), { key: 'creation.output' })
  assert.equal(f.commands.length, 0)
  await actionPackRequest(f.input, f.io)
  assert.deepEqual(f.snapshot.generationSpecs[0].parameters, { size: 'auto' })
  model.imageOutputs = [{ size: '1024x1024', aspectRatio: '1:1' }, output]
  await actionPackRequest({ ...f.input, operationId: randomUUID(), output }, f.io)
  assert.deepEqual(f.snapshot.generationSpecs.at(-1).parameters, output)
})

test('invalid plans and unsupported references never write; video actions pin the first frame', async () => {
  const f = fixture()
  for (const actions of [[], Array(7).fill({ name: 'x', prompt: 'p' }),
    [{ name: 'Idle', prompt: 'x' }, { name: 'ＩＤＬＥ', prompt: 'y' }]]) {
    await assert.rejects(actionPackRequest({ ...f.input, actions }, f.io), { key: 'pack.plan' })
  }
  await assert.rejects(actionPackRequest({ ...f.input, sourceResultId: randomUUID() }, f.io),
    { key: 'result.candidate_missing' })
  assert.equal(f.commands.length, 0)
  f.io.models = async () => [{ id: f.input.modelConfigId, kind: 'video', videoChoices: {
    first_frame: { resolution: '480P', durations: [5], defaultDuration: 5 },
  } }]
  await actionPackRequest(f.input, f.io)
  assert.ok(f.snapshot.references.every(ref => ref.role === 'first_frame'))
  assert.ok(f.snapshot.generationSpecs.every(spec => spec.parameters.videoMode === 'first_frame'
    && spec.parameters.durationSeconds === 5))
})

test('lost generation response resumes exact child operations without duplicate jobs or automatic adoption', async () => {
  const f = fixture()
  const { packId } = await actionPackRequest(f.input, f.io)
  const plan = packState(f.snapshot, packId, f.io.canRetry)
  const input = { action: 'generate', projectId: f.input.projectId, packId, operationId: randomUUID(),
    itemIds: plan.actions.map(action => action.itemId) }
  f.lose()
  assert.equal((await actionPackRequest(input, f.io)).status, 'unknown')
  assert.equal(f.snapshot.jobs.length, 1)
  const check = await actionPackRequest({ ...input, action: 'check', packAction: 'generate' }, f.io)
  assert.equal(check.status, 'unknown')
  assert.equal(f.snapshot.jobs.length, 1)
  await actionPackRequest(input, f.io)
  assert.equal(f.snapshot.jobs.length, 2)
  await actionPackRequest(input, f.io)
  assert.equal(f.snapshot.jobs.length, 2)
  assert.equal((await actionPackRequest({ ...input, action: 'check', packAction: 'generate' }, f.io)).status, 'applied')
  const submits = f.commands.filter(command => command.type === 'generation.submit')
  assert.deepEqual(submits.map(command => command.commandId), input.itemIds.map(id => uuid5(input.operationId, 'action:' + id)))
  assert.ok(submits.every(command => command.payload.adoptionPolicy === 'candidate_only' && !command.payload.batchId))
  assert.ok(f.snapshot.generationSpecs.every(spec => !spec.currentResultId))
  await actionPackRequest({ ...input, operationId: randomUUID() }, f.io)
  assert.equal(f.snapshot.jobs.length, 2)
  const retry = { ...input, itemIds: [input.itemIds[0]], operationId: randomUUID(), redo: true }
  f.snapshot.jobs[0].status = 'running'
  await actionPackRequest(retry, f.io)
  assert.equal(f.snapshot.jobs.length, 2)
  f.snapshot.jobs[0].status = 'failed'; f.snapshot.jobs[0].errorDetails = { category: 'submission_unknown' }
  await actionPackRequest(retry, f.io)
  assert.equal(f.snapshot.jobs.length, 2)
  f.snapshot.jobs[0].errorDetails = { category: 'quota' }
  await actionPackRequest(retry, f.io)
  assert.equal(f.snapshot.jobs.length, 3)
  assert.equal(f.commands.at(-1).payload.previousJobId, f.snapshot.jobs[0].id)
})

test('pack export captures each action’s selected version and actual generation settings', async () => {
  const f = fixture()
  const { packId } = await actionPackRequest(f.input, f.io)
  await assert.rejects(actionPackArchive({ packId }, f.io), { key: 'pack.incomplete' })
  const plan = packState(f.snapshot, packId, f.io.canRetry)
  await actionPackRequest({ action: 'generate', projectId: f.input.projectId, packId,
    operationId: randomUUID(), itemIds: plan.actions.map(action => action.itemId) }, f.io)
  for (const [i, spec] of f.snapshot.generationSpecs.entries()) {
    const asset = { id: randomUUID(), kind: 'image', fingerprint: String(i).repeat(64),
      metadata: { mimeType: 'image/png', size: 36 } }
    const result = { id: randomUUID(), specId: spec.id, jobId: f.snapshot.jobs[i].id,
      asset: { assetId: asset.id, kind: 'image' } }
    f.snapshot.assets.push(asset); f.snapshot.results.push(result)
    spec.currentResultId = result.id; spec.prompt = 'edited later'
  }
  f.snapshot.canvasItems[1].title = '../待机'
  const archive = await actionPackArchive({ packId }, f.io)
  // Changing selection after starting an export does not mix versions into its manifest.
  f.snapshot.generationSpecs[0].currentResultId = 'different'
  const files = []
  for await (const entry of archive.entries) files.push({ name: entry.name,
    body: await new Response(entry.data).text() })
  const manifest = JSON.parse(files[0].body)
  assert.deepEqual(files.map(file => file.name), ['manifest.json', '01-..-待机.png', '02-挥手.png'])
  assert.equal(manifest.actions[0].description, 'same character\n\nstanding')
  assert.equal(manifest.actions[1].model, 'frozen-model')
  assert.equal(files[1].body, f.snapshot.assets[0].id)
  assert.doesNotMatch(files[0].body, /PRIVATE|apiKey|edited later/)
})

test('action-pack HTTP route keeps reads lease-free, guards writes and streams selected original assets', async t => {
  const { apply } = await import('../index.js')
  const { createServer } = await import('node:http')
  const f = fixture()
  const { packId } = await actionPackRequest(f.input, f.io)
  const actions = packState(f.snapshot, packId, f.io.canRetry).actions
  for (const action of actions) {
    const assetId = randomUUID(), resultId = randomUUID()
    f.snapshot.assets.push({ id: assetId, kind: 'image', fingerprint: 'b'.repeat(64), metadata: { mimeType: 'image/png', size: 3 } })
    f.snapshot.results.push({ id: resultId, specId: action.specId, asset: { assetId, kind: 'image' } })
    f.snapshot.generationSpecs.find(spec => spec.id === action.specId).currentResultId = resultId
  }
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.method + ' ' + request.url)
    assert.equal(request.headers['x-opendirector-request'], '1')
    if (request.url === '/api/creation/projects/' + f.input.projectId) {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(f.snapshot)); return
    }
    if (request.url.endsWith('/content')) {
      response.setHeader('Content-Type', 'image/png'); response.end(Buffer.from([1, 2, 3])); return
    }
    response.statusCode = 404; response.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const routes = new Map()
  apply({ tools: { register() {} }, get() {}, inject(_services, callback) {
    callback({ effect(fn) { fn() }, connection: { fetch: { register(route) { routes.set(route.path, route.fetch) } } } })
  } }, { baseUrl: 'http://127.0.0.1:' + server.address().port })
  const route = routes.get('/api/opendirector/action-packs')
  const base = 'http://localhost/api/opendirector/action-packs'
  assert.equal((await route(new Request(base, { method: 'POST', body: '{}' }))).status, 403)
  assert.equal((await route(new Request(base, { method: 'POST', headers: {
    'X-OpenDirector-Action': '1', 'Sec-Fetch-Site': 'cross-site',
  }, body: '{}' }))).status, 403)
  assert.equal(requests.length, 0)
  const view = await route(new Request(base + '?project=' + f.input.projectId + '&pack=' + packId))
  assert.equal((await view.json()).selectedCount, 2)
  assert.ok(requests.every(request => request.startsWith('GET ')))
  const archive = await route(new Request(base + '?project=' + f.input.projectId + '&pack=' + packId + '&download=1'))
  assert.equal(archive.headers.get('Content-Type'), 'application/zip')
  assert.match(archive.headers.get('Content-Disposition'), /attachment; filename="action-pack-/)
  assert.equal(archive.headers.get('Cache-Control'), 'private, no-store')
  const body = Buffer.from(await archive.arrayBuffer())
  assert.equal(body.readUInt32LE(0), 0x04034b50)
  assert.ok(requests.some(request => request.endsWith('/content')))
  assert.ok(!requests.some(request => request.includes('/thumbnail') || request.includes('/open')))
})

test('a receipt read outage after a partial group keeps the original operation recoverable', async () => {
  const f = fixture()
  const { packId } = await actionPackRequest(f.input, f.io)
  const plan = packState(f.snapshot, packId, f.io.canRetry)
  const input = { action: 'generate', projectId: f.input.projectId, packId,
    operationId: randomUUID(), itemIds: plan.actions.map(action => action.itemId) }
  const read = f.io.receipt
  f.io.receipt = async id => {
    if (f.snapshot.jobs.length === 1) throw new Error('offline')
    return read(id)
  }
  assert.equal((await actionPackRequest(input, f.io)).status, 'unknown')
  assert.equal(f.snapshot.jobs.length, 1)
  f.io.receipt = read
  await actionPackRequest(input, f.io)
  assert.equal(f.snapshot.jobs.length, 2)
  assert.equal(f.commands.filter(command => command.type === 'generation.submit').length, 2)
})

test('revising one action preserves pinned references, sibling prompts, selected results and frozen jobs', async () => {
  const f = fixture()
  const { packId } = await actionPackRequest(f.input, f.io)
  const plan = packState(f.snapshot, packId, f.io.canRetry)
  await actionPackRequest({ action: 'generate', projectId: f.input.projectId, packId,
    operationId: randomUUID(), itemIds: plan.actions.map(action => action.itemId) }, f.io)
  const first = f.snapshot.generationSpecs[0]
  const selected = first.currentResultId = randomUUID()
  const oldInputs = structuredClone(f.snapshot.jobs.map(job => job.inputSnapshot))
  const oldRefs = structuredClone(f.snapshot.references)
  const input = { action: 'revise', projectId: f.input.projectId, packId, operationId: randomUUID(),
    itemId: plan.actions[0].itemId, expectedSpecRevision: first.revision, prompt: 'A slower wave' }
  const result = await actionPackRequest(input, f.io)
  assert.equal(result.status, 'applied')
  assert.equal(f.snapshot.generationSpecs[0].prompt, input.prompt)
  assert.equal(f.snapshot.generationSpecs[0].revision, 2)
  assert.equal(f.snapshot.generationSpecs[0].currentResultId, selected)
  assert.equal(f.snapshot.generationSpecs[1].prompt, 'same character\n\nwaving')
  assert.deepEqual(f.snapshot.references, oldRefs)
  assert.deepEqual(f.snapshot.jobs.map(job => job.inputSnapshot), oldInputs)
  assert.equal(f.snapshot.jobs.length, 2)
  const writes = f.commands.length
  await actionPackRequest(input, f.io)
  assert.equal(f.commands.length, writes)
  const checked = await actionPackRequest({ action: 'check', projectId: f.input.projectId, packId,
    operationId: input.operationId, packAction: 'revise', itemIds: [input.itemId] }, f.io)
  assert.equal(checked.status, 'applied')
  await assert.rejects(actionPackRequest({ ...input, operationId: randomUUID() }, f.io), { key: 'revision_conflict' })
  assert.equal(f.commands.length, writes)
  f.snapshot.jobs[0].status = 'running'
  await assert.rejects(actionPackRequest({ ...input, operationId: randomUUID(), expectedSpecRevision: 2 }, f.io), { key: 'pack.active' })
  assert.equal(f.commands.length, writes)
})

test('lost action-edit response can be confirmed without generating or rewriting the revision', async () => {
  const f = fixture()
  const { packId } = await actionPackRequest(f.input, f.io)
  const action = packState(f.snapshot, packId, f.io.canRetry).actions[0]
  const input = { action: 'revise', projectId: f.input.projectId, packId, operationId: randomUUID(),
    itemId: action.itemId, expectedSpecRevision: 1, prompt: 'Wave with the other hand' }
  f.lose()
  await assert.rejects(actionPackRequest(input, f.io), { name: 'UnknownOperationError' })
  const recovered = await actionPackRequest({ action: 'check', projectId: f.input.projectId, packId,
    operationId: input.operationId, packAction: 'revise', itemIds: [input.itemId] }, f.io)
  assert.equal(recovered.status, 'applied')
  assert.equal(recovered.actions[0].prompt, input.prompt)
  assert.equal(recovered.actions[0].revision, 2)
  assert.equal(f.snapshot.jobs.length, 0)
  await actionPackRequest(input, f.io)
  assert.equal(f.snapshot.generationSpecs[0].revision, 2)
})
