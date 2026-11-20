import { buildCreateGeneration, buildSubmitCommand, imageOutputParameters, requireUuid, requireString, uuid5 } from './operations.js'
import { InputError, UnknownOperationError } from './errors.js'
import { mediaDetails } from './presentation.js'
import { resultVersionInfo } from './versions.js'

const TAG = 'dsh-action-pack'
const LIMIT = 128 * 1024 * 1024
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' }

function packNodes(snapshot, packId) {
  const group = snapshot.canvasItems.find(item => item.id === packId && item.kind === 'group' && item.tags?.includes(TAG))
  if (!group) throw new InputError('pack.missing')
  const specs = new Map(snapshot.generationSpecs.map(spec => [spec.id, spec]))
  const nodes = snapshot.canvasItems.filter(item => item.parentId === packId
    && item.binding?.role === 'generation' && ['image', 'video'].includes(item.kind)
    && specs.has(item.binding.objectRef?.id))
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id))
  return { group, nodes, specs }
}

export function packState(snapshot, packId, canRetry) {
  const { group, nodes, specs } = packNodes(snapshot, packId)
  const metadata = new Map((snapshot.assets ?? []).map(asset => [asset.id, asset.metadata]))
  const versions = resultVersionInfo(snapshot)
  const actions = nodes.map(item => {
    const spec = specs.get(item.binding.objectRef.id)
    const jobs = snapshot.jobs.filter(job => job.inputSnapshot.spec.id === spec.id)
    const active = jobs.find(job => ['queued', 'running'].includes(job.status))
    const latest = jobs.at(-1)
    const results = snapshot.results.filter(result => result.specId === spec.id).map(result => ({
      resultId: result.id, assetId: result.asset.assetId, kind: result.asset.kind,
      selected: result.id === spec.currentResultId,
      ...(versions.get(result.id) ?? {}),
      details: mediaDetails(metadata.get(result.asset.assetId)),
    }))
    const reference = snapshot.references.find(ref => ref.targetSpecId === spec.id && ref.active !== false && ref.source?.assetId)
    return {
      itemId: item.id, specId: spec.id, name: item.title || spec.kind, prompt: spec.prompt, kind: spec.kind,
      revision: spec.revision, selectedResultId: spec.currentResultId,
      status: active?.status ?? latest?.status ?? 'not_started',
      jobs: jobs.map(job => ({ jobId: job.id, status: job.status, category: job.errorDetails?.category,
        cancelRequested: job.cancelRequested, remoteCancellation: job.remoteCancellation })),
      canRevise: !active,
      canGenerate: !active && (!latest || latest.status === 'succeeded' || canRetry(latest)),
      results,
      ...(reference && { reference: { assetId: reference.source.assetId, kind: reference.source.kind,
        details: mediaDetails(metadata.get(reference.source.assetId)) } }),
    }
  })
  return { projectId: snapshot.project.id, projectName: snapshot.project.name, packId, title: group.title,
    actions, selectedCount: actions.filter(action => action.selectedResultId && action.results.some(r => r.selected)).length,
    active: actions.some(action => ['queued', 'running'].includes(action.status)),
    missingCount: actions.filter(action => !action.jobs.length).length }
}

function validatePlan(input) {
  const title = requireString(input.title, 'title').trim()
  const shared = typeof input.sharedPrompt === 'string' ? input.sharedPrompt.trim() : ''
  if (!title || title.length > 100 || shared.length > 4000 || !Array.isArray(input.actions)
    || input.actions.length < 1 || input.actions.length > 6) throw new InputError('pack.plan')
  const names = new Set()
  const actions = input.actions.map(value => {
    const name = typeof value?.name === 'string' ? value.name.trim() : ''
    const prompt = typeof value?.prompt === 'string' ? value.prompt.trim() : ''
    const key = name.normalize('NFKC').toLowerCase()
    if (!name || name.length > 80 || !prompt || prompt.length > 4000 || names.has(key)) throw new InputError('pack.plan')
    names.add(key)
    return { name, prompt: [shared, prompt].filter(Boolean).join('\n\n') }
  })
  return { title, actions }
}

