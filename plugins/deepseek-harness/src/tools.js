import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderToolResult } from './presentation.js'
import {
  GENERATION_KINDS,
  MEDIA_KINDS,
  REFERENCE_BINDINGS,
  REFERENCE_ROLES,
  SUBJECT_ROLES,
} from './operations.js'
import {
  HttpError,
  InputError,
  NetworkError,
  RequestAbortedError,
  RequestTimeoutError,
  UnknownOperationError,
} from './errors.js'

const withDescription = (schema, description) => (
  description === undefined ? schema : { ...schema, description }
)
const string = (description) => withDescription({ type: 'string' }, description)
const integer = (description) => withDescription({ type: 'integer' }, description)
const number = (description) => withDescription({ type: 'number' }, description)
const boolean = (description) => withDescription({ type: 'boolean' }, description)
const arrayOf = (items, description) => withDescription({ type: 'array', items }, description)
const objectOf = (properties, { additionalProperties = true, description } = {}) => ({
  type: 'object',
  additionalProperties,
  ...(description === undefined ? {} : { description }),
  ...(properties === undefined ? {} : { properties }),
})
// defineTool compiles DSH property specs to JSON Schema, moving these markers
// to each parent object's required array (including nested objects and outputs).
const required = (schema) => ({ ...schema, required: true })

function outputSchema(properties, requiredKeys = []) {
  const mapped = {}
  for (const [key, value] of Object.entries(properties)) {
    mapped[key] = requiredKeys.includes(key) ? required(value) : value
  }
  return { type: 'object', additionalProperties: true, properties: mapped }
}

function rawInput(args) {
  const output = {}
  for (const key of [
    'action',
    'projectId',
    'operationId',
    'name',
    'kind',
    'modelConfigId',
    'specId',
    'resultId',
    'sourceResultId',
    'jobId',
    'expectedSpecRevision',
    'expectedItemRevision',
    'originItemId',
  ]) {
    if (args?.[key] !== undefined) output[key] = args[key]
  }
  return output
}

function presentationMeta(_args, value) {
  const meta = {}
  for (const key of ['projectId', 'operationId', 'specId', 'itemId', 'resultId', 'jobId', 'canvasUrl']) {
    if (typeof value?.[key] === 'string') meta[key] = value[key]
  }
  const status = value?.receipt?.status ?? value?.job?.status
  if (typeof status === 'string') meta.status = status
  if (Array.isArray(value?.jobIds)) meta.jobIds = value.jobIds.slice(0, 8)
  if (Array.isArray(value?.projects)) meta.projectCount = value.projects.length
  const kind = value?.job?.execution?.kind
  if (kind === 'image' || kind === 'video') {
    const candidates = value.results.filter(result => result.asset?.kind === kind)
    if (!candidates.length) return meta
    const references = value.job.inputSnapshot?.references ?? []
    const source = kind === 'video'
      ? references.find(ref => ref.role === 'continuation' || ref.role === 'first_frame')
      : references.find(ref => ref.asset?.kind === 'image')
    meta.mediaPreview = {
      kind,
      projectName: value.projectName,
      ...(source && { sourceAssetId: source.asset.assetId, sourceKind: source.asset.kind }),
      candidates: candidates.map(result => ({ resultId: result.id, assetId: result.asset.assetId })),
    }
  }
  return meta
}

