import { ConfigError } from './errors.js'

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000'
export const SUPPORTED_LOCALES = ['en-US', 'zh-CN']

export function normalizeUrl(value, field) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) throw new ConfigError('config.required', { field })
  if (/\s/.test(raw)) throw new ConfigError('config.urlInvalid', { field })
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError('config.urlInvalid', { field })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('config.urlScheme', { field })
  }
  if (url.username || url.password) {
    throw new ConfigError('config.urlCredentials', { field })
  }
  if (url.search || url.hash) {
    throw new ConfigError('config.urlQuery', { field })
  }
  if (!url.hostname) throw new ConfigError('config.urlInvalid', { field })
  if (/[?#]/.test(raw)) throw new ConfigError('config.urlQuery', { field })
  return raw.replace(/\/+$/, '')
}

export function resolveConfig(input = {}) {
  const baseUrl = normalizeUrl(input.baseUrl ?? DEFAULT_BASE_URL, 'baseUrl')
  const canvasBaseUrl = normalizeUrl(
    input.canvasBaseUrl == null || input.canvasBaseUrl === '' ? baseUrl : input.canvasBaseUrl,
    'canvasBaseUrl',
  )
  const locale = input.locale ?? 'en-US'
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw new ConfigError('config.locale', { value: String(locale) })
  }
  const requestTimeoutMs = input.requestTimeoutMs ?? 30000
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new ConfigError('config.timeout', { value: String(requestTimeoutMs) })
  }
  return { baseUrl, canvasBaseUrl, locale, requestTimeoutMs }
}
