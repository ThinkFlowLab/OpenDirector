import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeTraceProjection } from "../src/canvas/claudeTrace.ts";
function parse(records: unknown[]) {
  const projection = createClaudeTraceProjection();
  for (const record of records) projection.append([JSON.stringify(record)]);
  return projection.rows;
}
const message = (type: string, content: unknown[]) => ({ native: { type, message: { role: type, content } } });
test("assistant tool_use is a tool and user tool_result updates the same call", () => {
  const rows = parse([message("assistant", [{ type: "tool_use", id: "call1", name: "Bash", input: { command: "pwd && ls -la" } }]),
    message("user", [{ type: "tool_result", tool_use_id: "call1", content: "/work", is_error: false }])]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { native: { type: "tool_use", part: {
    tool: "Bash", state: { status: "completed", input: { command: "pwd && ls -la" }, output: "/work" },
  } }, callId: "call1" });
});
test("mixed Claude content retains text, reasoning and separate parallel tool identities", () => {
  const rows = parse([message("assistant", [{ type: "text", text: "Working" }, { type: "thinking", thinking: "Plan", signature: "opaque" },
    { type: "tool_use", id: "a", name: "Bash", input: {} }, { type: "tool_use", id: "b", name: "Bash", input: {} }]),
    message("user", [{ type: "tool_result", tool_use_id: "b", content: "Error", is_error: true }])]);
  assert.equal(rows.length, 4);
  assert.partialDeepStrictEqual(rows, [
    { native: { type: "text" } },
    { native: { type: "reasoning" } },
    { native: { type: "tool_use", part: { state: { status: "in_progress" } } } },
    { native: { type: "tool_use", part: { state: { status: "failed" } } } },
  ]);
  assert.ok(!JSON.stringify(rows).includes("opaque"));
  const projection = createClaudeTraceProjection();
  projection.append(['{"native":']);
  assert.deepEqual(projection.rows, []);
});
