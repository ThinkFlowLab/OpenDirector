import assert from "node:assert/strict";
import test from "node:test";
import { streamChat, type ChatEvent } from "../src/backend/chat.ts";

// #502: when the final write fails the server ends the stream with
// `{type: "end", conversation: null, error}`. The client must deliver that
// frame as the terminal event (not as "interrupted") with the partial text intact.
test("a failed finish ends the stream with its error and no conversation", async (t) => {
  const error = "回复未能保存，请检查后端日志。";
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      [
        { type: "delta", text: "已输出的部分回复" },
        { type: "end", turnId: "t", nextTurnId: null, conversation: null, error },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    ),
  );
  const events: ChatEvent[] = [];
  await streamChat(
    "project",
    { id: "t", runtime: "default", text: "x" } as never,
    new AbortController().signal,
    (event) => events.push(event),
  );
  assert.deepEqual(events.map((event) => event.type), ["delta", "end"]);
  const end = events[1] as Extract<ChatEvent, { type: "end" }>;
  assert.equal(end.conversation, null);
  assert.equal(end.error, error);
});
