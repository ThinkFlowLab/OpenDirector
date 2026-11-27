import type {
  DecisionRecord,
  DecisionStatus,
  LogicalTaskRecord,
} from "../backend/chat.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import { defaultTranslate } from "./assistantTranslate.ts";
import { CanvasIcon } from "./CanvasIcon.tsx";
import {
  formatAnsweredValue,
  formatContinuationError,
  formatOrderedOptionsSummary,
} from "./questionAnswerDrafts.ts";

const DECISION_STATUS_KEY: Record<DecisionStatus, MessageKey> = {
  waiting_input: "assistant.question.status.waiting",
  answer_saved: "assistant.question.status.answerSaved",
  resuming: "assistant.question.status.resuming",
  completed: "assistant.question.status.completed",
  invalidated: "assistant.question.status.invalidated",
  resume_failed: "assistant.question.status.resumeFailed",
  status_unknown: "assistant.question.status.statusUnknown",
};

export function QuestionSummaryCard({
  decision,
  expanded = false,
  busy = false,
  conflictNotice = false,
  onToggleExpand,
  onContinue,
  t = defaultTranslate,
}: {
  decision: DecisionRecord;
  expanded?: boolean;
  busy?: boolean;
  conflictNotice?: boolean;
  onToggleExpand?: (requestId: string) => void;
  onContinue?: (continuationId: string) => void;
  t?: Translate;
}) {
  if (decision.status === "waiting_input") {
    const canReopen = !expanded && Boolean(onToggleExpand);
    if (canReopen) {
      return (
        <button
          type="button"
          className="cw-question-inline-status is-waiting is-reopenable"
          data-question-summary-card={decision.requestId}
          data-decision-status={decision.status}
          onClick={() => onToggleExpand?.(decision.requestId)}
        >
          <CanvasIcon name="sliders" size={14} />
          <span>{t("assistant.question.waitingForAnswer")}</span>
          <span className="cw-question-reopen-pill">
            {t("assistant.question.reopenCard")}
          </span>
        </button>
      );
    }
    return (
      <div
        className="cw-question-inline-status is-waiting"
        data-question-summary-card={decision.requestId}
        data-decision-status={decision.status}
        role="status"
      >
        <CanvasIcon name="sliders" size={14} />
        <span>{t("assistant.question.waitingForAnswer")}</span>
      </div>
    );
  }

  const answersByQuestion = new Map(
    (decision.answers ?? []).map((item) => [item.questionId, item]),
  );

  return (
    <section
      className={`cw-question-summary-card is-${decision.status}`}
      data-question-summary-card={decision.requestId}
      data-decision-status={decision.status}
      role="region"
    >
      <header className="cw-question-summary-header">
        <span className="cw-question-summary-status">
          <CanvasIcon
            name={decision.status === "completed" ? "check" : "sliders"}
            size={14}
          />
          <span>{t(DECISION_STATUS_KEY[decision.status])}</span>
        </span>
      </header>

      <div className="cw-question-summary-items">
        {decision.questions.map((question) => {
          const answer = answersByQuestion.get(question.id);
          const answered = formatAnsweredValue(question, answer, t);
          return (
            <div
              key={question.id}
              className="cw-question-summary-item"
              data-question-id={question.id}
            >
              <div className="cw-question-summary-title">
                <span>{question.question}</span>
                {question.required === false && (
                  <small className="cw-question-optional-badge">
                    {t("assistant.question.optionalBadge")}
                  </small>
                )}
              </div>
              {answer ? (
                <div
                  className="cw-question-summary-answer"
                  data-answer-source={answer.source}
                >
                  {answered.tag && (
                    <span className="cw-question-answer-tag">
                      {answered.tag}
                    </span>
                  )}
                  <strong className="cw-question-answer-value">
                    {answered.text}
                  </strong>
                </div>
              ) : (
                <div
                  className="cw-question-summary-options"
                  data-question-options-preview
                >
                  {formatOrderedOptionsSummary(question, t)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {conflictNotice && (
        <p className="cw-question-summary-notice is-conflict" role="status">
          {t("assistant.question.conflictNotice")}
        </p>
      )}
      {decision.status === "invalidated" && (
        <p className="cw-question-summary-notice is-invalidated" role="status">
          {t("assistant.question.invalidatedNotice")}
        </p>
      )}
      {decision.status === "status_unknown" && (
        <p className="cw-question-summary-notice is-unknown" role="status">
          {t("assistant.question.statusUnknownNotice")}
        </p>
      )}
      {decision.status === "resume_failed" && (
        <p className="cw-question-summary-notice is-error" role="alert">
          {formatContinuationError(decision, t)}
        </p>
      )}

      {(decision.status === "answer_saved" ||
        decision.status === "resume_failed") &&
        decision.continuationId &&
        onContinue && (
          <div className="cw-question-summary-actions">
            <button
              type="button"
              className="cw-question-continue-button"
              disabled={busy}
              onClick={() => onContinue(decision.continuationId!)}
            >
              {decision.status === "resume_failed"
                ? t("assistant.question.retryContinue")
                : t("assistant.question.continue")}
            </button>
          </div>
        )}
    </section>
  );
}

const PLAN_STAGE_KEY: Partial<Record<LogicalTaskRecord["stage"], MessageKey>> = {
  waiting_confirmation: "assistant.plan.waitingConfirmation",
  executing: "assistant.plan.executing",
  status_unknown: "assistant.plan.statusUnknown",
  waiting_jobs: "assistant.plan.waitingJobs",
  execution_failed: "assistant.plan.executionFailed",
};

export function PlanConfirmationCard({
  task,
  busy = false,
  confirming = false,
  onConfirm,
  onAdjust,
  t = defaultTranslate,
}: {
  task: LogicalTaskRecord;
  busy?: boolean;
  confirming?: boolean;
  onConfirm?: (taskId: string, planRevision: number) => void;
  onAdjust?: (taskId: string, planRevision: number) => void;
  t?: Translate;
}) {
  const plan = task.plan;
  if (!plan || plan.revision < 1) return null;
  const isWaitingConfirm = task.stage === "waiting_confirmation";
  const canAdjust =
    task.stage === "executing" ||
    task.stage === "execution_failed" ||
    (task.stage === "status_unknown" &&
      plan.steps.some((step) => step.status === "completed"));
  const stageKey = PLAN_STAGE_KEY[task.stage];
  const statusLabel = stageKey
    ? t(stageKey)
    : task.stage === "completed" && task.confirmedPlanRevision === plan.revision
      ? t("assistant.plan.completed")
      : task.confirmedPlanRevision === plan.revision
        ? t("assistant.plan.confirmed", { revision: plan.revision })
        : t("assistant.plan.draft");

  return (
    <section
      className={`cw-plan-confirmation-card is-${task.stage}`}
      data-plan-confirmation-card={task.taskId}
      data-plan-revision={plan.revision}
    >
      <header className="cw-plan-confirmation-header">
        <span className="cw-plan-version-badge">
          <CanvasIcon name="sparkle" size={14} />
          <span>
            {t("assistant.plan.versionTitle", { revision: plan.revision })}
          </span>
        </span>
        <small className="cw-plan-stage-label">{statusLabel}</small>
      </header>

      <p className="cw-plan-confirmation-summary">{plan.summary}</p>
      {plan.steps.length > 0 && (
        <ol className="cw-plan-confirmation-steps">
          {plan.steps.map((step) => (
            <li key={step.id} data-status={step.status}>
              <small>{t(`assistant.plan.stepKind.${step.kind ?? "write"}`)}</small>
              {" "}{step.content}
            </li>
          ))}
        </ol>
      )}

      <div className="cw-plan-confirmation-actions">
        {isWaitingConfirm && !task.planOnly && onConfirm && (
          <button
            type="button"
            className="cw-plan-confirm-button"
            data-confirm-plan-button
            disabled={busy || confirming}
            onClick={() => onConfirm(task.taskId, plan.revision)}
          >
            {confirming
              ? t("assistant.plan.confirming")
              : t("assistant.plan.confirmAndExecute")}
          </button>
        )}
        {canAdjust && onAdjust && (
          <button
            type="button"
            className="cw-plan-adjust-button"
            data-adjust-plan-button
            onClick={() => onAdjust(task.taskId, plan.revision)}
          >
            {t("assistant.plan.adjustPlan")}
          </button>
        )}
      </div>
    </section>
  );
}