function packItemIds(input) {
  if (!Array.isArray(input.itemIds) || !input.itemIds.length || input.itemIds.length > 6) throw new InputError('pack.plan')
  const ids = input.itemIds.map(id => requireUuid(id, 'itemIds'))
  if (new Set(ids).size !== ids.length) throw new InputError('pack.plan')
  return ids
}

export async function actionPackRequest(input, io) {
  const action = input.action ?? 'get'
  if (!['list', 'get', 'check', 'prepare', 'generate', 'revise'].includes(action)) throw new InputError('pack.action')
  if (input.redo != null && typeof input.redo !== 'boolean') throw new InputError('pack.plan')
  if (action === 'list') {
    const snapshot = await io.read()
    const packs = snapshot.canvasItems.filter(item => item.kind === 'group' && item.tags?.includes(TAG))
      .map(item => ({ packId: item.id, title: item.title, actionCount: 0, selectedCount: 0 }))
    const groups = new Map(packs.map(pack => [pack.packId, pack]))
    const specs = new Map(snapshot.generationSpecs.map(spec => [spec.id, spec]))
    const results = new Map(snapshot.results.map(result => [result.id, result]))
    for (const item of snapshot.canvasItems) {
      const group = groups.get(item.parentId)
      const spec = item.binding?.role === 'generation' && specs.get(item.binding.objectRef?.id)
      if (!group || !spec || !['image', 'video'].includes(item.kind)) continue
      group.actionCount++
      if (results.get(spec.currentResultId)?.specId === spec.id) group.selectedCount++
    }
    return { projectId: input.projectId, packs }
  }
  const operationId = input.operationId == null ? null : requireUuid(input.operationId, 'operationId')
  if (input.packId == null && !operationId) throw new InputError('input.uuid', { field: 'packId' })
  const packId = action === 'prepare' || input.packId == null ? uuid5(operationId, 'action-pack') : requireUuid(input.packId, 'packId')
  if (action === 'get' || action === 'check') {
    const snapshot = await io.read()
    const exists = snapshot.canvasItems.some(item => item.id === packId && item.tags?.includes(TAG))
    if (!exists && action === 'check') return { status: 'unknown', projectId: input.projectId, packId, found: false }
    let status = 'applied', code
    if (action === 'check' && ['generate', 'revise'].includes(input.packAction)) {
      const ids = packItemIds(input)
      const receipts = await Promise.all(ids.map(id => io.receipt(uuid5(operationId, (input.packAction === 'revise' ? 'action.revise:' : 'action:') + id))))
      const rejected = receipts.find(receipt => receipt?.status === 'rejected')
      status = rejected ? 'rejected' : receipts.every(receipt => ['accepted', 'applied', 'noop'].includes(receipt?.status)) ? 'applied' : 'unknown'
      code = rejected?.issues?.[0]?.code
    }
    return { ...packState(snapshot, packId, io.canRetry), status, found: true, ...(code && { code }) }
  }
  if (!operationId) throw new InputError('input.uuid', { field: 'operationId' })
  if (action === 'prepare') {
    const prior = await io.receipt(uuid5(operationId, 'pack.prepare'))
    if (prior) return { status: prior.status, packId, code: prior.issues?.[0]?.code }
    const plan = validatePlan(input)
    const models = await io.models()
    const model = models.find(model => model.id === input.modelConfigId)
    if (!model || !['image', 'video'].includes(model.kind)
      || (model.kind === 'image' ? !(model.maxImages >= 1) : !model.videoChoices?.first_frame)) throw new InputError('pack.model')
    let parameters
    if (model.kind === 'image') {
      parameters = imageOutputParameters(model.imageOutputs, input.output)
    } else {
      const video = model.videoChoices.first_frame
      const durationSeconds = input.durationSeconds ?? video.defaultDuration
      if (durationSeconds != null && !video.durations.includes(durationSeconds)) throw new InputError('creation.video_duration')
      parameters = { videoMode: 'first_frame', resolution: video.resolution,
        ...(durationSeconds != null && { durationSeconds }) }
    }
    if (plan.actions.some(action => Array.from(action.prompt).length > Math.min(model.maxPromptCharacters ?? 20000, 20000))) {
      throw new InputError('pack.plan')
    }
    return io.edit(async (snapshot, execute) => {
      if (snapshot.canvasItems.some(item => item.id === packId)) return { status: 'noop', packId }
      const source = snapshot.results.find(result => result.id === input.sourceResultId)?.asset
      if (source?.kind !== 'image') throw new InputError('result.candidate_missing')
      const right = snapshot.canvasItems.filter(item => item.parentId == null)
        .reduce((x, item) => Math.max(x, item.position.x + item.width + 48), 0)
      const operations = [{ type: 'canvas.show', payload: { item: {
        id: packId, projectId: input.projectId, kind: 'group', title: plan.title, tags: [TAG],
        position: { x: right, y: 0 }, width: 1184, height: Math.ceil(plan.actions.length / 3) * 340 + 64,
        binding: { role: 'container' },
      } } }]
      plan.actions.forEach((action, index) => {
        const { command } = buildCreateGeneration({
          projectId: input.projectId, operationId: uuid5(operationId, 'action.' + index),
          kind: model.kind, modelConfigId: model.id, prompt: action.prompt, parameters,
          position: { x: 24 + (index % 3) * 384, y: 48 + Math.floor(index / 3) * 340 },
          references: [{ binding: 'pinned', role: model.kind === 'video' ? 'first_frame' : 'reference', order: 0, source }],
        })
        const { spec, item, references } = command.payload
        item.parentId = packId
        item.title = action.name
        operations.push({ type: 'generationSpec.create', payload: { spec } },
          { type: 'canvas.show', payload: { item } },
          ...references.map(reference => ({ type: 'reference.add', payload: { reference } })))
      })
      const receipt = await execute({ commandId: uuid5(operationId, 'pack.prepare'), projectId: input.projectId,
        type: 'creation.batch', expectedVersions: [], payload: { operations } })
      return { status: receipt.status, packId, code: receipt.issues?.[0]?.code }
    })
  }
  if (action === 'revise') {
    const itemId = requireUuid(input.itemId, 'itemId')
    const commandId = uuid5(operationId, 'action.revise:' + itemId)
    const prior = await io.receipt(commandId)
    if (prior) return { status: prior.status, packId, code: prior.issues?.[0]?.code }
    const prompt = requireString(input.prompt, 'prompt').trim()
    if (!prompt || Array.from(prompt).length > 20000) throw new InputError('pack.plan')
    if (!Number.isInteger(input.expectedSpecRevision) || input.expectedSpecRevision < 1) {
      throw new InputError('input.positiveInteger', { field: 'expectedSpecRevision' })
    }
    return io.edit(async (snapshot, execute) => {
      const { nodes, specs } = packNodes(snapshot, packId)
      const item = nodes.find(item => item.id === itemId)
      if (!item) throw new InputError('pack.missing')
      const spec = specs.get(item.binding.objectRef.id)
      if (spec.revision !== input.expectedSpecRevision) throw new InputError('revision_conflict')
      if (snapshot.jobs.some(job => job.inputSnapshot.spec.id === spec.id && ['queued', 'running'].includes(job.status))) {
        throw new InputError('pack.active')
      }
      const receipt = await execute({ commandId, projectId: input.projectId, type: 'generationSpec.update',
        expectedVersions: [{ objectType: 'generation_spec', id: spec.id, revision: spec.revision }],
        payload: { spec: { ...spec, prompt } } })
      return { status: receipt.status, packId, code: receipt.issues?.[0]?.code }
    })
  }
  if (action !== 'generate') throw new InputError('pack.action')
  return io.edit(async (snapshot, execute) => {
    const { nodes, specs } = packNodes(snapshot, packId)
    const selected = packItemIds(input)
    if (selected.some(id => !nodes.some(item => item.id === id))) throw new InputError('pack.missing')
    const accepted = []
    let blocked, uncertain = false
    for (const item of nodes) {
      if (!selected.includes(item.id)) continue
      const commandId = uuid5(operationId, 'action:' + item.id)
      let prior
      try { prior = await io.receipt(commandId) }
      catch { uncertain = true; break }
      if (prior) {
        if (['accepted', 'applied', 'noop'].includes(prior.status)) accepted.push(...(prior.jobIds ?? []))
        else if (prior.status === 'rejected') { blocked = prior.issues?.[0]?.code; break }
        continue
      }
      const spec = specs.get(item.binding.objectRef.id)
      const jobs = snapshot.jobs.filter(job => job.inputSnapshot.spec.id === spec.id)
      const latest = jobs.at(-1)
      if (jobs.some(job => ['queued', 'running'].includes(job.status))) continue
      if (latest && (!input.redo || (latest.status !== 'succeeded' && !io.canRetry(latest)))) continue
      const command = buildSubmitCommand({ projectId: input.projectId, operationId: commandId,
        specId: spec.id, originItemId: item.id, expectedSpecRevision: spec.revision,
        expectedItemRevision: item.revision,
        ...(latest && io.canRetry(latest) && { previousJobId: latest.id }) })
      try {
        const receipt = await execute(command)
        if (receipt.status === 'accepted') accepted.push(...receipt.jobIds)
        else { blocked = receipt.issues?.[0]?.code ?? 'unavailable'; break }
      } catch (error) {
        if (!(error instanceof UnknownOperationError)) throw error
        uncertain = true
        break
      }
    }
    return { status: uncertain ? 'unknown' : blocked ? 'rejected' : 'accepted',
      packId, jobIds: accepted, ...(blocked && { code: blocked }) }
  })
}

