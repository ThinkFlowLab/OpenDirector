import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { OpenDirectorClient } from '../src/client.js'
import { resultVersionInfo } from '../src/versions.js'

function asset(assetId, revision, fingerprint, kind = 'image') {
  return { assetId, revision, fingerprint, kind }
}

function result(specId, jobId, value) {
  return { id: randomUUID(), specId, jobId, asset: value }
}

test('video cards use the source job’s continuation modes and keep older results actionable', () => {
  const modes = [['first_frame', 'reference'], ['first_frame', 'continuation'], undefined]
  const jobs = modes.map(videoModes => ({ id: randomUUID(), inputSnapshot: { model: { inputRules: { videoModes } } } }))
  const results = jobs.map(job => result(randomUUID(), job.id, asset(randomUUID(), 1, 'a'.repeat(64), 'video')))
  const info = resultVersionInfo({ results, jobs })
  assert.deepEqual(results.map(row => info.get(row.id).supportsContinuation), [false, true, undefined])
})

test('versions follow each spec registration order and accept only valid createdAt strings', () => {
  const specA = randomUUID(), specB = randomUUID()
  const jobA1 = randomUUID(), jobA2 = randomUUID(), jobB = randomUUID(), jobC = randomUUID()
  const a1 = result(specA, jobA1, asset(randomUUID(), 1, 'a'.repeat(64)))
  const b1 = result(specB, jobB, asset(randomUUID(), 1, 'b'.repeat(64)))
  const a2 = result(specA, jobA2, asset(randomUUID(), 1, 'c'.repeat(64)))
  const snapshot = {
    results: [a1, b1, a2],
    jobs: [
      { id: jobA1, createdAt: '2025-01-02T03:04:05.000Z' },
      { id: jobB, createdAt: 'not a date' },
      { id: jobA2, createdAt: 42 },
      { id: jobC, createdAt: '' },
    ],
    canvasItems: [],
  }
  const info = resultVersionInfo(snapshot)
  assert.deepEqual(info.get(a1.id), { version: 1, createdAt: '2025-01-02T03:04:05.000Z' })
  assert.deepEqual(info.get(b1.id), { version: 1 })
  assert.deepEqual(info.get(a2.id), { version: 2 })
})

test('a source is reported only for one exact frozen reference match, preferring continuation then first_frame', () => {
  const sourceA = randomUUID(), sourceB = randomUUID(), target = randomUUID()
  const assetA = asset(randomUUID(), 3, 'a'.repeat(64))
  const assetB = asset(randomUUID(), 1, 'b'.repeat(64))
  const oldA = result(sourceA, randomUUID(), assetA)
  const oldB = result(sourceB, randomUUID(), assetB)
  const titleA = 'A'.repeat(200)
  const job = references => ({ id: randomUUID(), inputSnapshot: { references } })
  const continuation = result(target, randomUUID(), asset(randomUUID(), 1, 'c'.repeat(64)))
  continuation.jobId = job([{ role: 'reference', asset: assetB }, { role: 'continuation', asset: assetA }]).id
  const firstFrame = result(target, randomUUID(), asset(randomUUID(), 1, 'd'.repeat(64)))
  firstFrame.jobId = job([{ role: 'first_frame', asset: assetB }, { role: 'reference', asset: assetA }]).id
  const imageFallback = result(target, randomUUID(), asset(randomUUID(), 1, 'e'.repeat(64)))
  imageFallback.jobId = job([{ role: 'reference', asset: assetB }]).id
  const both = result(target, randomUUID(), asset(randomUUID(), 1, 'f'.repeat(64)))
  both.jobId = job([{ role: 'first_frame', asset: assetB }, { role: 'continuation', asset: assetA }]).id
  const snapshot = {
    results: [oldA, oldB, continuation, firstFrame, imageFallback, both],
    jobs: [
      { id: oldA.jobId }, { id: oldB.jobId },
      { id: continuation.jobId, inputSnapshot: { references: [{ role: 'reference', asset: assetB }, { role: 'continuation', asset: assetA }] } },
      { id: firstFrame.jobId, inputSnapshot: { references: [{ role: 'first_frame', asset: assetB }, { role: 'reference', asset: assetA }] } },
      { id: imageFallback.jobId, inputSnapshot: { references: [{ role: 'reference', asset: assetB }] } },
      { id: both.jobId, inputSnapshot: { references: [{ role: 'first_frame', asset: assetB }, { role: 'continuation', asset: assetA }] } },
    ],
    canvasItems: [
      { title: titleA, binding: { role: 'generation', objectRef: { id: sourceA } } },
      { title: 'Source B', binding: { role: 'generation', objectRef: { id: sourceB } } },
    ],
  }
  const info = resultVersionInfo(snapshot)
  assert.deepEqual(info.get(oldA.id), { version: 1 })
  assert.deepEqual(info.get(oldB.id), { version: 1 })
  assert.deepEqual(info.get(continuation.id), {
    version: 1, sourceResultId: oldA.id, sourceVersion: 1, sourceTitle: titleA.slice(0, 160),
  })
  assert.deepEqual(info.get(firstFrame.id), {
    version: 2, sourceResultId: oldB.id, sourceVersion: 1, sourceTitle: 'Source B',
  })
  assert.deepEqual(info.get(imageFallback.id), {
    version: 3, sourceResultId: oldB.id, sourceVersion: 1, sourceTitle: 'Source B',
  })
  assert.deepEqual(info.get(both.id), {
    version: 4, sourceResultId: oldA.id, sourceVersion: 1, sourceTitle: titleA.slice(0, 160),
  })
})

