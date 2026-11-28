import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionQuestion } from "../src/backend/chat.ts";
import {
  applyComposerAnswerInput,
  applyCustomAnswerText,
  applyOptionSelection,
  applyQuestionDefault,
  buildSubmissionAnswers,
  canUseQuestionDefault,
  clearQuestionDraft,
  formatAnsweredValue,
  formatContinuationError,
  formatOrderedOptionsSummary,
  readQuestionDraft,
  shouldShowQuestionSubmit,
  writeQuestionDraft,
} from "../src/canvas/questionAnswerDrafts.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

const sampleQuestion: DecisionQuestion = {
  id: "duration",
  question: "视频成片的目标时长是多少？",
  multiSelect: false,
  required: true,
  options: [
    { id: "8s", label: "8 秒", impact: "标准节奏" },
    { id: "5s", label: "5 秒", impact: "快节奏" },
    { id: "15s", label: "15 秒", impact: "舒缓叙事" },
  ],
};

test("summary card formats ordered options and appends recommended badge only to the first item in both locales", () => {
  setActiveLocale("zh-CN");
  assert.equal(
    formatOrderedOptionsSummary(sampleQuestion),
    "8 秒（推荐） · 5 秒 · 15 秒",
  );

  const enQuestion = {
    ...sampleQuestion,
    options: sampleQuestion.options.map(option => ({ ...option, label: option.id })),
  };
  setActiveLocale("en-US");
  assert.equal(
    formatOrderedOptionsSummary(enQuestion),
    "8s (Recommended) · 5s · 15s",
  );
  setActiveLocale("zh-CN");
});

test("continuation errors use stable codes and localize legacy Chinese details in English", () => {
  const legacy = { error: "助手运行时不可用。" };
  const coded = { ...legacy, errorCode: "continuation_resume_failed" };
  setActiveLocale("en-US");
  const retry = "Could not start the continuation. Check the Agent configuration and try again.";
  assert.equal(formatContinuationError(coded), retry);
  assert.equal(formatContinuationError(legacy), retry);
  assert.equal(formatContinuationError({ error: "Service unavailable" }), "Service unavailable");
  assert.equal(formatContinuationError({ errorCode: "continuation_plan_missing" }),
    "The answer is saved. The revised plan did not arrive. Continue to update the plan.");
  setActiveLocale("zh-CN");
  assert.equal(formatContinuationError(coded), "未能启动接续。请检查助手配置后重试。");
  assert.equal(formatContinuationError(legacy), legacy.error);
});

test("custom answer switches source explicitly and never merges with preset options", () => {
  const selected = applyOptionSelection(undefined, "8s", false);
  assert.deepEqual(selected, { source: "options", selectedOptionIds: ["8s"], customText: "", composerText: "" });

  const customText = "12 秒，最后留 3 秒空镜";
  const custom = applyCustomAnswerText(selected, customText);
  assert.deepEqual(custom, { source: "custom", selectedOptionIds: [], customText, composerText: "" });
  const answer = { questionId: "duration", source: "custom" as const, selectedOptionIds: [], customText };
  assert.deepEqual(buildSubmissionAnswers([sampleQuestion], { duration: custom }), [answer]);
  assert.equal(formatAnsweredValue(sampleQuestion, answer).text, customText);

  const multiQuestion = { ...sampleQuestion, id: "elements", multiSelect: true };
  const multiSelected = applyOptionSelection(undefined, "8s", true);
  const typed = applyComposerAnswerInput(multiSelected, "  自定义元素 C  ");
  const stale = { ...multiSelected, composerText: "自定义元素 D" };
  for (const [draft, expected] of [[typed, "自定义元素 C"], [stale, "自定义元素 D"]] as const) {
    assert.deepEqual(buildSubmissionAnswers([multiQuestion], { elements: draft }), [
      { questionId: "elements", source: "custom", selectedOptionIds: [], customText: expected },
    ]);
  }
});

test("multi-select, optional defaults and draft isolation by project, task and request ID", () => {
  const optional = { ...sampleQuestion, required: false, defaultOptionIds: ["8s"] };
  assert.equal(canUseQuestionDefault(sampleQuestion), false);
  assert.equal(canUseQuestionDefault({ ...sampleQuestion, required: false }), false);
  assert.equal(canUseQuestionDefault(optional), true);

  const first = applyOptionSelection(undefined, "empty_shot", true);
  const elements = applyOptionSelection(first, "close_up", true);
  assert.deepEqual(elements.selectedOptionIds, ["empty_shot", "close_up"]);
  const pacing = applyQuestionDefault(optional);
  assert.equal(pacing.source, "default");
  assert.deepEqual(pacing.selectedOptionIds, ["8s"]);

  const original = ["proj-a", "task-1", "req-1"] as const;
  const neighbors = [
    ["proj-b", "task-1", "req-1"],
    ["proj-a", "task-2", "req-1"],
    ["proj-a", "task-1", "req-2"],
  ] as const;
  writeQuestionDraft(...original, { elements, pacing });
  for (const [project, task, request] of neighbors) {
    const text = [project, task, request].join("/");
    writeQuestionDraft(project, task, request, { elements: applyCustomAnswerText(undefined, text) });
  }
  assert.deepEqual(readQuestionDraft(...original), { elements, pacing });
  clearQuestionDraft(...original);
  assert.deepEqual(readQuestionDraft(...original), {});
  for (const [project, task, request] of neighbors) {
    assert.equal(readQuestionDraft(project, task, request).elements.customText, [project, task, request].join("/"));
    clearQuestionDraft(project, task, request);
  }
});

test("submit button stays reachable on the last single-select question of a multi-question group", () => {
  const secondQuestion: DecisionQuestion = {
    ...sampleQuestion,
    id: "aspect",
    question: "请选择画幅比例",
    options: [
      { id: "16:9", label: "16:9", impact: "横屏" },
      { id: "9:16", label: "9:16", impact: "竖屏" },
    ],
  };

  // Single-question preset stays click-to-submit without showing a separate submit footer,
  // while custom answers expose the submit button.
  const singlePreset = { duration: applyOptionSelection(undefined, "8s", false) };
  assert.equal(shouldShowQuestionSubmit([sampleQuestion], singlePreset, 0), false);
  const singleCustom = { duration: applyCustomAnswerText(undefined, "10 秒") };
  assert.equal(shouldShowQuestionSubmit([sampleQuestion], singleCustom, 0), true);

  // Multi-question out-of-order completion: Q2 answered first via preset, then Q1 answered,
  // advancing back to Q2 (index 1). Submit button must remain visible on Q2.
  const onlySecond = { aspect: applyOptionSelection(undefined, "16:9", false) };
  assert.equal(shouldShowQuestionSubmit([sampleQuestion, secondQuestion], onlySecond, 1), false);
  const bothAnswered = {
    ...onlySecond,
    duration: applyOptionSelection(undefined, "8s", false),
  };
  assert.equal(shouldShowQuestionSubmit([sampleQuestion, secondQuestion], bothAnswered, 0), true);
  assert.equal(shouldShowQuestionSubmit([sampleQuestion, secondQuestion], bothAnswered, 1), true);
});
