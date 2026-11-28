import test from "node:test";
import assert from "node:assert/strict";
import {
  helpShortcutRows,
  matchesShortcut,
  shortcutAriaKeys,
  shortcutKeys,
} from "../src/canvas/shortcuts.ts";
import { zhCN } from "../src/i18n/messages/zh-CN/index.ts";
import type { MessageKey } from "../src/i18n/types.ts";

const t = (key: MessageKey) => {
  const value = zhCN[key];
  return typeof value === "string" ? value : value.other;
};

test("the displayed keys match the keys the handlers listen for", () => {
  assert.equal(shortcutKeys("settings", false), "Ctrl+,");
  assert.equal(shortcutKeys("settings", true), "⌘,");
  assert.equal(shortcutKeys("redo", false), "Ctrl+Shift+Z");
  assert.equal(shortcutKeys("redo", true), "⇧⌘Z");
  assert.equal(shortcutKeys("help", false), "?");
  assert.equal(shortcutAriaKeys("new-project"), "Control+N Meta+N");
  assert.equal(shortcutAriaKeys("help"), "?");
});

test("a printed key matches its spelled combo", () => {
  assert.ok(
    matchesShortcut({ key: ",", ctrlKey: true }, "settings"),
  );
  assert.ok(
    matchesShortcut({ key: "z", metaKey: true, shiftKey: true }, "redo"),
  );
  assert.ok(
    matchesShortcut({ key: "A", ctrlKey: true }, "select-all"),
  );
  assert.equal(matchesShortcut({ key: ",", ctrlKey: true }, "undo"), false);
  assert.equal(matchesShortcut({ key: "n", ctrlKey: false }, "new-project"), false);
  assert.equal(matchesShortcut({ key: "n", ctrlKey: true, shiftKey: true }, "new-project"), false);
});

test("every help row has a label and a key hint", () => {
  for (const [label, keys] of helpShortcutRows(t, false)) {
    assert.ok(label.length > 0, `label for ${keys}`);
    assert.ok(keys.length > 0, `keys for ${label}`);
  }
});
