import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "../src/backend/chat.ts";
import { flushChatDraft, rememberChat } from "../src/backend/chatDrafts.ts";

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
    messages: [],
    ...extra,
  }) as unknown as Conversation;

test("the saved draft sends only the fields the draft endpoint takes", async (t) => {
  let body: Record<string, unknown> = {};
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      assert.ok(url.endsWith("/assistant/draft"));
      assert.equal(init?.method, "PUT");
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  // A conversation read while a reply is running carries activeTurnId.
  rememberChat("project-1", conversation({ activeTurnId: "turn-1" }));
  await flushChatDraft("project-1");
  assert.ok(!("activeTurnId" in body), "activeTurnId must not be echoed back");
  assert.ok(!("messages" in body), "the transcript is not part of a draft");
  assert.deepEqual(Object.keys(body).sort(), [
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
  ]);
  assert.equal(body.draft, "写一段开场");
});
