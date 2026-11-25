import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { conversationTraceArchive, TraceExportError, type TraceExportErrorCode } from "../src/canvas/traceExport.ts";
import type { ConversationTurn } from "../src/canvas/traceTurns.ts";
import { parseZip } from "./traceZip.ts";

const encoder = new TextEncoder();
const MiB = 1024 * 1024;
const turn = (id: string, number: number, runtime: string = "default",
  status: ConversationTurn["status"] = "complete"): ConversationTurn =>
  ({ id, number, text: "A request", runtime, model: "test", status });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Log = Uint8Array | null | number | (() => Response);
type Setup = {
  turns: ConversationTurn[];
  /** Index responses after the first one (default: unchanged). */
  later?: ConversationTurn[][];
  logs?: Record<string, Log>;
  jobs?: (turnId: string) => Response;
};
/** Fake API: trace index, per-source logs (bytes, 404 for null, status number, or custom) and Jobs. */
function api(setup: Setup, calls: string[] = []): typeof fetch {
  let indexCalls = 0;
  return async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>)?.["X-OpenDirector-Request"], "1");
    if (url.endsWith("/trace")) {
      const turns = indexCalls === 0 ? setup.turns : setup.later?.[indexCalls - 1] ?? setup.turns;
      indexCalls++;
      return Response.json({ conversationId: "c", turns });
    }
    if (url.endsWith("/jobs"))
      return setup.jobs?.(url.split("/").at(-2)!) ?? Response.json([{ jobId: "job-1", status: "failed", adopted: false }]);
    const log = Object.entries(setup.logs ?? {}).find(([suffix]) => url.endsWith(suffix))?.[1];
    if (log === undefined || log === null) return new Response(null, { status: 404 });
    if (typeof log === "number") return new Response("denied", { status: log });
    if (typeof log === "function") return log();
    return new Response(log as Uint8Array<ArrayBuffer>);
  };
}
async function zipOf(blob: Blob) { return parseZip(new Uint8Array(await blob.arrayBuffer())); }
async function failure(work: Promise<unknown>, code: TraceExportErrorCode): Promise<TraceExportError> {
  const error = await work.then(() => undefined, (cause: unknown) => cause);
  assert.ok(error instanceof TraceExportError, String(error));
  assert.equal(error.code, code, error.message);
  return error;
}
/** Response whose body is a hand-made reader so cancel/release calls can be observed. */
function spyResponse(read: () => Promise<ReadableStreamReadResult<Uint8Array>>, headers: Record<string, string> = {}) {
  const spy = { cancelled: 0, released: 0 };
  const response = {
    ok: true, status: 200, headers: new Headers(headers),
    body: { getReader: () => ({ read, cancel: async () => { spy.cancelled++; }, releaseLock: () => { spy.released++; } }),
      cancel: async () => undefined },
  } as unknown as Response;
  return { spy, response };
}

test("central directory offset, size and entry count are valid and independent of the writer", async () => {
  const model = encoder.encode('{"prompt":"sk-demo-sensitive"}\n');
  const runtime = encoder.encode('not-json\n{"tool":{"output":"秘密"}}\n{"unfinished":');
  const blob = await conversationTraceArchive("project", "c", {
    generatedAt: "2026-11-25T00:00:00Z",
    fetcher: api({ turns: [turn("a", 1), turn("b", 2, "codex")],
      logs: { "/a/model": model, "/a/opencode": runtime, "/b/codex": new Uint8Array() } }),
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { entries, cdOffset, cdSize } = parseZip(bytes);
  assert.deepEqual(entries.map((entry) => entry.name),
    ["manifest.json", "turn-0001/model.jsonl", "turn-0001/opencode.jsonl", "turn-0002/codex.jsonl"]);
  const eocd = new DataView(bytes.buffer, bytes.byteLength - 22);
  assert.equal(eocd.getUint16(10, true), 4, "entry count");
  assert.equal(eocd.getUint32(12, true), cdSize);
  assert.equal(eocd.getUint32(16, true), cdOffset);
  assert.equal(cdOffset + cdSize + 22, bytes.byteLength);
  const files = new Map(entries.map((entry) => [entry.name, entry.data]));
  assert.deepEqual(files.get("turn-0001/model.jsonl"), model);
  assert.deepEqual(files.get("turn-0001/opencode.jsonl"), runtime);
  assert.equal(files.get("turn-0002/codex.jsonl")?.length, 0);
  assert.equal(blob.type, "application/zip");
});

test("manifest lists sources, byte counts, snapshot semantics and job lookup state", async () => {
  const { entries } = await zipOf(await conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1), turn("b", 2, "codex"), turn("c", 3, "claude"), turn("d", 4, "../../secret")],
      logs: { "/a/model": encoder.encode("m\n"), "/a/opencode": encoder.encode("raw\n"),
        "/b/codex": encoder.encode("x\n"), "/c/claude": null },
      jobs: (id) => id === "a" ? Response.json([]) : id === "b" ? Response.json([{ jobId: "job-1", status: "failed", adopted: false }])
        : new Response("boom", { status: 500 }) }),
  }));
  const manifest = JSON.parse(new TextDecoder().decode(entries[0]!.data));
  assert.equal(manifest.format, "opendirector-original-trace-archive");
  assert.match(manifest.snapshot, /not an atomic snapshot/);
  assert.ok(manifest.warning.includes("credentials"));
  assert.deepEqual(manifest.turns[0].sources, [
    { source: "model", file: "turn-0001/model.jsonl", bytes: 2, status: "included" },
    { source: "opencode", file: "turn-0001/opencode.jsonl", bytes: 4, status: "included" }]);
  assert.deepEqual([manifest.turns[0].jobs, manifest.turns[0].jobsStatus], [[], "ok"], "no linked jobs");
  assert.equal(manifest.turns[1].jobs[0].jobId, "job-1");
  assert.deepEqual([manifest.turns[2].jobs, manifest.turns[2].jobsStatus], [null, "unavailable"], "lookup failed");
  assert.deepEqual(manifest.turns[2].sources, [{ source: "claude", status: "missing" }]);
  assert.equal(manifest.turns[3].sources[0].status, "unsupported");
});

