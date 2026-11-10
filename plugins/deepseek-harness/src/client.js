import { randomUUID } from 'node:crypto'
import {
  buildCreateGeneration,
  buildJobCancelCommand,
  buildProjectCreateCommand,
  buildResultSelectCommand,
  buildSubmitCommand,
  requireUuid,
  requireString,
  requireEnum,
  uuid5,
} from './operations.js'
import {
  HttpError,
  InputError,
  NetworkError,
  RequestAbortedError,
  RequestTimeoutError,
  UnknownOperationError,
} from './errors.js'

const PROJECTS = '/api/creation/projects'
const PROMPT_LIMIT = 20000
const LIBRARY_PAGE_SIZE = 12
const MEDIA_TYPES = {
  image: ['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'image/avif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm'],
}

export function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
}

function creationPath(projectId) {
  return `${PROJECTS}/${projectId}`
}

function resultReference(input) {
  if (input.sourceResultId === undefined) return undefined
  const resultId = requireUuid(input.sourceResultId, 'sourceResultId')
  if (input.references?.length) throw new InputError('result.edit_reference_conflict')
  if (input.kind === 'image') return { resultId, kind: 'image', role: 'reference' }
  if (input.kind === 'video') {
    if (input.parameters?.videoMode === 'first_frame') return { resultId, kind: 'image', role: 'first_frame' }
    if (input.parameters?.videoMode === 'continuation') return { resultId, kind: 'video', role: 'continuation' }
  }
  throw new InputError('result.source_mode')
}

function responseError(response, payload, text) {
  const detail = typeof payload?.detail === 'string'
    ? payload.detail
    : typeof payload?.message === 'string'
      ? payload.message
      : text || response.statusText
  const code = typeof payload?.code === 'string' ? payload.code : `http_${response.status}`
  return new HttpError({
    status: response.status,
    code,
    detail,
    body: payload ?? text,
    location: response.headers.get('location'),
  })
}

