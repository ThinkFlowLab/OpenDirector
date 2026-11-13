import assert from "node:assert/strict";
import test from "node:test";
import {
  attachChat,
  ChatTurnEnded,
  conversation,
  type ChatEvent,
} from "../src/backend/chat.ts";

const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

test("returning to a project replays the running turn from its start", async (t) => {
  const saved = { messages: [], draft: "", assets: [], thinking: "auto", modelSelections: {} };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.endsWith("/assistant/turns/turn-1/events"));
    return sse([
      { type: "start", conversation: saved },
      { type: "sources", sources: [{ id: "turn1search0", url: "https://example.test/source", title: "Source" }] },
      { type: "delta", text: "继续" },
      { type: "end", conversation: saved, error: null },
    ]);
  });
  const events: ChatEvent[] = [];
  await attachChat("project", "turn-1", new AbortController().signal, (event) =>
    events.push(event),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "sources", "delta", "end"],
  );
  assert.deepEqual(events[1], { type: "sources", sources: [{ id: "turn1search0", url: "https://example.test/source", title: "Source" }] });
  assert.equal(fetch.mock.calls[0]!.arguments[1]?.method, undefined);
});

test("a turn that already ended is reported so the saved conversation is read", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ detail: "ended", code: "not_found" }, { status: 404 }),
  );
  await assert.rejects(
    attachChat("project", "turn-1", new AbortController().signal, () => {}),
    ChatTurnEnded,
  );
});

test("the running turn id stays out of the conversation that drafts are saved from", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      conversationId: "c",
      messages: [{ id: "m", role: "assistant", text: "", status: "streaming" }],
      draft: "",
      assets: [],
      thinking: "auto",
      modelSelections: {},
      activeTurnId: "turn-1",
    }),
  );
  const result = await conversation("project");
  assert.equal(result.activeTurnId, "turn-1");
  assert.equal("activeTurnId" in result.conversation, false);
  assert.equal(result.conversation.messages[0]!.status, "streaming");
});
