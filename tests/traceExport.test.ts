import assert from "node:assert/strict";
import test from "node:test";
import { conversationTraceArchive, zipStore } from "../src/canvas/traceExport.ts";
import type { ConversationTurn } from "../src/canvas/traceTurns.ts";

const encoder = new TextEncoder();
const turn = (id: string, number: number, runtime: string = "default",
  status: ConversationTurn["status"] = "complete"): ConversationTurn =>
  ({ id, number, text: "A request", runtime, model: "test", status });

function entries(zip: Uint8Array): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let i = 0;
  while (i + 4 < zip.byteLength && view.getUint32(i, true) === 0x04034b50) {
    assert.equal(view.getUint16(i + 8, true), 0, "STORE, no transformation");
    const size = view.getUint32(i + 18, true);
    const nameSize = view.getUint16(i + 26, true);
    const extra = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(zip.subarray(i + 30, i + 30 + nameSize));
    const start = i + 30 + nameSize + extra;
    result.set(name, zip.subarray(start, start + size));
    i = start + size;
  }
  assert.equal(view.getUint32(i, true), 0x02014b50, "central directory exists");
  assert.equal(view.getUint32(zip.byteLength - 22, true), 0x06054b50, "archive has EOCD");
  return result;
}
function manifest(zip: Uint8Array) {
  const file = entries(zip).get("manifest.json");
  assert.ok(file);
  return JSON.parse(new TextDecoder().decode(file));
}
function fetcherFor(logs: Record<string, Uint8Array | null | "error">,
  calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>)?.["X-OpenDirector-Request"], "1");
    if (url.endsWith("/jobs")) return Response.json([{ jobId: "job-1", status: "failed", adopted: false }]);
    const source = Object.entries(logs).find(([suffix]) => url.endsWith(suffix));
    if (!source || source[1] === null) return new Response(null, { status: 404 });
    if (source[1] === "error") return new Response("unavailable", { status: 503 });
    return new Response(source[1] as Uint8Array<ArrayBuffer>);
  };
}

test("ZIP is valid STORE structure and CRC32 matches the known test vector", () => {
  const zip = zipStore([{ name: "test.txt", data: encoder.encode("123456789") }]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(14, true), 0xcbf43926);
  assert.equal(new TextDecoder().decode(entries(zip).get("test.txt")), "123456789");
});

test("exports exact original JSONL bytes, including model requests, malformed lines and UTF-8", async () => {
  const calls: string[] = [];
  const model = encoder.encode('{"prompt":"sk-demo-sensitive"}\n');
  const runtime = encoder.encode('not-json\n{"tool":{"output":"秘密"}}\n{"unfinished":');
  const codex = encoder.encode('{"event":"tool.call","error":"denied"}\n');
  const archive = await conversationTraceArchive("project", "conversation",
    [turn("a", 1), turn("b", 2, "codex"), turn("c", 3, "claude")],
    fetcherFor({ "/a/model": model, "/a/opencode": runtime, "/b/codex": codex,
      "/c/claude": null }, calls), "2026-11-25T00:00:00Z");
  const files = entries(archive);
  assert.deepEqual([...files.keys()], [
    "manifest.json", "turn-0001/model.jsonl", "turn-0001/opencode.jsonl", "turn-0002/codex.jsonl",
  ]);
  assert.deepEqual(files.get("turn-0001/model.jsonl"), model);
  assert.deepEqual(files.get("turn-0001/opencode.jsonl"), runtime);
  assert.deepEqual(files.get("turn-0002/codex.jsonl"), codex);
  const index = manifest(archive);
  assert.equal(index.format, "opendirector-original-trace-archive");
  assert.equal(index.conversationId, "conversation");
  assert.equal(index.turns.length, 3);
  assert.equal(index.turns[0].jobs[0].jobId, "job-1");
  assert.deepEqual(index.turns[2].sources, [{ source: "claude", status: "missing" }]);
  assert.ok(index.warning.includes("credentials"));
  assert.equal(calls.filter((s) => s.endsWith("/model")).length, 1);
  assert.equal(calls.filter((s) => s.includes("/traces/")).length, 4);
});

test("all turns are independent of UI expansion and retain running status in manifest", async () => {
  const archive = await conversationTraceArchive("p", "c",
    [turn("one", 1, "deepseek", "streaming"), turn("two", 2, "jiuwenswarm", "interrupted")],
    fetcherFor({ "/one/deepseek": encoder.encode("raw\n"), "/two/jiuwenswarm": null }, []));
  assert.equal(manifest(archive).turns[0].status, "streaming");
  assert.equal(entries(archive).get("turn-0001/deepseek.jsonl")?.length, 4);
  assert.equal(manifest(archive).turns[1].sources[0].status, "missing");
});

test("a non-404 source failure rejects the entire export instead of emitting a partial ZIP", async () => {
  await assert.rejects(
    conversationTraceArchive("p", "c", [turn("x", 1, "codex")],
      fetcherFor({ "/x/codex": "error" }, [])),
    /Could not read original trace/
  );
});

test("excessive declared source length fails without downloading or truncating bytes", async () => {
  let consumed = false;
  const mock: typeof fetch = async (input) => {
    if (String(input).endsWith("/jobs")) return Response.json([]);
    const stream = new ReadableStream<Uint8Array>({
      pull() { consumed = true; return new Promise<void>(() => {}); },
    });
    return new Response(stream, { headers: { "content-length": String(33 * 1024 * 1024) } });
  };
  await assert.rejects(conversationTraceArchive("p", "c", [turn("a", 1, "codex")], mock),
    /size limit/);
  assert.equal(consumed, false);
});

test("unexpected source names cannot turn into ZIP paths or arbitrary fetch URLs", async () => {
  const calls: string[] = [];
  const archive = await conversationTraceArchive("p", "c", [turn("a", 1, "../../secret")],
    fetcherFor({}, calls));
  assert.equal(manifest(archive).turns[0].sources[0].status, "unsupported");
  assert.ok(!calls.some((url) => url.includes("/traces/")));
});