test('ambiguous, incomplete, fingerprint-only and later matches never claim a source', () => {
  const sourceA = randomUUID(), sourceB = randomUUID(), target = randomUUID()
  const shared = asset(randomUUID(), 1, 'a'.repeat(64))
  const first = result(sourceA, randomUUID(), { ...shared })
  const duplicate = result(sourceB, randomUUID(), { ...shared })
  const fingerprintOnly = result(sourceA, randomUUID(), asset(randomUUID(), 1, 'b'.repeat(64)))
  const newDuplicate = result(target, randomUUID(), asset(randomUUID(), 1, 'c'.repeat(64)))
  const newFingerprint = result(target, randomUUID(), asset(randomUUID(), 1, 'd'.repeat(64)))
  const newMissing = result(target, randomUUID(), asset(randomUUID(), 1, 'e'.repeat(64)))
  const laterAsset = asset(randomUUID(), 1, 'f'.repeat(64))
  const newLater = result(target, randomUUID(), asset(randomUUID(), 1, '0'.repeat(64)))
  const later = result(sourceB, randomUUID(), laterAsset)
  const snapshot = {
    results: [first, duplicate, fingerprintOnly, newDuplicate, newFingerprint, newMissing, newLater, later],
    jobs: [
      { id: first.jobId }, { id: duplicate.jobId }, { id: fingerprintOnly.jobId },
      { id: newDuplicate.jobId, inputSnapshot: { references: [{ role: 'continuation', asset: shared }] } },
      { id: newFingerprint.jobId, inputSnapshot: { references: [{ role: 'first_frame',
        asset: { assetId: randomUUID(), revision: 1, fingerprint: fingerprintOnly.asset.fingerprint, kind: 'image' } }] } },
      { id: newMissing.jobId, inputSnapshot: { references: [{ role: 'reference',
        asset: { assetId: fingerprintOnly.asset.assetId, fingerprint: fingerprintOnly.asset.fingerprint, kind: 'image' } }] } },
      { id: newLater.jobId, inputSnapshot: { references: [{ role: 'first_frame', asset: laterAsset }] } },
      { id: later.jobId },
    ],
    canvasItems: [],
  }
  const info = resultVersionInfo(snapshot)
  for (const entry of [newDuplicate, newFingerprint, newMissing, newLater]) {
    assert.equal(info.get(entry.id).sourceResultId, undefined)
    assert.equal(info.get(entry.id).sourceVersion, undefined)
    assert.equal(info.get(entry.id).sourceTitle, undefined)
  }
  const before = structuredClone(snapshot)
  assert.deepEqual(info, resultVersionInfo(snapshot))
  assert.deepEqual(snapshot, before)
})

