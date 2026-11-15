const TITLE_LIMIT = 160

function validTime(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))
    ? value
    : undefined
}

function identityKey(asset) {
  if (!asset || typeof asset.assetId !== 'string' || !Number.isInteger(asset.revision)
    || typeof asset.fingerprint !== 'string') return undefined
  return JSON.stringify([asset.assetId, asset.revision, asset.fingerprint])
}

function referenceSourceAsset(job) {
  const references = job?.inputSnapshot?.references
  if (!Array.isArray(references)) return undefined
  const continuation = references.find(reference => reference?.role === 'continuation')
  const firstFrame = references.find(reference => reference?.role === 'first_frame')
  const image = references.find(reference => reference?.asset?.kind === 'image')
  return (continuation ?? firstFrame ?? image)?.asset
}

function titlesBySpec(snapshot) {
  const titles = new Map()
  for (const item of snapshot?.canvasItems ?? []) {
    if (item?.binding?.role !== 'generation') continue
    const specId = item.binding.objectRef?.id
    if (typeof specId !== 'string' || titles.has(specId)) continue
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (title) titles.set(specId, title.slice(0, TITLE_LIMIT))
  }
  return titles
}

/**
 * Build the read-only version metadata for registered results.
 *
 * Versions come from each spec's results in snapshot registration order, so
 * paging and filtering never renumber them. A source is reported only when a
 * frozen reference asset identity matches exactly one result registered before
 * the current one; a shared fingerprint alone is not evidence of provenance.
 */
export function resultVersionInfo(snapshot) {
  const results = Array.isArray(snapshot?.results) ? snapshot.results : []
  const jobs = new Map((snapshot?.jobs ?? []).map(job => [job.id, job]))
  const titles = titlesBySpec(snapshot)
  const counts = new Map()
  const seenIdentities = new Map()
  const info = new Map()

  for (const result of results) {
    const version = (counts.get(result.specId) ?? 0) + 1
    counts.set(result.specId, version)
    const job = jobs.get(result.jobId)
    const createdAt = validTime(job?.createdAt)
    const key = identityKey(referenceSourceAsset(job))
    let source
    if (key !== undefined) {
      const prior = seenIdentities.get(key)
      if (prior?.length === 1) source = prior[0]
    }
    info.set(result.id, {
      version,
      ...(createdAt !== undefined && { createdAt }),
      ...(source && { sourceResultId: source.result.id, sourceVersion: source.version }),
      ...(source && titles.has(source.result.specId) && { sourceTitle: titles.get(source.result.specId) }),
    })
    const own = identityKey(result.asset)
    if (own !== undefined) {
      const registered = seenIdentities.get(own)
      if (registered) registered.push({ result, version })
      else seenIdentities.set(own, [{ result, version }])
    }
  }

  return info
}
