import { randomUUID } from 'node:crypto'
import {
  buildCreateGeneration,
  buildJobCancelCommand,
  buildProjectCreateCommand,
  buildResultSelectCommand,
  buildSubmitCommand,
  requireUuid,
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
    body, session = randomUUID(), signal, timeoutMs = this.requestTimeoutMs, mediaType, range,
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
        if (response.ok && (mediaType === 'video/*'
          ? !['video/mp4', 'video/webm', 'video/quicktime'].includes(type)
          : type !== mediaType)) {
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

  async models({ signal } = {}) {
    return this.#request('GET', '/api/model-configs', { signal })
  }

  async media(projectId, assetId, { kind, range, signal } = {}) {
    const project = requireUuid(projectId, 'projectId')
    const asset = requireUuid(assetId, 'assetId')
    if (kind !== 'image' && kind !== 'video') throw new InputError('input.enum', { field: 'kind', values: 'image|video' })
    const video = kind === 'video'
    return this.#request('GET', `${creationPath(project)}/assets/${asset}/${video ? 'content' : 'thumbnail'}`, {
      signal, mediaType: video ? 'video/*' : 'image/webp', range: video ? range : undefined,
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

  async adoptResult(input) {
    return this.#write(buildResultSelectCommand(input), input.signal)
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
