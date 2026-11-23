import assert from "node:assert/strict";
import { test } from "node:test";
import { hidePartialSuggestionMarker, parseSuggestedReplies } from "../src/canvas/suggestedReplies.ts";

const marker = "[opendirector-replies]: #";
const body = "有几个方向可以继续。";
const options = ["扩写 A", "扩写 B", "试试混合版", "调整光线", "保存脚本"];
const list = (items: string[]) => items.map((item) => "- " + item).join("\n");
const marked = (items: string[]) => list(items) + "\n\n" + marker;

test("reads 3 to 5 suggestions after the reply, or without a prefix", () => {
  for (const count of [3, 4, 5]) {
    const selected = options.slice(0, count);
    const text = body + "\n\n" + list(selected);
    assert.deepEqual(parseSuggestedReplies(text + "\n\n" + marker), {
      textWithoutMarker: text,
      suggestions: { prefix: body, options: selected },
    });
  }
  assert.deepEqual(parseSuggestedReplies(marked(options)), {
    textWithoutMarker: list(options),
    suggestions: { prefix: "", options },
  });
});

test("filters each overlong suggestion and keeps the original Markdown for fallback", () => {
  const atLimit = "🌊".repeat(80);
  const overLimit = atLimit + "🌊";
  const items = [atLimit, overLimit, options[0], options[1]];
  assert.deepEqual(parseSuggestedReplies(marked(items)), {
    textWithoutMarker: list(items),
    suggestions: { prefix: "", options: [atLimit, options[0], options[1]] },
  });
  const shortList = items.slice(0, 3);
  assert.deepEqual(parseSuggestedReplies(marked(shortList)), {
    textWithoutMarker: list(shortList),
    suggestions: { prefix: "", options: [atLimit, options[0]] },
  });
});

test("removes the final protocol definition while preserving invalid lists", () => {
  for (const markdown of [
    list(options.slice(0, 2)),
    list([...options, "第六项"]),
    list([options[0], options[0], options[1]]),
    list(["**加粗**", options[0], options[1]]),
    list(options.slice(0, 2)) + "\n\n[other-reference]: /guide",
  ]) {
    const text = body + "\n\n" + markdown;
    assert.deepEqual(parseSuggestedReplies(text + "\n\n" + marker), {
      textWithoutMarker: text,
      suggestions: null,
    });
  }
});

test("ordinary Markdown and literal protocol examples keep their text", () => {
  for (const text of [
    list(options),
    list(options) + "\n\n[other-reference]: #",
    marked(options) + "\n\n后续正文",
    '```md\n' + marked(options) + '\n```',
    '```md\n' + marked(options),
  ]) {
    assert.equal(parseSuggestedReplies(text), null, text);
  }
});

test("hides a streamed marker after a suggestion list and keeps code examples", () => {
  const text = body + "\n\n" + list(options);
  assert.equal(hidePartialSuggestionMarker(text + "\n\n[opendirector-rep"), text);
  const code = '```md\n' + list(options) + '\n\n[opendirector-rep';
  assert.equal(hidePartialSuggestionMarker(code), code);
});
