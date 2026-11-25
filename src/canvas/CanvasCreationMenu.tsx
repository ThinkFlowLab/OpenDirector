import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { CANVAS_CREATION_TOOLS } from "./creationTools";
import { shortcutKeys, type ShortcutId } from "./shortcuts";
import type { CanvasNodeKind } from "./model";
import { useT } from "../i18n/I18nProvider";
import "./canvas-creation-menu.css";

function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ),
  ];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "ArrowDown"
      ? (index + 1) % items.length
      : event.key === "ArrowUp"
        ? (index - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : null;
  if (next !== null) {
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  }
}

type CreationActions = {
  onCreate: (kind: CanvasNodeKind) => void;
  onAssets: () => void;
  onUpload: () => void;
};

export function CreationMenuContent({
  onCreate,
  onAssets,
  onUpload,
  allowedKinds,
}: CreationActions & { allowedKinds?: readonly CanvasNodeKind[] }) {
  const t = useT();
  return (
    <>
      <div className="cw-menu-caption">{t("canvas.menu.newNode")}</div>
      {CANVAS_CREATION_TOOLS.map((tool) =>
        tool.unavailable ? (
          <TooltipButton
            key={tool.kind}
            role="menuitem"
            aria-label={t(tool.labelKey)}
            aria-disabled="true"
            label={t("canvas.menu.unavailable")}
            tooltipSide="right"
            onClick={(event) => event.preventDefault()}
          >
            <CanvasIcon name={tool.icon} size={18} />
            <span>{t(tool.labelKey)}</span>
          </TooltipButton>
        ) : (
          <button
            key={tool.kind}
            role="menuitem"
            disabled={Boolean(
              allowedKinds && !allowedKinds.includes(tool.kind),
            )}
            title={
              allowedKinds && !allowedKinds.includes(tool.kind)
                ? t("canvas.menu.downstreamUnavailable")
                : undefined
            }
            onClick={() => onCreate(tool.kind)}
          >
            <CanvasIcon name={tool.icon} size={18} />
            <span>{t(tool.labelKey)}</span>
          </button>
        ),
      )}
      {!allowedKinds && (
        <>
          <hr />
          <button role="menuitem" onClick={onAssets}>
            <CanvasIcon name="rail-folder" size={18} />
            <span>{t("canvas.menu.addFromAssets")}</span>
          </button>
          <button role="menuitem" onClick={onUpload}>
            <CanvasIcon name="rail-upload" size={18} />
            <span>{t("canvas.menu.localUpload")}</span>
          </button>
        </>
      )}
    </>
  );
}

export function CanvasCreationMenu({
  x,
  y,
  mode,
  canPaste,
  canUndo,
  canRedo,
  onPaste,
  onUndo,
  onRedo,
  onOrganizeRuns,
  onClose,
  ...actions
}: CreationActions & {
  x: number;
  y: number;
  mode: "create" | "context";
  canPaste: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onPaste: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onOrganizeRuns?: () => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const focusSubmenu = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  const cancelClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  const closeSubmenu = () => {
    cancelClose();
    setExpanded(false);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setExpanded(false), 180);
  };
  const openSubmenu = (focus = false) => {
    cancelClose();
    focusSubmenu.current = focus;
    if (expanded && focus)
      submenu.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
    setExpanded(true);
  };

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !submenu.current?.contains(target))
        close.current();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      cancelClose();
    };
  }, []);
  useLayoutEffect(() => {
    root.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (expanded && focusSubmenu.current) {
      submenu.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
      focusSubmenu.current = false;
    }
  }, [expanded]);
  useEffect(() => {
    // Right-clicking a non-focusable caption can move focus to document.body.
    // Keep Escape usable even when the hovered submenu does not own focus.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (expanded) {
        closeSubmenu();
        trigger.current?.focus();
      } else {
        root.current
          ?.closest<HTMLElement>(".cw-workspace")
          ?.focus({ preventScroll: true });
        close.current();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [expanded]);
  const run = (action: () => void) => {
    action();
    onClose();
  };
  const creationActions = {
    onCreate: (kind: CanvasNodeKind) => run(() => actions.onCreate(kind)),
    onAssets: () => run(actions.onAssets),
    onUpload: () => run(actions.onUpload),
  };
  const shortcuts = ["paste", "redo", "undo"].map((id) =>
    shortcutKeys(id as ShortcutId),
  );
  const shell = (content: ReactNode) => (
    <div ref={root} onPointerLeave={scheduleClose} onPointerEnter={cancelClose}>
      <CanvasContextMenu
        x={x}
        y={y}
        className="cw-canvas-menu"
        aria-label={
          mode === "create"
            ? t("canvas.menu.newNode")
            : t("canvas.menu.canvasActions")
        }
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (expanded) {
              closeSubmenu();
              trigger.current?.focus();
            } else {
              root.current
                ?.closest<HTMLElement>(".cw-workspace")
                ?.focus({ preventScroll: true });
              onClose();
            }
          } else menuKeys(event);
        }}
      >
        {content}
      </CanvasContextMenu>
    </div>
  );
  return (
    <>
      {mode === "create"
        ? shell(<CreationMenuContent {...creationActions} />)
        : shell(
            <>
              <button
                ref={trigger}
                role="menuitem"
                className={expanded ? "is-open" : ""}
                aria-haspopup="menu"
                aria-expanded={expanded}
                onPointerEnter={() => openSubmenu()}
                onClick={() => openSubmenu(true)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    event.stopPropagation();
                    openSubmenu(true);
                  }
                }}
              >
                <span>{t("canvas.menu.newNode")}</span>
                <CanvasIcon name="chevronRight" size={18} />
              </button>
              <hr />
              {onOrganizeRuns && (
                <button
                  role="menuitem"
                  onPointerEnter={closeSubmenu}
                  onClick={() => run(onOrganizeRuns)}
                >
                  <span>{t("canvas.workspace.menu.organizeRuns")}</span>
                </button>
              )}
              <button
                role="menuitem"
                disabled={!canPaste}
                onPointerEnter={closeSubmenu}
                onClick={() => run(onPaste)}
              >
                <span>{t("canvas.menu.paste")}</span>
                <kbd>{shortcuts[0]}</kbd>
              </button>
              <button
                role="menuitem"
                disabled={!canRedo}
                onPointerEnter={closeSubmenu}
                onClick={() => run(onRedo)}
              >
                <span>{t("canvas.menu.redo")}</span>
                <kbd>{shortcuts[1]}</kbd>
              </button>
              <button
                role="menuitem"
                disabled={!canUndo}
                onPointerEnter={closeSubmenu}
                onClick={() => run(onUndo)}
              >
                <span>{t("canvas.menu.undo")}</span>
                <kbd>{shortcuts[2]}</kbd>
              </button>
            </>,
          )}
      {expanded &&
        mode === "context" &&
        createPortal(
          <div
            ref={submenu}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
          >
            <CanvasContextMenu
              x={x}
              y={y}
              anchor={trigger.current}
              className="cw-canvas-menu"
              aria-label={t("canvas.menu.newNode")}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeSubmenu();
                  trigger.current?.focus();
                } else menuKeys(event);
              }}
            >
              <CreationMenuContent {...creationActions} />
            </CanvasContextMenu>
          </div>,
          document.body,
        )}
    </>
  );
}
