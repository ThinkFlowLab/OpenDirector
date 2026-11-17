import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCommand,
  createDocument,
  createNode,
  TEXT_NODE_MIN_SIZE,
} from "../src/canvas/model.ts";
import {
  beginTransaction,
  commitTransaction,
  createHistory,
  executeCommand,
  undo,
} from "../src/canvas/history.ts";
import { authorFlowChanges } from "../src/canvas/workspaceInteraction.ts";

test("text resize clamps each axis, preserves Markdown, and commits one undo step", () => {
  const text = createNode(
    "text",
    { x: 12, y: 24 },
    { text: "# Heading\n\n```js\nconst x = `原文`;\n```" },
  );
  const doc = { ...createDocument(), nodes: [text] };
  let history = beginTransaction(createHistory(doc));
  for (const dimensions of [
    { width: 600, height: 60 },
    { width: 10, height: 400 },
  ]) {
    const command = authorFlowChanges(
      [{ type: "dimensions", id: text.id, dimensions, setAttributes: true }],
      { cancelled: false, dragging: false, moved: true },
    );
    history = executeCommand(history, command!);
    assert.equal(history.past.length, 0);
  }
  history = commitTransaction(history);
  assert.equal(history.past.length, 1);
  assert.equal(history.present.nodes[0]!.width, TEXT_NODE_MIN_SIZE.width);
  assert.equal(history.present.nodes[0]!.height, 400);
  assert.equal(history.present.nodes[0]!.data, text.data);
  assert.deepEqual(undo(history).present, doc);
  const short = applyCommand(doc, {
    type: "resize-node",
    id: text.id,
    width: 550,
    height: 10,
  });
  assert.equal(short.nodes[0]!.height, TEXT_NODE_MIN_SIZE.height);
  assert.equal(short.nodes[0]!.width, 550);
});

test("text locks, including a locked parent, reject resize and source edits", () => {
  const parent = { ...createNode("group"), locked: true };
  for (const text of [
    { ...createNode("text"), locked: true },
    { ...createNode("text"), parentId: parent.id },
  ]) {
    const doc = { ...createDocument(), nodes: [parent, text] };
    assert.equal(
      applyCommand(doc, {
        type: "resize-node",
        id: text.id,
        width: 600,
        height: 400,
      }),
      doc,
    );
    assert.equal(
      applyCommand(doc, {
        type: "update-node",
        id: text.id,
        patch: { data: { text: "overwritten" } },
      }),
      doc,
    );
  }
});
