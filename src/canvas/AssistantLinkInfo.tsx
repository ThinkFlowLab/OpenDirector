import { useLayoutEffect, useRef, useState } from "react";
import type { LinkSafetyModalProps } from "streamdown";
import type { Translate } from "../i18n/I18nProvider.tsx";
import { CanvasIcon } from "./CanvasIcon";
import "./assistant-link-info.css";

/** A nonmodal source card, kept next to its citation in the reply. */
export function AssistantLinkInfo({ url, onClose, onConfirm, t }: LinkSafetyModalProps & { t: Translate }) {
  const card = useRef<HTMLSpanElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = card.current;
    closeButton.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element?.contains(event.target) && !opener?.contains(event.target)) {
        close.current();
      }
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", outside);
      if (element?.contains(document.activeElement) && opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <span ref={card} className="cw-chat-link-info" data-streamdown="link-safety-modal"
      role="dialog" aria-label={t("assistant.reply.openExternalLink")}>
      <button ref={closeButton} type="button" className="cw-chat-link-close"
        aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
        <CanvasIcon name="close" size={16} />
      </button>
      <span className="cw-chat-link-description">{t("assistant.reply.externalLinkWarning")}</span>
      <span className="cw-chat-link-url">{url}</span>
      <span className="cw-chat-link-actions">
        <button type="button" onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopyState("copied");
          } catch { setCopyState("failed"); }
        }}>
          <CanvasIcon name={copyState === "copied" ? "check" : "copy"} size={14} />
          {t(copyState === "copied" ? "assistant.reply.copied" : "assistant.reply.copyLink")}
        </button>
        <button type="button" onClick={() => { onConfirm(); onClose(); }}>
          <CanvasIcon name="external" size={14} />
          {t("assistant.reply.openLink")}
        </button>
      </span>
      {copyState === "failed" && <span className="cw-chat-link-error" role="status">
        {t("assistant.reply.copyLinkFailed")}
      </span>}
    </span>
  );
}
