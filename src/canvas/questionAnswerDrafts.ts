import type {
  AnswerSource,
  DecisionAnswerSubmissionItem,
  DecisionQuestion,
  DecisionRecord,
  QuestionAnswerItem,
} from "../backend/chat.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import { getActiveLocale } from "../i18n/messages.ts";
import { defaultTranslate } from "./assistantTranslate.ts";

export function formatContinuationError(
  decision: Pick<DecisionRecord, "error" | "errorCode">,
  t: Translate = defaultTranslate,
): string {
  if (decision.errorCode === "continuation_plan_missing") {
    return t("assistant.question.continuationPlanMissing");
  }
  if (
    decision.errorCode === "continuation_resume_failed" ||
    !decision.error ||
    (getActiveLocale() === "en-US" && /[\u3400-\u9fff]/.test(decision.error))
  ) {
    return t("assistant.question.continuationResumeFailed");
  }
  return decision.error;
}

export function formatOrderedOptionsSummary(
  question: DecisionQuestion,
  t: Translate = defaultTranslate,
): string {
  const recommended = t("assistant.question.recommendedSuffix");
  return question.options
    .map((option, index) =>
      index === 0 ? `${option.label}${recommended}` : option.label,
    )
    .join(" · ");
}

export function formatAnsweredValue(
  question: DecisionQuestion,
  answer: QuestionAnswerItem | undefined,
  t: Translate = defaultTranslate,
): { text: string; tag: string | null } {
  if (!answer) return { text: "", tag: null };
  if (answer.source === "custom") {
    return {
      text: answer.customText ?? answer.displayText ?? "",
      tag: t("assistant.question.customAnswerTag"),
    };
  }
  const byId = new Map(question.options.map((opt) => [opt.id, opt.label]));
  const labels =
    answer.selectedOptionIds
      ?.map((id) => byId.get(id))
      .filter((item): item is string => Boolean(item)) ?? [];
  const text =
    labels.length > 0
      ? labels.join(" · ")
      : (answer.displayText ?? answer.customText ?? "");
  return {
    text,
    tag:
      answer.source === "default"
        ? t("assistant.question.defaultAnswerTag")
        : null,
  };
}

export interface QuestionAnswerDraftItem {
  source: AnswerSource | null;
  selectedOptionIds: string[];
  customText: string;
  composerText?: string;
}

export type QuestionGroupDraft = Record<string, QuestionAnswerDraftItem>;

const memoryDrafts = new Map<string, QuestionGroupDraft>();

function storageKey(projectId: string, taskId: string, requestId: string): string {
  return `opendirector.questionDraft.v1:${projectId}:${taskId}:${requestId}`;
}

export function emptyQuestionDraftItem(): QuestionAnswerDraftItem {
  return {
    source: null,
    selectedOptionIds: [],
    customText: "",
  };
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function readQuestionDraft(
  projectId: string,
  taskId: string,
  requestId: string,
): QuestionGroupDraft {
  const key = storageKey(projectId, taskId, requestId);
  const cached = memoryDrafts.get(key);
  if (cached) return cached;
  try {
    const raw = sessionStore()?.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as QuestionGroupDraft) : null;
    if (parsed && typeof parsed === "object") {
      memoryDrafts.set(key, parsed);
      return parsed;
    }
  } catch {
    /* Fall back to in-memory draft map when storage is unavailable. */
  }
  return {};
}

export function writeQuestionDraft(
  projectId: string,
  taskId: string,
  requestId: string,
  draft: QuestionGroupDraft,
): void {
  const key = storageKey(projectId, taskId, requestId);
  memoryDrafts.set(key, draft);
  try {
    sessionStore()?.setItem(key, JSON.stringify(draft));
  } catch {
    /* Keep in-memory draft when sessionStorage quota is exceeded. */
  }
}

export function clearQuestionDraft(
  projectId: string,
  taskId: string,
  requestId: string,
): void {
  const key = storageKey(projectId, taskId, requestId);
  memoryDrafts.delete(key);
  try {
    sessionStore()?.removeItem(key);
  } catch {
    /* Ignore storage removal errors. */
  }
}

export function applyOptionSelection(
  current: QuestionAnswerDraftItem | undefined,
  optionId: string,
  multiSelect = false,
): QuestionAnswerDraftItem {
  const base = current ?? emptyQuestionDraftItem();
  if (!multiSelect) {
    return {
      source: "options",
      selectedOptionIds: [optionId],
      customText: "",
      composerText: "",
    };
  }
  const existing =
    base.source === "options" && !(base.composerText ?? "").trim()
      ? base.selectedOptionIds
      : [];
  const nextIds = existing.includes(optionId)
    ? existing.filter((id) => id !== optionId)
    : [...existing, optionId];
  return {
    source: nextIds.length > 0 ? "options" : null,
    selectedOptionIds: nextIds,
    customText: "",
    composerText: "",
  };
}

