import { HttpError, NetworkError, RequestTimeoutError } from './errors.js'

function issue(error) {
  if (error instanceof RequestTimeoutError) return 'timeout'
  if (error instanceof NetworkError) return 'network'
  if (error instanceof HttpError) {
    if ([401, 403].includes(error.status)) return 'access'
    if (error.status === 404) return 'address'
    return 'service'
  }
  return 'response'
}

// Read the configured service only. Return counts, never model credentials,
// project names, provider replies or local file paths.
export async function connectionStatus(client, config, version, { signal } = {}) {
  const results = await Promise.allSettled([
    client.listProjects({ signal }).then(value => {
      if (!Array.isArray(value?.projects)) throw new TypeError('Invalid project catalog')
      return { status: 'ok', count: value.projects.length }
    }),
    client.creationModels({ signal }).then(models => {
      if (!Array.isArray(models)) throw new TypeError('Invalid model catalog')
      return {
        status: 'ok',
        count: models.length,
        capabilities: {
          image: models.filter(model => model.kind === 'image').length,
          imageEdit: models.filter(model => model.kind === 'image' && model.maxImages > 0).length,
          imageToVideo: models.filter(model => model.kind === 'video' && model.videoChoices?.first_frame).length,
          videoContinuation: models.filter(model => model.kind === 'video' && model.videoChoices?.continuation).length,
          voiceover: models.filter(model => model.kind === 'audio').length,
        },
      }
    }),
  ])
  if (signal?.aborted) throw signal.reason
  const [projects, models] = results.map(result => result.status === 'fulfilled'
    ? result.value : { status: issue(result.reason) })
  return {
    version,
    apiUrl: config.baseUrl,
    canvasUrl: config.canvasBaseUrl,
    projects,
    models,
  }
}