// Keep the header deadline separate from the body idle deadline. A video can
// stream for longer while chunks arrive; downstream backpressure pauses reads.
function withMediaBodyTimeout(response, controller, timeoutMs) {
  if (!response.body) return response
  const reader = response.body.getReader()
  const body = new ReadableStream({
    async pull(stream) {
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const { done, value } = await reader.read()
        if (done) stream.close()
        else stream.enqueue(value)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

export class OpenDirectorClient {
  constructor(config, { fetchImpl = globalThis.fetch, heartbeatIntervalMs = 15000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required')
    this.baseUrl = config.baseUrl
    this.canvasBaseUrl = config.canvasBaseUrl
    this.locale = config.locale
    this.requestTimeoutMs = config.requestTimeoutMs
    this.fetchImpl = fetchImpl
    this.heartbeatIntervalMs = heartbeatIntervalMs
  }

  canvasUrl(projectId) {
    return `${this.canvasBaseUrl}/ai-canvas/${requireUuid(projectId, 'projectId')}`
  }

  async #request(method, path, {
    body, session = randomUUID(), signal, timeoutMs = this.requestTimeoutMs, mediaType, allowedMediaTypes = [mediaType], range,
  } = {}) {
    const url = joinUrl(this.baseUrl, path)
    const headers = {
      'X-OpenDirector-Request': '1',
      'X-OpenDirector-Session': session,
      'Accept-Language': this.locale,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (mediaType) headers.Accept = mediaType
    if (range) headers.Range = range
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const transportError = (error) => {
      if (signal?.aborted) return new RequestAbortedError(error)
      if (timedOut) return new RequestTimeoutError(timeoutMs)
      return new NetworkError(url, error)
    }
    try {
      let response
      const fetch = this.fetchImpl
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: requestSignal,
        })
      } catch (error) {
        throw transportError(error)
      }
      if (mediaType && (response.ok || response.status === 416)) {
        const type = response.headers.get('content-type')?.split(';', 1)[0]
        if (response.ok && !allowedMediaTypes.includes(type)) {
          await response.body?.cancel()
          throw new HttpError({ status: 502, code: 'invalid_media', detail: 'Unexpected OpenDirector media type.' })
        }
        return withMediaBodyTimeout(response, controller, timeoutMs)
      }
      let text = ''
      try {
        text = await response.text()
      } catch (error) {
        throw transportError(error)
      }
      let payload = null
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = text
        }
      }
      if (response.status >= 300 && response.status < 400) {
        throw new HttpError({
          status: response.status,
          code: 'redirect_not_followed',
          detail: response.headers.get('location') ?? response.statusText,
          body: payload,
          location: response.headers.get('location'),
        })
      }
      if (!response.ok) throw responseError(response, payload, text)
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  #startHeartbeat(projectId, session) {
    const controller = new AbortController()
    let pending = null
    const timer = setInterval(() => {
      if (pending) return
      pending = this.#request('PUT', `/api/creation/sessions/${session}`, {
        body: { projectId },
        session,
        signal: controller.signal,
      })
        .catch(() => {})
        .finally(() => {
          pending = null
        })
    }, this.heartbeatIntervalMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }

  async #withLease(projectId, signal, action) {
    const session = randomUUID()
    let stop = () => {}
    try {
      const snapshot = await this.#request('POST', `${creationPath(projectId)}/open`, { session, signal })
      stop = this.#startHeartbeat(projectId, session)
      return await action(session, snapshot)
    } finally {
      stop()
      // An open response can be lost after the server grants our own lease.
      await this.#request('DELETE', `/api/creation/sessions/${session}`, {
        session, timeoutMs: Math.min(this.requestTimeoutMs, 1500),
      }).catch(() => {})
    }
  }

  async #command({ projectId, operationId, command, session, signal }) {
    try {
      return await this.#request('POST', `${creationPath(projectId)}/commands`, {
        body: command,
        session,
        signal,
      })
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 408
        && error.code !== 'storage_unavailable') throw error
      throw new UnknownOperationError({ projectId, operationId, cause: error })
    }
  }

  async listProjects({ signal } = {}) {
    return this.#request('GET', PROJECTS, { signal })
  }

  async project(projectId, { signal } = {}) {
    const id = requireUuid(projectId, 'projectId')
    return this.#request('GET', creationPath(id), { signal })
  }

  async libraryResults(projectId, { kind = 'all', selection = 'all', order = 'newest', after, signal } = {}) {
    requireEnum(kind, 'kind', ['all', ...Object.keys(MEDIA_TYPES)])
    requireEnum(selection, 'selection', ['all', 'current', 'other'])
    requireEnum(order, 'order', ['newest', 'oldest'])
    const cursor = after == null ? null : requireUuid(after, 'after')
    const snapshot = await this.project(projectId, { signal })
    const specs = new Map(snapshot.generationSpecs.map(spec => [spec.id, spec]))
    const jobs = new Map(snapshot.jobs.map(job => [job.id, job]))
    const results = []
    const step = order === 'oldest' ? 1 : -1
    const cursorIndex = cursor === null ? null : snapshot.results.findIndex(result => result.id === cursor)
    if (cursorIndex === -1) throw new InputError('library.cursor_expired')
    const start = cursorIndex === null ? (step === 1 ? 0 : snapshot.results.length - 1) : cursorIndex + step
    // Registration order is stable even when jobs finish out of order.
    for (let index = start; index >= 0 && index < snapshot.results.length && results.length <= LIBRARY_PAGE_SIZE; index += step) {
      const { id, specId, jobId, asset } = snapshot.results[index]
      if (!Object.hasOwn(MEDIA_TYPES, asset.kind) || (kind !== 'all' && asset.kind !== kind)) continue
      const selected = specs.get(specId)?.currentResultId === id
      if ((selection === 'current' && !selected) || (selection === 'other' && selected)) continue
      results.push({
        resultId: id,
        specId,
        assetId: asset.assetId,
        kind: asset.kind,
        selected,
        prompt: jobs.get(jobId)?.inputSnapshot?.spec?.prompt?.slice(0, 160) ?? '',
      })
    }
    const hasMore = results.length > LIBRARY_PAGE_SIZE
    if (hasMore) results.pop()
    return { projectId, projectName: snapshot.project.name, canvasUrl: this.canvasUrl(projectId), results,
      nextCursor: hasMore ? results.at(-1).resultId : null }
  }

  async models({ signal } = {}) {
    return this.#request('GET', '/api/model-configs', { signal })
  }

  async creationModels({ signal } = {}) {
    const models = await this.models({ signal })
    return models.filter(model => (model.kind === 'image' && model.protocol !== 'vllm_omni_segmentation')
      || (model.kind === 'audio' && !['vllm_omni_music', 'vllm_omni_score'].includes(model.protocol)))
      .map(({ id, kind, modelId, connectionType, inputRules }) => ({
        id, kind, modelId, connectionType,
        imageOutputs: inputRules?.imageOutputs ?? [],
        maxImages: inputRules?.allowedKinds?.includes('image') ? (inputRules.maxImages ?? 0) : 0,
        voiceRequired: inputRules?.voiceRequired === true,
        maxPromptCharacters: inputRules?.maxPromptCharacters,
      }))
  }

  async media(projectId, assetId, { kind, original, range, signal } = {}) {
    const project = requireUuid(projectId, 'projectId')
    const asset = requireUuid(assetId, 'assetId')
    if (!Object.hasOwn(MEDIA_TYPES, kind)) throw new InputError('input.enum', { field: 'kind', values: 'image|video|audio' })
    const thumbnail = kind === 'image' && !original
    return this.#request('GET', `${creationPath(project)}/assets/${asset}/${thumbnail ? 'thumbnail' : 'content'}`, {
      signal, mediaType: thumbnail ? 'image/webp' : `${kind}/*`,
      allowedMediaTypes: thumbnail ? ['image/webp'] : MEDIA_TYPES[kind], range: thumbnail ? undefined : range,
      timeoutMs: Math.min(this.requestTimeoutMs, 5000),
    })
  }

  async job(projectId, jobId, { signal } = {}) {
    const id = requireUuid(projectId, 'projectId')
    const job = requireUuid(jobId, 'jobId')
    const snapshot = await this.project(id, { signal })
    const value = Array.isArray(snapshot?.jobs)
      ? snapshot.jobs.find((item) => item.id === job)
      : undefined
    if (!value) throw new InputError('job.missing', { jobId: job, projectId: id })
    const results = Array.isArray(snapshot?.results)
      ? snapshot.results.filter((item) => item.jobId === job)
      : []
    return {
      job: value, results, projectName: snapshot.project.name,
      registered: results.length > 0,
      adopted: snapshot.generationSpecs.some(spec => results.some(result => result.id === spec.currentResultId)),
    }
  }

  async creationStatus(projectId, jobId, { signal } = {}) {
    const project = requireUuid(projectId, 'projectId')
    const id = requireUuid(jobId, 'jobId')
    const job = await this.#request('POST', `${creationPath(project)}/queries`, {
      body: { type: 'job.get', projectId: project, queryId: randomUUID(), objectId: id }, signal,
    })
    if (job.status !== 'succeeded') return { status: job.status, category: job.errorDetails?.category }
    const value = await this.job(project, id, { signal })
    return {
      status: job.status,
      results: value.results.map(result => ({ resultId: result.id, assetId: result.asset.assetId, kind: result.asset.kind })),
    }
  }

  async receipt(projectId, operationId, { signal } = {}) {
    const id = requireUuid(projectId, 'projectId')
    const command = requireUuid(operationId, 'operationId')
    try {
      return await this.#request('GET', `${creationPath(id)}/receipts/${command}`, { signal })
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null
      throw error
    }
  }

  async createProject({ name, projectId, operationId, signal } = {}) {
    const command = buildProjectCreateCommand({ name, projectId, operationId })
    return this.#command({
      projectId: command.projectId,
      operationId: command.commandId,
      command,
      session: randomUUID(),
      signal,
    })
  }

  async createGeneration(input) {
    const reference = resultReference(input)
    const planned = reference ? undefined : buildCreateGeneration(input)
    const projectId = planned?.command.projectId ?? requireUuid(input.projectId, 'projectId')
    return this.#withLease(projectId, input.signal, async (session, snapshot) => {
      let generation = planned
      if (reference) {
        const result = snapshot.results.find(item => item.id === reference.resultId)
        if (result?.asset?.kind !== reference.kind) {
          throw new InputError('result.source_missing', { resultId: reference.resultId, kind: reference.kind })
        }
        generation = buildCreateGeneration({
          ...input,
          references: [{ binding: 'pinned', role: reference.role, order: 0, source: result.asset }],
        })
      }
      const { command, specId, itemId, referenceIds } = generation
      const receipt = await this.#command({
        projectId, operationId: command.commandId, command, session, signal: input.signal,
      })
      return { receipt, projectName: snapshot.project.name, specId, itemId, referenceIds }
    })
  }

  async submit(input) {
    return this.#write(buildSubmitCommand(input), input.signal)
  }

  async startCreation(input, { signal } = {}) {
    const projectId = requireUuid(input.projectId, 'projectId')
    const intent = requireUuid(input.operationId, 'operationId')
    const createId = uuid5(intent, 'creation.draft')
    const submitId = uuid5(intent, 'creation.submit')
    if (input.check === true) {
      const submitted = await this.receipt(projectId, submitId, { signal })
      if (submitted) return { status: submitted.status, jobId: submitted.jobIds?.[0], code: submitted.issues?.[0]?.code }
      const draft = await this.receipt(projectId, createId, { signal })
      return draft?.status === 'rejected'
        ? { status: 'rejected', code: draft.issues?.[0]?.code }
        : { status: 'unknown', draftSaved: draft?.status === 'applied' }
    }
    const prompt = requireString(input.prompt, 'prompt').trim()
    const modelConfigId = requireUuid(input.modelConfigId, 'modelConfigId')
    const model = (await this.creationModels({ signal })).find(item => item.id === modelConfigId)
    if (!model || model.kind !== input.kind) throw new InputError('creation.model')
    if (!prompt || Array.from(prompt).length > Math.min(model.maxPromptCharacters ?? PROMPT_LIMIT, PROMPT_LIMIT)) {
      throw new InputError('creation.prompt')
    }
    const values = input.sourceResultIds ?? (input.sourceResultId == null ? [] : [input.sourceResultId])
    if (!Array.isArray(values) || (input.sourceResultIds != null && input.sourceResultId != null)) {
      throw new InputError('creation.references')
    }
    if (values.length && (model.kind !== 'image' || values.length > model.maxImages)) {
      throw new InputError('creation.reference_limit')
    }
    const sourceIds = values.map(id => requireUuid(id, 'sourceResultIds'))
    if (new Set(sourceIds).size !== sourceIds.length) throw new InputError('creation.references')
    let parameters
    if (model.kind === 'image') {
      const output = input.output == null ? model.imageOutputs[0]
        : model.imageOutputs.find(item => item.size === input.output.size && item.aspectRatio === input.output.aspectRatio)
      if (!output && (input.output != null || model.imageOutputs.length)) throw new InputError('creation.output')
      parameters = output ? { size: output.size, aspectRatio: output.aspectRatio } : { size: 'auto' }
    } else {
      const voice = typeof input.voice === 'string' ? input.voice.trim() : ''
      if ((model.voiceRequired && !voice) || voice.length > 200) throw new InputError('creation.voice')
      parameters = { creationType: 'audio', ...(voice && { voice }) }
    }
    if (input.projectName != null) {
      if (sourceIds.length) throw new InputError('creation.references')
      const project = await this.createProject({
        projectId, name: input.projectName, operationId: uuid5(intent, 'creation.project'), signal,
      })
      if (project.status !== 'applied' && project.status !== 'noop') {
        return { status: 'rejected', code: project.issues?.[0]?.code }
      }
    }
    return this.#withLease(projectId, signal, async (session, snapshot) => {
      const existing = snapshot.generationSpecs.some(spec => spec.id === uuid5(createId, 'spec'))
      if (existing) {
        const receipt = await this.receipt(projectId, submitId, { signal })
        return receipt ? { status: receipt.status, jobId: receipt.jobIds?.[0], code: receipt.issues?.[0]?.code }
          : { status: 'unknown', draftSaved: true }
      }
      const references = sourceIds.map((id, order) => {
        const source = snapshot.results.find(result => result.id === id)?.asset
        if (source?.kind !== 'image') throw new InputError('result.candidate_missing')
        return { binding: 'pinned', role: 'reference', order, source }
      })
      if (new Set(references.map(reference => reference.source.assetId)).size !== references.length) {
        throw new InputError('creation.references')
      }
      const right = snapshot.canvasItems.filter(item => item.parentId == null)
        .reduce((x, item) => Math.max(x, item.position.x + item.width + 48), 0)
      const { command, specId, itemId } = buildCreateGeneration({
        projectId, operationId: createId, kind: model.kind, modelConfigId, prompt, parameters,
        position: { x: right, y: 0 },
        references,
      })
      const draft = await this.#command({ projectId, operationId: createId, command, session, signal })
      if (draft.status !== 'applied') return { status: 'rejected', code: draft.issues?.[0]?.code }
      const submit = buildSubmitCommand({
        projectId, operationId: submitId, specId, originItemId: itemId,
        expectedSpecRevision: draft.changed.find(item => item.id === specId)?.revision,
        expectedItemRevision: draft.changed.find(item => item.id === itemId)?.revision,
      })
      const accepted = await this.#command({ projectId, operationId: submitId, command: submit, session, signal })
      return { status: accepted.status, jobId: accepted.jobIds?.[0], code: accepted.issues?.[0]?.code, draftSaved: true }
    })
  }

  async adoptResult(input) {
    return this.#write(buildResultSelectCommand(input), input.signal)
  }

  async adoptCandidate({ projectId, resultId, operationId, check, signal }) {
    const project = requireUuid(projectId, 'projectId')
    const result = requireUuid(resultId, 'resultId')
    const commandId = uuid5(requireUuid(operationId, 'operationId'), `result.select:${project}:${result}`)
    if (check) {
      return this.receipt(project, commandId, { signal })
    }
    return this.#withLease(project, signal, async (session, snapshot) => {
      const candidate = snapshot.results.find(item => item.id === result)
      const spec = snapshot.generationSpecs.find(item => item.id === candidate?.specId)
      if (!spec) throw new InputError('result.candidate_missing')
      if (spec.currentResultId === result) return { status: 'noop' }
      const expectedCanvasVersions = snapshot.canvasItems
        .filter(item => item.binding?.objectRef?.id === spec.id || item.binding?.draftSpec?.id === spec.id)
        .map(({ id, revision }) => ({ id, revision }))
      const command = buildResultSelectCommand({
        projectId: project, operationId: commandId, specId: spec.id, resultId: result,
        expectedSpecRevision: spec.revision, expectedCanvasVersions,
      })
      return this.#command({ projectId: project, operationId: commandId, command, session, signal })
    })
  }

  async cancelJob(input) {
    return this.#write(buildJobCancelCommand(input), input.signal)
  }

  async #write(command, signal) {
    return this.#withLease(command.projectId, signal, async (session, snapshot) => ({
      receipt: await this.#command({
        projectId: command.projectId, operationId: command.commandId, command, session, signal,
      }),
      projectName: snapshot.project.name,
    }))
  }
}
