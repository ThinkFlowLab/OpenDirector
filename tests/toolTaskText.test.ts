import test from "node:test";
import assert from "node:assert/strict";
import {
  toolTaskError,
  toolTaskPhase,
} from "../src/canvas/toolTaskText.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

test("tool progress messages are localized, including counters", () => {
  setActiveLocale("en-US");
  assert.equal(toolTaskPhase("准备素材"), "Preparing media");
  assert.equal(
    toolTaskPhase("正在增强细节（2/4）"),
    "Enhancing details (2/4)",
  );
  assert.equal(toolTaskPhase("正在补帧到 60 fps"), "Interpolating to 60 fps");
  assert.equal(toolTaskPhase("正在识别并跟踪「猫、狗」"), 'Detecting and tracking "猫、狗"');
  assert.equal(toolTaskPhase("provider custom text"), "provider custom text");
  assert.equal(toolTaskPhase(null), undefined);
  assert.equal(toolTaskPhase("正在生成人物三视图（1/1）"), "Generating Character three-view (1/1)");
  assert.equal(toolTaskPhase("正在生成面部三视图（1/1）"), "Generating Face three-view (1/1)");
  assert.equal(toolTaskPhase("正在生成产品三视图（1/1）"), "Generating Product three-view (1/1)");
  setActiveLocale("zh-CN");
  assert.equal(toolTaskPhase("准备素材"), "准备素材");
});

test("tool task errors never leak persisted Chinese", () => {
  setActiveLocale("en-US");
  const unknownSubmission = "生成请求的提交结果不明。 请先核对供应商是否已接收请求，避免重复生成。 不会自动重新提交。";
  assert.match(toolTaskError(unknownSubmission)!, /acceptance is unknown/);
  assert.doesNotMatch(toolTaskError(unknownSubmission)!, /Try again/);
  assert.equal(
    toolTaskError("服务重启，任务已中断，请重新提交。"),
    "The service restarted and the task was interrupted. Submit it again.",
  );
  assert.equal(
    toolTaskError("工具执行出错，请检查素材和参数后重试。"),
    "The tool failed. Check the media and parameters and try again.",
  );
  assert.equal(
    toolTaskError("unexpected provider exception"),
    "unexpected provider exception",
  );
  assert.equal(
    toolTaskError("新的中文错误"),
    "The tool task did not complete. Try again.",
  );
  assert.equal(toolTaskError(null), undefined);
  setActiveLocale("zh-CN");
});

test("matting errors distinguish prompt translation from an empty tracking result in both locales", () => {
  const translation = "无法识别「三花猫」，请改用英文描述，或在“模型接入”中添加对话模型以自动翻译。";
  const missing = "视频中没有识别到「cat」，请换一种描述后重试。";
  try {
    setActiveLocale("zh-CN");
    assert.match(toolTaskError(translation)!, /「三花猫」.*改用简短的英文描述/);
    assert.equal(toolTaskError(missing), missing);
    setActiveLocale("en-US");
    assert.match(toolTaskError(translation)!, /translate "三花猫".*short English description/);
    assert.match(toolTaskError(missing)!, /Could not find "cat" in the video/);
  } finally {
    setActiveLocale("zh-CN");
  }
});
