import assert from "node:assert/strict";
import test from "node:test";
import { canvasLinkClickAction } from "../src/canvas/assistantCanvasLink.ts";
import type { ChatCanvasLink } from "../src/backend/chat.ts";

const id = "11111111-1111-4111-8111-111111111111";

function link(overrides: Partial<ChatCanvasLink>): ChatCanvasLink {
  return {
    target: "notes.md",
    status: "focused",
    nodeId: null,
    assetId: null,
    projectId: null,
    kind: null,
    action: null,
    candidates: null,
    ...overrides,
  };
}

test("focused and hidden links focus their node id on click", () => {
  assert.deepEqual(canvasLinkClickAction(link({ status: "focused", nodeId: id })), { focus: id });
  assert.deepEqual(canvasLinkClickAction(link({ status: "hidden", nodeId: id, action: "reveal" })), { focus: id });
});

test("a focused link without a node id never focuses", () => {
  assert.deepEqual(canvasLinkClickAction(link({ status: "focused", nodeId: null })), {
    hintKey: "assistant.reply.canvasLink.missing",
  });
});

test("non-focusable outcomes show a translated hint and never focus a colliding id", () => {
  const projectId = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(canvasLinkClickAction(link({ status: "cross-project", nodeId: id, projectId })), {
    hintKey: "assistant.reply.canvasLink.crossProject",
    projectId,
  });
  assert.deepEqual(canvasLinkClickAction(link({ status: "materialize", assetId: id })), {
    hintKey: "assistant.reply.canvasLink.materialize",
  });
  assert.deepEqual(canvasLinkClickAction(link({ status: "ambiguous" })), {
    hintKey: "assistant.reply.canvasLink.ambiguous",
  });
  assert.deepEqual(canvasLinkClickAction(link({ status: "missing" })), {
    hintKey: "assistant.reply.canvasLink.missing",
  });
  assert.deepEqual(canvasLinkClickAction(link({ status: "external" })), {
    hintKey: "assistant.reply.canvasLink.missing",
  });
});
