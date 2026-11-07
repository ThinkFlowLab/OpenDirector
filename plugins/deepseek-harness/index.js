import Schema from '@deepseek-ai/schemastery'
import { OpenDirectorClient } from './src/client.js'
import { resolveConfig } from './src/config.js'
import { ConfigError, HttpError, InputError } from './src/errors.js'
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
  for (const tool of createOpenDirectorTools({ client, t: messages })) {
    ctx.tools.register(tool)
  }
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/opendirector/media',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const { searchParams } = new URL(request.url)
        try {
          const media = await client.media(
            searchParams.get('project'), searchParams.get('asset'), {
              kind: searchParams.get('kind'), range: request.headers.get('range'), signal: request.signal,
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
  })
}
