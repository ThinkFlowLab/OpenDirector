import { randomUUID } from 'node:crypto'
import { mediaDetails, resultMediaDetails } from './presentation.js'
import { resultVersionInfo } from './versions.js'
import { actionPackRequest, actionPackArchive } from './action-packs.js'
import {
  buildCreateGeneration,
  buildJobCancelCommand,
  buildProjectCreateCommand,
  buildResultSelectCommand,
  buildSubmitCommand,
  imageOutputParameters,
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
const RETRYABLE_FAILURES = new Set(['quota', 'rate_limit', 'authentication', 'permission', 'temporary', 'provider'])
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

function canRetryFailedJob(job) {
  return job?.status === 'failed' && job.recovery === 'retry' && !job.cancelRequested
    && RETRYABLE_FAILURES.has(job.errorDetails?.category)
}

function librarySearch(snapshot, query) {
  if (typeof query !== 'string' || query.length > 200) throw new InputError('library.search')
  const normalize = value => value.normalize('NFKC').toLowerCase()
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean)
  const titles = new Map()
  for (const item of snapshot.canvasItems ?? []) {
    if (item.binding?.role !== 'generation' || !item.title) continue
    const specId = item.binding.objectRef.id
    titles.set(specId, [titles.get(specId), item.title].filter(Boolean).join(' · '))
  }
  return {
    title: specId => titles.get(specId),
    matches: (prompt, title, modelId, ...ids) => {
      if (!terms.length) return true
      const text = normalize([prompt, title, modelId].filter(value => typeof value === 'string').join('\n'))
      return terms.every(term => text.includes(term))
        || (terms.length === 1 && terms[0].length >= 8 && ids.some(id => id?.startsWith(terms[0])))
    },
  }
}

