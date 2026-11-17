import { createHash } from 'node:crypto'
import { InputError } from './errors.js'

export const GENERATION_KINDS = ['text', 'image', 'video', 'audio']
export const REFERENCE_ROLES = ['reference', 'first_frame', 'last_frame', 'continuation']
export const MEDIA_KINDS = ['text', 'image', 'video', 'audio', 'file']
export const SUBJECT_ROLES = ['main', 'auxiliary', 'voice']
export const REFERENCE_BINDINGS = ['follow_current', 'pinned']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(key, params) {
  throw new InputError(key, params)
}

export function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('input.uuid', { field })
  return value
}

export function requireRevision(value, field) {
  if (!Number.isInteger(value) || value < 1) fail('input.positiveInteger', { field })
  return value
}

export function requireString(value, field, { allowEmpty = false } = {}) {
  if (value == null) fail('input.required', { field })
  if (typeof value !== 'string') fail('input.string', { field })
  if (!allowEmpty && value.trim() === '') fail('input.required', { field })
  return value
}

export function requireObject(value, field) {
  if (value == null) fail('input.required', { field })
  if (typeof value !== 'object' || Array.isArray(value)) fail('input.object', { field })
  return value
}

function requireArray(value, field) {
  if (value == null) return []
  if (!Array.isArray(value)) fail('input.array', { field })
  return value
}

function requireEnum(value, field, values) {
  if (value == null) fail('input.required', { field })
  if (!values.includes(value)) fail('input.enum', { field, values: values.join('|') })
  return value
}

function requireNumber(value, field) {
  if (value == null) fail('input.required', { field })
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('input.number', { field })
  return value
}

function requireAssetRef(value, field) {
  const source = requireObject(value, field)
  requireUuid(source.assetId, `${field}.assetId`)
  requireRevision(source.revision, `${field}.revision`)
  requireString(source.fingerprint, `${field}.fingerprint`)
  requireEnum(source.kind, `${field}.kind`, MEDIA_KINDS)
  return {
    assetId: source.assetId,
    revision: source.revision,
    fingerprint: source.fingerprint,
    kind: source.kind,
  }
}

function requireSourceVersion(value, field) {
  const version = requireObject(value, field)
  if (version.objectType != null && version.objectType !== 'canvas_item') {
    fail('input.enum', { field: `${field}.objectType`, values: 'canvas_item' })
  }
  return {
    objectType: 'canvas_item',
    id: requireUuid(version.id, `${field}.id`),
    revision: requireRevision(version.revision, `${field}.revision`),
  }
}

