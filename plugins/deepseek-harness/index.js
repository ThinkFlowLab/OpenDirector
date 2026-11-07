import Schema from '@deepseek-ai/schemastery'
import { OpenDirectorClient } from './src/client.js'
import { resolveConfig } from './src/config.js'
import { ConfigError } from './src/errors.js'
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
}
