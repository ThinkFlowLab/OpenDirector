import type { GenerationRequest, ReferenceInput } from "../backend/generation.ts";
import {
  backendBlocker,
  backendModel,
  backendReferences,
  backendVideoMode,
  serviceVoice,
  type ModelConfig,
} from "../backend/rules.ts";
import { tNow } from "../i18n/messages.ts";
import { assistantReferences } from "./assistantReferences.ts";
import type { PortSide } from "./connectionPorts.ts";
import { getNodeGenerationSettings } from "./generationSettings.ts";
import { generationContent } from "./generationReferenceContent.ts";
import type { ResultSource } from "./linkedResults.ts";
import type { CanvasCommand, CanvasDocument, CanvasNode, Point } from "./model.ts";
import { referenceSnapshot } from "./referenceEvidence.ts";
import { agentGenerationBlocker, agentNodeSettings } from "./textGeneration.ts";

type FlowChange = {
  type: string;
  id?: string;
  selected?: boolean;
  position?: Point;
  dimensions?: { width: number; height: number } | null;
  setAttributes?: boolean | "width" | "height";
};

/** React Flow select changes merge into the current ids. Existing order stays; new ids append. */
export function mergeFlowSelection(
  ids: readonly string[],
  changes: readonly { id: string; selected: boolean }[],
): string[] {
  const next = new Set(ids);
  for (const change of changes) {
    if (change.selected) next.add(change.id);
    else next.delete(change.id);
  }
  return [...next];
}

/** Select-all addresses visible cards. Folded stack members stay behind their stack. */
export function canvasSelectAllIds(nodes: readonly CanvasNode[]): string[] {
  const hidden = new Set<string>();
  for (const node of nodes)
    if (node.type === "stack")
      for (const id of node.data.stack?.nodeIds ?? []) hidden.add(id);
  return nodes.filter((node) => !hidden.has(node.id)).map((node) => node.id);
}

/**
 * Position and resize changes become one canvas command.
 * A cancelled gesture, or a drag still inside click slop, authors nothing.
 * A resize owns the gesture, including the child-compensation position that arrives with it.
 */
export function authorFlowChanges(
  changes: readonly FlowChange[],
  gesture: { cancelled: boolean; dragging: boolean; moved: boolean },
): CanvasCommand | null {
  if (gesture.cancelled || (gesture.dragging && !gesture.moved)) return null;
  const resize = changes.find(
    (change) =>
      change.type === "dimensions" &&
      change.id &&
      change.dimensions &&
      change.setAttributes,
  );
  if (resize?.id && resize.dimensions) {
    const move = changes.find(
      (change) => change.type === "position" && change.id === resize.id,
    );
    return {
      type: "resize-node",
      id: resize.id,
      width: resize.dimensions.width,
      height: resize.dimensions.height,
      ...(move?.position ? { position: move.position } : {}),
    };
  }
  const commands = changes.flatMap((change) =>
    change.type === "position" && change.id && change.position
      ? [
          {
            type: "update-node" as const,
            id: change.id,
            patch: { position: change.position },
          },
        ]
      : [],
  );
  return commands.length ? { type: "batch", commands } : null;
}

/** A dropped connection places the new node so the drop point is its facing port. */
export function placeCreatedNode(
  size: { width: number; height: number },
  where: Point,
  connected?: { direction: "source" | "target"; side?: PortSide },
  parent?: { id: string; origin: Point },
): { position: Point; parentId?: string } {
  let position = {
    x: where.x - size.width / 2,
    y: where.y - size.height / 2,
  };
  if (connected) {
    position = {
      x: where.x - (connected.direction === "target" ? size.width : 0),
      y: where.y - size.height / 2,
    };
    if (connected.side === "left")
      position = { x: where.x - size.width, y: where.y - size.height / 2 };
    if (connected.side === "top")
      position = { x: where.x - size.width / 2, y: where.y - size.height };
    if (connected.side === "bottom")
      position = { x: where.x - size.width / 2, y: where.y };
  }
  if (parent)
    position = {
      x: position.x - parent.origin.x,
      y: position.y - parent.origin.y,
    };
  return { position, ...(parent ? { parentId: parent.id } : {}) };
}

/** A connection drag opens the creation menu only after it leaves the handle as an unfinished link. */
export function connectionDragReleased(input: {
  spacePressed: boolean;
  cancelled: boolean;
  moved: boolean;
  start: Point | null;
  point: Point | null;
  isValid: boolean;
  hasEndpoints: boolean;
}): boolean {
  if (input.spacePressed || input.cancelled) return false;
  if (
    !input.point ||
    !input.start ||
    (!input.moved &&
      Math.hypot(input.point.x - input.start.x, input.point.y - input.start.y) <=
        4)
  )
    return false;
  return !input.isValid && input.hasEndpoints;
}

