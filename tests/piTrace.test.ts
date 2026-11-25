import assert from "node:assert/strict";
import test from "node:test";
import { normalizePiTrace } from "../src/canvas/piTrace.ts";
const parse = (records: unknown[]) => normalizePiTrace(records.map(record => JSON.stringify(record)).join("\n")).split("\n").filter(Boolean).map(line => JSON.parse(line));
const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({ native: { type: "message_end", message: { role, content, timestamp: 1733234401000, ...extra } } });
const call = (type: string, toolCallId: string, extra: Record<string, unknown> = {}) => ({ native: { type, toolCallId, toolName: "bash", ...extra } });
const kinds = (rows: { native: { type: string; role?: string } }[]) => rows.map(row => `${row.native.type}:${row.native.role ?? "-"}`);

test("pi messages render with their own role and one tool row carries the result", () => {
  const rows = parse([
    { native: { type: "session", version: 3, id: "session-1" } }, { native: { type: "agent_start" } }, { native: { type: "turn_start" } },
    message("user", "List the project"),
    { native: { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } } },
    { native: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working" } } },
    message("assistant", [{ type: "thinking", thinking: "Read the list first" }, { type: "text", text: "Working" },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "opendirector project show" } }], { stopReason: "toolUse" }),
    call("tool_execution_start", "call_1", { args: { command: "opendirector project show" } }),
    call("tool_execution_update", "call_1", { args: { command: "opendirector project show" }, partialResult: { content: [{ type: "text", text: "partial" }] } }),
    call("tool_execution_end", "call_1", { args: { command: "opendirector project show" }, result: { content: [{ type: "text", text: "{\"nodes\":2}" }] }, isError: false, durationMs: 412 }),
    message("toolResult", [{ type: "text", text: "{\"nodes\":2}" }], { toolCallId: "call_1", toolName: "bash", isError: false }),
    message("assistant", [{ type: "text", text: "The project has two nodes." }], { stopReason: "stop" }),
    { native: { type: "turn_end" } }, { native: { type: "agent_end", messages: [], willRetry: false } }, { native: { type: "agent_settled", aborted: false } },
  ]);
  assert.deepEqual(kinds(rows), ["text:user", "reasoning:-", "text:assistant", "tool_use:-", "text:assistant"]);
  assert.equal(rows[0].native.part.text, "List the project");
  assert.equal(rows[1].native.part.text, "Read the list first");
  assert.deepEqual(rows[3].native.part, { tool: "bash", state: { status: "completed", input: { command: "opendirector project show" }, output: "{\"nodes\":2}" } });
  assert.equal(rows[3].native.durationMs, 412);
  assert.equal(rows[1].native.timestamp, 1733234401000);
});

test("parallel calls keep separate identities and a failure keeps its flag", () => {
  const rows = parse([call("tool_execution_start", "a", { args: { path: "a.md" } }), call("tool_execution_start", "b", { args: { path: "b.md" } }),
    call("tool_execution_end", "b", { result: { content: [{ type: "text", text: "ENOENT" }] }, isError: true }),
    call("tool_execution_update", "a", { partialResult: { content: [{ type: "text", text: "half" }] } })]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].native.part.state.status, "in_progress");
  assert.equal(rows[0].native.part.state.output, "half");
  assert.deepEqual(rows[1].native.part.state, { status: "failed", input: { path: "b.md" }, output: "ENOENT" });
});

test("a retried attempt does not fail the turn and only the settled agent_end reports the error", () => {
  const rows = parse([message("assistant", [], { stopReason: "error", errorMessage: "rate limited" }),
    message("assistant", [{ type: "text", text: "Attempt two" }], { stopReason: "stop" }),
    { native: { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }], willRetry: false } }]);
  assert.deepEqual(kinds(rows), ["text:assistant"]);
  const failed = parse([message("assistant", [], { stopReason: "error", errorMessage: "rate limited" }),
    { native: { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "登录已过期" }], willRetry: false } }]);
  assert.deepEqual(kinds(failed), ["error:-"]);
  assert.equal(failed[0].native.part.text, "登录已过期");
  const anonymous = parse([{ native: { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error" }] } }]);
  assert.equal(anonymous[0].native.type, "agent_end");
});

test("an unfinished call still shows, unknown records are kept and broken lines are dropped", () => {
  const rows = parse([call("tool_execution_end", "orphan", { result: { content: [{ type: "text", text: "" }] }, isError: false }),
    { native: { type: "compaction_start", reason: "threshold" } }]);
  assert.deepEqual(kinds(rows), ["tool_use:-", "compaction_start:-"]);
  assert.equal(rows[0].native.part.state.status, "completed");
  assert.equal(normalizePiTrace('{"native":'), "");
  assert.equal(normalizePiTrace('{"native":{"type":"message_end"}}\nnot json'), "");
});
