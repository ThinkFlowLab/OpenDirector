import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { OpenDirectorClient } from '../src/client.js'

function fixture(kind = 'image') {
  const [projectId, modelId, specId, resultId, jobId, assetId, itemId, referenceId] =
    Array.from({ length: 8 }, randomUUID)
  const protocol = kind === 'image' ? 'openai_compatible_images' : 'vllm_omni_tts'
  const parameters = kind === 'image'
    ? { size: '2K', aspectRatio: '3:2', preset: 'product-views', responseFormat: 'url', outputFormat: 'png' }
    : { creationType: 'audio', mode: 'unified', voice: 'character-a', voiceSelection: {
      protocol, modelId: 'fixture', connectionId: 'test', voiceId: 'character-a', name: 'Character',
      source: 'uploaded', hasReferenceAudio: true, refText: 'Original transcript',
    } }
  const reference = { referenceId: randomUUID(), role: 'reference', asset: {
    assetId: referenceId, revision: 2, fingerprint: 'a'.repeat(64), kind,
  }, sourceVersion: { objectType: 'canvas_item', id: randomUUID(), revision: 4 },
  metadata: kind === 'image' ? { width: 512, height: 512 } : { durationSeconds: 2 },
  transmission: 'content' }
  const frozen = {
    spec: { id: specId, projectId, modelConfigId: modelId, kind, prompt: 'Original description',
      promptContent: null, parameters }, model: { modelId: 'fixture', protocol }, references: [reference],
  }
  const snapshot = {
    project: { id: projectId }, assets: [], references: [],
    generationSpecs: [{ id: specId, revision: 9, currentResultId: resultId, parameters: { size: '1024x1024' } }],
    canvasItems: [{ id: itemId, position: { x: 0, y: 0 }, width: 352, parentId: null }],
    jobs: [{ id: jobId, status: 'succeeded', inputSnapshot: frozen }],
    results: [{ id: resultId, jobId, specId, asset: { assetId, kind, revision: 1, fingerprint: 'b'.repeat(64) } }],
  }
  const model = { id: modelId, kind, modelId: 'fixture', protocol,
    inputRules: { allowedKinds: [kind], maxImages: 3, voiceRequired: kind === 'audio',
      imageOutputs: [{ size: '1536x1024', aspectRatio: '3:2' }] } }
  const commands = []
  const calls = []
  const receipts = new Map()
  let loseSubmission = true
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    async fetchImpl(url, request) {
      const path = new URL(url).pathname
      calls.push(path)
      if (path === '/api/model-configs') return Response.json([model])
      if (request.method === 'DELETE') return Response.json({})
      if (path.endsWith('/open') || path.endsWith('/' + projectId)) return Response.json(snapshot)
      if (path.includes('/receipts/')) {
        const value = receipts.get(path.split('/').at(-1))
        return Response.json(value ?? {}, { status: value ? 200 : 404 })
      }
      assert.ok(path.endsWith('/commands'))
      const command = JSON.parse(request.body)
      commands.push(command)
      if (command.type === 'canvas.createGeneration') {
        snapshot.generationSpecs.push(command.payload.spec)
        const receipt = { status: 'applied', changed: [
          { id: command.payload.spec.id, revision: 1 }, { id: command.payload.item.id, revision: 1 },
        ] }
        receipts.set(command.commandId, receipt)
        return Response.json(receipt)
      }
      assert.equal(command.type, 'generation.submit')
      const receipt = { status: 'accepted', jobIds: [randomUUID()] }
      receipts.set(command.commandId, receipt)
      if (loseSubmission) { loseSubmission = false; throw new TypeError('Lost response') }
      return Response.json(receipt)
    },
  })
  return { client, commands, calls, frozen, snapshot, model, reference, projectId, resultId, modelId }
}

test('reuse reads frozen settings, pins ordered assets and changes only an explicit image size', async () => {
  const f = fixture()
  const template = await f.client.creationTemplate(f.projectId, f.resultId)
  assert.equal(template.prompt, f.frozen.spec.prompt)
  assert.equal(template.originalOutput, '2K · 3:2')
  assert.equal(template.references[0].assetId, f.reference.asset.assetId)
  assert.equal(f.calls.some(path => path.endsWith('/open')), false)
  assert.equal(Object.hasOwn(template, 'model'), false)
  const input = { projectId: f.projectId, operationId: randomUUID(), modelConfigId: f.modelId, kind: 'image',
    prompt: 'A new description', reuseResultId: f.resultId, output: null }
  await assert.rejects(f.client.startCreation(input), { name: 'UnknownOperationError' })
  const receipt = await f.client.startCreation({ ...input, check: true })
  assert.equal(receipt.status, 'accepted')
  assert.deepEqual(await f.client.startCreation(input), receipt)
  assert.equal(f.commands.length, 2)
  assert.deepEqual(f.commands[0].payload.spec.parameters, f.frozen.spec.parameters)
  assert.equal(f.commands[0].payload.spec.prompt, input.prompt)
  assert.deepEqual(f.commands[0].payload.references[0].source, f.reference.asset)
  assert.deepEqual(f.commands[0].payload.references[0].sourceVersion, f.reference.sourceVersion)
  assert.equal(f.commands[1].payload.adoptionPolicy, 'candidate_only')
  assert.equal(f.snapshot.generationSpecs[0].currentResultId, f.resultId)
  assert.equal(f.frozen.spec.prompt, 'Original description')
  await f.client.startCreation({ ...input, operationId: randomUUID(), output: f.model.inputRules.imageOutputs[0] })
  assert.deepEqual(f.commands[2].payload.spec.parameters,
    { ...f.frozen.spec.parameters, ...f.model.inputRules.imageOutputs[0] })
  f.frozen.spec.promptContent = [{ type: 'text', text: 'Structured input' }]
  await assert.rejects(f.client.creationTemplate(f.projectId, f.resultId), { key: 'creation.template_complex' })
  await assert.rejects(f.client.startCreation({ ...input, operationId: randomUUID() }), { key: 'creation.template_complex' })
  assert.equal(f.commands.length, 4)
})

test('voiceover reuse keeps the registered voice identity and rejects an implicit voice or model change', async () => {
  const f = fixture('audio')
  const input = { projectId: f.projectId, operationId: randomUUID(), modelConfigId: f.modelId, kind: 'audio',
    prompt: 'Another line to read', reuseResultId: f.resultId, voice: 'character-a' }
  const template = await f.client.creationTemplate(f.projectId, f.resultId)
  assert.equal(template.voice, 'character-a')
  await assert.rejects(f.client.startCreation({ ...input, voice: 'another-voice' }), { key: 'creation.template_unavailable' })
  assert.equal(f.commands.length, 0)
  await assert.rejects(f.client.startCreation(input), { name: 'UnknownOperationError' })
  assert.deepEqual(f.commands[0].payload.spec.parameters, f.frozen.spec.parameters)
  assert.equal(f.commands[0].payload.references[0].source.kind, 'audio')
  f.model.protocol = 'different-protocol'
  await assert.rejects(f.client.creationTemplate(f.projectId, f.resultId), { key: 'creation.template_unavailable' })
  assert.equal(f.commands.length, 2)
})
