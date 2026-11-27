import assert from "node:assert/strict";
import test from "node:test";
import { readDOM, editContent } from "../src/canvas/chatReferenceDOM.ts";

test("a browser's lone empty line is empty content, while real line breaks remain", () => {
  const previousElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  class Element {
    dataset = {};
    nodeType = 1;
    nodeName: string;
    childNodes: object[];
    constructor(nodeName: string, childNodes: object[] = []) {
      this.nodeName = nodeName;
      this.childNodes = childNodes;
    }
    get firstChild() {
      return this.childNodes[0];
    }
  }
  globalThis.HTMLElement = Element as unknown as typeof HTMLElement;
  globalThis.Node = { TEXT_NODE: 3 } as typeof Node;
  const br = new Element("BR");
  const text = (textContent: string) => ({ nodeType: 3, nodeName: "#text", textContent });
  try {
    assert.deepEqual(readDOM(new Element("DIV", [br]) as unknown as HTMLElement), []);
    assert.deepEqual(
      readDOM(new Element("DIV", [text("first"), br, text("second")]) as unknown as HTMLElement),
      [{ type: "text", text: "first\nsecond" }],
    );
  } finally {
    globalThis.HTMLElement = previousElement;
    globalThis.Node = previousNode;
  }
});


test("consuming a skill command preserves references and surrounding text", () => {
  const reference = {type: "reference" as const, assetId: "asset", name: "source.mp4", fingerprint: "source"};
  const content = [reference, {type: "text" as const, text: " /skill 保留正文"}];
  assert.deepEqual(editContent(content, {start: 2, end: 8}, []), [reference, {type: "text", text: "  保留正文"}]);
});


test("skill tokens retain their document position and occupy one editing unit", async () => {
  const { editingText } = await import("../src/canvas/chatReferenceDOM.ts");
  const { contentText, referenceIds, validContent } = await import("../src/canvas/chatReferenceContent.ts");
  const reference = {type: "reference" as const, assetId: "image", name: "source.png", fingerprint: null};
  const content = [reference, {type: "text" as const, text: " /skill trailing"}];
  const inserted = editContent(content, {start: 2, end: 8}, [{type: "skill", name: "character-replacement"}]);
  assert.deepEqual(inserted, [reference, {type: "text", text: " "}, {type: "skill", name: "character-replacement"}, {type: "text", text: " trailing"}]);
  assert.equal(editingText(inserted), "\ufffc \ufffc trailing");
  assert.deepEqual(referenceIds(inserted), ["image"]);
  assert.match(contentText(inserted), /\/character-replacement trailing$/);
  assert.deepEqual(editContent(inserted, {start: 2, end: 3}, []), [reference, {type: "text", text: "  trailing"}]);
  assert.equal(validContent([{type: "skill", name: "first"}, {type: "skill", name: "second"}]), false);
});

test("the caret after a preset chip lands before the summary note", async () => {
  const { select } = await import("../src/canvas/chatReferenceDOM.ts");
  class Element {
    dataset: Record<string, string> = {};
    nodeType = 1;
    nodeName: string;
    childNodes: object[];
    constructor(nodeName: string, childNodes: object[] = []) {
      this.nodeName = nodeName;
      this.childNodes = childNodes;
    }
  }
  const text = (textContent: string) => ({ nodeType: 3, nodeName: "#text", textContent });
  const previous = {
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    document: globalThis.document,
    window: globalThis.window,
  };
  globalThis.HTMLElement = Element as unknown as typeof HTMLElement;
  globalThis.Node = { TEXT_NODE: 3 } as typeof Node;
  const chip = new Element("SPAN", [new Element("BUTTON", [text("人物四视图")])]);
  chip.dataset.preset = "four-view";
  const anchor = text("\u200b");
  const note = new Element("SPAN", [anchor]);
  note.dataset.presetNote = "直接基于当前图像生成";
  const root = new Element("DIV", [chip, note, text("\u200b")]) as unknown as HTMLElement;
  const range = {
    start: null as null | [object, number],
    setStart(node: object, offset: number) {
      this.start = [node, offset];
    },
    setEnd() {},
  };
  globalThis.document = { createRange: () => range } as unknown as Document;
  globalThis.window = {
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  } as unknown as Window & typeof globalThis;
  try {
    select(root, { start: 1, end: 1 });
    assert.equal(range.start?.[0], anchor);
    assert.equal(range.start?.[1], 1);
    anchor.textContent += "正文";
    assert.deepEqual(readDOM(root), [
      { type: "skill", name: "", preset: "four-view" },
      { type: "text", text: "正文" },
    ]);
  } finally {
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.Node = previous.Node;
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  }
});