/** The menu anchors to the pane or an unlocked group. A drop on any other node is ignored. */
export function droppedConnectionTarget(input: {
  toNodeId?: string | null;
  groupId?: string | null;
  onPane: boolean;
  fromNodeId: string;
  direction: "source" | "target";
}): { id: string; direction: "source" | "target"; parentId?: string } | null {
  if (input.toNodeId && input.toNodeId !== input.groupId) return null;
  if (!input.groupId && !input.onPane) return null;
  return {
    id: input.fromNodeId,
    direction: input.direction,
    ...(input.groupId ? { parentId: input.groupId } : {}),
  };
}

export type CanvasKeyAction =
  | { type: "edit-text" }
  | { type: "history"; forward: boolean }
  | { type: "select-all" }
  | { type: "copy" }
  | { type: "cut" }
  | { type: "reorder"; direction: "front" | "back" | "forward" | "backward" }
  | { type: "paste"; duplicate: boolean }
  | { type: "group"; ungroup: boolean }
  | { type: "save" }
  | { type: "import" }
  | { type: "delete" }
  | { type: "fit"; selection: boolean }
  | { type: "add-text" }
  | { type: "preview" }
  | { type: "help" }
  | { type: "nudge"; delta: Point };

/** Keyboard actions once the workspace has decided the event belongs to the canvas. */
export function canvasKeyAction(input: {
  key: string;
  code: string;
  mod: boolean;
  shift: boolean;
  hasClipboard: boolean;
  editText: boolean;
  hasSingle: boolean;
}): CanvasKeyAction | null {
  const key = input.key.toLowerCase();
  if (!input.mod && input.key === "Enter" && input.editText)
    return { type: "edit-text" };
  if (input.mod && key === "z") return { type: "history", forward: input.shift };
  if (input.mod && key === "y") return { type: "history", forward: true };
  if (input.mod && key === "a") return { type: "select-all" };
  if (input.mod && key === "c") return { type: "copy" };
  if (input.mod && key === "x") return { type: "cut" };
  if (
    input.mod &&
    (input.code === "BracketLeft" || input.code === "BracketRight")
  )
    return {
      type: "reorder",
      direction:
        input.code === "BracketLeft"
          ? input.shift
            ? "back"
            : "backward"
          : input.shift
            ? "front"
            : "forward",
    };
  if (input.mod && key === "v" && input.hasClipboard)
    return { type: "paste", duplicate: false };
  if (input.mod && key === "d") return { type: "paste", duplicate: true };
  if (input.mod && key === "g") return { type: "group", ungroup: input.shift };
  if (input.mod && key === "s") return { type: "save" };
  if (input.mod && key === "o") return { type: "import" };
  if (input.key === "Delete" || input.key === "Backspace")
    return { type: "delete" };
  if (input.shift && input.code === "Digit1")
    return { type: "fit", selection: false };
  if (input.shift && input.code === "Digit2")
    return { type: "fit", selection: true };
  if (!input.mod && key === "t") return { type: "add-text" };
  if (!input.mod && key === "f" && input.hasSingle) return { type: "preview" };
  if (!input.mod && input.key === "?") return { type: "help" };
  if (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(input.key)
  ) {
    const step = input.shift ? 10 : 1;
    return {
      type: "nudge",
      delta: {
        x:
          input.key === "ArrowLeft"
            ? -step
            : input.key === "ArrowRight"
              ? step
              : 0,
        y:
          input.key === "ArrowUp"
            ? -step
            : input.key === "ArrowDown"
              ? step
              : 0,
      },
    };
  }
  return null;
}

type SubmissionAsset = { id: string; kind?: string | null };

/** Pinned prompt tokens submit the saved asset, never a canvas node invented from the label. */
export function pinnedSubmissionInputs(
  node: CanvasNode,
  assets: readonly SubmissionAsset[],
): ReferenceInput[] {
  return (node.data.promptContent ?? []).flatMap((part) => {
    if (part.type !== "reference" || part.binding !== "asset") return [];
    const asset = assets.find((item) => item.id === part.assetId);
    if (
      !asset?.kind ||
      !["text", "image", "video", "audio"].includes(asset.kind)
    )
      throw new Error(tNow("canvas.workspace.error.pinnedMetadataUnloaded"));
    return [
      {
        binding: "asset" as const,
        assetId: asset.id,
        fingerprint: part.fingerprint,
        referenceId: part.referenceId,
        kind: asset.kind as "image" | "video" | "audio" | "text",
        title: part.name,
      },
    ];
  });
}

