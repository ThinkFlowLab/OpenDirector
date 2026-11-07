/** Model-facing summaries. The canonical value remains available to programs. */
export function renderToolResult(key, value, t) {
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
    if (value.registered) {
      lines.push(t(value.adopted ? 'summary.adopted' : 'summary.candidate'))
      lines.push(...value.results.map(result => `resultId: ${result.id}; specId: ${result.specId}`))
    }
    if (value.job.errorDetails?.message) lines.push(value.job.errorDetails.message)
  } else if (key === 'adoptResult') {
    lines.push(t('summary.adopted'), `resultId: ${value.resultId}`)
  } else if (key === 'cancel') {
    lines.push(t('summary.cancelRequested'), `jobId: ${value.jobId}`)
  } else if (key === 'projects' && value.action === 'list') {
    lines.push(...value.projects.map(project => `- [${project.name}](${project.canvasUrl}) — ${project.id}`))
    lines.push(...value.warnings)
  } else {
    lines.push(JSON.stringify(value, null, 2))
  }
  if (value.operationId) lines.push(`operationId: ${value.operationId}`)
  if (value.canvasUrl) lines.push(`[${t('summary.openCanvas')}](${value.canvasUrl})`)
  return lines.join('\n')
}
