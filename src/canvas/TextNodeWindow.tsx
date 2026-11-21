import {
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useT } from "../i18n/I18nProvider";
import type { CanvasNode } from "./model";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { TextNodeEditor, type TextSelections } from "./TextNodeEditor";
import { TextMarkdown } from "./TextMarkdown";
import "./text-node-window.css";

/** A large editing surface for a text node.
 *
 * The window edits the same `data.text` the inline canvas editor writes, so the
 * two entries stay equivalent: no copy of the script lives here, and every
 * keystroke goes through the node command that already owns undo, autosave and
 * locking. The whole session is one undo step, like editing inside the node.
 */
export function TextNodeWindow({
  node,
  locked,
  selections,
  onUpdate,
  onClose,
  onBeginEdit,
  onEndEdit,
}: {
  node: CanvasNode;
  locked: boolean;
  selections: TextSelections;
  onUpdate: (text: string) => void;
  onClose: () => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const text = node.data.text ?? "";
  useLayoutEffect(() => {
    onBeginEdit();
    return onEndEdit;
  }, [onBeginEdit, onEndEdit]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    // Keep focus in the window: the canvas toolbar behind the backdrop must not
    // become the next tab stop while this surface is open.
    const controls = [
      ...(panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
      ) ?? []),
    ];
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (edge && document.activeElement === edge) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  };
  return (
    <div
      ref={panel}
      className="cw-modal-backdrop cw-text-window-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={keyDown}
    >
      <div className="cw-text-window">
        <header className="cw-text-window-header">
          <span className="cw-text-window-kind" aria-hidden="true">
            <CanvasIcon name="text" size={16} />
          </span>
          <div className="cw-text-window-heading">
            <strong id={titleId}>
              {node.data.title || t("canvas.kind.text")}
            </strong>
            <small id={hintId}>
              {locked
                ? t("canvas.textWindow.locked")
                : t("canvas.textWindow.hint")}
            </small>
          </div>
          <div
            className="cw-text-window-modes"
            role="group"
            aria-label={t("canvas.textWindow.mode")}
          >
            <button
              type="button"
              aria-pressed={!preview}
              onClick={() => setPreview(false)}
            >
              {t("canvas.textWindow.edit")}
            </button>
            <button
              type="button"
              aria-pressed={preview}
              onClick={() => setPreview(true)}
            >
              {t("canvas.textWindow.preview")}
            </button>
          </div>
          <div className="cw-text-window-controls">
            <TooltipButton
              label={t("common.close")}
              aria-label={t("common.close")}
              tooltipSide="bottom"
              onClick={onClose}
            >
              <CanvasIcon name="close" size={15} />
            </TooltipButton>
          </div>
        </header>
        {preview ? (
          <div
            className="cw-text-window-input cw-text-window-preview nodrag nopan nowheel"
            tabIndex={0}
          >
            <TextMarkdown text={text} />
          </div>
        ) : (
          <TextNodeEditor
            id={node.id}
            value={text}
            locked={locked}
            selections={selections}
            className="cw-text-window-input nodrag nopan nowheel"
            aria-labelledby={titleId}
            aria-describedby={hintId}
            placeholder={t("canvasNodes.text.placeholder")}
            onUpdate={onUpdate}
            onKeyDown={(event) => {
              // Canvas shortcuts act on nodes; typing here belongs to the text.
              // Escape still bubbles so the window can close without committing a
              // half-finished IME composition.
              if (event.key !== "Escape" || event.nativeEvent.isComposing)
                event.stopPropagation();
            }}
          />
        )}
        <footer className="cw-text-window-footer">
          <span>{t("canvas.textWindow.count", { count: text.length })}</span>
          {locked && (
            <span className="cw-text-window-locked">
              {t("canvas.textWindow.locked")}
            </span>
          )}
          <kbd>Esc</kbd>
          <button
            type="button"
            className="cw-text-window-done"
            onClick={onClose}
          >
            {t("common.done")}
          </button>
        </footer>
      </div>
    </div>
  );
}