test("48 MiB single source is exported byte for byte under the 64 MiB total cap", async () => {
  const big = new Uint8Array(48 * MiB);
  for (let index = 0; index < big.length; index += 4099) big[index] = (index * 31) & 0xff;
  const { entries } = await zipOf(await conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex")], logs: { "/a/codex": big } }),
  }));
  const file = entries.find((entry) => entry.name === "turn-0001/codex.jsonl")!;
  assert.equal(file.size, 48 * MiB);
  assert.equal(sha(file.data), sha(big));
});

test("total cap includes ZIP overhead: raw bytes that fit alone still fail with turn and source", async () => {
  const raw = encoder.encode("x".repeat(1000));
  const fits = api({ turns: [turn("a", 1, "codex")], logs: { "/a/codex": raw } });
  await conversationTraceArchive("p", "c", { fetcher: fits, maxArchiveBytes: 4096 });
  const error = await failure(conversationTraceArchive("p", "c", { fetcher: fits, maxArchiveBytes: 1100 }), "tooLarge");
  assert.deepEqual([error.detail.turn, error.detail.source], [1, "codex"], "limit allows the raw bytes but not the headers");
});

test("second source over the cumulative cap names its turn, with chunked and declared lengths", async () => {
  const chunk = new Uint8Array(600);
  const stream = (reader: { cancelled: number }) => () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); }, cancel() { reader.cancelled++; } }));
  const chunked = { cancelled: 0 };
  const error = await failure(conversationTraceArchive("p", "c", {
    maxArchiveBytes: 2000,
    fetcher: api({ turns: [turn("a", 1, "codex"), turn("b", 2, "claude")],
      logs: { "/a/codex": chunk, "/b/claude": stream(chunked) } }),
  }), "tooLarge");
  assert.deepEqual([error.detail.turn, error.detail.source], [2, "claude"]);
  assert.equal(chunked.cancelled, 1, "unbounded stream was cancelled");
  const declared = spyResponse(async () => ({ done: true, value: undefined }), { "content-length": String(70 * MiB) });
  let bodyCancelled = 0;
  (declared.response.body as { cancel: () => Promise<void> }).cancel = async () => { bodyCancelled++; };
  const second = await failure(conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex")], logs: { "/a/codex": () => declared.response } }),
  }), "tooLarge");
  assert.equal(second.detail.source, "codex");
  assert.equal(bodyCancelled, 1, "oversized declared length cancels the body without reading it");
  assert.match(second.message, /tooLarge turn 1 codex/);
});

for (const status of [403, 500]) {
  test(`HTTP ${status} on a source fails the export and names turn and source`, async () => {
    const error = await failure(conversationTraceArchive("p", "c", {
      fetcher: api({ turns: [turn("a", 1, "codex"), turn("b", 2, "claude")],
        logs: { "/a/codex": encoder.encode("ok\n"), "/b/claude": status } }),
    }), "read");
    assert.deepEqual([error.detail.turn, error.detail.source, error.detail.status], [2, "claude", status]);
  });
}

test("404 marks only that source missing", async () => {
  const { entries } = await zipOf(await conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "opencode")], logs: { "/a/model": null, "/a/opencode": encoder.encode("r\n") } }),
  }));
  const manifest = JSON.parse(new TextDecoder().decode(entries[0]!.data));
  assert.equal(manifest.turns[0].sources[0].status, "missing");
  assert.deepEqual(entries.map((entry) => entry.name), ["manifest.json", "turn-0001/opencode.jsonl"]);
});

