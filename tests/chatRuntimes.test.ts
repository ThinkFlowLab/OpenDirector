import assert from "node:assert/strict";
import test from "node:test";
import { chatRuntimeInventory, chatRuntimeStatus, type RuntimeInfo } from "../src/backend/chat.ts";

test("canvas changes reuse a known runtime status without probing the other harnesses", async (t) => {
  const codex: RuntimeInfo = {
    id: "codex", label: "Codex", status: "checking", available: true,
    group: "harness", modelSource: "cli", modelOverride: true,
  };
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    if (url.endsWith("?probe=false")) return Response.json([codex, { ...codex, id: "claude" }]);
    assert.ok(url.endsWith("/codex/status"));
    return Response.json({ ...codex, status: "ready" });
  });

  assert.equal((await chatRuntimeInventory("source"))[0].status, "checking");
  await chatRuntimeStatus("source", "codex");
  const target = await chatRuntimeInventory("target");
  assert.equal(target[0].status, "ready");
  assert.equal(target[1].status, "checking");
  await chatRuntimeStatus("target", "codex");
  assert.equal(calls.filter((url) => url.endsWith("/status")).length, 1);
  await chatRuntimeStatus("target", "codex", undefined, true);
  assert.equal(calls.filter((url) => url.endsWith("/status")).length, 2);
});
