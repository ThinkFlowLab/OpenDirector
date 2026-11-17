import assert from "node:assert/strict";
import test from "node:test";
import { createZip } from "../src/canvas/zipArchive.ts";
import {
  EXAMPLE_MAX_BYTES,
  ExampleError,
  fetchExampleBytes,
  fetchExampleCanvas,
  normalizeToCanvas,
} from "../src/canvas/workspace/example/exampleDownload.ts";
import type { ExampleEntry } from "../src/canvas/workspace/example/exampleCatalog.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A minimal but structurally valid `.canvas` archive. */
async function canvasArchive(title = "示例"): Promise<Blob> {
  return createZip([
    {
      path: "manifest.json",
      data: encoder.encode(
        JSON.stringify({
          magic: "opendirector-canvas",
          formatVersion: 2,
          document: "canvas.json",
          assets: [],
        }),
      ),
      compress: true,
    },
    {
      path: "canvas.json",
      data: encoder.encode(JSON.stringify({ title, nodes: [] })),
      compress: true,
    },
  ]);
}

/** The shipped samples: an outer ZIP holding exactly one `.canvas`. */
async function wrappedArchive(): Promise<Blob> {
  const inner = new Uint8Array(await (await canvasArchive("包裹")).arrayBuffer());
  return createZip([{ path: "图像创作示例画布.canvas", data: inner }]);
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function entry(overrides: Partial<ExampleEntry> = {}): ExampleEntry {
  return {
    id: "test",
    title: { "zh-CN": "测试", "en-US": "Test" },
    url: "https://lz.qaiu.top/parser?url=x",
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<ExampleError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExampleError, `expected ExampleError, got ${error}`);
    return error;
  }
  throw new Error("expected the call to fail");
}

test("a plain archive passes through untouched", async () => {
  const archive = await bytesOf(await canvasArchive());
  const normalized = await normalizeToCanvas(archive);
  assert.equal(normalized.kind, "canvas");
  assert.equal(normalized.innerEntry, undefined);
  assert.deepEqual(normalized.bytes, archive);
});

test("a ZIP wrapping one .canvas is unwrapped exactly one level", async () => {
  const outer = await bytesOf(await wrappedArchive());
  const normalized = await normalizeToCanvas(outer);
  assert.equal(normalized.kind, "zip-wrapper");
  assert.equal(normalized.innerEntry, "图像创作示例画布.canvas");
  assert.notDeepEqual(normalized.bytes, outer);
  // The unwrapped bytes are themselves a readable archive.
  const inner = await normalizeToCanvas(normalized.bytes);
  assert.equal(inner.kind, "canvas");
  assert.match(decoder.decode(normalized.bytes.subarray(0, 2)), /PK/);
});

test("a ZIP with two .canvas entries is ambiguous, never guessed", async () => {
  const one = new Uint8Array(await (await canvasArchive("a")).arrayBuffer());
  const two = new Uint8Array(await (await canvasArchive("b")).arrayBuffer());
  const outer = await bytesOf(
    await createZip([
      { path: "a.canvas", data: one },
      { path: "b.canvas", data: two },
    ]),
  );
  assert.equal((await rejection(normalizeToCanvas(outer))).code, "ambiguous");
});

test("a ZIP without any .canvas entry is ambiguous", async () => {
  const outer = await bytesOf(
    await createZip([{ path: "readme.txt", data: encoder.encode("nothing here") }]),
  );
  assert.equal((await rejection(normalizeToCanvas(outer))).code, "ambiguous");
});

test("an HTML login page is reported as html, not as a damaged archive", async () => {
  const page = encoder.encode("<!doctype html><html><body>请登录</body></html>");
  assert.equal((await rejection(normalizeToCanvas(page))).code, "html");
});

test("JSON error bodies and plain text are rejected as HTML-ish markup", async () => {
  const body = encoder.encode('{"errno":-62,"error":"need login"}');
  assert.equal((await rejection(normalizeToCanvas(body))).code, "html");
});

test("non-ZIP bytes and truncated archives are notArchive", async () => {
  assert.equal(
    (await rejection(normalizeToCanvas(encoder.encode("plain text, no markup")))).code,
    "notArchive",
  );
  assert.equal((await rejection(normalizeToCanvas(new Uint8Array()))).code, "notArchive");
  const archive = await bytesOf(await canvasArchive());
  const truncated = archive.subarray(0, Math.floor(archive.length / 2));
  assert.equal((await rejection(normalizeToCanvas(truncated))).code, "notArchive");
});

function respond(
  body: BodyInit | null,
  init: ResponseInit = {},
): () => Response {
  return () => new Response(body, { status: 200, ...init });
}

test("the shipped shape downloads end to end", async () => {
  const outer = await wrappedArchive();
  const result = await fetchExampleCanvas(entry(), {
    fetchImpl: (async () => respond(outer)()) as typeof fetch,
  });
  assert.equal(result.kind, "zip-wrapper");
  assert.equal(result.innerEntry, "图像创作示例画布.canvas");
  assert.equal(result.outerBytes, (await outer.arrayBuffer()).byteLength);
  assert.equal((await normalizeToCanvas(result.bytes)).kind, "canvas");
});

