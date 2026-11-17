import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { apply } from '../index.js'

test('media route accepts relative URLs, forwards ranges, and ends a stalled body', { timeout: 8000 }, async () => {
  const project = randomUUID()
  const asset = randomUUID()
  const stalled = randomUUID()
  const server = createServer((request, response) => {
    const root = '/api/creation/projects/' + project + '/assets/'
    if (request.url === root + asset + '/content') {
      assert.equal(request.headers.range, 'bytes=0-2')
      response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-2/9',
        'Content-Length': '3', 'Accept-Ranges': 'bytes' })
      response.end('abc')
    } else if (request.url === root + asset + '/thumbnail') {
      response.writeHead(200, { 'Content-Type': 'image/webp' })
      response.end('thumbnail')
    } else if (request.url === root + stalled + '/content') {
      response.writeHead(200, { 'Content-Type': 'video/mp4' })
      response.write('a')
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    let route
    apply({
      tools: { register() {} },
      get() { return undefined },
      inject(_services, configure) {
        configure({
          effect(register) { register() },
          connection: { fetch: { register(value) { route = value } } },
        })
      },
    }, { baseUrl: 'http://127.0.0.1:' + server.address().port, requestTimeoutMs: 750 })
    const request = (id, kind, range) => route.fetch({
      url: '/api/opendirector/media?' + new URLSearchParams({ project, asset: id, kind }),
      headers: new Headers(range ? { Range: range } : {}),
    })
    const video = await request(asset, 'video', 'bytes=0-2')
    assert.equal(video.status, 206)
    assert.equal(video.headers.get('content-range'), 'bytes 0-2/9')
    assert.equal(video.headers.get('accept-ranges'), 'bytes')
    assert.equal(video.headers.get('content-type'), 'video/mp4')
    assert.equal(await video.text(), 'abc')
    const thumbnail = await request(asset, 'image')
    assert.equal(thumbnail.headers.get('content-type'), 'image/webp')
    assert.equal(await thumbnail.text(), 'thumbnail')
    assert.equal((await request('invalid-id', 'video')).status, 400)

    const waiting = await request(stalled, 'video')
    assert.equal(waiting.status, 200)
    const reader = waiting.body.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'a')
    await assert.rejects(reader.read(), { name: 'AbortError' })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
