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
  assert.ok(result.includes("Review <secret> \\[report\\]"));
  assert.ok(!result.includes("Review <secret> [report]"));
});
