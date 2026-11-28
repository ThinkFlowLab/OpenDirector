import test from "node:test";
import assert from "node:assert/strict";
import { assistantToolText } from "../src/canvas/assistantToolText.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

test("agent tool errors never show Chinese in the English reply card", () => {
  setActiveLocale("en-US");
  assert.equal(
    assistantToolText("本轮工具入口已关闭。"),
    "The tool entry point is closed for this turn.",
  );
  assert.equal(
    assistantToolText("只能读取不超过 64 KB 的文本素材。"),
    "Only text assets up to 64 KB can be read.",
  );
  assert.equal(
    assistantToolText("新的中文错误"),
    "The tool failed. Expand the details.",
  );
  assert.equal(
    assistantToolText("provider returned 500"),
    "provider returned 500",
  );
  setActiveLocale("zh-CN");
  assert.equal(assistantToolText("本轮工具入口已关闭。"), "本轮工具入口已关闭。");
});

test("image geometry rejections retain their concrete cause in both languages", () => {
  setActiveLocale("en-US");
  assert.equal(
    assistantToolText("图片尺寸不符合服务要求。", undefined, "capability_unavailable"),
    "Image dimensions do not meet the service requirements.",
  );
  setActiveLocale("zh-CN");
  assert.equal(
    assistantToolText("图片尺寸不符合服务要求。", undefined, "capability_unavailable"),
    "图片尺寸不符合服务要求。",
  );
});

test("decision tool errors show the action to take in both locales", () => {
  const cases = [
    ["task_waiting_input", "Answer the current question before continuing this task.", "请先回答当前问题，再继续任务。"],
    ["plan_confirmation_required", "Confirm the current plan before modifying the project or starting generation.", "请先确认当前计划，再修改工程或发起生成。"],
    ["plan_revision_stale", "The plan version changed. Confirm the latest plan before continuing.", "计划版本已变更，请确认最新计划后再继续。"],
    ["continuation_status_unknown", "The previous execution status needs verification and was not resent automatically.", "上一轮请求执行状态待核对，未自动重复发送。"],
  ];
  for (const [code, english, chinese] of cases) {
    setActiveLocale("en-US");
    assert.equal(assistantToolText("后端拒绝了操作", undefined, code), english);
    setActiveLocale("zh-CN");
    assert.equal(assistantToolText("Backend rejected the operation", undefined, code), chinese);
  }
});
