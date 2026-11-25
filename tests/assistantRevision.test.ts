import assert from "node:assert/strict";
import test from "node:test";
import { turnRequest } from "../src/canvas/chatTurnRequest.ts";
import type { Conversation } from "../src/backend/chat.ts";

const conversation = (patch: Partial<Conversation> = {}): Conversation => ({
  messages: [],
  draft: "NEW-标记",
  assets: [],
  thinking: "auto",
  modelSelections: {},
  conversationId: "conversation-1",
  revision: 4,
  ...patch,
});

test("an ordinary turn carries no revision identity", () => {
  const body = turnRequest(conversation(), { id: "turn-2", modelId: "model", editing: null });
  assert.equal(body.revisionOf, undefined);
  assert.equal(body.expectedRevision, undefined);
  assert.equal(body.text, "NEW-标记");
});

test("an edit names the stopped turn and the revision it was composed on", () => {
  const editing = {
    turnId: "turn-stopped",
    conversationId: "conversation-1",
    saved: { draft: "", draftContent: null, assets: [], skills: [] },
  };
  const body = turnRequest(conversation(), {
    id: "turn-3", modelId: "model", editing, revision: 4,
  });
  assert.equal(body.revisionOf, "turn-stopped");
  assert.equal(body.expectedRevision, 4);
  // The revised text is what the new attempt sends, exactly once.
  assert.equal(body.text, "NEW-标记");
});

test("an edit keeps the references and skills of the message it revises", () => {
  const editing = {
    turnId: "turn-stopped",
    conversationId: "conversation-1",
    saved: { draft: "", draftContent: null, assets: [], skills: [] },
  };
  const body = turnRequest(
    conversation({
      assets: [{ id: "asset-1", name: "a", type: "image/png", size: 1, fingerprint: "f" }],
      skills: ["canvas"],
      draftContent: [{ type: "text", text: "NEW-标记" }],
    }),
    { id: "turn-3", modelId: "model", editing, revision: 4 },
  );
  assert.deepEqual(body.assets, ["asset-1"]);
  assert.deepEqual(body.skills, ["canvas"]);
  assert.deepEqual(body.content, [{ type: "text", text: "NEW-标记" }]);
});
