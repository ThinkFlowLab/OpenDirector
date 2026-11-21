import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipEntries } from '../src/archive.js'

const encoder = new TextEncoder()

async function collect(entries, options) {
  const chunks = []
  for await (const chunk of zipEntries(entries, options)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function findPython() {
  const candidates = [process.env.PYTHON, process.env.PYTHON3, 'python3', 'python']
  for (const command of candidates) {
    if (!command) continue
    const result = spawnSync(command, ['-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status === 0 && result.stdout.trim() === '3') return command
  }
  return null
}

const PYTHON_SCRIPT = `
import base64, binascii, json, sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as archive:
    bad = archive.testzip()
    entries = []
    for info in archive.infolist():
        data = archive.read(info.filename)
        entries.append({
            'name': info.filename,
            'size': info.file_size,
            'compress_size': info.compress_size,
            'crc': info.CRC,
            'expected_crc': binascii.crc32(data) & 0xffffffff,
            'method': info.compress_type,
            'utf8': bool(info.flag_bits & 0x800),
            'descriptor': bool(info.flag_bits & 0x8),
            'data': base64.b64encode(data).decode('ascii'),
        })
print(json.dumps({'bad': bad, 'entries': entries}))
`

async function inspectWithPython(t, archive) {
  const python = findPython()
  if (!python) {
    t.diagnostic('independent Python zipfile validation skipped: Python 3 not found')
    return null
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'archive.zip')
  await writeFile(path, archive)
  const result = spawnSync(python, ['-c', PYTHON_SCRIPT, path], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.bad, null)
  return parsed.entries
}

test('creates a ZIP32 stored archive that Python reads with UTF-8 names and real CRCs', async t => {
  const streamedParts = [
    encoder.encode('streamed '),
    encoder.encode('chunks '),
    new Uint8Array([0, 1, 2, 255]),
  ]
  const expected = new Map([
    ['中文 名字.txt', Buffer.from(encoder.encode('你好，ZIP！'))],
    ['empty.txt', Buffer.alloc(0)],
    ['streamed.bin', Buffer.concat(streamedParts.map(part => Buffer.from(part)))],
    ['web.bin', Buffer.from(encoder.encode('web stream'))],
  ])
  const entries = [
    { name: '中文 名字.txt', data: new Uint8Array(expected.get('中文 名字.txt')) },
    { name: 'empty.txt', data: new Uint8Array(0) },
    { name: 'streamed.bin', data: (async function* () { yield* streamedParts })() },
    {
      name: 'web.bin',
      data: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('web '))
          controller.enqueue(encoder.encode('stream'))
          controller.close()
        },
      }),
    },
  ]
  const archive = await collect(entries)
  assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304')

  const actual = await inspectWithPython(t, archive)
  if (!actual) return
  assert.equal(actual.length, 4)
  for (const info of actual) {
    const bytes = expected.get(info.name)
    assert.ok(bytes, `unexpected entry ${info.name}`)
    assert.equal(info.size, bytes.length)
    assert.equal(info.compress_size, bytes.length)
    assert.equal(info.method, 0)
    assert.equal(info.utf8, true)
    assert.equal(info.descriptor, true)
    assert.equal(info.crc, info.expected_crc)
    assert.deepEqual(Buffer.from(info.data, 'base64'), bytes)
  }
})

test('rejects unsafe, duplicate and oversized entry names', async () => {
  const rejected = [
    ['../escape.txt', /slashes/],
    ['dir/file.txt', /slashes/],
    ['dir\\file.txt', /slashes/],
    ['.', /basename/],
    ['..', /basename/],
    ['', /basename/],
    [null, /basename/],
    ['bad\nname.txt', /control/],
    ['bad\u0000name.txt', /control/],
    ['bad\u007f.txt', /control/],
    ['bad\u0085.txt', /control/],
    ['a'.repeat(256), /255/],
    ['中'.repeat(86), /255/],
  ]
  for (const [name, pattern] of rejected) {
    await assert.rejects(collect([{ name, data: new Uint8Array(0) }]), pattern)
  }
  await assert.rejects(collect([
    { name: 'same.txt', data: new Uint8Array(0) },
    { name: 'same.txt', data: new Uint8Array(0) },
  ]), /duplicate/)
})

test('enforces the cumulative uncompressed size cap', async () => {
  const archive = await collect([
    { name: 'a.bin', data: new Uint8Array(6) },
    { name: 'b.bin', data: new Uint8Array(4) },
  ], { maxBytes: 10 })
  assert.ok(archive.length > 0)
  await assert.rejects(collect([
    { name: 'a.bin', data: new Uint8Array(6) },
    { name: 'b.bin', data: new Uint8Array(5) },
  ], { maxBytes: 10 }), /maxBytes/)
})

test('aborting cancels the active ReadableStream reader', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024).fill(7))
    },
    cancel() {
      cancelled = true
    },
  })
  const controller = new AbortController()
  let seen = 0
  await assert.rejects(async () => {
    for await (const chunk of zipEntries([{ name: 'large.bin', data: stream }], { signal: controller.signal })) {
      seen += 1
      if (seen === 2) controller.abort()
    }
  }, error => error.name === 'AbortError')
  assert.ok(seen >= 2)
  assert.equal(cancelled, true)
})

test('aborting closes the active async iterator', async () => {
  let closed = false
  const data = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { value: new Uint8Array(1024), done: false }
        },
        async return() {
          closed = true
          return { done: true }
        },
      }
    },
  }
  const controller = new AbortController()
  let seen = 0
  await assert.rejects(async () => {
    for await (const chunk of zipEntries([{ name: 'iter.bin', data }], { signal: controller.signal })) {
      seen += 1
      if (seen === 2) controller.abort()
    }
  }, error => error.name === 'AbortError')
  assert.equal(closed, true)
})
