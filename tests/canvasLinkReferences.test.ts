import assert from "node:assert/strict";
import test from "node:test";
import { prepareCanvasReferences, renderCanvasReferences } from "../src/canvas/canvasReferences.ts";
import { applyCanvasLinkClick } from "../src/canvas/assistantCanvasLink.ts";
import type { ChatCanvasLink } from "../src/backend/chat.ts";

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
};
type HastNode = HastText | HastElement | { type: string };
type HastRoot = { type: "root"; children: HastNode[] };

const nodeId = "11111111-1111-4111-8111-111111111111";

function link(overrides: Partial<ChatCanvasLink>): ChatCanvasLink {
  return {
    target: `canvas:${nodeId}`,
    status: "focused",
    nodeId,
    assetId: null,
    projectId: null,
    kind: "text",
    action: null,
    candidates: null,
    ...overrides,
  };
}

/** What Streamdown's Markdown renderer hands to the rehype chain. */
function anchorTree(href: string, label = "Finished note"): HastRoot {
  return {
    type: "root",
    children: [{
      type: "element",
      tagName: "p",
      properties: {},
      children: [{
        type: "element",
        tagName: "a",
        properties: { href },
        children: [{ type: "text", value: label }],
      }],
    }],
  };
}

function anchor(tree: HastRoot): HastElement {
  return (tree.children[0] as HastElement).children[0] as HastElement;
}

function chain(tree: HastRoot, targets: string[]): void {
  // Mirrors the production plugin order in AssistantReply: prepare, then the
  // third-party sanitize/harden passes (which see only the https placeholder
  // asserted below), then render.
  prepareCanvasReferences({ targets })(tree as never);
  renderCanvasReferences({ targets })(tree as never);
}

test("a persisted markdown reference becomes a clickable canvas-reference", () => {
  const persisted = link({});
  // Use the real message.canvasLinks map the component builds.
  const links = new Map([[persisted.target, persisted]]);
  const targets = Array.from(links.keys());
  const tree = anchorTree(persisted.target);

  prepareCanvasReferences({ targets })(tree as never);
  // The placeholder must be an ordinary https URL so the sanitizer keeps it.
  assert.equal(anchor(tree).tagName, "a");
  assert.match(String(anchor(tree).properties.href),
    /^https:\/\/opendirector\.invalid\/canvas-reference\/0$/);

  renderCanvasReferences({ targets })(tree as never);
  const reference = anchor(tree);
  assert.equal(reference.tagName, "canvas-reference");
  assert.equal(reference.properties.href, persisted.target);
  assert.deepEqual(reference.children, [{ type: "text", value: "Finished note" }]);

  // The component looks the rendered href back up in the persisted links and
  // applies the click action; a focused link must reach the canvas callback.
  const focused: string[] = [];
  const hint = applyCanvasLinkClick(links.get(String(reference.properties.href))!, (id) => focused.push(id));
  assert.equal(hint, null);
  assert.deepEqual(focused, [nodeId]);
});

test("a reference target that is not persisted stays an ordinary anchor", () => {
  // The component only passes targets it has resolved links for; an anchor
  // whose destination is not in message.canvasLinks must not become a
  // canvas-reference with a guessed identity.
  const links = new Map<string, ChatCanvasLink>();
  const targets = Array.from(links.keys());
  const href = `canvas:${nodeId}`;
  const tree = anchorTree(href);

  chain(tree, targets);

  const untouched = anchor(tree);
  assert.equal(untouched.tagName, "a");
  assert.equal(untouched.properties.href, href);
  assert.equal(links.get(String(untouched.properties.href)), undefined);
});

test("a materialize reference renders but reports a declarative hint", () => {
  const persisted = link({ target: "notes.md", status: "materialize", nodeId: null,
    assetId: "22222222-2222-4222-8222-222222222222", action: "materialize" });
  const links = new Map([[persisted.target, persisted]]);
  const targets = Array.from(links.keys());
  const tree = anchorTree(persisted.target, "notes.md");

  chain(tree, targets);
  const reference = anchor(tree);
  assert.equal(reference.tagName, "canvas-reference");

  const focused: string[] = [];
  const hint = applyCanvasLinkClick(links.get(String(reference.properties.href))!, (id) => focused.push(id));
  assert.deepEqual(focused, []);
  assert.deepEqual(hint, { hintKey: "assistant.reply.canvasLink.materialize" });
});
