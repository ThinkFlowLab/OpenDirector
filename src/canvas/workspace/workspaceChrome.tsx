import { type Node } from "@xyflow/react";
import { lazy } from "react";
import { CanvasReferenceEdge } from "../CanvasConnections";

import { CanvasIcon } from "../CanvasIcon";
import { CanvasNodeView } from "../CanvasNodeView";
import { type ActiveGeneration } from "../generationActivity";

import { incomingReferenceNodes } from "../generationReferenceContent.ts";
import { type CanvasDocument, type CanvasNodeData, type CanvasNodeKind, type Point } from "../model";

import type { MessageKey } from "../../i18n/types";
import { type CanvasToolId } from "../toolCatalog";
import { TooltipButton } from "../TooltipButton";
import { type PortSide } from "../useCanvasReferences";


export const DirectorStage = lazy(() =>
  import("../DirectorStage").then((module) => ({
    default: module.DirectorStage,
  })),
);

export type FlowNode = Node<CanvasNodeData, CanvasNodeKind>;
export type Panel = "assets" | "search" | "history" | null;
export type Menu = {
  mode?: "create" | "context";
  x: number;
  y: number;
  world: Point;
  nodeId?: string;
  parentId?: string;
  connected?: {
    id: string;
    ids?: string[];
    direction: "source" | "target";
    side?: PortSide;
    anchor?: Point;
  };
};
/** A generation submitted to the local API from this page. */
export type ServiceRun = ActiveGeneration & {
  controller: AbortController;
  projectId?: string;
  taskId?: string;
  /** Pending unified delivery, not a persisted or synthetic Job. */
  unified?: boolean;
  /** Tool tasks are cancelled through the tool task route. */
  tool?: CanvasToolId;
  targetNodeId?: string;
};
/** Media kind of a tool's first result, or null when it is only known after the run. */
export const toolOutputKind = (
  tool: CanvasToolId,
  source: CanvasNodeKind,
): "image" | "video" | "audio" | null => {
  if (tool === "dynamic-poster") return "video";
  // Separation returns a soundtrack and a silent video in one run.
  if (tool === "audio-separation") return null;
  return source === "image" || source === "video" || source === "audio"
    ? source
    : null;
};
export const jobTime = (locale: string) =>
  new Date().toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
/** Shortcut hints name the keys the running platform actually has. */
export const helpShortcuts = (
  mac: boolean,
  t: (key: MessageKey) => string,
): Array<[string, string]> =>
  mac
    ? [
        [t("canvas.workspace.help.pan"), t("canvas.workspace.help.panKeys")],
        [t("canvas.workspace.help.zoom"), t("canvas.workspace.help.zoomKeys")],
        [t("canvas.workspace.help.marquee"), t("canvas.workspace.help.marqueeKeys")],
        [t("canvas.workspace.help.tools"), t("canvas.workspace.help.toolsKeys")],
        [t("canvas.workspace.help.upload"), t("canvas.workspace.help.uploadKeys")],
        [t("canvas.workspace.help.undoRedo"), t("canvas.workspace.help.undoRedoKeys")],
        [t("canvas.workspace.help.clipboard"), t("canvas.workspace.help.clipboardKeys")],
        [t("canvas.workspace.help.group"), t("canvas.workspace.help.groupKeys")],
        [t("canvas.workspace.help.fit"), t("canvas.workspace.help.fitKeys")],
        [t("canvas.workspace.help.nudge"), t("canvas.workspace.help.nudgeKeys")],
        [t("canvas.workspace.help.delete"), t("canvas.workspace.help.deleteKeys")],
        [t("canvas.workspace.help.toggleAssistant"), t("canvas.workspace.help.doubleShift")],
      ]
    : [
        [t("canvas.workspace.help.pan"), t("canvas.workspace.help.panKeys")],
        [t("canvas.workspace.help.zoom"), t("canvas.workspace.help.zoomKeysPc")],
        [t("canvas.workspace.help.marquee"), t("canvas.workspace.help.marqueeKeys")],
        [t("canvas.workspace.help.tools"), t("canvas.workspace.help.toolsKeys")],
        [t("canvas.workspace.help.upload"), t("canvas.workspace.help.uploadKeysPc")],
        [t("canvas.workspace.help.undoRedo"), t("canvas.workspace.help.undoRedoKeysPc")],
        [t("canvas.workspace.help.clipboard"), t("canvas.workspace.help.clipboardKeysPc")],
        [t("canvas.workspace.help.group"), t("canvas.workspace.help.groupKeysPc")],
        [t("canvas.workspace.help.fit"), t("canvas.workspace.help.fitKeys")],
        [t("canvas.workspace.help.nudge"), t("canvas.workspace.help.nudgeKeys")],
        [t("canvas.workspace.help.delete"), t("canvas.workspace.help.deleteKeysPc")],
        [t("canvas.workspace.help.toggleAssistant"), t("canvas.workspace.help.doubleShift")],
      ];
export const nodeTypes = {
  image: CanvasNodeView,
  video: CanvasNodeView,
  audio: CanvasNodeView,
  file: CanvasNodeView,
  text: CanvasNodeView,
  group: CanvasNodeView,
  timeline: CanvasNodeView,
  subject: CanvasNodeView,
  stack: CanvasNodeView,
  tool: CanvasNodeView,
  external: CanvasNodeView,
};
export const edgeTypes = { reference: CanvasReferenceEdge };
export const referenceSideKeys: Record<PortSide, MessageKey> = {
  top: "canvas.workspace.side.top",
  right: "canvas.workspace.side.right",
  bottom: "canvas.workspace.side.bottom",
  left: "canvas.workspace.side.left",
};

export const nodeKindKeys: Record<CanvasNodeKind, MessageKey> = {
  image: "canvas.workspace.kind.image",
  video: "canvas.workspace.kind.video",
  audio: "canvas.workspace.kind.audio",
  text: "canvas.workspace.kind.text",
  file: "canvas.workspace.kind.file",
  group: "canvas.workspace.kind.group",
  timeline: "canvas.workspace.kind.timeline",
  subject: "canvas.workspace.kind.subject",
  stack: "canvas.workspace.kind.stack",
  tool: "canvas.workspace.kind.tool",
  external: "canvas.workspace.kind.external",
};
export const kinds: CanvasNodeKind[] = [
  "image",
  "video",
  "audio",
  "text",
  "timeline",
  "subject",
  "stack",
  "tool",
  "external",
  "file",
  "group",
];
export type EditorMode =
  | "default"
  | "layers"
  | "annotation"
  | "grid"
  | "mask"
  | "trim"
  | "frame"
  | "extract-audio"
  | "crop";

export function IconButton({
  name,
  label,
  onClick,
  active,
  highlighted = active,
  disabled,
  shortcut,
  size,
  tooltipSide = "top",
  tooltipDelay = 200,
}: {
  name: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  highlighted?: boolean;
  disabled?: boolean;
  shortcut?: string;
  size?: number;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  tooltipDelay?: number;
}) {
  return (
    <TooltipButton
      className={`cw-icon-button ${highlighted ? "is-active" : ""}`}
      aria-label={label}
      label={label}
      shortcut={shortcut}
      tooltipSide={tooltipSide}
      tooltipDelay={tooltipDelay}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <CanvasIcon name={name} size={size} />
    </TooltipButton>
  );
}

export function incomingNodes(
  document: CanvasDocument,
  nodeId: string | null | undefined,
) {
  return incomingReferenceNodes(document, nodeId);
}

export type SaveStatus =
  | { state: "opening" | "saving" | "saved" }
  | { state: "savedViewFailed"; warning: string }
  | { state: "failed"; error: string };
