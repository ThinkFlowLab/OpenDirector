import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventSchema, proxyRequest } from '../src/host.mjs';
import { messages } from '../src/locale.mjs';
import { registerCommand } from '../src/command.mjs';
import { mkdtemp, readlink, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Host readiness rejects foreign origins and malformed control messages', () => {
  const ready = { type: 'ready', version: 1, runtime: {} };
  for (const url of ['https://evil.test', 'http://localhost:80', 'http://127.0.0.1:42/?token=x', 'http://u:p@127.0.0.1:42']) {
    assert.equal(eventSchema.safeParse({ ...ready, url }).success, false);
  }
  assert.equal(eventSchema.safeParse({ ...ready, url: 'http://127.0.0.1:23456' }).success, true);
});

test('Proxy authenticates only the owned Host and streams media range responses', async () => {
  const host = { url: 'http://127.0.0.1:23456', token: 'private-token' };
  let calls = 0;
  const fetcher = async (url, options) => {
    calls += 1;
    assert.equal(url, host.url + '/api/media');
    assert.equal(options.headers.get('x-opendirector-desktop'), host.token);
    assert.equal(options.headers.get('range'), 'bytes=2-4');
    assert.equal(options.headers.has('cookie'), false);
    assert.equal(options.redirect, 'manual');
    return new Response('abc', { status: 206, headers: { 'content-range': 'bytes 2-4/10', 'set-cookie': 'secret=x', 'connection': 'close' } });
  };
  const response = await proxyRequest(new Request('opendirector://app/api/media', { headers: { range: 'bytes=2-4', cookie: 'x=y' } }), host, fetcher);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(await response.text(), 'abc');
  assert.equal((await proxyRequest(new Request('opendirector://other/api/media'), host, fetcher)).status, 403);
  assert.equal((await proxyRequest(new Request('opendirector://app//other.test/media'), host, fetcher)).status, 403);
  assert.equal(calls, 1);
});

test('Native dialogs have matching bilingual keys', () => {
  assert.deepEqual(Object.keys(messages['en-US']).sort(), Object.keys(messages['zh-CN']).sort());
});

test('Command registration preserves existing files and supports repeated installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'od-command-'));
  const destination = join(directory, 'opendirector');
  const launcher = join(directory, 'launcher');
  try {
    await writeFile(destination, 'another installation');
    await assert.rejects(registerCommand({ destination, launcher }), /command_collision/);
    assert.equal(await readFile(destination, 'utf8'), 'another installation');
    await rm(destination);
    assert.equal(await registerCommand({ destination, launcher }), 'installed');
    if (process.platform !== 'win32') assert.equal(await readlink(destination), launcher);
    assert.equal(await registerCommand({ destination, launcher }), 'already_installed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Proxy never follows redirects carrying the desktop credential', async () => {
  const response = await proxyRequest(new Request('opendirector://app/api/test'),
    { url: 'http://127.0.0.1:23456', token: 'private' },
    async () => new Response(null, { status: 302, headers: { location: 'https://other.test' } }));
  assert.equal(response.status, 502);
});

test('Concurrent command installs preserve the winning launcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'od-command-race-'));
  const destination = join(directory, 'opendirector');
  const launchers = ['first', 'second'].map(name => join(directory, name));
  try {
    const results = await Promise.allSettled(launchers.map(launcher =>
      registerCommand({ destination, launcher })));
    const winner = results.findIndex(result => result.status === 'fulfilled');
    assert.notEqual(winner, -1);
    assert.deepEqual(results[winner], { status: 'fulfilled', value: 'installed' });
    assert.match(results[1 - winner].reason?.message ?? '', /^command_collision$/);
    if (process.platform === 'win32') {
      assert.equal(await readFile(destination, 'utf8'), `@"${launchers[winner]}" %*\r\n`);
    } else {
      assert.equal(await readlink(destination), launchers[winner]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Proxy can forward the first upload chunk before the producer finishes', async () => {
  let producer;
  const body = new ReadableStream({ start(controller) { producer = controller; } });
  const cancellation = new AbortController();
  const request = new Request('opendirector://app/api/creation/projects/project/uploads/handle', {
    method: 'PUT', body, duplex: 'half', signal: cancellation.signal,
    headers: { 'x-asset-name': 'video.mp4' },
  });
  producer.enqueue(Uint8Array.of(1, 2, 3));

  let firstChunk;
  const forwarded = proxyRequest(request, { url: 'http://127.0.0.1:12345', token: 'private' },
    async (_url, options) => {
      assert.equal(options.method, 'PUT');
      assert.equal(options.duplex, 'half');
      assert.equal(options.headers.get('x-asset-name'), 'video.mp4');
      const reader = options.body.getReader();
      firstChunk = await reader.read();
      assert.equal(options.signal.aborted, false);
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      await reader.cancel();
      return new Response(null, { status: 204 });
    });

  try {
    // Allow both the proxy and stream reader to advance without closing the source.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(firstChunk, { value: Uint8Array.of(1, 2, 3), done: false });
  } finally {
    producer.close();
    cancellation.abort();
    await forwarded;
  }
});