function localizeError(error, t, client) {
  if (error instanceof InputError) {
    const failure = new Error(t(error.key, error.params))
    failure.name = 'OpenDirectorToolError'
    failure.code = error.key
    return failure
  }
  if (error instanceof HttpError) {
    const detail = String(error.detail ?? '').slice(0, 2000)
    const busy = error.status === 409 && error.code === 'storage_busy'
    const message = busy
      ? t('http.busy', { status: error.status, code: error.code, detail })
      : error.status >= 300 && error.status < 400
        ? t('http.redirect', { status: error.status })
        : t('http.error', { status: error.status, code: error.code, detail })
    const failure = new Error(message)
    failure.name = 'OpenDirectorToolError'
    failure.status = error.status
    failure.code = error.code
    if (typeof error.body !== 'string') failure.remote = error.body
    return failure
  }
  if (error instanceof UnknownOperationError) {
    const guidance = t('guidance.operation', {
      projectId: error.projectId,
      operationId: error.operationId,
    })
    const failure = new Error(t('unknown.operation', {
      operationId: error.operationId,
      projectId: error.projectId,
      guidance,
    }))
    failure.name = 'OpenDirectorToolError'
    failure.code = 'operation_unknown'
    failure.projectId = error.projectId
    failure.operationId = error.operationId
    failure.cause = error.cause
    return failure
  }
  if (error instanceof RequestAbortedError) {
    const failure = new Error(t('request.aborted'))
    failure.name = 'OpenDirectorToolError'
    failure.code = 'aborted'
    return failure
  }
  if (error instanceof RequestTimeoutError) {
    const failure = new Error(t('network.timeout', { timeoutMs: error.timeoutMs }))
    failure.name = 'OpenDirectorToolError'
    failure.code = 'timeout'
    return failure
  }
  if (error instanceof NetworkError) {
    const failure = new Error(t('network.error', {
      baseUrl: client.baseUrl,
      detail: error.message,
    }))
    failure.name = 'OpenDirectorToolError'
    failure.code = 'network_error'
    return failure
  }
  return error
}

const receiptSchema = objectOf({
  commandId: string('Stable command ID.'),
  projectId: string('Owning project ID.'),
  inputFingerprint: string('Fixed input fingerprint.'),
  status: { type: 'string', enum: ['applied', 'accepted', 'noop', 'rejected'] },
  changed: arrayOf(objectOf({
    objectType: string('Changed object type.'),
    id: string('Changed object ID.'),
    revision: integer('Changed object revision.'),
  })),
  jobIds: arrayOf(string('Generation job ID.')),
  issues: arrayOf(objectOf({
    code: string('Stable issue code.'),
    message: string('Issue message.'),
  })),
})

const resultSchema = objectOf({
  id: string('Result ID.'),
  specId: string('Generation spec ID.'),
  jobId: string('Generation job ID.'),
  asset: objectOf(),
})

const jobSchema = objectOf({
  id: string('Job ID.'),
  revision: integer('Job revision.'),
  status: string('Job status.'),
  phase: string('Job phase.'),
  cancelRequested: boolean('Whether cancellation was requested.'),
  adopted: boolean('Whether the result was adopted.'),
  adoptionPolicy: string('Adoption policy.'),
  remoteCancellation: string('Remote cancellation state.'),
})

const snapshotSchema = objectOf({
  format: string('Project format.'),
  formatVersion: integer('Project format version.'),
  project: objectOf({
    id: string('Project ID.'),
    revision: integer('Project revision.'),
    name: string('Project name.'),
  }),
  assets: arrayOf(objectOf()),
  generationSpecs: arrayOf(objectOf()),
  references: arrayOf(objectOf()),
  canvasItems: arrayOf(objectOf()),
  editorDocuments: arrayOf(objectOf()),
  jobs: arrayOf(jobSchema),
  results: arrayOf(resultSchema),
  eventCursor: integer('Latest project event cursor.'),
  undoClearedThrough: integer('Undo history boundary.'),
})

const modelSchema = objectOf({
  id: string('Model configuration ID.'),
  kind: string('Model kind.'),
  modelId: string('Provider model ID.'),
  url: string('Provider base URL.'),
  inputRules: objectOf(),
})

