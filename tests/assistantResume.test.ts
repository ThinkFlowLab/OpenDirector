import assert from "node:assert/strict";
import test from "node:test";
import { setLeaseRecovery } from "../src/backend/api.ts";
import {
  attachChat,
  ChatTurnEnded,
  conversation,
  streamDecisionContinuation,
  streamPlanConfirmation,
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

test("streaming continuation and plan confirmation recover a lapsed lease once", async (t) => {
  const saved = { messages: [], draft: "", assets: [], thinking: "auto", modelSelections: {} };
  const expired = () =>
    Response.json({ detail: "会话已过期", code: "session_expired" }, { status: 409 });
  let renewedCount = 0;
  setLeaseRecovery(async (projectId) => {
    assert.equal(projectId, "project-1");
    renewedCount += 1;
    return true;
  });
  t.after(() => setLeaseRecovery(undefined));

  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    attempts += 1;
    if (attempts === 1 || attempts === 3) return expired();
    assert.ok(url.includes("/continuations/cont-1") || url.includes("/tasks/task-1/confirm-plan"));
    return sse([
      { type: "start", turnId: "seg-1", conversation: saved },
      { type: "end", turnId: "seg-1", nextTurnId: null, conversation: saved, error: null },
    ]);
  });

  const seen: string[] = [];
  await streamDecisionContinuation(
    "project-1",
    "cont-1",
    new AbortController().signal,
    (event) => seen.push(event.type),
  );
  await streamPlanConfirmation(
    "project-1",
    "task-1",
    1,
    new AbortController().signal,
    (event) => seen.push(event.type),
  );
  assert.equal(renewedCount, 2);
  assert.equal(attempts, 4);
  assert.deepEqual(seen, ["start", "end", "start", "end"]);
});

test("an interrupted chained turn after nextTurnId is still reported as interrupted", async (t) => {
  const saved = { messages: [], draft: "", assets: [], thinking: "auto", modelSelections: {} };
  t.mock.method(globalThis, "fetch", async () =>
    sse([
      { type: "start", turnId: "turn-1", conversation: saved },
      { type: "end", turnId: "turn-1", nextTurnId: "turn-2", conversation: saved, error: null },
      { type: "start", turnId: "turn-2", conversation: saved },
      { type: "delta", text: "一半" },
    ]),
  );
  await assert.rejects(
    attachChat("project-1", "turn-1", new AbortController().signal, () => {}),
    /中断|interrupted/i,
  );
});
