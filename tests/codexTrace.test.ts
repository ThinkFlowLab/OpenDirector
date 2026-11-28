import assert from "node:assert/strict";
import test from "node:test";
import { createCodexTraceProjection } from "../src/canvas/codexTrace.ts";
function parse(records: unknown[]) {
  const projection = createCodexTraceProjection();
  for (const record of records) projection.append([JSON.stringify(record)]);
  return projection.rows;
}
test("Codex command updates merge in place and retain command, output and failure", () => {
  const start = { native: { type: "item.started", item: { id: "a", type: "command_execution", command: "pwd", status: "in_progress" } } };
  assert.equal(parse([start])[0].native?.item?.status, "in_progress");
  const rows = parse([start, { native: { type: "item.completed", item: { id: "b", type: "agent_message", text: "Working" } } },
    { native: { type: "item.completed", item: { id: "a", aggregated_output: "Permission denied", exit_code: 1, status: "failed" } } }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].native?.item, { id: "a", type: "command_execution", command: "pwd", status: "failed", aggregated_output: "Permission denied", exit_code: 1 });
  assert.equal(rows[1].native?.item?.text, "Working");
});
test("Codex hides lifecycle noise but preserves errors and merges CLI receipts", () => {
  const rows = parse([{ native: { type: "thread.started" } }, { native: { type: "turn.started" } },
    { type: "tool", id: "cli:a", name: "project show", status: "running", arguments: {} },
    { type: "tool", id: "cli:a", status: "completed", result: { ok: true } },
    { native: { type: "item.completed", item: { id: "error", type: "error", message: "API failure" } } }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "project show");
  assert.deepEqual(rows[0].result, { ok: true });
  assert.equal(rows[1].native?.item?.message, "API failure");
  const projection = createCodexTraceProjection();
  projection.append(['{"native":']);
  assert.deepEqual(projection.rows, []);
});
