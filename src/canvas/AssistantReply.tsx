import { memo, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import type { LinkSafetyModalProps } from "streamdown";
import type { ChatMessage, ChatTool } from "../backend/chat";
import type { Translate } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import { CanvasIcon } from "./CanvasIcon";
import { AssistantLinkInfo } from "./AssistantLinkInfo";
import { activityProgress, replySections, toolLabel } from "./assistantActivity.ts";
import { assistantToolText } from "./assistantToolText.ts";
import { assistantCitationFormatter } from "./assistantCitations.ts";
import { defaultTranslate } from "./assistantTranslate.ts";

const STATUS: Record<ChatTool["status"], MessageKey> = {
  running: "assistant.reply.status.running",
  complete: "assistant.reply.status.complete",
  failed: "assistant.reply.status.failed",
  interrupted: "assistant.reply.status.interrupted",
};

function ToolActivity({ tool, t }: { tool: ChatTool; t: Translate }) {
  return (
    <details className={`cw-chat-activity is-${tool.status}`}>
      <summary>
        <CanvasIcon
          name="sparkle"
          size={15}
        />
        <span>{toolLabel(tool, t)}</span>
        <small>{t(STATUS[tool.status])}</small>
        <CanvasIcon name="chevronRight" size={14} />
      </summary>
      <div className="cw-chat-activity-detail">
        {(tool.error || tool.message) && (
          <p>{assistantToolText(tool.error || tool.message!, t)}</p>
        )}
        {tool.arguments && <details className="cw-chat-tool-data">
          <summary><CanvasIcon name="chevronRight" size={12} />{t("assistant.reply.arguments")}</summary>
          <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
        </details>}
        {tool.result !== undefined && <details className="cw-chat-tool-data">
          <summary><CanvasIcon name="chevronRight" size={12} />{t("assistant.reply.result")}{tool.resultTruncated ? t("assistant.reply.truncated") : ""}</summary>
          <pre>{tool.result}</pre>
          {tool.resultTruncated && <p>{t("assistant.reply.truncatedDetail")}</p>}
        </details>}
        {tool.taskId && (
          <p>
            {t("assistant.reply.task")}<code>{tool.taskId}</code>
          </p>
        )}
      </div>
    </details>
  );
}

function ToolGroup({ tools, t }: { tools: ChatTool[]; t: Translate }) {
  const [open, setOpen] = useState(false);
  const [hiddenCount, setHiddenCount] = useState<number | null>(null);
  const hidden = hiddenCount ?? Math.max(0, tools.length - 50);
  const completed = tools.filter((tool) => tool.status === "complete").length;
  const failed = tools.filter((tool) => tool.status === "failed");
  const interrupted = tools.filter((tool) => tool.status === "interrupted");
  const running = tools.filter((tool) => tool.status === "running");
  return (
    <div className="cw-chat-tool-group">
      <details
        className={`cw-chat-activity${running.length ? " is-running" : ""}`}
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          if (next) setHiddenCount((count) => count ?? Math.max(0, tools.length - 50));
          setOpen(next);
        }}
      >
        <summary>
          <CanvasIcon name="sparkle" size={15} />
          <span>{t("assistant.reply.tools", { count: tools.length })}</span>
          <small>{t("assistant.reply.progress", { done: completed, total: tools.length })}{failed.length > 0 && ` · ${t("assistant.reply.failedCount", { count: failed.length })}`}{interrupted.length > 0 && ` · ${t("assistant.reply.interruptedCount", { count: interrupted.length })}`}</small>
          <CanvasIcon name="chevronRight" size={14} />
        </summary>
        {open && <div className="cw-chat-tool-group-items">
          {hidden > 0 && <button
            type="button"
            className="cw-chat-show-earlier"
            onClick={() => setHiddenCount(Math.max(0, hidden - 50))}
          >{t("assistant.reply.showEarlier", { count: Math.min(50, hidden) })}</button>}
          {tools.slice(hidden).map((tool) => <ToolActivity key={tool.id} tool={tool} t={t} />)}
        </div>}
      </details>
    </div>
  );
}