test('library paging, filtering and comparison keep registration versions stable', async () => {
  const projectId = randomUUID(), specId = randomUUID()
  const results = Array.from({ length: 14 }, (_, index) => result(specId, randomUUID(),
    asset(randomUUID(), 1, String(index).repeat(64))))
  const video = result(specId, randomUUID(), asset(randomUUID(), 1, 'v'.repeat(64), 'video'))
  const snapshot = {
    project: { id: projectId, name: 'Studio' },
    generationSpecs: [{ id: specId, currentResultId: results[5].id }],
    canvasItems: [], jobs: [], assets: [], results: [...results, video],
  }
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', canvasBaseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    fetchImpl: async () => Response.json(snapshot),
  })
  const version = value => results.indexOf(value) + 1
  const first = await client.libraryResults(projectId, { kind: 'image' })
  assert.deepEqual(first.results.map(item => [item.resultId, item.version]),
    results.slice().reverse().slice(0, 12).map(item => [item.id, version(item)]))
  const second = await client.libraryResults(projectId, { kind: 'image', after: first.nextCursor })
  assert.deepEqual(second.results.map(item => [item.resultId, item.version]),
    results.slice(0, 2).reverse().map(item => [item.id, version(item)]))
  const all = await client.libraryResults(projectId)
  assert.equal(all.results.find(item => item.resultId === video.id).version, 15)
  assert.equal(all.results.find(item => item.resultId === results[13].id).version, 14)
  const other = await client.libraryResults(projectId, { kind: 'image', selection: 'other' })
  assert.deepEqual(other.results.map(item => [item.resultId, item.version]),
    results.slice().reverse().filter(item => item.id !== results[5].id).slice(0, 12)
      .map(item => [item.id, version(item)]))
  const compared = await client.compareImages(projectId, [results[13].id, results[0].id])
  assert.deepEqual(compared.images.map(image => [image.resultId, image.version]),
    [[results[13].id, 14], [results[0].id, 1]])
})

test('creation and group status projections reuse the same versions and createdAt', async () => {
  const projectId = randomUUID(), specId = randomUUID(), groupId = randomUUID()
  const job1 = randomUUID(), job2 = randomUUID()
  const first = result(specId, job1, asset(randomUUID(), 1, 'a'.repeat(64)))
  const second = result(specId, job2, asset(randomUUID(), 1, 'b'.repeat(64)))
  const snapshot = {
    project: { id: projectId, name: 'Studio' },
    generationSpecs: [{ id: specId, currentResultId: second.id }],
    canvasItems: [], assets: [first, second].map(item => ({
      id: item.asset.assetId, metadata: { width: 512, height: 512 },
    })),
    jobs: [
      { id: job1, batchId: groupId, status: 'succeeded', createdAt: '2025-02-03T04:05:06.000Z',
        inputSnapshot: { spec: { id: specId, parameters: { size: '512x512' } } } },
      { id: job2, batchId: groupId, status: 'succeeded', inputSnapshot: { spec: { id: specId, parameters: { size: '1536x1024' } } } },
    ],
    results: [first, second],
  }
  const client = new OpenDirectorClient({ baseUrl: 'http://localhost', requestTimeoutMs: 1000 }, {
    fetchImpl: async url => new URL(url).pathname.endsWith('/queries')
      ? Response.json(snapshot.jobs[0])
      : Response.json(snapshot),
  })
  const status = await client.creationStatus(projectId, job1)
  assert.deepEqual(status.results.map(item => [item.resultId, item.version, item.createdAt]), [
    [first.id, 1, '2025-02-03T04:05:06.000Z'],
    [second.id, 2, undefined],
  ])
  const group = await client.creationGroupStatus(projectId, groupId)
  for (const view of [status, group]) {
    assert.deepEqual(view.results.map(item => item.details), [
      { width: 512, height: 512 }, { width: 512, height: 512, requestedSize: '1536x1024' },
    ])
  }
  assert.deepEqual(group.results.map(item => [item.resultId, item.version, item.selected]), [
    [first.id, 1, false], [second.id, 2, true],
  ])
})
