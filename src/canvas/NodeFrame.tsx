import { useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import type { CanvasNodeKind } from "./model";
import { nodePorts } from "./connectionPolicy.ts";
import { CanvasActionsContext } from "./CanvasActionsContext";
import { CanvasIcon } from "./CanvasIcon";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { displayNodeTitle } from "./nodeTitle.ts";

/** Shared node chrome and title editing; each node renderer owns only its contents. */
export function NodeFrame({
  id,
  kind,
  title,
  selected,
  empty,
  busy,
  children,
}: {
  id: string;
  kind: CanvasNodeKind;
  title: string;
  selected: boolean;
  empty: boolean;
  busy: boolean;
  children: ReactNode;
}) {
  const { t, locale } = useI18n();
  const shownTitle = displayNodeTitle(kind, title, locale);
  const actions = useContext(CanvasActionsContext);
  const locked = Boolean(actions?.isLocked(id));
  const target = actions?.referenceTargetState?.(id);
  const editing = actions?.nameEdit?.id === id;
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (!editing || finished.current) return;
    finished.current = true;
    actions?.finishNameEdit?.(save);
  };
  useLayoutEffect(() => {
    if (editing) {
      finished.current = false;
      input.current?.focus({ preventScroll: true });
      input.current?.select();
      if (actions?.nameEdit?.value === title && shownTitle !== title)
        actions?.changeNameDraft?.(shownTitle);
    }
  }, [editing, title, shownTitle]);
  return (
    <div
      className={`cw-node cw-node-${kind}${target ? ` cw-node-reference-${target}` : ""}${empty ? " cw-node-empty" : ""}${selected ? " cw-node-selected" : ""}${locked ? " cw-node-locked" : ""}${busy ? " cw-node-generating" : ""}${actions?.isArriving(id) ? " cw-node-result-arrival" : ""}`}
      aria-busy={busy}
      onContextMenu={(event) => {
        if (
          (event.target as Element).closest(
            "input,textarea,[contenteditable=true]",
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        actions?.contextMenu(id, event);
      }}
    >
      <div className="cw-node-heading">
        <span className="cw-node-type">
          <CanvasIcon name={kind} size={15} />
        </span>
        {editing ? (
          <span
            className="cw-node-title-field nodrag nopan nowheel"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <span aria-hidden="true" className="cw-node-title-measure">
              {actions?.nameEdit?.value ||
                t("canvasNodes.nodeName.placeholder")}
            </span>
            <input
              ref={input}
              className="cw-node-title-input"
              aria-label={t("canvasNodes.nodeName.aria")}
              placeholder={t("canvasNodes.nodeName.placeholder")}
              value={actions?.nameEdit?.value ?? ""}
              onChange={(event) =>
                actions?.changeNameDraft?.(event.target.value)
              }
              onBlur={() => finish(true)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.currentTarget.value.trim()) finish(true);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  finish(false);
                }
              }}
            />
          </span>
        ) : (
          <span
            className="cw-node-title nodrag nopan"
            title={
              locked
                ? shownTitle
                : t("canvasNodes.nodeName.renameHint", { title: shownTitle })
            }
            tabIndex={0}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              actions?.rename(id);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "F2") {
                event.preventDefault();
                event.stopPropagation();
                actions?.rename(id);
              }
            }}
          >
            {shownTitle}
          </span>
        )}
        {locked && <CanvasIcon name="lock" size={12} />}
      </div>
      {children}
      {["text", "image", "video", "audio"].includes(kind) &&
        (actions?.versionCount?.(id) ?? 0) > 1 && (
          <button
            type="button"
            className="cw-node-version-button nodrag nopan nowheel"
            aria-label={t("canvasNodes.history.aria", {
              count: actions?.versionCount?.(id) ?? 0,
            })}
            aria-expanded={actions?.versionsOpen?.(id) ?? false}
            title={t("canvasNodes.history.title")}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              actions?.showVersions?.(
                id,
                event.currentTarget.getBoundingClientRect(),
              );
            }}
          >
            <span className="cw-node-badge-count">
              {actions?.versionCount?.(id)}
            </span>
            <CanvasIcon name="chevronDown" size={11} />
          </button>
        )}
      {nodePorts(kind).target && (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          isConnectable={false}
          className="cw-port cw-proxy-port"
        />
      )}
      {nodePorts(kind).source && (
        <Handle
          id="out"
          type="source"
          position={Position.Right}
          isConnectable={false}
          className="cw-port cw-proxy-port"
        />
      )}
    </div>
  );
}