export function uuid5(namespace, name) {
  requireUuid(namespace, 'namespace')
  if (typeof name !== 'string') fail('input.string', { field: 'name' })
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex')
  const digest = createHash('sha1')
    .update(namespaceBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

function buildReferences(input, { projectId, specId, operationId }) {
  return requireArray(input, 'references').map((raw, index) => {
    const field = `references[${index}]`
    const reference = requireObject(raw, field)
    const binding = reference.binding ?? 'follow_current'
    requireEnum(binding, `${field}.binding`, REFERENCE_BINDINGS)
    const role = reference.role ?? 'reference'
    requireEnum(role, `${field}.role`, REFERENCE_ROLES)
    const order = reference.order ?? index
    if (!Number.isInteger(order) || order < 0) fail('input.positiveInteger', { field: `${field}.order` })
    const common = {
      id: uuid5(operationId, `reference-${index}`),
      projectId,
      targetSpecId: specId,
      role,
      order,
      active: true,
      binding,
    }
    if (binding === 'pinned') {
      const value = {
        ...common,
        source: requireAssetRef(reference.source, `${field}.source`),
      }
      if (reference.sourceVersion != null) {
        value.sourceVersion = requireSourceVersion(reference.sourceVersion, `${field}.sourceVersion`)
      }
      if (reference.subjectRole != null) {
        value.subjectRole = requireEnum(reference.subjectRole, `${field}.subjectRole`, SUBJECT_ROLES)
      }
      return value
    }
    const sourceItemId = requireUuid(
      reference.sourceItemId ?? reference.source?.id,
      `${field}.sourceItemId`,
    )
    return {
      ...common,
      binding: 'follow_current',
      source: { objectType: 'canvas_item', id: sourceItemId },
    }
  })
}

export function buildProjectCreateCommand({ name, projectId, operationId } = {}) {
  const id = requireUuid(projectId, 'projectId')
  const commandId = requireUuid(operationId, 'operationId')
  const title = requireString(name, 'name').trim()
  return {
    commandId,
    projectId: id,
    type: 'project.create',
    payload: { name: title },
    expectedVersions: [],
  }
}

export function buildCreateGeneration({
  projectId,
  operationId,
  kind,
  modelConfigId,
  prompt,
  parameters,
  position,
  references,
} = {}) {
  const id = requireUuid(projectId, 'projectId')
  const commandId = requireUuid(operationId, 'operationId')
  const generationKind = requireEnum(kind, 'kind', GENERATION_KINDS)
  const model = requireUuid(modelConfigId, 'modelConfigId')
  const text = requireString(prompt, 'prompt', { allowEmpty: true })
  const values = requireObject(parameters, 'parameters')
  const point = requireObject(position, 'position')
  const specId = uuid5(commandId, 'spec')
  const itemId = uuid5(commandId, 'item')
  const builtReferences = buildReferences(references, {
    projectId: id,
    specId,
    operationId: commandId,
  })
  const command = {
    commandId,
    projectId: id,
    type: 'canvas.createGeneration',
    payload: {
      spec: {
        id: specId,
        projectId: id,
        kind: generationKind,
        purpose: 'generation',
        modelConfigId: model,
        prompt: text,
        parameters: values,
      },
      item: {
        id: itemId,
        projectId: id,
        kind: generationKind,
        position: {
          x: requireNumber(point.x, 'position.x'),
          y: requireNumber(point.y, 'position.y'),
        },
        binding: {
          role: 'generation',
          objectRef: { objectType: 'generation_spec', id: specId },
        },
      },
      references: builtReferences,
    },
    expectedVersions: [],
  }
  return {
    command,
    specId,
    itemId,
    referenceIds: builtReferences.map((reference) => reference.id),
  }
}

export function buildSubmitCommand({
  projectId,
  operationId,
  specId,
  expectedSpecRevision,
  originItemId,
  expectedItemRevision,
} = {}) {
  const id = requireUuid(projectId, 'projectId')
  const commandId = requireUuid(operationId, 'operationId')
  const spec = requireUuid(specId, 'specId')
  const revision = requireRevision(expectedSpecRevision, 'expectedSpecRevision')
  const hasOrigin = originItemId != null
  const hasItemRevision = expectedItemRevision != null
  if (hasOrigin !== hasItemRevision) fail('input.pair', { fields: 'originItemId|expectedItemRevision' })
  const origin = hasOrigin ? requireUuid(originItemId, 'originItemId') : null
  const itemRevision = hasItemRevision
    ? requireRevision(expectedItemRevision, 'expectedItemRevision')
    : null
  const expectedVersions = [
    { objectType: 'generation_spec', id: spec, revision },
    ...(origin == null ? [] : [{ objectType: 'canvas_item', id: origin, revision: itemRevision }]),
  ]
  return {
    commandId,
    projectId: id,
    type: 'generation.submit',
    payload: {
      specId: spec,
      expectedSpecRevision: revision,
      ...(origin == null ? {} : { originItemId: origin }),
      adoptionPolicy: 'candidate_only',
      showAdditionalResult: false,
    },
    expectedVersions,
  }
}

export function buildResultSelectCommand({
  projectId,
  operationId,
  specId,
  resultId,
  expectedSpecRevision,
  expectedCanvasVersions = [],
} = {}) {
  const id = requireUuid(projectId, 'projectId')
  const commandId = requireUuid(operationId, 'operationId')
  const spec = requireUuid(specId, 'specId')
  const result = requireUuid(resultId, 'resultId')
  const revision = requireRevision(expectedSpecRevision, 'expectedSpecRevision')
  return {
    commandId,
    projectId: id,
    type: 'result.select',
    payload: { specId: spec, resultId: result },
    expectedVersions: [
      { objectType: 'generation_spec', id: spec, revision },
      ...requireArray(expectedCanvasVersions, 'expectedCanvasVersions').map(value => ({
        objectType: 'canvas_item',
        id: requireUuid(value.id, 'expectedCanvasVersions.id'),
        revision: requireRevision(value.revision, 'expectedCanvasVersions.revision'),
      })),
    ],
  }
}

export function buildJobCancelCommand({ projectId, operationId, jobId, expectedJobRevision } = {}) {
  const id = requireUuid(projectId, 'projectId')
  const commandId = requireUuid(operationId, 'operationId')
  const job = requireUuid(jobId, 'jobId')
  return {
    commandId,
    projectId: id,
    type: 'job.cancel',
    payload: { jobId: job },
    expectedVersions: [{ objectType: 'job', id: job, revision: requireRevision(expectedJobRevision, 'expectedJobRevision') }],
  }
}
