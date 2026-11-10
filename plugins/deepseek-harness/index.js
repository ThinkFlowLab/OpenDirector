import Schema from '@deepseek-ai/schemastery'
import { OpenDirectorClient } from './src/client.js'
import { resolveConfig } from './src/config.js'
import { ConfigError, HttpError, InputError, UnknownOperationError } from './src/errors.js'
import { createMessages } from './src/i18n.js'
import { createOpenDirectorTools } from './src/tools.js'

export const name = 'opendirector'
export const inject = ['tools']

export const Config = Schema.object({
  baseUrl: Schema.string().default('http://127.0.0.1:8000'),
  canvasBaseUrl: Schema.string().default(''),
  locale: Schema.union(['en-US', 'zh-CN']).default('en-US'),
  requestTimeoutMs: Schema.number().default(30000),
})

function isBrowserAction(request) {
  const site = request.headers.get('sec-fetch-site')
  return request.headers.get('x-opendirector-action') === '1' && (!site || site === 'same-origin')
}

async function actionInput(request) {
  const input = await request.json()
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid action')
  return input
}

function errorCode(error) {
  if (error instanceof HttpError) return error.code
  return error instanceof InputError ? error.key : 'unavailable'
}

export function apply(ctx, config) {
  const requestedLocale = config?.locale === 'zh-CN' ? 'zh-CN' : 'en-US'
  const requestedMessages = createMessages(requestedLocale)
  let resolved
  try {
    resolved = resolveConfig(config ?? {})
  } catch (error) {
    if (error instanceof ConfigError) throw new Error(requestedMessages(error.key, error.params))
    throw error
  }
  const messages = createMessages(resolved.locale)
  const client = new OpenDirectorClient(resolved)
  for (const tool of createOpenDirectorTools({ client, t: messages, hasWebPreview: () => Boolean(ctx.get('webServer')) })) {
    ctx.tools.register(tool)
  }
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/opendirector/media',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        let searchParams
        try {
          ({ searchParams } = new URL(request.url, 'http://localhost'))
        } catch {
          return new Response(null, { status: 400 })
        }
        try {
          const media = await client.media(
            searchParams.get('project'), searchParams.get('asset'), {
              kind: searchParams.get('kind'), original: searchParams.get('original') === '1',
              range: request.headers.get('range'), signal: request.signal,
            },
          )
          const headers = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
          for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
            const value = media.headers.get(name)
            if (value !== null) headers.set(name, value)
          }
          return new Response(media.body, { status: media.status, headers })
        } catch (error) {
          const status = error instanceof InputError ? 400
            : error instanceof HttpError && error.status === 404 ? 404
              : 502
          return new Response(null, { status })
        }
      },
    }), 'OpenDirector media previews')

    const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/opendirector/library',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const params = new URL(request.url, 'http://localhost').searchParams
          const projectId = params.get('project')
          if (projectId !== null) {
            const library = await client.libraryResults(projectId, {
              kind: params.get('kind') ?? undefined, selection: params.get('selection') ?? undefined,
              order: params.get('order') ?? undefined, after: params.get('after'), signal: request.signal,
            })
            return Response.json(library, { headers })
          }
          const value = await client.listProjects({ signal: request.signal })
          const projects = value.projects.map(({ id, name }) => ({ id, name }))
          return Response.json({ projects }, { headers })
        } catch (error) {
          const status = error instanceof InputError ? (error.key === 'library.cursor_expired' ? 409 : 400)
            : error instanceof HttpError && error.status === 404 ? 404
              : 502
          return new Response(null, { status, headers })
        }
      },
    }), 'OpenDirector project library')

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/opendirector/adopt',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        // The DSH connection authenticates the request. Require a same-origin
        // browser action as well, so a cross-origin form cannot adopt a result.
        if (!isBrowserAction(request)) {
          return new Response(null, { status: 403, headers })
        }
        let input
        try {
          input = await actionInput(request)
        } catch {
          return new Response(null, { status: 400, headers })
        }
        const { projectId, resultId, operationId } = input
        const check = input.check === true
        try {
          const receipt = await client.adoptCandidate({
            projectId, resultId, operationId, check, signal: request.signal,
          })
          return Response.json({
            status: receipt?.status ?? 'unknown',
            code: receipt?.issues?.[0]?.code,
            canvasUrl: client.canvasUrl(projectId),
          }, { headers })
        } catch (error) {
          if (error instanceof UnknownOperationError || (check && !(error instanceof InputError))) {
            return Response.json({ status: 'unknown' }, { headers })
          }
          return Response.json({ status: 'rejected', code: errorCode(error) }, { headers })
        }
      },
    }), 'OpenDirector result adoption')

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/opendirector/creation',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method === 'GET') {
          try {
            const params = new URL(request.url, 'http://localhost').searchParams
            const { signal } = request
            const value = params.has('job')
              ? await client.creationStatus(params.get('project'), params.get('job'), { signal })
              : { models: await client.creationModels({ signal }) }
            return Response.json(value, { headers })
          } catch (error) {
            return new Response(null, { status: error instanceof InputError ? 400 : 502, headers })
          }
        }
        if (!isBrowserAction(request)) return new Response(null, { status: 403, headers })
        let input
        try {
          input = await actionInput(request)
        } catch {
          return new Response(null, { status: 400, headers })
        }
        try {
          const value = await client.startCreation(input, { signal: request.signal })
          return Response.json({ ...value, canvasUrl: client.canvasUrl(input.projectId) }, { headers })
        } catch (error) {
          const unknown = error instanceof UnknownOperationError || (input.check === true && !(error instanceof InputError))
          return Response.json(unknown ? { status: 'unknown' }
            : { status: 'rejected', code: errorCode(error) }, { headers })
        }
      },
    }), 'OpenDirector creation controls')
  })
}
