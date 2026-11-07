/** Model-facing summaries. The canonical value remains available to programs. */
export function renderToolResult(key, value, t, { webPreview = false } = {}) {
  const lines = [t(`render.${key}`)]
  if (value.projectId) lines.push(`${t('summary.project')}: ${value.projectName ?? value.projectId}`)
  const status = value.receipt?.status ?? value.job?.status
  if (status) lines.push(`${t('summary.status')}: ${t(`status.${status}`)}`)
  if (value.receipt?.status === 'rejected') {
    lines.push(...value.receipt.issues.map(issue => `${issue.code}: ${issue.message}`))
  } else if (key === 'submit') {
    lines.push(t('summary.submitted'), ...value.jobIds.map(id => `jobId: ${id}`))
  } else if (key === 'job') {
    lines.push(`jobId: ${value.jobId}`)
    if (value.job?.revision !== undefined) lines.push(`revision: ${value.job.revision}`)
    if (typeof value.job?.cancelRequested === 'boolean') lines.push(`cancelRequested: ${value.job.cancelRequested}`)
    if (value.job?.remoteCancellation != null) lines.push(`remoteCancellation: ${value.job.remoteCancellation}`)
    if (value.registered) {
      lines.push(t(value.adopted ? 'summary.adopted' : 'summary.candidate'))
      for (const result of value.results) {
        lines.push(`resultId: ${result.id}; specId: ${result.specId}`)
        if (result.asset) lines.push(`${t('summary.referenceAsset')}: ${JSON.stringify(result.asset)}`)
      }
      const hasPreview = webPreview && value.results.some(({ asset }) =>
        asset?.kind === 'image' || asset?.kind === 'video')
      lines.push(t(hasPreview ? 'summary.webPreview' : 'summary.canvasPreview'))
    }
    if (value.job.errorDetails?.message) lines.push(value.job.errorDetails.message)
    if (value.job.errorDetails?.suggestion) lines.push(value.job.errorDetails.suggestion)
  } else if (key === 'adoptResult') {
    if (value.receipt?.status === 'applied') lines.push(t('summary.adopted'), t('summary.adoptionComplete'))
    lines.push(`resultId: ${value.resultId}`)
  } else if (key === 'cancel') {
    if (value.receipt?.status === 'applied') lines.push(t('summary.cancelRequested'))
    lines.push(`jobId: ${value.jobId}`)
  } else if (key === 'projects' && value.action === 'list') {
    lines.push(...value.projects.map(project => `- [${project.name}](${project.canvasUrl}) — ${project.id}`))
    lines.push(...value.warnings)
  } else {
    lines.push(JSON.stringify(value))
  }
  if (value.operationId) lines.push(`operationId: ${value.operationId}`)
  if (value.canvasUrl) lines.push(`[${t('summary.openCanvas')}](${value.canvasUrl})`)
  return lines.join('\n')
}
