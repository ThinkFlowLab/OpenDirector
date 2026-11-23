import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TooltipButton } from "./TooltipButton";
import { useT } from "../i18n/I18nProvider";

/** A selection menu lives outside the toolbar's horizontal scroll container. */
export function SelectionToolbarMenu({
  anchor,
  id,
  label,
  role = "menu",
  initialFocus = "first",
  onClose,
  children,
}: {
  anchor: HTMLButtonElement;
  id: string;
  label: string;
  role?: "menu" | "dialog";
  initialFocus?: "first" | "last";
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const panel = root.current;
    if (!panel) return;
    let frame = 0;
    let previous = "";
    const place = () => {
      if (!anchor.isConnected) {
        closeRef.current();
        return;
      }
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 12;
      const top = (viewport?.offsetTop ?? 0) + 12;
      const right = left + (viewport?.width ?? window.innerWidth) - 24;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 24;
      const target = anchor.getBoundingClientRect();
      const width = Math.min(panel.offsetWidth, right - left);
      const naturalHeight =
        panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      const below = Math.max(0, bottom - target.bottom - 8);
      const above = Math.max(0, target.top - top - 8);
      const down = naturalHeight <= below || below >= above;
      const space = down ? below : above;
      const maxHeight =
        space >= Math.min(160, naturalHeight) ? space : bottom - top;
      const height = Math.min(naturalHeight, maxHeight);
      const position = {
        left: Math.round(Math.max(left, Math.min(target.left, right - width))),
        top: Math.round(
          Math.max(
            top,
            Math.min(
              down ? target.bottom + 8 : target.top - height - 8,
              bottom - height,
            ),
          ),
        ),
        maxWidth: right - left,
        maxHeight,
      };
      const next = JSON.stringify(position);
      if (next !== previous) {
        Object.assign(panel.style, {
          left: `${position.left}px`,
          top: `${position.top}px`,
          maxWidth: `${position.maxWidth}px`,
          maxHeight: `${position.maxHeight}px`,
          visibility: "visible",
        });
        previous = next;
      }
      frame = requestAnimationFrame(place);
    };
    place();
    const items = panel.querySelectorAll<HTMLElement>(
      role === "menu"
        ? '[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled)'
        : 'input:not(:disabled),button:not(:disabled):not([tabindex="-1"])',
    );
    (items[initialFocus === "last" ? items.length - 1 : 0] ?? panel).focus({
      preventScroll: true,
    });
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !anchor.contains(event.target)
      )
        closeRef.current();
    };
    const dismissOnFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !anchor.contains(event.target)
      )
        closeRef.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      anchor.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("focusin", dismissOnFocus, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("focusin", dismissOnFocus, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [anchor, initialFocus, role]);

  return createPortal(
    <div
      ref={root}
      id={id}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className="cw-selection-menu nodrag nopan nowheel"
      style={{ visibility: "hidden" }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (role !== "menu") return;
        if (event.key === "Tab") {
          onClose();
          anchor.focus({ preventScroll: true });
          return;
        }
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const items = [
          ...(root.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled)',
          ) ?? []),
        ];
        if (!items.length) return;
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
                items.length;
        items[next]?.focus({ preventScroll: true });
        items[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Hover previews dimensions; activating a grid cell creates the chosen tiles. */
export function GridSplitOptions({
  onConfirm,
  onCancel,
}: {
  onConfirm: (rows: number, columns: number) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [size, setSize] = useState({ rows: 3, columns: 3 });
  const grid = useRef<HTMLDivElement>(null);
  const dimensions = Array.from({ length: 7 }, (_, index) => index + 1);
  return (
    <div className="cw-grid-split-options">
      <header>
        <strong>{t("canvas.selection.gridSplit")}</strong>
        <span aria-live="polite">
          {t("canvas.selection.gridSize", {
            rows: size.rows,
            columns: size.columns,
          })}
        </span>
      </header>
      <p>{t("canvas.selection.gridSplitHint")}</p>
      <div
        ref={grid}
        role="group"
        aria-label={t("canvas.selection.gridSizeLabel")}
        className="cw-grid-split-cells"
        onKeyDown={(event) => {
          const movement: Record<string, [number, number]> = {
            ArrowLeft: [0, -1],
            ArrowRight: [0, 1],
            ArrowUp: [-1, 0],
            ArrowDown: [1, 0],
          };
          const delta = movement[event.key];
          if (!delta) return;
          event.preventDefault();
          const rows = Math.max(1, Math.min(7, size.rows + delta[0]));
          const columns = Math.max(1, Math.min(7, size.columns + delta[1]));
          setSize({ rows, columns });
          grid.current
            ?.querySelector<HTMLButtonElement>(
              `[data-size="${rows}-${columns}"]`,
            )
            ?.focus({ preventScroll: true });
        }}
      >
        {dimensions.flatMap((rows) =>
          dimensions.map((columns) => (
            <TooltipButton
              key={`${rows}-${columns}`}
              data-size={`${rows}-${columns}`}
              label={t("canvas.selection.gridSize", { rows, columns })}
              tooltipSide="right"
              aria-pressed={size.rows === rows && size.columns === columns}
              tabIndex={size.rows === rows && size.columns === columns ? 0 : -1}
              className={
                rows <= size.rows && columns <= size.columns ? "is-filled" : ""
              }
              onPointerEnter={() => setSize({ rows, columns })}
              onFocus={() => setSize({ rows, columns })}
              onClick={() => {
                if (rows * columns > 1) onConfirm(rows, columns);
              }}
            />
          )),
        )}
      </div>
      <footer>
        <button type="button" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="is-primary"
          disabled={size.rows * size.columns < 2}
          onClick={() => onConfirm(size.rows, size.columns)}
        >
          {t("canvas.selection.gridSplitConfirm", {
            count: size.rows * size.columns,
          })}
        </button>
      </footer>
    </div>
  );
}
