import assert from "node:assert/strict";
import test from "node:test";
import { createTraceCursor } from "../src/canvas/traceCursor.ts";

test("a live DeepSeek cursor merges split updates, retains snapshots and drains at completion", async (context) => {
  function event(sessionUpdate: string, text: string) {
    return JSON.stringify({ native: { jsonrpc: "2.0", params: { update: {
      sessionUpdate, messageId: "a", content: { type: "text", text },
    } } } }) + "\n";
  }
  const initial = Buffer.from(event("agent_message_chunk", "先检查"));
  const delta = Buffer.from(event("agent_message_chunk", "场景。"));
  const split = delta.indexOf(Buffer.from("场")) + 1;
  const responses = [
    new Response(initial, { headers: { "X-Trace-Cursor": "1:2:100", "X-Trace-Running": "1" } }),
    new Response(delta.subarray(0, split), { headers: { "X-Trace-Cursor": "1:2:200", "X-Trace-Running": "1" } }),
    new Response(delta.subarray(split), { headers: { "X-Trace-Cursor": "1:2:300", "X-Trace-Running": "0" } }),
  ];
  const fetch = context.mock.method(globalThis, "fetch", async () => responses.shift());
  const cursor = createTraceCursor("deepseek");
  const initialRead = await cursor.read("/traces/turn", {}, true);
  const partialRead = await cursor.read("/traces/turn", {}, true);
  const terminal = await cursor.read("/traces/turn", {}, true);
  assert.equal(partialRead.snapshot, initialRead.snapshot);
  assert.equal(partialRead.follow, true);
  assert.equal(terminal.follow, false);
  assert.equal(terminal.more, false);
  assert.equal(initialRead.snapshot.rows.length, 1);
  assert.equal(terminal.snapshot.rows.length, 1);
  assert.partialDeepStrictEqual(initialRead.snapshot.rows[0], { native: { part: { text: "先检查" } } });
  assert.partialDeepStrictEqual(terminal.snapshot.rows[0], { native: { part: { text: "先检查场景。" } } });
  assert.deepEqual(fetch.mock.calls.map((call) => call.arguments[0]), [
    "/traces/turn/deepseek?cursor=", "/traces/turn/deepseek?cursor=1%3A2%3A100",
    "/traces/turn/deepseek?cursor=1%3A2%3A200",
  ]);
});