test("a disallowed URL never reaches the network", async () => {
  let called = false;
  const failure = await rejection(
    fetchExampleBytes(entry({ url: "http://lz.qaiu.top/x" }), {
      fetchImpl: (async () => {
        called = true;
        return respond(new Blob())();
      }) as typeof fetch,
    }),
  );
  assert.equal(failure.code, "invalidUrl");
  assert.equal(called, false);
});

test("an HTTP error keeps its status", async () => {
  const failure = await rejection(
    fetchExampleBytes(entry(), {
      fetchImpl: (async () =>
        new Response("nope", { status: 403 })) as typeof fetch,
    }),
  );
  assert.equal(failure.code, "http");
  assert.equal(failure.status, 403);
});

test("a body larger than the budget is stopped while streaming", async () => {
  const failure = await rejection(
    fetchExampleBytes(entry(), {
      maxBytes: 1024,
      fetchImpl: (async () => respond(new Blob([new Uint8Array(4096)]))()) as typeof fetch,
    }),
  );
  assert.equal(failure.code, "tooLarge");
});

test("a declared content-length over the budget fails before reading", async () => {
  let read = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read = true;
        controller.close();
      },
    },
    // Without this the stream prefetches one chunk on creation (default 1).
    { highWaterMark: 0 },
  );
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(EXAMPLE_MAX_BYTES + 1) }),
    body,
  } as unknown as Response;
  const failure = await rejection(
    fetchExampleBytes(entry(), {
      fetchImpl: (async () => response) as typeof fetch,
    }),
  );
  assert.equal(failure.code, "tooLarge");
  assert.equal(read, false);
});

test("an integrity mismatch discards the download", async () => {
  const outer = await wrappedArchive();
  const failure = await rejection(
    fetchExampleBytes(entry({ sha256: "b".repeat(64) }), {
      fetchImpl: (async () => respond(outer)()) as typeof fetch,
    }),
  );
  assert.equal(failure.code, "integrity");
});

test("the inner digest is checked after unwrapping", async () => {
  const outer = await wrappedArchive();
  const failure = await rejection(
    fetchExampleCanvas(
      entry({ inner: { entry: "x.canvas", sha256: "c".repeat(64) } }),
      { fetchImpl: (async () => respond(outer)()) as typeof fetch },
    ),
  );
  assert.equal(failure.code, "integrity");
});

test("progress reports received bytes against the declared total", async () => {
  const outer = await wrappedArchive();
  const bytes = new Uint8Array(await outer.arrayBuffer());
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(bytes.byteLength) }),
    body: new Blob([bytes]).stream(),
  } as unknown as Response;
  const events: [number, number | null][] = [];
  const received = await fetchExampleBytes(entry(), {
    fetchImpl: (async () => response) as typeof fetch,
    onProgress: (progress, total) => events.push([progress, total]),
  });
  assert.equal(received.byteLength, bytes.byteLength);
  assert.equal(events[0]?.[0], 0);
  assert.equal(events[0]?.[1], bytes.byteLength);
  assert.equal(events.at(-1)?.[0], bytes.byteLength);
  assert.equal(events.at(-1)?.[1], bytes.byteLength);
});

test("progress falls back to an unknown total without content-length", async () => {
  const outer = await wrappedArchive();
  const events: (number | null)[] = [];
  await fetchExampleBytes(entry(), {
    fetchImpl: (async () => respond(outer)()) as typeof fetch,
    onProgress: (_received, total) => events.push(total),
  });
  assert.ok(events.length > 0);
  assert.equal(events.at(-1), null);
});

test("release zeroes the downloaded buffers and is idempotent", async () => {
  const outer = await wrappedArchive();
  const result = await fetchExampleCanvas(entry(), {
    fetchImpl: (async () => respond(outer)()) as typeof fetch,
  });
  assert.ok(result.bytes.some((byte) => byte !== 0), "expected a real archive");
  result.release();
  assert.ok(result.bytes.every((byte) => byte === 0));
  result.release();
  assert.ok(result.bytes.every((byte) => byte === 0));
});

test("cancellation and the deadline both surface as aborted", async () => {
  const hanging = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, rejectPlaceholder) => {
      const fail = () => rejectPlaceholder(new DOMException("aborted", "AbortError"));
      // An already-aborted signal never fires the event again.
      if (init?.signal?.aborted) return fail();
      init?.signal?.addEventListener("abort", fail);
    })) as unknown as typeof fetch;

  const controller = new AbortController();
  controller.abort();
  const cancelled = await rejection(
    fetchExampleBytes(entry(), { fetchImpl: hanging, signal: controller.signal }),
  );
  assert.equal(cancelled.code, "aborted");

  const timedOut = await rejection(
    fetchExampleBytes(entry(), { fetchImpl: hanging, timeoutMs: 10 }),
  );
  assert.equal(timedOut.code, "aborted");
});
