import assert from "node:assert/strict";
import test from "node:test";
import {
  continueQueue,
  retractChatMessage,
  sendChat,
  type ChatEvent,
  type ChatRequest,
} from "../src/backend/chat.ts";

const request: ChatRequest = {
  id: "message-1",
  text: "再补一点",
  assets: [],
  thinking: "auto",
  modelSelections: {},
};

const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

test("a message sent while a reply runs is queued instead of started", async (t) => {
  const queued = {
    id: "message-1",
    role: "user",
    text: "再补一点",
    status: "queued",
    queueSeq: 2,
  };
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      assert.ok(url.endsWith("/assistant/messages"));
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({ queued, chainId: "chain-1", turnId: "turn-1" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const events: ChatEvent[] = [];
  const accepted = await sendChat(
    "project",
    request,
    new AbortController().signal,
    (event) => events.push(event),
  );
  assert.equal(accepted?.queued.status, "queued");
  assert.equal(accepted?.chainId, "chain-1");
  assert.deepEqual(events, []);
  assert.equal(fetch.mock.calls.length, 1);
});

test("an idle project answers on the same endpoint with the running reply", async (t) => {
  const saved = {
    messages: [],
    draft: "",
    assets: [],
    thinking: "auto",
    modelSelections: {},
  };
  t.mock.method(globalThis, "fetch", async () =>
    sse([
      { type: "start", conversation: saved },
      { type: "delta", text: "先做这个" },
      // The chain moves on to a queued message on the same stream.
      {
        type: "end",
        turnId: "turn-1",
        nextTurnId: "turn-2",
        conversation: saved,
        error: null,
      },
      { type: "start", conversation: saved },
      { type: "delta", text: "｜完" },
      {
        type: "end",
        turnId: "turn-2",
        nextTurnId: null,
        conversation: saved,
        error: null,
      },
    ]),
  );
  const events: ChatEvent[] = [];
  const accepted = await sendChat(
    "project",
    request,
    new AbortController().signal,
    (event) => events.push(event),
  );
  assert.equal(accepted, null);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "delta", "end", "start", "delta", "end"],
  );
  const ends = events.filter((event) => event.type === "end");
  assert.equal(ends[0]!.type === "end" && ends[0]!.nextTurnId, "turn-2");
  assert.equal(ends[1]!.type === "end" && ends[1]!.nextTurnId, null);
});

test("a queued message is withdrawn through the message itself", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      assert.ok(url.endsWith("/assistant/messages/message-2"));
      assert.equal(init?.method, "DELETE");
      return new Response(
        JSON.stringify({
          retracted: "message-2",
          conversation: { messages: [], draft: "", assets: [], thinking: "auto", modelSelections: {} },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const result = await retractChatMessage("project", "message-2");
  assert.equal(result.retracted, "message-2");
  assert.equal(fetch.mock.calls.length, 1);
});

test("a stalled queue is continued and its reply read from the same stream", async (t) => {
  const saved = {
    messages: [],
    draft: "",
    assets: [],
    thinking: "auto",
    modelSelections: {},
  };
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: string) => {
      assert.ok(url.endsWith("/assistant/queue/dispatch"));
      return sse([
        { type: "start", conversation: saved },
        { type: "delta", text: "继续" },
        { type: "end", turnId: "turn-2", nextTurnId: null, conversation: saved, error: null },
      ]);
    },
  );
  const events: ChatEvent[] = [];
  await continueQueue("project", new AbortController().signal, (event) => events.push(event));
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "delta", "end"],
  );
  assert.equal(fetch.mock.calls.length, 1);
});