export async function actionPackArchive(input, io) {
  const snapshot = await io.read()
  const pack = packState(snapshot, input.packId, io.canRetry)
  if (!pack.actions.length || pack.selectedCount !== pack.actions.length) throw new InputError('pack.incomplete')
  const assets = new Map(snapshot.assets.map(asset => [asset.id, asset]))
  const files = pack.actions.map((action, index) => {
    const result = snapshot.results.find(result => result.id === action.selectedResultId && result.specId === action.specId)
    const asset = result && assets.get(result.asset.assetId)
    const extension = EXTENSIONS[asset?.metadata?.mimeType]
    if (!asset || !extension) throw new InputError('pack.export')
    const safeName = action.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 60).replace(/[ .]+$/g, '') || 'action'
    const filename = String(index + 1).padStart(2, '0') + '-' + safeName + '.' + extension
    const job = snapshot.jobs.find(job => job.id === result.jobId)
    return { filename, assetId: asset.id, size: asset.metadata.size, kind: asset.kind,
      manifest: { name: action.name, file: filename, resultId: result.id, jobId: result.jobId,
        description: job?.inputSnapshot?.spec?.prompt ?? action.prompt,
        model: job?.inputSnapshot?.model?.modelId, fingerprint: asset.fingerprint } }
  })
  const manifest = { version: 1, project: pack.projectName, pack: pack.title,
    actions: files.map(file => file.manifest) }
  const description = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n')
  if (description.length + files.reduce((sum, file) => sum + (file.size ?? 0), 0) > LIMIT) throw new InputError('pack.too_large')
  async function* entries() {
    yield { name: 'manifest.json', data: description }
    for (const file of files) {
      const media = await io.media(file.assetId, file.kind)
      yield { name: file.filename, data: media.body }
    }
  }
  return { entries: entries(), filename: 'action-pack-' + input.packId.slice(0, 8) + '.zip', maxBytes: LIMIT }
}
