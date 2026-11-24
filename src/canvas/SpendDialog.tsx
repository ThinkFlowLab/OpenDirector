import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/I18nProvider";
import { CanvasIcon } from "./CanvasIcon";

/** A review waits for an existing modal, then keeps keyboard focus on the decision. */
export function SpendDialog({ title, focusKey, busy, onClose, children }: {
  title: string; focusKey: string; busy: boolean; onClose: () => void; children: ReactNode;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const observer = new MutationObserver(show);
    function show() {
      if (element.open || document.querySelector("dialog:modal")) return;
      element.showModal();
      close.current?.focus({preventScroll: true});
      observer.disconnect();
    }
    // Initial setup or model settings must finish before a pending review opens.
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    show();
    // Close before React removes the element so the browser restores the opener's focus.
    return () => { observer.disconnect(); element.close(); };
  }, []);
  useLayoutEffect(() => {
    const element = dialog.current!;
    if (element.open && !busy && !element.contains(document.activeElement)) close.current?.focus({preventScroll: true});
  }, [focusKey, busy]);
  useLayoutEffect(() => {
    const escape = (event: KeyboardEvent) => {
      const element = dialog.current!;
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing ||
          !element.open || !element.contains(document.activeElement)) return;
      // Canvas popovers listen on document capture. The modal owns this Escape.
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [busy, onClose]);
  return createPortal(<dialog ref={dialog} className="cw-spend-dialog cw-spend-panel"
    aria-labelledby="cw-spend-dialog-title" onKeyDown={event => event.stopPropagation()} onCancel={event => {
      event.preventDefault();
      if (!busy) onClose();
    }}>
    <div className="cw-spend-heading">
      <h3 id="cw-spend-dialog-title">{title}</h3>
      <button ref={close} type="button" className="cw-spend-close" disabled={busy}
        aria-label={t("common.close")} onClick={onClose}><CanvasIcon name="close" size={16} /></button>
    </div>
    <div className="cw-spend-body">{children}</div>
  </dialog>, document.body);
}
