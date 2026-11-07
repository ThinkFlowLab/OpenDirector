import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCreateGeneration,
  buildJobCancelCommand,
  buildProjectCreateCommand,
  buildResultSelectCommand,
  buildSubmitCommand,
  uuid5,
} from '../src/operations.js'
import { InputError } from '../src/errors.js'

const projectId = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'
const modelConfigId = '33333333-3333-4333-8333-333333333333'
const specId = '44444444-4444-4444-8444-444444444444'
const itemId = '55555555-5555-4555-8555-555555555555'
const resultId = '66666666-6666-4666-8666-666666666666'
const jobId = '77777777-7777-4777-8777-777777777777'

const generation = {
  projectId,
  operationId,
  kind: 'video',
  modelConfigId,
  prompt: 'A slow pan across a lake',
  parameters: { durationSeconds: 5, videoMode: 'first_frame' },
  position: { x: 10, y: 20 },
  references: [
    { binding: 'follow_current', role: 'first_frame', sourceItemId: itemId },
    {
      binding: 'pinned',
      role: 'reference',
      source: {
        assetId: itemId,
        revision: 2,
        fingerprint: `sha256:${'a'.repeat(64)}`,
        kind: 'image',
      },
    },
  ],
}

test('uuid5 is stable for an operation and suffix', () => {
  const first = uuid5(operationId, 'spec')
  const second = uuid5(operationId, 'spec')
  assert.equal(first, second)
  assert.notEqual(first, uuid5(operationId, 'item'))
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('create-generation replay is byte-identical for the same operation', () => {
  const first = buildCreateGeneration(generation)
  const second = buildCreateGeneration(generation)
  assert.deepEqual(first, second)
  assert.equal(first.command.commandId, operationId)
  assert.equal(first.command.payload.spec.id, uuid5(operationId, 'spec'))
  assert.equal(first.command.payload.item.id, uuid5(operationId, 'item'))
  assert.equal(first.command.payload.references[0].id, uuid5(operationId, 'reference-0'))
  assert.equal(first.command.payload.references[1].id, uuid5(operationId, 'reference-1'))
  assert.equal(first.command.payload.references[0].source.id, itemId)
  assert.equal(first.command.payload.references[1].source.assetId, itemId)
  const different = buildCreateGeneration({
    ...generation,
    operationId: '88888888-8888-4888-8888-888888888888',
  })
  assert.notEqual(different.specId, first.specId)
  assert.notEqual(different.itemId, first.itemId)
})

test('project create uses explicit project and command IDs without opening a session', () => {
  const command = buildProjectCreateCommand({ name: 'Storyboard', projectId, operationId })
  assert.deepEqual(command, {
    commandId: operationId,
    projectId,
    type: 'project.create',
    payload: { name: 'Storyboard' },
    expectedVersions: [],
  })
})

test('submit is candidate-only and includes only supplied expected versions', () => {
  const command = buildSubmitCommand({
    projectId,
    operationId,
    specId,
    expectedSpecRevision: 4,
    originItemId: itemId,
    expectedItemRevision: 7,
  })
  assert.equal(command.type, 'generation.submit')
  assert.equal(command.payload.adoptionPolicy, 'candidate_only')
  assert.equal(command.payload.showAdditionalResult, false)
  assert.deepEqual(command.expectedVersions, [
    { objectType: 'generation_spec', id: specId, revision: 4 },
    { objectType: 'canvas_item', id: itemId, revision: 7 },
  ])
  const withoutOrigin = buildSubmitCommand({
    projectId,
    operationId,
    specId,
    expectedSpecRevision: 4,
  })
  assert.deepEqual(withoutOrigin.expectedVersions, [
    { objectType: 'generation_spec', id: specId, revision: 4 },
  ])
  assert.throws(
    () => buildSubmitCommand({
      projectId,
      operationId,
      specId,
      expectedSpecRevision: 4,
      originItemId: itemId,
    }),
    (error) => error instanceof InputError && error.key === 'input.pair',
  )
})

test('result adoption carries the expected spec revision only', () => {
  const command = buildResultSelectCommand({
    projectId,
    operationId,
    specId,
    resultId,
    expectedSpecRevision: 5,
  })
  assert.deepEqual(command.payload, { specId, resultId })
  assert.deepEqual(command.expectedVersions, [
    { objectType: 'generation_spec', id: specId, revision: 5 },
  ])
})

test('cancel is explicit and deterministic for the same operation', () => {
  const command = buildJobCancelCommand({ projectId, operationId, jobId, expectedJobRevision: 2 })
  assert.equal(command.type, 'job.cancel')
  assert.deepEqual(command.expectedVersions, [{ objectType: 'job', id: jobId, revision: 2 }])
  assert.deepEqual(command, buildJobCancelCommand({ projectId, operationId, jobId, expectedJobRevision: 2 }))
  assert.throws(
    () => buildJobCancelCommand({
      projectId: 'not-a-uuid',
      operationId,
      jobId,
    }),
    (error) => error instanceof InputError && error.key === 'input.uuid',
  )
})
