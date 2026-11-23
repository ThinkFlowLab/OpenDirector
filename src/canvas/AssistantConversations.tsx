import { useEffect, useId, useRef, useState } from "react";
import type { ConversationSummary } from "../backend/chat";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { useT } from "../i18n/I18nProvider.tsx";
import type { AssistantLayout } from "./useAssistantLayout";

const dockControls = {
  left: { icon: "dockLeft", label: "assistant.panel.dock" },
  right: { icon: "dockRight", label: "assistant.panel.dockRight" },
} as const;

/** Session navigation stays inside the assistant, independent of canvas projects. */
export function AssistantConversations({
  activeId,
  messageCount,
  hasDraft,
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
  placement,
}: {
  activeId?: string;
  messageCount: number;
  hasDraft: boolean;
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
  placement?: Pick<AssistantLayout, "floating" | "toggleFloating" | "moveHandle" | "side" | "dockTo">;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const oppositeSide = placement?.side === "left" ? "right" : "left";
  const floatControl = placement?.floating
    ? dockControls[placement.side]
    : { icon: "floatPanel", label: "assistant.panel.float" } as const;
  const titleText = (item?: ConversationSummary) =>
    item?.title ??
    t(
      item?.messageCount
        ? "assistant.sessions.media"
        : "assistant.sessions.new",
    );
  const shown = items.filter((item) =>
    titleText(item)
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const title = messageCount
    ? titleText(items.find((item) => item.id === activeId))
    : t("assistant.sessions.new");
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
    if (await onChange(id, create)) {
      if (create) setQuery("");
      closeHistory();
    }
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
        {placement ? (
          <h2
            className="cw-assistant-move-handle"
            tabIndex={0}
            title={t("assistant.panel.moveHint")}
            aria-description={t("assistant.panel.moveHint")}
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
            {...placement.moveHandle}
            onPointerDown={(event) => {
              if (open) closeHistory();
              placement.moveHandle.onPointerDown(event);
            }}
          >
            <CanvasIcon name="grip" size={16} />
            <span>{title}</span>
          </h2>
        ) : (
          <h2 title={title}>{title}</h2>
        )}
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
          {placement && <>
            <TooltipButton
              className="cw-assistant-icon-button"
              label={t(dockControls[oppositeSide].label)}
              tooltipSide="bottom"
              aria-controls="canvas-assistant"
              onClick={() => {
                closeHistory();
                placement.dockTo(oppositeSide);
              }}
            >
              <CanvasIcon name={dockControls[oppositeSide].icon} size={18} />
            </TooltipButton>
            <TooltipButton
              className="cw-assistant-icon-button cw-assistant-placement-toggle"
              label={t(floatControl.label)}
              tooltipSide="bottom"
              aria-controls="canvas-assistant"
              onClick={() => {
                closeHistory();
                placement.toggleFloating();
              }}
            >
              <CanvasIcon name={floatControl.icon} size={18} />
            </TooltipButton>
          </>}
          {collapsible && (
            <TooltipButton
              className="cw-assistant-collapse"
              label={t("assistant.sessions.collapse")}
              tooltipSide="bottom"
              aria-controls="canvas-assistant"
              aria-expanded="true"
              onClick={onClose}
            >
              <CanvasIcon name="collapse" size={18} />
            </TooltipButton>
          )}
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
            <span title={projectTitle}>{t("assistant.sessions.currentCanvas")}</span>
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
            <div
              className="cw-assistant-session-list"
              aria-busy={changing || loading}
            >
              {shown.map((item) => {
                const active = item.id === activeId;
                const count = active ? messageCount : item.messageCount;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="cw-assistant-session-row"
                    aria-current={active || undefined}
                    disabled={!!disabledReason}
                    title={titleText(item)}
                    onClick={() => void choose(item.id)}
                  >
                    <span className="cw-assistant-session-details">
                      <strong>{titleText(item)}</strong>
                      <small>
                        {count
                          ? t("assistant.sessions.messageCount", { count })
                          : t("assistant.sessions.noMessages")}
                        {(active ? hasDraft : item.hasDraft)
                          ? ` · ${t("assistant.sessions.hasDraft")}`
                          : ""}
                      </small>
                    </span>
                    {active && (
                      <span className="cw-assistant-session-current">
                        <CanvasIcon name="check" size={14} />
                        {t("assistant.sessions.current")}
                      </span>
                    )}
                  </button>
                );
              })}
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
