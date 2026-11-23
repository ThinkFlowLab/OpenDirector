import assert from "node:assert/strict";
import test from "node:test";
import { conversationTraceReport, traceEventSummary } from "../src/canvas/traceExport.ts";
import type { ConversationTurn } from "../src/canvas/traceTurns.ts";

const turn = (id: string, number: number, runtime = "default", status: ConversationTurn["status"] = "complete"): ConversationTurn =>
  ({ id, number, text: "Review <secret> [report]", runtime, model: "example", status });

test("export omits raw model data, arguments, tool output and credential-like content", async () => {
  const secret = "provider_secret_not_for_report";
  const summary = traceEventSummary([
    JSON.stringify({ event: "model.request", payload: { messages: [{ content: secret }] } }),
    JSON.stringify({ native: { type: "tool_call", part: { state: { status: "completed" }, input: secret } } }),
    JSON.stringify({ native: { type: "tool_call_update", item: { status: "failed", aggregated_output: secret } } }),
  ].join("\n"));
  assert.deepEqual(summary.events, [
    { kind: "model.request" }, { kind: "tool_call", status: "completed" }, { kind: "tool_call_update", status: "failed" },
  ]);
  assert.ok(!JSON.stringify(summary).includes(secret));
});

test("all turns including collapsed ones export with their own runtime and linked job status", async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    paths.push(path);
    if (path.includes("/turns/a/jobs"))
      return Response.json([{ jobId: "job-1", status: "running", adopted: false }]);
    if (path.includes("/turns/b/jobs"))
      return Response.json([{ jobId: "job-2", status: "failed", adopted: false }]);
    if (path.endsWith("/traces/a/opencode"))
      return new Response('{"event":"model.request","payload":{"messages":[{"content":"password"}]}}\n', { status: 200 });
    if (path.endsWith("/traces/b/codex"))
      return new Response('{"type":"turn.started"}\n', { status: 200 });
    return new Response("", { status: 404 });
  };
  const result = await conversationTraceReport("project", "conversation",
    [turn("a", 1), turn("b", 2, "codex", "streaming")], fetcher, "2026-11-21T00:00:00Z");
  assert.match(result, /## Turn 1/);
  assert.match(result, /## Turn 2/);
  assert.match(result, /job-1: running \(not adopted\)/);
  assert.match(result, /job-2: failed \(not adopted\)/);
  assert.match(result, /partial snapshot/);
  assert.ok(!result.includes("password"));
  assert.deepEqual(paths.filter((p) => p.includes("/traces/")).sort(),
    ["/api/creation/projects/project/assistant/traces/a/opencode", "/api/creation/projects/project/assistant/traces/b/codex"]);
});

test("missing and failed logs remain explicit without invented events", async () => {
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/jobs") ? new Response("", { status: 503 }) : new Response("", { status: 404 });
  const result = await conversationTraceReport("p", "c", [turn("a", 1)], fetcher);
  assert.match(result, /Trace not recorded/);
  assert.match(result, /Job data unavailable/);
  assert.doesNotMatch(result, /No linked jobs/);
});

test("untrusted metadata cannot inject Markdown headings or list entries", async () => {
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/jobs") ? Response.json([]) : new Response("", { status: 404 });
  const result = await conversationTraceReport("p", "c", [turn("a", 1)], fetcher);
  assert.ok(result.includes("Review &lt;secret&gt; \\[report\\]"));
  assert.ok(!result.includes("Review <secret> [report]"));
});

const MAX = 1_000_000;
const jobsOrLog = (log: (path: string) => Response): typeof fetch => async (input) => {
  const path = String(input);
  return path.endsWith("/jobs") ? Response.json([]) : log(path);
};
const SECRETS = ["SENTINEL_PROMPT", "SENTINEL_ARGS", "SENTINEL_RESULT", "sk-DEMOSECRET123456"];
const secretLine = JSON.stringify({ event: "model.request", payload: { prompt: SECRETS[0], arguments: SECRETS[1],
  result: SECRETS[2], apiKey: SECRETS[3] } });

test("a very large log is read only up to the limit plus one chunk and marked truncated", async () => {
  const line = JSON.stringify({ event: "tool_call", pad: "x".repeat(990) }) + "\n";
  const chunk = new TextEncoder().encode(line.repeat(100));
  let pulled = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulled += chunk.byteLength; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await conversationTraceReport("p", "c", [turn("a", 1)],
    jobsOrLog(() => new Response(stream, { status: 200 })));
  assert.ok(cancelled);
  assert.ok(pulled > MAX && pulled <= MAX + chunk.byteLength, "pulled " + pulled);
  assert.match(result, /Event list truncated/);
  assert.match(result, /- tool\\_call/);
});

test("a line cut at the limit does not produce a bogus event", async () => {
  const full = JSON.stringify({ event: "good.event" }) + "\n";
  const cutLine = JSON.stringify({ event: "cut.event" });
  const filler = JSON.stringify({ event: "x", pad: "y".repeat(MAX - full.length - 20) }) + "\n";
  // Line "cut.event" starts before the limit but ends after it.
  const body = full + filler + cutLine + "\n" + cutLine;
  assert.ok(body.length > MAX);
  const result = await conversationTraceReport("p", "c", [turn("a", 1)],
    jobsOrLog(() => new Response(body, { status: 200 })));
  assert.match(result, /good\\.event/);
  assert.doesNotMatch(result, /cut\\.event/);
  assert.match(result, /Event list truncated/);
});

test("invalid JSON lines are skipped without failing", async () => {
  const result = await conversationTraceReport("p", "c", [turn("a", 1)],
    jobsOrLog(() => new Response('not json\n{"event":"ok.event"\n{"event":"fine"}\n{', { status: 200 })));
  assert.match(result, /- fine/);
  assert.doesNotMatch(result, /ok\\.event/);
  assert.doesNotMatch(result, /unavailable/);
});

test("stream errors and rejected fetches are reported as unavailable", async () => {
  const failing = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"event":"a"}\n')); },
    pull(controller) { controller.error(new Error("network")); },
  }, { highWaterMark: 0 });
  const streamed = await conversationTraceReport("p", "c", [turn("a", 1)],
    jobsOrLog(() => new Response(failing, { status: 200 })));
  assert.match(streamed, /Trace unavailable/);
  assert.match(streamed, /## Turn 1/);
  const rejected: typeof fetch = async (input) => {
    if (String(input).endsWith("/jobs")) return Response.json([]);
    throw new TypeError("offline");
  };
  const result = await conversationTraceReport("p", "c", [turn("a", 1)], rejected);
  assert.match(result, /Trace unavailable/);
});

test("an empty response is available with no readable events", async () => {
  const result = await conversationTraceReport("p", "c", [turn("a", 1)],
    jobsOrLog(() => new Response("", { status: 200 })));
  assert.match(result, /No readable events/);
  assert.doesNotMatch(result, /unavailable|not recorded/);
});

test("sentinel secrets in logs never reach the report, including when clipped", async () => {
  const body = (secretLine + "\n").repeat(Math.ceil(MAX / secretLine.length) + 5);
  for (const text of [secretLine + "\n", body]) {
    const result = await conversationTraceReport("p", "c", [turn("a", 1), turn("b", 2, "codex")],
      jobsOrLog(() => new Response(text, { status: 200 })));
    for (const secret of SECRETS) assert.ok(!result.includes(secret), secret);
  }
});