export function createOpenDirectorTools({ client, t, hasWebPreview = () => false }) {
  const projectIdParam = required(string(t('param.projectId')))
  const operationIdParam = required(string(t('param.operationId')))
  const makeTool = ({ key, name, description, parameters, schema, execute }) => defineTool({
    name,
    description,
    parameters,
    output: {
      schema,
      render: (_args, value) => [{
        type: 'text',
        text: renderToolResult(key, value, t, { webPreview: key === 'job' && hasWebPreview() }),
      }],
      presentationMeta,
    },
    presentCall: (args) => ({
      card: 'generic',
      title: t(`present.call.${key}`),
      rawInput: rawInput(args),
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: t(`present.result.${key}`),
      content: result.content,
    }),
    async execute(args, exec) {
      try {
        return await execute(args, exec)
      } catch (error) {
        throw localizeError(error, t, client)
      }
    },
  })

  const referenceItem = objectOf({
    sourceItemId: string(t('param.sourceItemId')),
    binding: { type: 'string', enum: REFERENCE_BINDINGS, description: t('param.referenceBinding') },
    role: { type: 'string', enum: REFERENCE_ROLES, description: t('param.referenceRole') },
    order: integer(t('param.referenceOrder')),
    source: objectOf({
      assetId: string(t('param.assetId')),
      revision: integer(t('param.assetRevision')),
      fingerprint: string(t('param.fingerprint')),
      kind: { type: 'string', enum: MEDIA_KINDS, description: t('param.assetKind') },
    }, { description: t('param.source') }),
    sourceVersion: objectOf({
      objectType: { type: 'string', const: 'canvas_item', description: t('param.sourceObjectType') },
      id: string(t('param.sourceId')),
      revision: integer(t('param.sourceRevision')),
    }, { description: t('param.sourceVersion') }),
    subjectRole: { type: 'string', enum: SUBJECT_ROLES, description: t('param.subjectRole') },
  })

  const projects = makeTool({
    key: 'projects',
    name: 'opendirector_projects',
    description: t('tool.projects.description'),
    parameters: {
      action: required({
        type: 'string',
        enum: ['list', 'create'],
        description: t('param.action'),
      }),
      name: string(t('param.name')),
      projectId: string(t('param.projectId')),
      operationId: string(t('param.operationId')),
    },
    schema: outputSchema({
      action: { type: 'string', enum: ['list', 'create'] },
      projects: arrayOf(objectOf({
        id: string('Project ID.'),
        name: string('Project name.'),
        path: string('Project directory.'),
      })),
      unreadable: arrayOf(objectOf()),
      warnings: arrayOf(string()),
      projectId: string('Created project ID.'),
      operationId: string('Operation ID.'),
      receipt: receiptSchema,
      canvasUrl: string('OpenDirector canvas URL.'),
    }, ['action']),
    async execute(args, exec) {
      if (args.action === 'list') {
        const value = await client.listProjects({ signal: exec.signal })
        return {
          action: 'list',
          projects: Array.isArray(value?.projects) ? value.projects.map(project => ({ ...project, canvasUrl: client.canvasUrl(project.id) })) : [],
          unreadable: Array.isArray(value?.unreadable) ? value.unreadable : [],
          warnings: Array.isArray(value?.warnings) ? value.warnings : [],
        }
      }
      const receipt = await client.createProject({
        name: args.name,
        projectId: args.projectId,
        operationId: args.operationId,
        signal: exec.signal,
      })
      return {
        action: 'create',
        projectName: args.name,
        projectId: args.projectId,
        operationId: args.operationId,
        receipt,
        canvasUrl: client.canvasUrl(args.projectId),
      }
    },
  })

  const project = makeTool({
    key: 'project',
    name: 'opendirector_project',
    description: t('tool.project.description'),
    parameters: {
      projectId: projectIdParam,
    },
    schema: outputSchema({
      projectId: string('Project ID.'),
      canvasUrl: string('OpenDirector canvas URL.'),
      snapshot: snapshotSchema,
      models: arrayOf(modelSchema),
    }, ['projectId', 'canvasUrl', 'snapshot', 'models']),
    async execute(args, exec) {
      const [snapshot, models] = await Promise.all([
        client.project(args.projectId, { signal: exec.signal }),
        client.models({ signal: exec.signal }),
      ])
      return {
        projectId: args.projectId,
        canvasUrl: client.canvasUrl(args.projectId),
        snapshot,
        projectName: snapshot.project.name,
        models: Array.isArray(models) ? models : [],
      }
    },
  })

  const createGeneration = makeTool({
    key: 'createGeneration',
    name: 'opendirector_create_generation',
    description: t('tool.createGeneration.description'),
    parameters: {
      projectId: projectIdParam,
      operationId: operationIdParam,
      kind: required({
        type: 'string',
        enum: GENERATION_KINDS,
        description: t('param.kind'),
      }),
      modelConfigId: required(string(t('param.modelConfigId'))),
      prompt: required(string(t('param.prompt'))),
      parameters: required(objectOf(undefined, { description: t('param.parameters') })),
      position: required(objectOf({
        x: required(number(t('param.positionX'))),
        y: required(number(t('param.positionY'))),
      }, { additionalProperties: false, description: t('param.position') })),
      references: arrayOf(referenceItem, t('param.references')),
      sourceResultId: string(t('param.sourceResultId')),
    },
    schema: outputSchema({
      projectId: string('Project ID.'),
      canvasUrl: string('OpenDirector canvas URL.'),
      operationId: string('Operation ID.'),
      receipt: receiptSchema,
      specId: string('Generation spec ID.'),
      itemId: string('Canvas item ID.'),
      referenceIds: arrayOf(string('Reference ID.')),
    }, ['projectId', 'canvasUrl', 'operationId', 'receipt', 'specId', 'itemId', 'referenceIds']),
    async execute(args, exec) {
      const value = await client.createGeneration({
        projectId: args.projectId,
        operationId: args.operationId,
        kind: args.kind,
        modelConfigId: args.modelConfigId,
        prompt: args.prompt,
        parameters: args.parameters,
        position: args.position,
        references: args.references,
        sourceResultId: args.sourceResultId,
        signal: exec.signal,
      })
      return {
        projectId: args.projectId,
        canvasUrl: client.canvasUrl(args.projectId),
        operationId: args.operationId,
        receipt: value.receipt,
        projectName: value.projectName,
        specId: value.specId,
        itemId: value.itemId,
        referenceIds: value.referenceIds,
      }
    },
  })

  const submit = makeTool({
    key: 'submit',
    name: 'opendirector_submit',
    description: t('tool.submit.description'),
    parameters: {
      projectId: projectIdParam,
      operationId: operationIdParam,
      specId: required(string(t('param.specId'))),
      expectedSpecRevision: required(integer(t('param.expectedSpecRevision'))),
      originItemId: string(t('param.originItemId')),
      expectedItemRevision: integer(t('param.expectedItemRevision')),
    },
    schema: outputSchema({
      projectId: string('Project ID.'),
      canvasUrl: string('OpenDirector canvas URL.'),
      operationId: string('Operation ID.'),
      receipt: receiptSchema,
      jobIds: arrayOf(string('Generation job ID.')),
    }, ['projectId', 'canvasUrl', 'operationId', 'receipt', 'jobIds']),
    async execute(args, exec) {
      const { receipt, projectName } = await client.submit({
        projectId: args.projectId,
        operationId: args.operationId,
        specId: args.specId,
        expectedSpecRevision: args.expectedSpecRevision,
        originItemId: args.originItemId,
        expectedItemRevision: args.expectedItemRevision,
        signal: exec.signal,
      })
      return {
        projectId: args.projectId,
        canvasUrl: client.canvasUrl(args.projectId),
        operationId: args.operationId,
        receipt,
        jobIds: Array.isArray(receipt?.jobIds) ? receipt.jobIds : [],
        projectName,
      }
    },
  })

  const job = makeTool({
    key: 'job',
    name: 'opendirector_job',
    description: t('tool.job.description'),
    parameters: {
      projectId: projectIdParam,
      jobId: required(string(t('param.jobId'))),
    },
    schema: outputSchema({
      projectId: string('Project ID.'),
      canvasUrl: string('OpenDirector canvas URL.'),
      jobId: string('Job ID.'),
      job: jobSchema,
      results: arrayOf(resultSchema),
    }, ['projectId', 'canvasUrl', 'jobId', 'job', 'results']),
    async execute(args, exec) {
      const value = await client.job(args.projectId, args.jobId, { signal: exec.signal })
      return {
        projectId: args.projectId,
        canvasUrl: client.canvasUrl(args.projectId),
        jobId: args.jobId,
        job: value.job,
        projectName: value.projectName,
        registered: value.registered,
        adopted: value.adopted,
        results: value.results,
      }
    },
  })

  const adoptResult = makeTool({
    key: 'adoptResult',
    name: 'opendirector_adopt_result',
    description: t('tool.adoptResult.description'),
    parameters: {
      projectId: projectIdParam,
      operationId: operationIdParam,
      specId: required(string(t('param.specId'))),
      resultId: required(string(t('param.resultId'))),
      expectedSpecRevision: required(integer(t('param.expectedSpecRevision'))),
      expectedCanvasVersions: arrayOf(objectOf({
        id: required(string(t('param.sourceId'))),
        revision: required(integer(t('param.sourceRevision'))),
      }, { additionalProperties: false }), t('param.expectedCanvasVersions')),
    },
    schema: outputSchema({
      projectId: string('Project ID.'),
      canvasUrl: string('OpenDirector canvas URL.'),
      operationId: string('Operation ID.'),
      receipt: receiptSchema,
      specId: string('Generation spec ID.'),
      resultId: string('Result ID.'),
    }, ['projectId', 'canvasUrl', 'operationId', 'receipt', 'specId', 'resultId']),
    async execute(args, exec) {
      const { receipt, projectName } = await client.adoptResult({
        projectId: args.projectId,
        operationId: args.operationId,
        specId: args.specId,
        resultId: args.resultId,
        expectedSpecRevision: args.expectedSpecRevision,
        expectedCanvasVersions: args.expectedCanvasVersions,
        signal: exec.signal,
      })
      return {
        projectId: args.projectId,
        canvasUrl: client.canvasUrl(args.projectId),
        operationId: args.operationId,
        receipt,
        specId: args.specId,
        resultId: args.resultId,
        projectName,
      }
    },
  })

  const cancel = makeTool({
    key: 'cancel',
    name: 'opendirector_cancel',
    description: t('tool.cancel.description'),
    parameters: {
      projectId: projectIdParam,
      operationId: operationIdParam,
      jobId: required(string(t('param.jobId'))),
      expectedJobRevision: required(integer(t('param.expectedJobRevision'))),
    },
    schema: outputSchema({
      projectId: string('Project ID.'),
      canvasUrl: string('OpenDirector canvas URL.'),
      operationId: string('Operation ID.'),
      jobId: string('Job ID.'),
      receipt: receiptSchema,
    }, ['projectId', 'canvasUrl', 'operationId', 'jobId', 'receipt']),
    async execute(args, exec) {
      const { receipt, projectName } = await client.cancelJob({
        projectId: args.projectId,
        operationId: args.operationId,
        jobId: args.jobId,
        expectedJobRevision: args.expectedJobRevision,
        signal: exec.signal,
      })
      return {
        projectId: args.projectId,
        canvasUrl: client.canvasUrl(args.projectId),
        operationId: args.operationId,
        jobId: args.jobId,
        receipt,
        projectName,
      }
    },
  })

  const operation = makeTool({
    key: 'operation',
    name: 'opendirector_operation',
    description: t('tool.operation.description'),
    parameters: {
      projectId: projectIdParam,
      operationId: operationIdParam,
    },
    schema: outputSchema({
      projectId: string('Project ID.'),
      operationId: string('Operation ID.'),
      found: boolean('Whether a committed receipt exists.'),
      receipt: receiptSchema,
      guidance: string('Next-step guidance when no receipt exists.'),
    }, ['projectId', 'operationId', 'found']),
    async execute(args, exec) {
      const receipt = await client.receipt(args.projectId, args.operationId, { signal: exec.signal })
      if (receipt === null) {
        return {
          projectId: args.projectId,
          operationId: args.operationId,
          found: false,
          guidance: t('operation.notFound', { operationId: args.operationId }),
        }
      }
      return {
        projectId: args.projectId,
        operationId: args.operationId,
        found: true,
        receipt,
      }
    },
  })

  return [projects, project, createGeneration, submit, job, adoptResult, cancel, operation]
}
