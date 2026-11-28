import assert from "node:assert/strict";
import test from "node:test";
import { createDeepseekTraceProjection } from "../src/canvas/deepseekTrace.ts";

function update(value: object) {
  return { native: { jsonrpc: "2.0", method: "session/update", params: { update: value } } };
}

function project(records: object[]) {
  const projection = createDeepseekTraceProjection();
  for (const record of records) projection.append([JSON.stringify(record)]);
  return projection.rows;
}

test("ACP chunks form separate assistant and thinking rows by message identity", () => {
  const records = [
    update({ sessionUpdate: "agent_thought_chunk", messageId: "a", content: { type: "text", text: "Inspect " } }),
    update({ sessionUpdate: "agent_thought_chunk", messageId: "a", content: { type: "text", text: "the project." } }),
    update({ sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "Working." } }),
    update({ sessionUpdate: "agent_thought_chunk", messageId: "b", content: { type: "text", text: "Next step." } }),
  ];
  const rows = project(records).map((row) => {
    assert.ok("raw" in row);
    return row;
  });
  assert.deepEqual(rows.map((row) => [row.native.type, row.native.part.text]), [
    ["reasoning", "Inspect the project."], ["text", "Working."], ["reasoning", "Next step."],
  ]);
  assert.equal(rows[0].raw.length, 2);
});

test("tool updates preserve arguments and update one row for each parallel call", () => {
  const start = (toolCallId: string) => update({ sessionUpdate: "tool_call", toolCallId,
    title: "bash", status: "in_progress", rawInput: { command: toolCallId } });
  const running = project([start("a"), start("b")]);
  assert.partialDeepStrictEqual(running[0], { native: { part: { state: { status: "in_progress" } } } });
  const rows = project([start("a"), start("b"), update({
    sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Done" } }],
  })]);
  assert.equal(rows.length, 2);
  assert.partialDeepStrictEqual(rows, [
    { native: { part: { state: { status: "completed", input: { command: "a" } } } } },
    { native: { part: { state: { status: "in_progress" } } } },
  ]);
  const first = rows[0];
  assert.ok("raw" in first);
  assert.equal(first.raw.length, 2);
});

test("transport handshakes and usage stay out of the activity list while CLI receipts remain", () => {
  const receipt = { type: "tool", name: "opendirector project show", status: "complete" };
  const rows = project([
    { native: { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } } },
    update({ sessionUpdate: "usage_update", used: 123, size: 1000 }),
    receipt,
    { native: { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } } },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], receipt);
  assert.partialDeepStrictEqual(rows[1], { native: { part: { reason: "end_turn" } } });
});
