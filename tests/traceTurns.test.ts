import assert from "node:assert/strict";
import test from "node:test";
import { initialTurn, normalizeTrace, runtimeName, traceRuntime, traceSources, type ConversationTurn } from "../src/canvas/traceTurns.ts";

const turn = (id: string, number: number, runtime = "default"): ConversationTurn =>
  ({ id, number, text: id, runtime, model: null, status: "complete" });

test("each turn reads its own runtime's log sources", () => {
  assert.deepEqual(traceSources(traceRuntime("default")), ["model", "opencode"]);
  assert.deepEqual(traceSources(traceRuntime("codex")), ["codex"]);
  assert.deepEqual(traceSources(traceRuntime("deepseek")), ["deepseek"]);
  assert.equal(runtimeName("deepseek"), "DeepSeek Harness");
  assert.equal(runtimeName("unknown"), "unknown");
});

test("normalizers are selected by the turn's source, other sources pass through", () => {
  const body = '{"event":"model.request"}\n';
  assert.equal(normalizeTrace("opencode", body), body);
  assert.equal(normalizeTrace("model", body), body);
  assert.notEqual(normalizeTrace("codex", '{"type":"thread.started"}\n'), undefined);
});

test("linked turn is opened, otherwise the latest", () => {
  const turns = [turn("a", 1), turn("b", 2, "codex"), turn("c", 3, "deepseek")];
  assert.equal(initialTurn(turns, "a"), "a");
  assert.equal(initialTurn(turns, ""), "c");
  assert.equal(initialTurn(turns, "missing"), "c");
  assert.equal(initialTurn([], "a"), "");
});