export type ServiceGenerationPlan =
  | { status: "blocked"; message: string | null }
  | {
      status: "ready";
      request: GenerationRequest;
      origin: ResultSource;
      count: number;
      label: string;
    };

/** The request the workspace submits for an image, video, or audio node. */
export function serviceGenerationPlan(input: {
  document: Pick<CanvasDocument, "id" | "title" | "nodes">;
  node: CanvasNode;
  incoming: readonly CanvasNode[];
  models: readonly ModelConfig[];
  assets: readonly SubmissionAsset[];
}): ServiceGenerationPlan {
  const settings = getNodeGenerationSettings(input.node, input.models);
  const config = backendModel(settings, input.models);
  const blocked = backendBlocker(settings, input.incoming, input.models);
  if (blocked || !config)
    return { status: "blocked", message: blocked };
  const references = backendReferences(settings, input.incoming, config);
  const request: GenerationRequest = {
    documentId: input.document.id,
    documentTitle: input.document.title,
    nodeId: input.node.id,
    promptContent: generationContent(input.node, input.incoming),
    config,
    kind: settings.mode,
    prompt: settings.prompt,
    title: input.node.data.title,
    videoMode: backendVideoMode(settings, references, config),
    durationSeconds: config.inputRules.videoCapabilities
      ? settings.durationSeconds
      : undefined,
    aspectRatio: settings.aspectRatio,
    resolution: settings.resolution,
    voice: serviceVoice(settings),
    references: [
      ...assistantReferences(input.incoming).map((item) => ({
        ...item,
        contextOnly: !references.some(
          ({ node: source }) =>
            source.id === item.nodeId &&
            source.data.kind === item.kind &&
            (item.kind === "text" || source.data.src === item.src),
        ),
      })),
      ...pinnedSubmissionInputs(input.node, input.assets).map((item) => ({
        ...item,
        contextOnly:
          settings.mode === "audio" ||
          (settings.mode === "video" &&
            settings.videoMode === "first-last" &&
            item.kind === "image" &&
            references.some((ref) => ref.role === "firstFrame")),
      })),
    ],
  };
  return {
    status: "ready",
    request,
    origin: {
      documentId: input.document.id,
      nodeId: input.node.id,
      kind: input.node.type,
      src: input.node.data.src,
      referenceInputs: referenceSnapshot(
        references.map(
          (item) =>
            input.document.nodes.find((node) => node.id === item.node.id) ??
            item.node,
        ),
      ),
    },
    count: settings.mode === "audio" ? 1 : (settings.count ?? 1),
    label: settings.prompt || input.node.data.title,
  };
}

export type TextGenerationPlan =
  | { status: "blocked"; message: string | null }
  | { status: "ready"; request: GenerationRequest; origin: ResultSource; label: string };

/** The request the workspace submits for a text node. */
export function textGenerationPlan(input: {
  document: Pick<CanvasDocument, "id" | "title" | "nodes">;
  node: CanvasNode;
  incoming: readonly CanvasNode[];
  models: readonly ModelConfig[];
  assets: readonly SubmissionAsset[];
}): TextGenerationPlan {
  const settings = agentNodeSettings(input.node);
  const agents = input.models.filter((model) => model.kind === "agent");
  const config = agents.find(
    (model) => model.id === (settings.modelConfigId ?? agents[0]?.id),
  );
  const blocker = agentGenerationBlocker(input.node, input.incoming, config);
  if (blocker || !config) return { status: "blocked", message: blocker };
  return {
    status: "ready",
    label: input.node.data.title,
    request: {
      documentId: input.document.id,
      documentTitle: input.document.title,
      nodeId: input.node.id,
      promptContent: generationContent(input.node, input.incoming),
      config,
      kind: "text",
      prompt: input.node.data.prompt,
      title: input.node.data.title,
      videoMode: "first_frame",
      thinking: settings.thinking,
      maxTokens: settings.maxTokens,
      references: [
        ...assistantReferences(input.incoming),
        ...pinnedSubmissionInputs(input.node, input.assets),
      ],
    },
    origin: {
      documentId: input.document.id,
      nodeId: input.node.id,
      kind: "text",
      text: input.node.data.text,
      referenceInputs: referenceSnapshot([...input.incoming]),
    },
  };
}