function creationSeed(snapshot, resultId, model) {
  const result = snapshot.results.find(item => item.id === resultId)
  const job = snapshot.jobs.find(item => item.id === result?.jobId)
  const spec = job?.inputSnapshot?.spec
  if (!spec || job.status !== 'succeeded' || !['image', 'audio'].includes(spec.kind)
    || spec.kind !== model?.kind || spec.modelConfigId !== model.id
    || job.inputSnapshot.model.modelId !== model.modelId
    || job.inputSnapshot.model.protocol !== model.protocol) throw new InputError('creation.template_unavailable')
  const references = job.inputSnapshot.references ?? []
  if (spec.promptContent != null || references.some(ref => ref.role !== 'reference'
    || ref.documentVersion || ref.subjectRole || (ref.transmission && ref.transmission !== 'content'))) {
    throw new InputError('creation.template_complex')
  }
  if (spec.kind === 'image' && references.filter(ref => ref.asset.kind === 'image').length > model.maxImages) {
    throw new InputError('creation.reference_limit')
  }
  return { spec, references }
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

function videoChoices(inputRules) {
  const modes = inputRules?.videoModes ?? []
  const caps = inputRules?.videoCapabilities
  const choices = {}
  for (const mode of ['first_frame', 'continuation']) {
    if (!modes.includes(mode)) continue
    if (mode === 'first_frame' && (!inputRules.allowedKinds?.includes('image') || !inputRules.maxImages)) continue
    const resolution = mode === 'first_frame' ? caps?.defaultResolution ?? 'auto' : 'auto'
    const outputs = caps?.outputs.filter(output => resolution === 'auto' || output.resolution === resolution) ?? []
    const durations = [...new Set(outputs.flatMap(output => output.durations))].sort((a, b) => a - b)
    choices[mode] = { durations, resolution, defaultDuration: caps?.defaultDuration ?? null }
  }
  return choices
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

  actionPack(input, { signal } = {}) {
    return this.#actionPackIO(input, signal, actionPackRequest)
  }

  actionPackArchive(input, { signal } = {}) {
    return this.#actionPackIO(input, signal, actionPackArchive)
  }

  #actionPackIO(input, signal, run) {
    const projectId = requireUuid(input.projectId, 'projectId')
    return run({ ...input, projectId }, {
      read: () => this.project(projectId, { signal }),
      models: () => this.creationModels({ signal }),
      receipt: id => this.receipt(projectId, id, { signal }),
      canRetry: canRetryFailedJob,
      media: (assetId, kind) => this.media(projectId, assetId, { kind, original: true, signal }),
      edit: action => this.#withLease(projectId, signal, (session, snapshot) => action(snapshot,
        command => this.#command({ projectId, operationId: command.commandId, command, session, signal }))),
    })
  }

  async listProjects({ signal } = {}) {
    return this.#request('GET', PROJECTS, { signal })
  }

  async project(projectId, { signal } = {}) {
    const id = requireUuid(projectId, 'projectId')
    return this.#request('GET', creationPath(id), { signal })
  }

  async libraryResults(projectId, { kind = 'all', selection = 'all', order = 'newest', query = '', after, signal } = {}) {
    requireEnum(kind, 'kind', ['all', ...Object.keys(MEDIA_TYPES)])
    requireEnum(selection, 'selection', ['all', 'current', 'other'])
    requireEnum(order, 'order', ['newest', 'oldest'])
    const cursor = after == null ? null : requireUuid(after, 'after')
    const snapshot = await this.project(projectId, { signal })
    const search = librarySearch(snapshot, query)
    const specs = new Map(snapshot.generationSpecs.map(spec => [spec.id, spec]))
    const jobs = new Map(snapshot.jobs.map(job => [job.id, job]))
    const detailsFor = resultMediaDetails(snapshot, jobs)
    const versions = resultVersionInfo(snapshot)
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
      const job = jobs.get(jobId)
      const prompt = job?.inputSnapshot?.spec?.prompt ?? ''
      const title = search.title(specId)
      if (!search.matches(prompt, title, job?.inputSnapshot?.model?.modelId, id, jobId, specId)) continue
      const details = detailsFor({ asset, jobId })
      results.push({
        resultId: id,
        specId,
        assetId: asset.assetId,
        kind: asset.kind,
        selected,
        ...(versions.get(id) ?? {}),
        ...(details && { details }), ...(title && { title }),
        prompt: prompt.slice(0, 160),
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

  async libraryJobs(projectId, { kind = 'all', order = 'newest', status = 'all', query = '', after, signal } = {}) {
    requireEnum(kind, 'kind', ['all', ...Object.keys(MEDIA_TYPES)])
    requireEnum(order, 'order', ['newest', 'oldest'])
    const cursor = after == null ? null : requireUuid(after, 'after')
    const snapshot = await this.project(projectId, { signal })
    requireEnum(status, 'status', ['all', 'active', 'succeeded', 'failed', 'cancelled', 'interrupted'])
    const search = librarySearch(snapshot, query)
    const cursorIndex = cursor === null ? null : snapshot.jobs.findIndex(job => job.id === cursor)
    if (cursorIndex === -1) throw new InputError('library.cursor_expired')
    const step = order === 'oldest' ? 1 : -1
    const start = cursorIndex === null ? (step === 1 ? 0 : snapshot.jobs.length - 1) : cursorIndex + step
    const jobs = []
    for (let index = start; index >= 0 && index < snapshot.jobs.length && jobs.length <= LIBRARY_PAGE_SIZE; index += step) {
      const job = snapshot.jobs[index]
      const spec = job.inputSnapshot.spec
      if (!Object.hasOwn(MEDIA_TYPES, spec.kind) || (kind !== 'all' && spec.kind !== kind)) continue
      if (status === 'active' ? !['queued', 'running'].includes(job.status)
        : status !== 'all' && job.status !== status) continue
      const title = search.title(spec.id)
      if (!search.matches(spec.prompt, title, job.inputSnapshot.model.modelId, job.id, spec.id)) continue
      jobs.push({
        jobId: job.id, kind: spec.kind, status: job.status, prompt: spec.prompt.slice(0, 160),
        ...(job.batchId && { groupId: job.batchId }),
        ...(title && { title }),
        modelId: job.inputSnapshot.model.modelId,
      })
    }
    const hasMore = jobs.length > LIBRARY_PAGE_SIZE
    if (hasMore) jobs.pop()
    return { projectId, projectName: snapshot.project.name, canvasUrl: this.canvasUrl(projectId), jobs,
      nextCursor: hasMore ? jobs.at(-1).jobId : null }
  }

  async creationModels({ signal } = {}) {
    const models = await this.models({ signal })
    return models.filter(model => (model.kind === 'image' && model.protocol !== 'vllm_omni_segmentation')
      || (model.kind === 'audio' && !['vllm_omni_music', 'vllm_omni_score'].includes(model.protocol))
      || (model.kind === 'video' && Object.keys(videoChoices(model.inputRules)).length > 0))
      .map(({ id, kind, modelId, protocol, connectionType, inputRules }) => ({
        id, kind, modelId, protocol, connectionType,
        imageOutputs: inputRules?.imageOutputs ?? [],
        maxImages: inputRules?.allowedKinds?.includes('image') ? (inputRules.maxImages ?? 0) : 0,
        voiceRequired: inputRules?.voiceRequired === true,
        maxPromptCharacters: inputRules?.maxPromptCharacters,
        ...(kind === 'video' && { videoChoices: videoChoices(inputRules) }),
      }))
  }

  async compareImages(projectId, resultIds, { signal } = {}) {
    const project = requireUuid(projectId, 'projectId')
    if (!Array.isArray(resultIds) || resultIds.length !== 2) throw new InputError('library.compare')
    const ids = resultIds.map(id => requireUuid(id, 'resultId'))
    if (ids[0] === ids[1]) throw new InputError('library.compare')
    const snapshot = await this.project(project, { signal })
    const specs = new Map(snapshot.generationSpecs.map(spec => [spec.id, spec]))
    const jobs = new Map(snapshot.jobs.map(job => [job.id, job]))
    const results = new Map(snapshot.results.map(result => [result.id, result]))
    const detailsFor = resultMediaDetails(snapshot, jobs)
    const names = librarySearch(snapshot, '')
    const versions = resultVersionInfo(snapshot)
    const images = ids.map(resultId => {
      const result = results.get(resultId)
      if (result?.asset.kind !== 'image') throw new InputError('library.compare')
      return {
        resultId, assetId: result.asset.assetId, kind: 'image', specId: result.specId,
        selected: specs.get(result.specId)?.currentResultId === resultId,
        ...(versions.get(resultId) ?? {}),
        title: names.title(result.specId) ?? '',
        prompt: jobs.get(result.jobId)?.inputSnapshot?.spec?.prompt?.slice(0, 500) ?? '',
        details: detailsFor(result),
      }
    })
    return { projectId: project, canvasUrl: this.canvasUrl(project), images }
  }

  async creationTemplate(projectId, resultId, { signal } = {}) {
    const project = requireUuid(projectId, 'projectId')
    const id = requireUuid(resultId, 'resultId')
    const [snapshot, models] = await Promise.all([this.project(project, { signal }), this.creationModels({ signal })])
    const jobId = snapshot.results.find(item => item.id === id)?.jobId
    const spec = snapshot.jobs.find(job => job.id === jobId)?.inputSnapshot?.spec
    const model = models.find(item => item.id === spec?.modelConfigId)
    const seed = creationSeed(snapshot, id, model)
    return {
      kind: seed.spec.kind, modelConfigId: seed.spec.modelConfigId, prompt: seed.spec.prompt,
      voice: seed.spec.parameters.voice ?? '',
      originalOutput: [seed.spec.parameters.size, seed.spec.parameters.aspectRatio].filter(Boolean).join(' · '),
      references: seed.references.map(({ asset, metadata }) => ({ assetId: asset.assetId, kind: asset.kind, details: mediaDetails(metadata) })),
    }
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
    const versions = resultVersionInfo(snapshot)
    const results = Array.isArray(snapshot?.results)
      ? snapshot.results.filter((item) => item.jobId === job).map(item => ({ ...item, ...versions.get(item.id) }))
      : []
    const detailsFor = resultMediaDetails(snapshot)
    const resultDetails = Object.fromEntries(results.flatMap(result => {
      const details = detailsFor(result)
      return details ? [[result.asset.assetId, details]] : []
    }))
    return {
      job: value, results, projectName: snapshot.project.name,
      ...(Object.keys(resultDetails).length && { resultDetails }),
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
    const cancellation = job.cancelRequested
      ? { cancelRequested: true, remoteCancellation: job.remoteCancellation } : {}
    if (job.status !== 'succeeded') {
      return {
        status: job.status, ...cancellation,
        category: job.errorDetails?.category,
        ...(canRetryFailedJob(job) && { canRetry: true }),
        ...(job.resumeAllowed && ['failed', 'interrupted'].includes(job.status) && { canResume: true }),
      }
    }
    const snapshot = await this.project(project, { signal })
    const specId = job.inputSnapshot.spec.id
    const selected = snapshot.generationSpecs.find(spec => spec.id === specId)?.currentResultId
    const detailsFor = resultMediaDetails(snapshot)
    const versions = resultVersionInfo(snapshot)
    return {
      status: job.status, ...cancellation,
      results: snapshot.results.filter(result => result.specId === specId).map(result => {
        const { id, asset } = result
        const details = detailsFor(result)
        return { resultId: id, assetId: asset.assetId, kind: asset.kind, selected: id === selected,
          ...(versions.get(id) ?? {}),
          ...(details && { details }) }
      }),
    }
  }

  async creationGroupStatus(projectId, groupId, { signal } = {}) {
    const project = requireUuid(projectId, 'projectId')
    const group = requireUuid(groupId, 'groupId')
    const snapshot = await this.project(project, { signal })
    const jobs = snapshot.jobs.filter(job => job.batchId === group)
    if (!jobs.length) throw new InputError('job.missing', { projectId: project, jobId: group })
    const active = jobs.some(job => ['queued', 'running'].includes(job.status))
    const done = jobs.filter(job => job.status === 'succeeded').length
    const failed = jobs.filter(job => ['failed', 'interrupted'].includes(job.status)).length
    const status = active ? 'running' : done ? 'succeeded'
      : jobs.every(job => job.status === 'cancelled') ? 'cancelled' : 'failed'
    const ids = new Set(jobs.map(job => job.id))
    const selected = new Set(snapshot.generationSpecs.map(spec => spec.currentResultId))
    const detailsFor = resultMediaDetails(snapshot)
    const versions = resultVersionInfo(snapshot)
    return {
      groupId: group, status, completedCount: done, failedCount: failed, totalCount: jobs.length,
      jobs: jobs.map(job => ({ jobId: job.id, status: job.status, cancelRequested: job.cancelRequested,
        remoteCancellation: job.remoteCancellation, category: job.errorDetails?.category })),
      results: snapshot.results.filter(result => ids.has(result.jobId)).map(result => ({
        resultId: result.id, assetId: result.asset.assetId, kind: result.asset.kind, selected: selected.has(result.id),
        ...(versions.get(result.id) ?? {}), details: detailsFor(result),
      })),
    }
  }

  async #startCandidateGroup(input, signal) {
    const projectId = requireUuid(input.projectId, 'projectId')
    const groupId = requireUuid(input.operationId, 'operationId')
    const count = input.candidateCount
    const accepted = []
    let blocked
    for (let index = 0; index < count; index++) {
      const child = uuid5(groupId, 'candidate.' + index)
      let reply = await this.receipt(projectId, uuid5(child, 'creation.submit'), { signal })
      if (!reply && !input.check) {
        try {
          if (index === 0 && input.continueGroup) break
          const { candidateCount, continueGroup, check, ...base } = input
          reply = await this.startCreation(index === 0
            ? { ...base, operationId: child, batchId: groupId }
            : { projectId, operationId: child, repeatJobId: accepted[0], batchId: groupId }, { signal })
        } catch (error) {
          if (error instanceof UnknownOperationError || error instanceof NetworkError || error instanceof RequestTimeoutError
            || error instanceof RequestAbortedError) break
          blocked = error instanceof InputError ? error.key : error instanceof HttpError ? error.code : 'unavailable'
          break
        }
      }
      const jobId = reply?.jobId ?? reply?.jobIds?.[0]
      if (jobId && ['accepted', 'applied', 'noop'].includes(reply.status)) {
        accepted.push(jobId)
      } else if (reply?.status === 'rejected') {
        blocked = reply.code ?? reply.issues?.[0]?.code ?? 'unavailable'
        break
      } else break
    }
    const complete = accepted.length === count || blocked != null
    const firstDraft = input.check && !accepted.length
      ? await this.receipt(projectId, uuid5(uuid5(groupId, 'candidate.0'), 'creation.draft'), { signal }) : null
    return {
      status: blocked ? 'rejected' : complete ? 'accepted' : 'unknown',
      groupId, requestedCount: count, acceptedCount: accepted.length,
      jobId: accepted[0], jobIds: accepted, groupComplete: complete,
      ...(firstDraft?.status === 'applied' && { draftSaved: true }),
      ...(input.projectName != null && { projectCreated: true }),
      ...(blocked && { code: blocked }),
      ...(!complete && accepted.length > 0 && { canContinueGroup: true }),
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

  async #submissionReceipt(projectId, operationId, signal) {
    try {
      return await this.receipt(projectId, operationId, { signal })
    } catch (cause) {
      throw new UnknownOperationError({ projectId, operationId, cause })
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
    const count = input.candidateCount ?? 1
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new InputError('creation.candidate_count')
    if (count > 1) return this.#startCandidateGroup(input, signal)
    if (input.batchId != null) requireUuid(input.batchId, 'batchId')
    const projectId = requireUuid(input.projectId, 'projectId')
    const intent = requireUuid(input.operationId, 'operationId')
    const createId = uuid5(intent, 'creation.draft')
    const submitId = uuid5(intent, 'creation.submit')
    if (input.check === true) {
      const submitted = await this.receipt(projectId, submitId, { signal })
      if (submitted) return { status: submitted.status, jobId: submitted.jobIds?.[0], code: submitted.issues?.[0]?.code,
        ...(input.repeatJobId == null && submitted.status === 'rejected' && { draftSaved: true }),
        ...(input.projectName != null && { projectCreated: true }) }
      if (input.repeatJobId != null) return { status: 'unknown' }
      const draft = await this.receipt(projectId, createId, { signal })
      return draft?.status === 'rejected'
        ? { status: 'rejected', code: draft.issues?.[0]?.code, ...(input.projectName != null && { projectCreated: true }) }
        : { status: 'unknown', draftSaved: draft?.status === 'applied' }
    }
    if (input.repeatJobId != null) {
      return this.#repeatCreation(projectId, submitId, requireUuid(input.repeatJobId, 'repeatJobId'), signal, input.batchId)
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
    const reuseResultId = input.reuseResultId == null ? null : requireUuid(input.reuseResultId, 'reuseResultId')
    if (reuseResultId && (values.length || input.projectName != null || model.kind === 'video')) {
      throw new InputError('creation.template_unavailable')
    }
    const isVideo = model.kind === 'video'
    const video = isVideo && Object.hasOwn(model.videoChoices, input.videoMode) && model.videoChoices[input.videoMode]
    if (isVideo && !video) throw new InputError('creation.video_mode')
    if (isVideo && values.length !== 1) throw new InputError('creation.video_source')
    if (!isVideo && values.length && (model.kind !== 'image' || values.length > model.maxImages)) {
      throw new InputError('creation.reference_limit')
    }
    const sourceIds = values.map(id => requireUuid(id, 'sourceResultIds'))
    if (new Set(sourceIds).size !== sourceIds.length) throw new InputError('creation.references')
    let parameters
    const videoSource = isVideo && resultReference({
      kind: 'video', sourceResultId: sourceIds[0], parameters: { videoMode: input.videoMode },
    })
    if (reuseResultId && (model.kind === 'audio' || input.output == null)) parameters = {}
    else if (model.kind === 'image') {
      parameters = imageOutputParameters(model.imageOutputs, input.output)
    } else if (video) {
      const durationSeconds = input.durationSeconds ?? video.defaultDuration
      if (durationSeconds !== null && !video.durations.includes(durationSeconds)) throw new InputError('creation.video_duration')
      parameters = { videoMode: input.videoMode, resolution: video.resolution, ...(durationSeconds !== null && { durationSeconds }) }
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
    const started = await this.#withLease(projectId, signal, async (session, snapshot) => {
      const existing = snapshot.generationSpecs.some(spec => spec.id === uuid5(createId, 'spec'))
      if (existing) {
        const receipt = await this.#submissionReceipt(projectId, submitId, signal)
        return receipt ? { status: receipt.status, jobId: receipt.jobIds?.[0], code: receipt.issues?.[0]?.code,
          ...(receipt.status === 'rejected' && { draftSaved: true }) }
          : { status: 'unknown', draftSaved: true }
      }
      const seed = reuseResultId ? creationSeed(snapshot, reuseResultId, model) : null
      let references = sourceIds.map((id, order) => {
        const source = snapshot.results.find(result => result.id === id)?.asset
        if (source?.kind !== (videoSource?.kind ?? 'image')) {
          throw new InputError(isVideo ? 'creation.video_source' : 'result.candidate_missing')
        }
        return { binding: 'pinned', role: videoSource?.role ?? 'reference', order, source }
      })
      if (seed) {
        if (model.kind === 'audio' && input.voice != null && input.voice !== (seed.spec.parameters.voice ?? '')) {
          throw new InputError('creation.template_unavailable')
        }
        const inherited = { ...seed.spec.parameters }
        if (model.kind === 'image' && input.output != null) {
          delete inherited.size
          delete inherited.aspectRatio
        }
        parameters = { ...inherited, ...parameters }
        references = seed.references.map((ref, order) => ({
          binding: 'pinned', role: ref.role, order, source: ref.asset,
          ...(ref.sourceVersion && { sourceVersion: ref.sourceVersion }),
        }))
      }
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
        batchId: input.batchId,
      })
      try {
        const accepted = await this.#command({ projectId, operationId: submitId, command: submit, session, signal })
        return { status: accepted.status, jobId: accepted.jobIds?.[0], code: accepted.issues?.[0]?.code, draftSaved: true }
      } catch (error) {
        if (error instanceof HttpError) return { status: 'rejected', code: error.code, draftSaved: true }
        throw error
      }
    }).catch(error => {
      if (input.projectName != null && error instanceof HttpError) return { status: 'rejected', code: error.code }
      if (input.projectName != null && (error instanceof NetworkError || error instanceof RequestTimeoutError)) {
        return { status: 'rejected', code: 'creation.unavailable' }
      }
      throw error
    })
    return input.projectName == null ? started : { ...started, projectCreated: true }
  }

  async #repeatCreation(projectId, submitId, jobId, signal, batchId) {
    return this.#withLease(projectId, signal, async (session, snapshot) => {
      const existing = await this.#submissionReceipt(projectId, submitId, signal)
      if (existing) return { status: existing.status, jobId: existing.jobIds?.[0], code: existing.issues?.[0]?.code }
      const job = snapshot.jobs.find(item => item.id === jobId)
      const spec = snapshot.generationSpecs.find(item => item.id === job?.inputSnapshot?.spec?.id)
      const item = snapshot.canvasItems.find(item => item.id === job?.originItemId)
      const ownGroup = batchId != null && job?.batchId === batchId
      if ((job?.status !== 'succeeded' && !canRetryFailedJob(job) && !(ownGroup && ['queued', 'running'].includes(job?.status)))
        || !spec || !Object.hasOwn(MEDIA_TYPES, spec.kind)
        || item?.binding?.objectRef?.id !== spec.id) {
        throw new InputError('creation.repeat_unavailable')
      }
      if (ownGroup && spec.revision !== job.inputSnapshot.spec.revision) throw new InputError('revision_conflict')
      const command = buildSubmitCommand({
        projectId, operationId: submitId, specId: spec.id, originItemId: item.id, batchId,
        expectedSpecRevision: spec.revision, expectedItemRevision: item.revision,
        ...(job.status === 'failed' && { previousJobId: job.id }),
      })
      const receipt = await this.#command({ projectId, operationId: submitId, command, session, signal })
      return { status: receipt.status, jobId: receipt.jobIds?.[0], code: receipt.issues?.[0]?.code }
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

  async cancelCreation({ projectId, jobId, operationId, check, signal }) {
    const project = requireUuid(projectId, 'projectId')
    const job = requireUuid(jobId, 'jobId')
    const commandId = uuid5(requireUuid(operationId, 'operationId'), 'job.cancel:' + project + ':' + job)
    if (check) return this.receipt(project, commandId, { signal })
    return this.#withLease(project, signal, async (session, snapshot) => {
      const existing = await this.#submissionReceipt(project, commandId, signal)
      if (existing) return existing
      const current = snapshot.jobs.find(item => item.id === job)
      if (!current) throw new InputError('job.missing', { projectId: project, jobId: job })
      if (current.cancelRequested || !['accepted', 'queued', 'running'].includes(current.status)) return { status: 'noop' }
      const command = buildJobCancelCommand({
        projectId: project, jobId: job, operationId: commandId, expectedJobRevision: current.revision,
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