test("a stream cut short of its Content-Length is an error, never a shorter file", async () => {
  let sent = false;
  const short = spyResponse(async () => sent ? { done: true, value: undefined }
    : (sent = true, { done: false, value: new Uint8Array(10) }), { "content-length": "100" });
  const error = await failure(conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex")], logs: { "/a/codex": () => short.response } }),
  }), "incomplete");
  assert.deepEqual([error.detail.turn, error.detail.source], [1, "codex"]);
});

test("a network error mid-stream fails the export and cancels and releases the reader", async () => {
  let reads = 0;
  const broken = spyResponse(async () => {
    if (reads++ === 0) return { done: false, value: new Uint8Array(10) };
    throw new TypeError("terminated");
  });
  await failure(conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex")], logs: { "/a/codex": () => broken.response } }),
  }), "incomplete");
  assert.deepEqual(broken.spy, { cancelled: 1, released: 1 });
});

test("a stalled request times out with turn and source", async () => {
  const stalled: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/trace")) return Response.json({ conversationId: "c", turns: [turn("a", 1, "codex")] });
    return new Promise<Response>(() => { void init; }); // ignores the signal on purpose
  };
  const error = await failure(conversationTraceArchive("p", "c", { fetcher: stalled, requestTimeoutMs: 20 }), "timeout");
  assert.deepEqual([error.detail.turn, error.detail.source], [1, "codex"]);
});

test("a stalled body times out and releases the reader", async () => {
  const stalled = spyResponse(() => new Promise<never>(() => {}));
  const error = await failure(conversationTraceArchive("p", "c", {
    requestTimeoutMs: 20,
    fetcher: api({ turns: [turn("a", 1, "codex")], logs: { "/a/codex": () => stalled.response } }),
  }), "timeout");
  assert.equal(error.detail.source, "codex");
  assert.deepEqual(stalled.spy, { cancelled: 1, released: 1 });
});

test("the whole export is bounded as well as each request", async () => {
  const slow: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/trace")) return Response.json({ conversationId: "c", turns: [turn("a", 1, "codex"), turn("b", 2, "codex")] });
    if (url.endsWith("/jobs")) return Response.json([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response("x\n");
  };
  await failure(conversationTraceArchive("p", "c", { fetcher: slow, requestTimeoutMs: 1000, totalTimeoutMs: 45 }), "timeout");
});

test("cancelling releases the reader and reports aborted", async () => {
  const stalled = spyResponse(() => new Promise<never>(() => {}));
  const controller = new AbortController();
  const pending = conversationTraceArchive("p", "c", {
    signal: controller.signal,
    fetcher: api({ turns: [turn("a", 1, "codex")], logs: { "/a/codex": () => stalled.response } }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await failure(pending, "aborted");
  assert.deepEqual(stalled.spy, { cancelled: 1, released: 1 });
  await failure(conversationTraceArchive("p", "c", { signal: controller.signal, fetcher: api({ turns: [] }) }), "aborted");
});

test("a running turn blocks export before any source is read", async () => {
  const calls: string[] = [];
  const error = await failure(conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex"), turn("b", 2, "codex", "streaming")] }, calls),
  }), "running");
  assert.equal(error.detail.turn, 2);
  assert.ok(!calls.some((url) => url.includes("/traces/")), calls.join("\n"));
});

test("the click-time recheck uses the server's current status, not what the page showed", async () => {
  // The page believed every turn was complete; the index now reports the latest as streaming.
  await failure(conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex", "streaming")], logs: { "/a/codex": encoder.encode("x\n") } }),
  }), "running");
});

test("a turn that starts running or changes during the reads rejects the export", async () => {
  const logs = { "/a/codex": encoder.encode("x\n") };
  await failure(conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex")], later: [[turn("a", 1, "codex", "streaming")]], logs }),
  }), "running");
  await failure(conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex")], later: [[turn("a", 1, "codex"), turn("b", 2, "codex")]], logs }),
  }), "changed");
  await failure(conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex")], later: [[turn("a", 1, "codex", "stopped")]], logs }),
  }), "changed");
});

test("a failing trace index is an error naming the index", async () => {
  const error = await failure(conversationTraceArchive("p", "c", {
    fetcher: async () => new Response("nope", { status: 403 }),
  }), "read");
  assert.deepEqual([error.detail.source, error.detail.status], ["trace index", 403]);
});

test("the independent ZIP parser rejects the old writer's EOCD defect (central directory size + 12)", async () => {
  const blob = await conversationTraceArchive("p", "c", {
    fetcher: api({ turns: [turn("a", 1, "codex")], logs: { "/a/codex": encoder.encode("x\n") } }),
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  parseZip(bytes);
  const view = new DataView(bytes.buffer, bytes.byteLength - 22);
  view.setUint32(12, view.getUint32(12, true) + 12, true);
  assert.throws(() => parseZip(bytes), /does not end at EOCD/);
});