export function applyCustomAnswerText(
  _current: QuestionAnswerDraftItem | undefined,
  text: string,
): QuestionAnswerDraftItem {
  const trimmed = text.trim();
  // Explicitly switch answer source to custom and clear preset options so they never silently merge.
  return {
    source: trimmed.length > 0 ? "custom" : null,
    selectedOptionIds: [],
    customText: text,
    composerText: "",
  };
}

export function applyComposerAnswerInput(
  _current: QuestionAnswerDraftItem | undefined,
  text: string,
): QuestionAnswerDraftItem {
  const trimmed = text.trim();
  return {
    source: trimmed.length > 0 ? "custom" : null,
    selectedOptionIds: [],
    customText: trimmed,
    composerText: text,
  };
}

export function effectiveQuestionDraftItem(
  item: QuestionAnswerDraftItem | undefined,
): QuestionAnswerDraftItem {
  if (!item) return emptyQuestionDraftItem();
  const typed = (item.composerText ?? "").trim();
  if (typed.length > 0) {
    return {
      source: "custom",
      selectedOptionIds: [],
      customText: typed,
      composerText: item.composerText,
    };
  }
  return item;
}

export function canUseQuestionDefault(question: DecisionQuestion): boolean {
  return (
    question.required === false &&
    Boolean(
      (question.defaultOptionIds && question.defaultOptionIds.length > 0) ||
        (question.defaultText && question.defaultText.trim().length > 0),
    )
  );
}

export function applyQuestionDefault(
  question: DecisionQuestion,
): QuestionAnswerDraftItem {
  if (!canUseQuestionDefault(question)) return emptyQuestionDraftItem();
  return {
    source: "default",
    selectedOptionIds: [...(question.defaultOptionIds ?? [])],
    customText: question.defaultText ?? "",
    composerText: "",
  };
}

export function isQuestionAnswered(
  question: DecisionQuestion,
  item: QuestionAnswerDraftItem | undefined,
): boolean {
  const resolved = effectiveQuestionDraftItem(item);
  if (resolved.source === "custom") return resolved.customText.trim().length > 0;
  if (resolved.source === "options") return resolved.selectedOptionIds.length > 0;
  return (!resolved.source || resolved.source === "default") && canUseQuestionDefault(question);
}

export function buildSubmissionAnswers(
  questions: DecisionQuestion[],
  draft: QuestionGroupDraft,
): DecisionAnswerSubmissionItem[] | null {
  const out: DecisionAnswerSubmissionItem[] = [];
  for (const question of questions) {
    const item = effectiveQuestionDraftItem(draft[question.id]);
    if (!isQuestionAnswered(question, item)) return null;
    if (item.source === "custom") {
      out.push({
        questionId: question.id,
        source: "custom",
        selectedOptionIds: [],
        customText: item.customText.trim(),
      });
    } else if (item.source === "options") {
      out.push({
        questionId: question.id,
        source: "options",
        selectedOptionIds: [...item.selectedOptionIds],
        customText: null,
      });
    } else {
      out.push({
        questionId: question.id,
        source: "default",
        selectedOptionIds: [...(question.defaultOptionIds ?? [])],
        customText: question.defaultText ?? null,
      });
    }
  }
  return out;
}

export function resolveNextAnswerAction(
  questions: DecisionQuestion[],
  draft: QuestionGroupDraft,
  currentIndex: number,
): { nextIndex: number } | { answers: DecisionAnswerSubmissionItem[] } | null {
  if (currentIndex < questions.length - 1) return { nextIndex: currentIndex + 1 };
  const answers = buildSubmissionAnswers(questions, draft);
  if (answers) return { answers };
  const unanswered = questions.findIndex((q) => !isQuestionAnswered(q, draft[q.id]));
  return unanswered >= 0 ? { nextIndex: unanswered } : null;
}

export function shouldShowQuestionSubmit(
  questions: DecisionQuestion[],
  draft: QuestionGroupDraft,
  activeIndex: number,
): boolean {
  const safeIndex = Math.min(activeIndex, Math.max(0, questions.length - 1));
  const currentQuestion = questions[safeIndex];
  if (!currentQuestion) return false;
  if (currentQuestion.multiSelect) return safeIndex === questions.length - 1;
  if (!buildSubmissionAnswers(questions, draft)) return false;
  const rawDraft = draft[currentQuestion.id] ?? emptyQuestionDraftItem();
  const currentDraft = effectiveQuestionDraftItem(rawDraft);
  const hasTypedComposerCustom = (rawDraft.composerText ?? "").trim().length > 0;
  const hasSavedCustom =
    currentDraft.source === "custom" &&
    currentDraft.customText.trim().length > 0 &&
    !hasTypedComposerCustom;
  return hasSavedCustom || hasTypedComposerCustom || questions.length > 1;
}
