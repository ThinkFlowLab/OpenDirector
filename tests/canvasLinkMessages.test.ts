import assert from "node:assert/strict";
import test from "node:test";
import { translate } from "../src/i18n/messages.ts";
import { zhCN } from "../src/i18n/messages/zh-CN/index.ts";
import { enUS } from "../src/i18n/messages/en-US/index.ts";
import { renderCanvasMentions } from "../src/canvas/assistantCanvasMentions.ts";

type HastText = { type: "text"; value: string };
type HastElement = { type: "element"; tagName: string; properties: Record<string, unknown>; children: HastNode[] };
type HastNode = HastText | HastElement | { type: string };
type HastRoot = { type: "root"; children: HastNode[] };

function text(value: string): HastText {
  return { type: "text", value };
}

function element(tagName: string, children: HastNode[], properties: Record<string, unknown> = {}): HastElement {
  return { type: "element", tagName, properties, children };
}

function rendered(value: string, targets: string[]): HastNode[] {
  const tree: HastRoot = { type: "root", children: [element("p", [text(value)])] };
  renderCanvasMentions({ targets })(tree as unknown as Parameters<ReturnType<typeof renderCanvasMentions>>[0]);
  return (tree.children[0] as HastElement).children;
}

const keys = [
  "assistant.reply.canvasLink.materialize",
  "assistant.reply.canvasLink.ambiguous",
  "assistant.reply.canvasLink.missing",
  "assistant.reply.canvasLink.crossProject",
] as const;

test("canvas link messages exist in both catalogs", () => {
  for (const key of keys) {
    assert.ok(key in zhCN, `missing zh-CN key ${key}`);
    assert.ok(key in enUS, `missing en-US key ${key}`);
  }
});

test("canvas link messages resolve in both locales without leaking the other language", () => {
  for (const key of keys) {
    const zh = translate("zh-CN", key);
    const en = translate("en-US", key);
    assert.ok(zh.length > 0 && en.length > 0);
    assert.match(zh, /[㐀-鿿]/, `${key} should be Chinese`);
    assert.doesNotMatch(en, /[㐀-鿿]/, `${key} must not contain Chinese`);
    assert.notEqual(zh, en);
  }
});

test("canvas link outcome copy names the user-visible action", () => {
  // Hidden links focus their node (which the workspace reveals); only
  // outcomes that cannot focus have a hint, so there is no hidden hint key.
  assert.equal(translate("en-US", "assistant.reply.canvasLink.materialize"), "Show on canvas");
  assert.equal(translate("zh-CN", "assistant.reply.canvasLink.materialize"), "在画布中显示");
});

test("a standalone mention renders as a clickable canvas reference", () => {
  assert.deepEqual(rendered("@Title", ["@Title"]), [
    element("canvas-reference", [text("@Title")], { href: "@Title" }),
  ]);
});

test("a mention glued to a word character stays plain prose", () => {
  assert.deepEqual(rendered("foo@Title", ["@Title"]), [text("foo@Title")]);
  assert.deepEqual(rendered("see foo@Title and @Title", ["@Title"]), [
    text("see foo@Title and "),
    element("canvas-reference", [text("@Title")], { href: "@Title" }),
  ]);
});

test("CJK prose directly before a mention is a boundary, like the backend", () => {
  // JavaScript \w is ASCII-only, so the Chinese character before @ is prose,
  // not part of the mention; the backend now uses the same boundary.
  assert.deepEqual(rendered("看这个@Title", ["@Title"]), [
    text("看这个"),
    element("canvas-reference", [text("@Title")], { href: "@Title" }),
  ]);
});

test("a mention inside an anchor (an autolinked URL) is left untouched", () => {
  const tree: HastRoot = {
    type: "root",
    children: [element("a", [text("https://x/@Title")], { href: "https://x/@Title" })],
  };
  renderCanvasMentions({ targets: ["@Title"] })(tree as unknown as Parameters<ReturnType<typeof renderCanvasMentions>>[0]);
  const anchor = tree.children[0] as HastElement;
  assert.equal(anchor.tagName, "a");
  assert.deepEqual(anchor.children, [text("https://x/@Title")]);
});
