import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasNode } from "./model.ts";
import {
  pendingCanvasReferences,
  samePendingReferences,
  type PendingCanvasReference,
} from "./pendingCanvasReferences.ts";

interface PendingSelection {
  id: string;
  projectId: string;
  items: PendingCanvasReference[];
}

export function usePendingCanvasReferences(
  projectId: string,
  open: boolean,
  selectedNodes: readonly CanvasNode[],
  selectionRequest: number,
) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const latest = useRef(pending);
  const previous = useRef({
    projectId,
    open: false,
    selection: "",
    request: 0,
  });
  const suppressed = useRef(false);
  const cancel = useCallback(() => {
    latest.current = null;
    setPending(null);
  }, []);
  const isCurrent = useCallback((id: string) => latest.current?.id === id, []);
  const consume = useCallback(
    (id: string) => {
      if (latest.current?.id === id) cancel();
    },
    [cancel],
  );
  const selection = JSON.stringify(selectedNodes.map((node) => node.id).sort());
  useEffect(() => {
    const before = previous.current;
    previous.current = {
      projectId,
      open,
      selection,
      request: selectionRequest,
    };
    if (before.projectId !== projectId || !open || !before.open)
      suppressed.current = false;
    if (!open || !selectedNodes.length) {
      cancel();
      return;
    }
    const items = pendingCanvasReferences(selectedNodes);
    const changed =
      before.projectId !== projectId ||
      !before.open ||
      before.selection !== selection ||
      before.request !== selectionRequest;
    const refreshed =
      latest.current && !samePendingReferences(latest.current.items, items);
    if (!suppressed.current && (changed || refreshed)) {
      const value = { id: crypto.randomUUID(), projectId, items };
      latest.current = value;
      setPending(value);
    }
  }, [projectId, open, selection, selectionRequest, selectedNodes, cancel]);
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      if (target.closest(".react-flow")) suppressed.current = false;
      if (
        !latest.current ||
        target.closest(
          "[data-pending-references],.cw-chat-reference-editor,.cw-chat-button,.cw-chat-result,.cw-preview",
        )
      )
        return;
      if (
        event.shiftKey &&
        target.closest(".react-flow") &&
        !target.closest("button,input,textarea,select")
      )
        return;
      cancel();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        suppressed.current = false;
        return;
      }
      if (!latest.current || event.isComposing || event.keyCode === 229) return;
      // Menus and modal previews own their dismissal.
      if (
        event.target instanceof Element &&
        event.target.closest('[role="menu"],dialog:modal')
      )
        return;
      event.preventDefault();
      suppressed.current = true;
      cancel();
      // Allow an active marquee to cancel too, without letting its final
      // selection repopulate the just-cancelled preview.
      if (
        !(
          event.target instanceof Element &&
          event.target.closest(
            '.cw-workspace[data-canvas-interacting="true"]',
          ) &&
          !event.target.closest(".cw-assistant-panel")
        )
      )
        event.stopPropagation();
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [cancel]);
  return {
    pending: open && pending?.projectId === projectId ? pending : null,
    cancel,
    consume,
    isCurrent,
  };
}
