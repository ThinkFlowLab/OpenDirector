import assert from "node:assert/strict";
import test from "node:test";
import { translate } from "../src/i18n/messages.ts";
import { zhCN } from "../src/i18n/messages/zh-CN/index.ts";
import { enUS } from "../src/i18n/messages/en-US/index.ts";

const keys = [
  "assistant.reply.canvasLink.open",
  "assistant.reply.canvasLink.hidden",
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
  assert.equal(translate("en-US", "assistant.reply.canvasLink.hidden"), "Show hidden item");
  assert.equal(translate("en-US", "assistant.reply.canvasLink.materialize"), "Show on canvas");
  assert.equal(translate("zh-CN", "assistant.reply.canvasLink.hidden"), "显示隐藏对象");
  assert.equal(translate("zh-CN", "assistant.reply.canvasLink.materialize"), "在画布中显示");
});
