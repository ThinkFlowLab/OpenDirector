import type { ChatCanvasLink } from "../backend/chat";
import type { MessageKey } from "../i18n/types";

/** The decision made when a resolved canvas link is clicked. */
export type CanvasLinkClick =
  | { focus: string }
  | { hintKey: MessageKey; projectId?: string };

export type CanvasLinkHint = { hintKey: MessageKey; projectId?: string };

/** Map a resolved link to its click behavior, split out for logic-level tests. */
export function canvasLinkClickAction(link: ChatCanvasLink): CanvasLinkClick {
  if ((link.status === "focused" || link.status === "hidden") && link.nodeId) {
    return { focus: link.nodeId };
  }
  const keys: Record<string, MessageKey> = {
    "cross-project": "assistant.reply.canvasLink.crossProject",
    materialize: "assistant.reply.canvasLink.materialize",
    ambiguous: "assistant.reply.canvasLink.ambiguous",
    missing: "assistant.reply.canvasLink.missing",
  };
  return {
    hintKey: keys[link.status] ?? "assistant.reply.canvasLink.missing",
    ...(link.status === "cross-project" && link.projectId
      ? { projectId: link.projectId }
      : {}),
  };
}

/**
 * Apply a click: focus the referenced node, or return the hint to display.
 * Split from the React handler so the rendered-reference path can be tested.
 */
export function applyCanvasLinkClick(
  link: ChatCanvasLink,
  focus: (nodeId: string) => void,
): CanvasLinkHint | null {
  const action = canvasLinkClickAction(link);
  if ("focus" in action) {
    focus(action.focus);
    return null;
  }
  return action;
}
