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

test("job-wait activity errors follow the interface language", () => {
  const provider = "Provider rejected the video task (1027).";
  setActiveLocale("en-US");
  assert.equal(
    assistantToolText(`Job failed: ${provider}`),
    `Job failed: ${provider}`,
  );
  assert.equal(assistantToolText("Job cancelled: stopped"), "Job cancelled: stopped");
  assert.equal(
    assistantToolText("Job interrupted: connection dropped"),
    "Job interrupted: connection dropped",
  );
  assert.equal(assistantToolText("Job failed."), "Job failed.");
  assert.equal(assistantToolText("Job cancelled."), "Job cancelled.");
  assert.equal(assistantToolText("Job interrupted."), "Job interrupted.");
  assert.equal(
    assistantToolText("Job failed: 供应商拒绝了任务。"),
    "The tool failed. Expand the details.",
  );

  setActiveLocale("zh-CN");
  assert.equal(
    assistantToolText(`Job failed: ${provider}`),
    `任务失败：${provider}`,
  );
  assert.equal(assistantToolText("Job cancelled: stopped"), "任务已取消：stopped");
  assert.equal(
    assistantToolText("Job interrupted: connection dropped"),
    "任务已中断：connection dropped",
  );
  assert.equal(assistantToolText("Job failed."), "任务失败。");
  assert.equal(assistantToolText("Job cancelled."), "任务已取消。");
  assert.equal(assistantToolText("Job interrupted."), "任务已中断。");
  assert.equal(
    assistantToolText("Job failed: 供应商拒绝了任务。"),
    "任务失败：供应商拒绝了任务。",
  );
  assert.equal(assistantToolText("provider returned 500"), "provider returned 500");
});
