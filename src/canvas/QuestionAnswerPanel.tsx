import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  DecisionAnswerSubmissionItem,
  DecisionRecord,
} from "../backend/chat.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import { defaultTranslate } from "./assistantTranslate.ts";
import { CanvasIcon } from "./CanvasIcon.tsx";
import {
  applyOptionSelection,
  applyQuestionDefault,
  buildSubmissionAnswers,
  canUseQuestionDefault,
  effectiveQuestionDraftItem,
  emptyQuestionDraftItem,
  isQuestionAnswered,
  resolveNextAnswerAction,
  shouldShowQuestionSubmit,
  type QuestionAnswerDraftItem,
  type QuestionGroupDraft,
} from "./questionAnswerDrafts.ts";

export function QuestionAnswerPanel({
  decision,
  draft,
  activeIndex,
  submitting = false,
  disabled = false,
  onChangeIndex,
  onUpdateDraft,
  onSubmit,
  onDefer,
  onEditCustomInComposer,
  t = defaultTranslate,
}: {
  decision: DecisionRecord;
  draft: QuestionGroupDraft;
  activeIndex: number;
  submitting?: boolean;
  disabled?: boolean;
  onChangeIndex: (index: number) => void;
  onUpdateDraft: (
    questionId: string,
    updater: (
      current: QuestionAnswerDraftItem | undefined,
    ) => QuestionAnswerDraftItem,
  ) => QuestionGroupDraft;
  onSubmit: (
    requestId: string,
    answers: DecisionAnswerSubmissionItem[],
  ) => Promise<void> | void;
  onDefer: () => void;
  onEditCustomInComposer: (questionId: string, text: string) => void;
  t?: Translate;
}) {
  const { requestId, questions } = decision;
  const safeIndex = Math.min(activeIndex, Math.max(0, questions.length - 1));
  const currentQuestion = questions[safeIndex];
  const rawDraft = currentQuestion
    ? (draft[currentQuestion.id] ?? emptyQuestionDraftItem())
    : emptyQuestionDraftItem();
  const currentDraft = effectiveQuestionDraftItem(rawDraft);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const defaultHighlightIndex = () => {
    if (!currentQuestion) return 0;
    if (
      currentDraft.source === "options" &&
      currentDraft.selectedOptionIds.length > 0
    ) {
      const idx = currentQuestion.options.findIndex(
        (opt) => opt.id === currentDraft.selectedOptionIds[0],
      );
      if (idx >= 0) return idx;
    }
    return currentDraft.source === "custom" ? -1 : 0;
  };
  const [highlightedIndex, setHighlightedIndex] = useState(defaultHighlightIndex);

  useEffect(() => {
    setHighlightedIndex(defaultHighlightIndex());
  }, [requestId, currentQuestion?.id, currentDraft.source]);

  if (!currentQuestion) return null;

  const hasDefault = canUseQuestionDefault(currentQuestion);
  const recommendedSuffix = t("assistant.question.recommendedSuffix");
  const submissionPayload = buildSubmissionAnswers(questions, draft);
  const canSubmit = Boolean(submissionPayload) && !submitting && !disabled;
  const currentAnswered = isQuestionAnswered(currentQuestion, currentDraft);
  const hasTypedComposerCustom = (rawDraft.composerText ?? "").trim().length > 0;
  const hasSavedCustom =
    currentDraft.source === "custom" &&
    currentDraft.customText.trim().length > 0 &&
    !hasTypedComposerCustom;
  const showNextButton =
    Boolean(currentQuestion.multiSelect) && safeIndex < questions.length - 1;
  const showSubmitButton = shouldShowQuestionSubmit(questions, draft, safeIndex);
  const showFooter = hasDefault || showNextButton || showSubmitButton;

  const advanceOrSubmit = (nextDraft: QuestionGroupDraft) => {
    const action = resolveNextAnswerAction(questions, nextDraft, safeIndex);
    if (!action) return;
    if ("nextIndex" in action) onChangeIndex(action.nextIndex);
    else void onSubmit(requestId, action.answers);
  };

  const handleOptionClick = (optionId: string, index: number) => {
    setHighlightedIndex(index);
    const isMulti = Boolean(currentQuestion.multiSelect);
    const nextDraft = onUpdateDraft(currentQuestion.id, (prev) => applyOptionSelection(prev, optionId, isMulti));
    if (!isMulti) advanceOrSubmit(nextDraft);
  };

  const handleSkip = () => {
    advanceOrSubmit(onUpdateDraft(currentQuestion.id, () => applyQuestionDefault(currentQuestion)));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (submitting || disabled) return;
    const count = currentQuestion.options.length;
    if (!count) return;
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta !== 0) {
      event.preventDefault();
      const nextIndex = (highlightedIndex + delta + count) % count;
      setHighlightedIndex(nextIndex);
      optionRefs.current[nextIndex]?.focus();
    } else if (
      !currentQuestion.multiSelect &&
      event.key >= "1" &&
      event.key <= String(Math.min(9, count)) &&
      !(event.target instanceof HTMLInputElement)
    ) {
      const idx = Number(event.key) - 1;
      const option = currentQuestion.options[idx];
      if (option) {
        event.preventDefault();
        handleOptionClick(option.id, idx);
      }
    }
  };

  return (
    <section
      className="cw-question-answer-panel"
      data-question-answer-panel={requestId}
      aria-label={t("assistant.question.panelAria")}
      onKeyDown={handleKeyDown}
    >
      <header className="cw-question-answer-header">
        <div className="cw-question-prompt-line">
          <strong>{currentQuestion.question}</strong>
          {currentQuestion.multiSelect && (
            <span className="cw-question-optional-badge">
              {t("assistant.question.multiSelectBadge")}
            </span>
          )}
          {currentQuestion.required === false && (
            <span className="cw-question-optional-badge">
              {t("assistant.question.optionalBadge")}
            </span>
          )}
        </div>

        <div className="cw-question-header-controls">
          {questions.length > 1 && (
            <div className="cw-question-pager">
              <button
                type="button"
                className="cw-question-pager-btn"
                data-question-prev-button
                aria-label={t("assistant.question.prevQuestion")}
                title={t("assistant.question.prevQuestion")}
                disabled={submitting || safeIndex === 0}
                onClick={() => onChangeIndex(Math.max(0, safeIndex - 1))}
              >
                <CanvasIcon name="chevronLeft" size={14} />
              </button>
              <span className="cw-question-pager-count">
                {t("assistant.question.stepOf", {
                  current: safeIndex + 1,
                  total: questions.length,
                })}
              </span>
              <button
                type="button"
                className="cw-question-pager-btn"
                data-question-next-button
                aria-label={t("assistant.question.nextQuestion")}
                title={t("assistant.question.nextQuestion")}
                disabled={submitting || safeIndex >= questions.length - 1}
                onClick={() =>
                  onChangeIndex(Math.min(questions.length - 1, safeIndex + 1))
                }
              >
                <CanvasIcon name="chevronRight" size={14} />
              </button>
            </div>
          )}
          <button
            type="button"
            className="cw-question-close-btn"
            data-question-defer-button
            aria-label={t("assistant.question.answerLater")}
            title={t("assistant.question.answerLater")}
            disabled={submitting}
            onClick={onDefer}
          >
            <CanvasIcon name="close" size={15} />
          </button>
        </div>
      </header>

      <div
        className="cw-question-answer-body"
        data-active-question-id={currentQuestion.id}
      >
        <div
          className="cw-question-options-list"
          role={currentQuestion.multiSelect ? "group" : "radiogroup"}
          aria-label={currentQuestion.question}
        >
          {currentQuestion.options.map((option, index) => {
            const isSelected =
              currentDraft.source === "options" &&
              currentDraft.selectedOptionIds.includes(option.id);
            const isHighlighted =
              !hasSavedCustom && !hasTypedComposerCustom && highlightedIndex === index;
            const showActiveBadge = isSelected || (!currentQuestion.multiSelect && isHighlighted);
            return (
              <button
                key={option.id}
                ref={(el) => {
                  optionRefs.current[index] = el;
                }}
                type="button"
                role={currentQuestion.multiSelect ? "checkbox" : "radio"}
                aria-checked={isSelected}
                data-question-option={option.id}
                disabled={submitting || disabled}
                className={`cw-question-option-item${isSelected ? " is-selected" : ""}${isHighlighted ? " is-highlighted" : ""}`}
                onMouseEnter={() => setHighlightedIndex(index)}
                onFocus={() => setHighlightedIndex(index)}
                onClick={() => handleOptionClick(option.id, index)}
              >
                <span
                  className={`cw-question-option-num${showActiveBadge ? " is-active" : ""}`}
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span className="cw-question-option-copy">
                  <span className="cw-question-option-label">
                    {option.label}
                    {index === 0 ? recommendedSuffix : ""}
                  </span>
                  <span className="cw-question-option-impact">
                    {option.impact}
                  </span>
                </span>
                <span className="cw-question-option-arrow" aria-hidden="true">
                  {currentQuestion.multiSelect ? (
                    isSelected ? (
                      <CanvasIcon name="check" size={15} />
                    ) : null
                  ) : isSelected || isHighlighted ? (
                    <CanvasIcon name="arrowRight" size={16} />
                  ) : null}
                </span>
              </button>
            );
          })}

          {hasSavedCustom && (
            <button
              type="button"
              className="cw-question-option-item is-selected is-custom-saved"
              data-active-answer-source="custom"
              disabled={submitting || disabled}
              onClick={() =>
                onEditCustomInComposer(
                  currentQuestion.id,
                  currentDraft.customText,
                )
              }
            >
              <span className="cw-question-option-num is-active" aria-hidden="true">
                <CanvasIcon name="pencil" size={12} />
              </span>
              <span className="cw-question-option-copy">
                <span className="cw-question-option-label">
                  {currentDraft.customText}
                </span>
                <span className="cw-question-option-impact">
                  {t("assistant.question.editCustomAnswer")}
                </span>
              </span>
              <span className="cw-question-option-arrow" aria-hidden="true">
                <CanvasIcon name="arrowRight" size={16} />
              </span>
            </button>
          )}
        </div>
      </div>

      {showFooter && (
        <footer className="cw-question-answer-footer">
          <div className="cw-question-answer-actions">
            {hasDefault && (
              <button
                type="button"
                className="cw-question-skip-button"
                data-question-default-button
                disabled={submitting || disabled}
                onClick={handleSkip}
              >
                {t("assistant.question.skip")}
              </button>
            )}
            {showNextButton && (
              <button
                type="button"
                className="cw-question-submit-button"
                disabled={!currentAnswered || submitting || disabled}
                onClick={() => onChangeIndex(safeIndex + 1)}
              >
                {t("assistant.question.nextQuestion")}
              </button>
            )}
            {showSubmitButton && (
              <button
                type="button"
                className="cw-question-submit-button"
                data-question-submit-button
                disabled={!canSubmit}
                onClick={() => {
                  if (submissionPayload) {
                    void onSubmit(requestId, submissionPayload);
                  }
                }}
              >
                {submitting
                  ? t("assistant.question.submitting")
                  : t("assistant.question.submit")}
              </button>
            )}
          </div>
        </footer>
      )}
    </section>
  );
}
