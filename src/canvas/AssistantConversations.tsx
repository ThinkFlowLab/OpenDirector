import { useEffect, useId, useRef, useState } from "react";
import type { ConversationSummary } from "../backend/chat";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { useT } from "../i18n/I18nProvider.tsx";

/** Session navigation stays inside the assistant, independent of canvas projects. */
export function AssistantConversations({
  activeId,
  hasMessages,
  projectTitle,
  items,
  loading,
  error,
  disabledReason,
  changing,
  onRefresh,
  onChange,
  onClose,
  collapsible = true,
}: {
  activeId?: string;
  hasMessages: boolean;
  projectTitle: string;
  items: ConversationSummary[];
  loading: boolean;
  error: string;
  disabledReason: string;
  changing: boolean;
  onRefresh: () => void;
  onChange: (id?: string, create?: boolean) => Promise<boolean>;
  onClose: () => void;
  collapsible?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const titleText = (item?: ConversationSummary) =>
    item?.title ?? t(item?.messageCount ? "assistant.sessions.media" : "assistant.sessions.new");
  const shown = items.filter((item) =>
    titleText(item).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const title = titleText(items.find((item) => item.id === activeId));
  const closeHistory = (focus = false) => {
    setOpen(false);
    if (focus)
      root.current
        ?.querySelector<HTMLButtonElement>("[data-session-history]")
        ?.focus();
  };

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);

  const choose = async (id?: string, create = false) => {
    if (disabledReason) return;
    if (await onChange(id, create)) closeHistory();
  };

  return (
    <div
      className="cw-assistant-sessions"
      ref={root}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeHistory(true);
        } else if (
          !event.nativeEvent.isComposing &&
          ["ArrowDown", "ArrowUp"].includes(event.key)
        ) {
          const options = [
            ...(root.current?.querySelectorAll<HTMLButtonElement>(
              ".cw-assistant-session-row:not(:disabled)",
            ) ?? []),
          ];
          if (!options.length) return;
          event.preventDefault();
          const index = options.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            index < 0
              ? event.key === "ArrowDown"
                ? 0
                : options.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                options.length;
          options[next]?.focus();
        }
      }}
    >
      <header className="cw-assistant-header">
        <h2 title={hasMessages ? title : t("assistant.sessions.new")}>
          {hasMessages ? title : t("assistant.sessions.new")}
        </h2>
        <div className="cw-assistant-header-actions">
          <TooltipButton
            className="cw-assistant-new-session"
            label={disabledReason || t("assistant.sessions.create")}
            aria-label={t("assistant.sessions.create")}
            aria-disabled={!!disabledReason}
            tooltipSide="bottom"
            onClick={() => void choose(undefined, true)}
          >
            <CanvasIcon name="plus" size={16} />
            <span>{t("assistant.sessions.createShort")}</span>
          </TooltipButton>
          <TooltipButton
            className="cw-assistant-icon-button"
            label={t("assistant.sessions.history")}
            data-session-history
            tooltipSide="bottom"
            showTooltip={!open}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-controls={listId}
            onClick={() => {
              if (open) closeHistory();
              else {
                setQuery("");
                setOpen(true);
                onRefresh();
              }
            }}
          >
            <CanvasIcon name="history" size={18} />
          </TooltipButton>
          {collapsible && <TooltipButton
            className="cw-assistant-collapse"
            label={t("assistant.sessions.collapse")}
            tooltipSide="bottom"
            aria-controls="canvas-assistant"
            aria-expanded="true"
            onClick={onClose}
          >
            <CanvasIcon name="collapse" size={18} />
          </TooltipButton>}
        </div>
      </header>
      {open && (
        <section
          id={listId}
          className="cw-assistant-session-history"
          role="dialog"
          aria-label={t("assistant.sessions.history")}
        >
          <div className="cw-assistant-session-heading">
            <strong>{t("assistant.sessions.history")}</strong>
            <span title={projectTitle}>
              {t("assistant.sessions.currentCanvas")}
            </span>
          </div>
          <label className="cw-assistant-session-search">
            <CanvasIcon name="search" size={16} />
            <input
              ref={search}
              aria-label={t("assistant.sessions.search")}
              placeholder={t("assistant.sessions.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {disabledReason && (
            <p className="cw-assistant-session-notice" role="status">
              {disabledReason}
            </p>
          )}
          {error ? (
            <div className="cw-assistant-session-notice" role="alert">
              <p>{error}</p>
              <button type="button" onClick={onRefresh}>
                {t("assistant.sessions.retry")}
              </button>
            </div>
          ) : loading ? (
            <p className="cw-assistant-session-notice" role="status">
              {t("assistant.sessions.loading")}
            </p>
          ) : (
            <div className="cw-assistant-session-list" aria-busy={changing}>
              {shown.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="cw-assistant-session-row"
                  aria-current={item.id === activeId ? "true" : undefined}
                  disabled={!!disabledReason}
                  title={titleText(item)}
                  onClick={() => void choose(item.id)}
                >
                  <span className="cw-assistant-session-details">
                    <strong>{titleText(item)}</strong>
                    <small>
                      {item.messageCount
                        ? t("assistant.sessions.messageCount", {
                            count: item.messageCount,
                          })
                        : t("assistant.sessions.noMessages")}
                      {item.hasDraft
                        ? ` · ${t("assistant.sessions.hasDraft")}`
                        : ""}
                    </small>
                  </span>
                  {item.id === activeId && (
                    <span className="cw-assistant-session-current">
                      <CanvasIcon name="check" size={14} />
                      {t("assistant.sessions.current")}
                    </span>
                  )}
                </button>
              ))}
              {!shown.length && (
                <p className="cw-assistant-session-notice">
                  {query.trim()
                    ? t("assistant.sessions.noMatches")
                    : t("assistant.sessions.empty")}
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
