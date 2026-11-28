import assert from "node:assert/strict";
import test from "node:test";
import { saveChatDraft, type Conversation } from "../src/backend/chat.ts";
import { draftOf, flushChatDraft, rememberChat } from "../src/backend/chatDrafts.ts";

const conversation = (extra: Record<string, unknown>): Conversation =>
  ({
    conversationId: "conversation-1",
    draft: "写一段开场",
    draftContent: null,
    assets: [],
    thinking: "auto",
    builtinModelThinking: {},
    modelSelections: {},
    runtime: "default",
    runtimeModel: null,
    harnessModels: {},
    skills: [],
    messages: [{ id: "m-1", role: "user", text: "hi" }],
    ...extra,
  }) as unknown as Conversation;

const EXPECTED_KEYS = [
  "assets",
  "builtinModelThinking",
  "conversationId",
  "draft",
  "draftContent",
  "harnessModels",
  "modelSelections",
  "runtime",
  "runtimeModel",
  "skills",
  "thinking",
];

test("the saved draft sends only the fields the draft endpoint takes", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      assert.ok(url.endsWith("/assistant/draft"));
      assert.equal(init?.method, "PUT");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  // A conversation read carries messages, activeTurnId, decisions and tasks.
  const enriched = conversation({
    activeTurnId: "turn-1",
    decisions: [{ requestId: "req-1", status: "waiting_input" }],
    tasks: [{ taskId: "task-1", stage: "waiting_confirmation" }],
  });
  rememberChat("project-1", enriched);
  await flushChatDraft("project-1");
  await saveChatDraft("project-1", {
    ...draftOf(enriched),
    modelSelections: { agent: "agent-1" },
  });
  await saveChatDraft("project-1", enriched);

  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.ok(!("activeTurnId" in body), "activeTurnId must not be echoed back");
    assert.ok(!("messages" in body), "the transcript is not part of a draft");
    assert.ok(!("decisions" in body), "decisions must not be echoed back");
    assert.ok(!("tasks" in body), "tasks must not be echoed back");
    assert.deepEqual(Object.keys(body).sort(), EXPECTED_KEYS);
  }
  assert.equal(bodies[0]!.draft, "写一段开场");
  assert.deepEqual(bodies[1]!.modelSelections, { agent: "agent-1" });
});
