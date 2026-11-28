import { crc32 } from 'node:zlib'

const CHUNK_SIZE = 64 * 1024
const MAX_ENTRIES = 0xffff
const MAX_NAME_BYTES = 255
const FLAGS = 0x0808
const DOS_TIME = 0
const DOS_DATE = 0x0021
const EMPTY = Buffer.alloc(0)

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

function asChunk(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('entry data chunks must be Uint8Array')
  return value
}

function validateName(name, seen) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') {
    throw new TypeError('entry name must be a non-empty basename')
  }
  if (/[\\/]|\p{Cc}/u.test(name)) throw new TypeError('entry name must not contain slashes or control characters')
  const bytes = Buffer.from(name, 'utf8')
  if (bytes.length > MAX_NAME_BYTES) throw new RangeError('entry name exceeds 255 UTF-8 bytes')
  const key = bytes.toString('hex')
  if (seen.has(key)) throw new TypeError(`duplicate entry name: ${name}`)
  seen.add(key)
  return bytes
}

function build(size, name, fields) {
  const buffer = Buffer.alloc(size + name.length)
  for (const [offset, value, width] of fields) {
    if (width === 4) buffer.writeUInt32LE(value, offset)
    else buffer.writeUInt16LE(value, offset)
  }
  name.copy(buffer, size)
  return buffer
}

function localHeader(name) {
  return build(30, name, [
    [0, 0x04034b50, 4], [4, 20, 2], [6, FLAGS, 2], [8, 0, 2],
    [10, DOS_TIME, 2], [12, DOS_DATE, 2], [26, name.length, 2],
  ])
}

function dataDescriptor(crc, size) {
  return build(16, EMPTY, [
    [0, 0x08074b50, 4], [4, crc, 4], [8, size, 4], [12, size, 4],
  ])
}

function centralHeader({ name, crc, size, offset }) {
  return build(46, name, [
    [0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, FLAGS, 2], [10, 0, 2],
    [12, DOS_TIME, 2], [14, DOS_DATE, 2], [16, crc, 4], [20, size, 4],
    [24, size, 4], [28, name.length, 2], [42, offset, 4],
  ])
}

function endOfCentralDirectory(count, size, offset) {
  return build(22, EMPTY, [
    [0, 0x06054b50, 4], [8, count, 2], [10, count, 2], [12, size, 4], [16, offset, 4],
  ])
}

function raceAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

async function* chunksOf(data, signal) {
  if (data instanceof Uint8Array) {
    if (data.length > 0) yield data
    return
  }
  const reader = data && typeof data.getReader === 'function' ? data.getReader() : null
  const iterator = reader || !data || typeof data[Symbol.asyncIterator] !== 'function'
    ? null
    : data[Symbol.asyncIterator]()
  if (!reader && !iterator) {
    throw new TypeError('entry.data must be a Uint8Array, ReadableStream, or AsyncIterable<Uint8Array>')
  }
  let complete = false
  try {
    while (true) {
      throwIfAborted(signal)
      const result = await raceAbort(reader ? reader.read() : iterator.next(), signal)
      if (result.done) { complete = true; break }
      yield asChunk(result.value)
    }
  } finally {
    if (!complete) {
      try {
        if (reader) await reader.cancel(signal?.reason)
        else if (typeof iterator.return === 'function') await iterator.return()
      } catch {}
    }
    if (reader) try { reader.releaseLock() } catch {}
  }
}

export async function* zipEntries(entries, { signal, maxBytes = 128 * 1024 * 1024 } = {}) {
  if (entries == null || (typeof entries[Symbol.iterator] !== 'function' && typeof entries[Symbol.asyncIterator] !== 'function')) {
    throw new TypeError('entries must be iterable or async iterable')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer')
  }
  throwIfAborted(signal)
  const central = []
  const names = new Set()
  let offset = 0
  let total = 0
  for await (const entry of entries) {
    throwIfAborted(signal)
    if (entry == null || typeof entry !== 'object') throw new TypeError('entry must be an object')
    const name = validateName(entry.name, names)
    if (central.length === MAX_ENTRIES) throw new RangeError('ZIP32 supports at most 65535 entries')
    const localOffset = offset
    const header = localHeader(name)
    offset += header.length
    yield header
    let crc = 0
    let size = 0
    for await (const chunk of chunksOf(entry.data, signal)) {
      throwIfAborted(signal)
      if (size + chunk.length > 0xffffffff) throw new RangeError('entry exceeds ZIP32 size limit')
      total += chunk.length
      if (total > maxBytes) throw new RangeError(`archive exceeds maxBytes (${maxBytes})`)
      size += chunk.length
      crc = crc32(chunk, crc) >>> 0
      for (let start = 0; start < chunk.length; start += CHUNK_SIZE) {
        throwIfAborted(signal)
        const slice = chunk.subarray(start, Math.min(start + CHUNK_SIZE, chunk.length))
        offset += slice.length
        yield slice
      }
    }
    throwIfAborted(signal)
    const descriptor = dataDescriptor(crc, size)
    offset += descriptor.length
    yield descriptor
    central.push({ name, crc, size, offset: localOffset })
  }
  throwIfAborted(signal)
  const centralOffset = offset
  let centralSize = 0
  for (const entry of central) {
    throwIfAborted(signal)
    const record = centralHeader(entry)
    centralSize += record.length
    offset += record.length
    yield record
  }
  throwIfAborted(signal)
  yield endOfCentralDirectory(central.length, centralSize, centralOffset)
}