export const AssistantReply = memo(function AssistantReply({
  message,
  thinking,
  t = defaultTranslate,
}: {
  message: ChatMessage;
  thinking: boolean;
  /** Injected by the panel; standalone mounts fall back to the active locale. */
  t?: Translate;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const formatText = useMemo(() => assistantCitationFormatter(
    message.text, message.sources, message.status === "streaming", t,
  ), [message.text, message.sources, message.status, t]);
  const linkSafety = useMemo(() => ({
    enabled: true,
    renderModal: (props: LinkSafetyModalProps) => props.isOpen ? <AssistantLinkInfo {...props} t={t} /> : null,
  }), [t]);
  const copyLabel =
    copyState === "copied"
      ? t("assistant.reply.copied")
      : copyState === "failed"
        ? t("assistant.reply.copyFailed")
        : t("assistant.reply.copyReply");
  const markdown = (text: string, key: string) =>
    text && (
      <Streamdown
        key={key}
        className="cw-chat-markdown"
        controls={false}
        mode={message.status === "streaming" ? "streaming" : "static"}
        isAnimating={message.status === "streaming"}
        linkSafety={linkSafety}
      >
        {formatText(text)}
      </Streamdown>
    );
  const sections = replySections(message);
  const renderPart = (part: ReturnType<typeof replySections>["reply"][number]) => part.type === "text"
    ? markdown(part.text, part.id)
    : <ToolGroup key={part.id} tools={part.tools} t={t} />;
  return (
    <>
      {!!message.plan?.length && <details className="cw-chat-plan cw-chat-activity">
        <summary>
          <CanvasIcon name="sparkle" size={15} />
          <span>{t("assistant.reply.plan")}</span>
          <small>{t("assistant.reply.progress", { done: message.plan.filter((step) => step.status === "completed").length, total: message.plan.length })}</small>
          <CanvasIcon name="chevronRight" size={14} />
        </summary>
        <ol>{message.plan.map((step, index) => <li key={index} data-status={step.status}>
          {step.content}
        </li>)}</ol>
      </details>}
      {sections.activity.length > 0 && <details className="cw-chat-activity cw-chat-execution-history">
        <summary>
          <CanvasIcon name="sparkle" size={15} />
          <span>{t("assistant.reply.tools", { count: message.tools?.length ?? 0 })}</span>
          <small>{t("assistant.reply.progress", { done: message.tools?.filter((tool) => tool.status === "complete").length ?? 0, total: message.tools?.length ?? 0 })}{message.tools?.some((tool) => tool.status === "failed") && ` · ${t("assistant.reply.failedCount", { count: message.tools.filter((tool) => tool.status === "failed").length })}`}</small>
          <CanvasIcon name="chevronRight" size={14} />
        </summary>
        <div className="cw-chat-activity-detail">{sections.activity.map(renderPart)}</div>
      </details>}
      {sections.reply.map(renderPart)}
      {message.status === "streaming" && (
        <div className="cw-chat-progress" role="status" aria-live="polite">
          <span className="cw-chat-waiting" aria-hidden="true"><i /><i /><i /></span>
          {activityProgress(message, thinking, t)}
        </div>
      )}
      {!message.text &&
        !message.tools?.length &&
        message.status !== "streaming" && (
          <p className="cw-chat-progress">{t("assistant.reply.empty")}</p>
        )}
      {!!message.text && message.status !== "streaming" && (
        <div className="cw-chat-message-actions">
          <button
            type="button"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(formatText(message.text));
                setCopyState("copied");
              } catch {
                setCopyState("failed");
              }
            }}
          >
            <CanvasIcon name="copy" size={15} />
            <span>{copyState === "copied" ? t("assistant.reply.copied") : t("assistant.reply.copy")}</span>
          </button>
        </div>
      )}
    </>
  );
});
