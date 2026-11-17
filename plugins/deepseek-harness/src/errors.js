export class ConfigError extends Error {
  constructor(key, params = {}) {
    super(key)
    this.name = 'ConfigError'
    this.key = key
    this.params = params
  }
}

export class InputError extends Error {
  constructor(key, params = {}) {
    super(key)
    this.name = 'InputError'
    this.key = key
    this.params = params
  }
}

export class HttpError extends Error {
  constructor({ status, code, detail, body, location, cause }) {
    super(detail || `HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.detail = detail
    this.body = body
    this.location = location
    this.cause = cause
  }
}

export class RequestAbortedError extends Error {
  constructor(cause) {
    super('request aborted')
    this.name = 'RequestAbortedError'
    this.cause = cause
  }
}

export class RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`request timed out after ${timeoutMs}ms`)
    this.name = 'RequestTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class NetworkError extends Error {
  constructor(url, cause) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'NetworkError'
    this.url = url
    this.cause = cause
  }
}

export class UnknownOperationError extends Error {
  constructor({ projectId, operationId, cause }) {
    super(`unknown write outcome for operation ${operationId} in project ${projectId}; call opendirector_operation before retrying and do not resend with a new operationId`)
    this.name = 'UnknownOperationError'
    this.projectId = projectId
    this.operationId = operationId
    this.cause = cause
  }
}
