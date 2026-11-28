import {
  copyGenerationSettings,
  isGenerationSettings,
  nodeResources,
  parseNodeData,
} from "./dataBoundary.ts";
import { compactMedia, expandMedia } from "./mediaStorage.ts";
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasNode,
  CanvasNodeKind,
  Point,
} from "./model.ts";
import { MAX_ZOOM, MIN_ZOOM } from "./model.ts";
import { tNow } from "../i18n/messages.ts";
import { parseAssetSource } from "../backend/assetSource.ts";

export interface CanvasStorageError {
  code:
    | "invalid-document"
    | "invalid-json"
    | "unavailable"
    | "blocked"
    | "storage"
    | "transient-media";
  message: string;
}
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: CanvasStorageError };
const NODE_KINDS: CanvasNodeKind[] = [
  "image",
  "video",
  "audio",
  "file",
  "text",
  "group",
  "timeline",
  "subject",
  "stack",
  "tool",
  "external",
];
const failure = <T>(
  code: CanvasStorageError["code"],
  message: string,
): Result<T> => ({ ok: false, error: { code, message } });
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const point = (value: unknown): value is Point =>
  object(value) && finite(value.x) && finite(value.y);
const optionalString = (value: unknown) =>
  value === undefined || typeof value === "string";

/** Validates persisted JSON at the owning boundary, preserving source strings and explicit missing media. */
export function parseDocument(input: unknown): Result<CanvasDocument> {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      return failure(
        "invalid-json",
        tNow("errors.storage.json", { reason: errorMessage(error) }),
      );
    }
  }
  if (object(value) && value.version === 2) {
    try {
      value = expandMedia(value);
    } catch (error) {
      return failure("invalid-document", errorMessage(error));
    }
  }
  if (
    !object(value) ||
    value.version !== 1 ||
    !nonempty(value.id) ||
    typeof value.title !== "string"
  )
    return failure("invalid-document", tNow("errors.storage.document"));
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges))
    return failure("invalid-document", tNow("errors.storage.arrays"));
  if (
    !point(value.viewport) ||
    !object(value.viewport) ||
    !finite(value.viewport.zoom) ||
    value.viewport.zoom < MIN_ZOOM ||
    value.viewport.zoom > MAX_ZOOM
  )
    return failure(
      "invalid-document",
      tNow("errors.storage.viewport", { min: MIN_ZOOM, max: MAX_ZOOM }),
    );
  if (!isGenerationSettings(value.settings))
    return failure("invalid-document", tNow("errors.storage.settings"));

  const nodes: CanvasNode[] = [];
  if (value.hiddenNodes !== undefined && !Array.isArray(value.hiddenNodes))
    return failure("invalid-document", tNow("errors.storage.hidden"));
  const hiddenIds = new Set(
    (value.hiddenNodes as { id: string }[] | undefined)?.map(
      (node) => node?.id,
    ) ?? [],
  );
  const nodeIds = new Set<string>();
  for (const raw of [
    ...value.nodes,
    ...((value.hiddenNodes as unknown[]) ?? []),
  ]) {
    if (
      !object(raw) ||
      !nonempty(raw.id) ||
      !NODE_KINDS.includes(raw.type as CanvasNodeKind) ||
      !point(raw.position) ||
      !finite(raw.width) ||
      raw.width <= 0 ||
      !finite(raw.height) ||
      raw.height <= 0 ||
      (raw.locked !== undefined && typeof raw.locked !== "boolean") ||
      (raw.color !== undefined &&
        (typeof raw.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw.color))) ||
      (raw.zIndex !== undefined && !Number.isSafeInteger(raw.zIndex)) ||
      (raw.parentId !== undefined && !nonempty(raw.parentId))
    )
      return failure(
        "invalid-document",
        tNow("errors.storage.node"),
      );
    if (nodeIds.has(raw.id))
      return failure(
        "invalid-document",
        tNow("errors.storage.duplicateNode", { id: raw.id }),
      );
    const parsedData = parseNodeData(raw.type as CanvasNodeKind, raw.data);
    if (!parsedData.ok)
      return failure(
        "invalid-document",
        tNow("errors.storage.nodeDetail", {
          id: raw.id,
          reason: parsedData.error,
        }),
      );
    nodes.push({
      id: raw.id,
      type: raw.type as CanvasNodeKind,
      position: { ...raw.position },
      width: raw.width,
      height: raw.height,
      data: parsedData.value,
      ...(typeof raw.locked === "boolean" ? { locked: raw.locked } : {}),
      ...(typeof raw.color === "string" ? { color: raw.color } : {}),
      ...(raw.type === "group" && raw.autoLayout === "run" ? { autoLayout: raw.autoLayout } : {}),
      ...(typeof raw.zIndex === "number" ? { zIndex: raw.zIndex } : {}),
      ...(typeof raw.parentId === "string" ? { parentId: raw.parentId } : {}),
    });
    nodeIds.add(raw.id);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const stackedIds = new Set<string>();
  for (const node of nodes) {
    if (node.type === "stack" && node.data.stack) {
      if (node.parentId)
        return failure("invalid-document", tNow("errors.storage.stackRoot"));
      for (const id of node.data.stack.nodeIds) {
        const member = byId.get(id);
        if (
          !member ||
          member.parentId ||
          ![
            "image",
            "video",
            "audio",
            "text",
            "subject",
            "timeline",
            "external",
          ].includes(member.type) ||
          stackedIds.has(id)
        )
          return failure(
            "invalid-document",
            tNow("errors.storage.stackMembers"),
          );
        stackedIds.add(id);
      }
    }
    if (node.parentId && byId.get(node.parentId)?.type !== "group")
      return failure(
        "invalid-document",
        tNow("errors.storage.parentMissing", { id: node.id }),
      );
    const ancestors = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId) {
      if (ancestors.has(parentId))
        return failure(
          "invalid-document",
          tNow("errors.storage.parentCycle", { id: node.id }),
        );
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  for (const raw of value.edges) {
    if (
      !object(raw) ||
      !nonempty(raw.id) ||
      typeof raw.source !== "string" ||
      typeof raw.target !== "string" ||
      !nodeIds.has(raw.source) ||
      !nodeIds.has(raw.target) ||
      (raw.intent !== undefined &&
        raw.intent !== "generation_input" &&
        raw.intent !== "assembly_input" &&
        raw.intent !== "post_edit_result") ||
      (raw.intent === "assembly_input" && !nonempty(raw.assemblySlotId)) ||
      (raw.sourceHandle !== null && !optionalString(raw.sourceHandle)) ||
      (raw.targetHandle !== null && !optionalString(raw.targetHandle))
    )
      return failure("invalid-document", tNow("errors.storage.edge"));
    if (edgeIds.has(raw.id))
      return failure(
        "invalid-document",
        tNow("errors.storage.duplicateEdge", { id: raw.id }),
      );
    edges.push({
      id: raw.id,
      source: raw.source,
      target: raw.target,
      ...(raw.intent === "assembly_input"
        ? { assemblySlotId: raw.assemblySlotId as string }
        : {}),
      ...(raw.intent !== undefined
        ? { intent: raw.intent as CanvasEdge["intent"] }
        : {}),
      ...(raw.referenceBinding === "pinned" ||
      raw.referenceBinding === "follow_current"
        ? { referenceBinding: raw.referenceBinding }
        : {}),
      ...(raw.sourceHandle !== undefined
        ? { sourceHandle: raw.sourceHandle as string | null }
        : {}),
      ...(raw.targetHandle !== undefined
        ? { targetHandle: raw.targetHandle as string | null }
        : {}),
    });
    edgeIds.add(raw.id);
  }
  const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
  for (const node of nodes) {
    const guide = node.data.h3Segment;
    if (guide?.guideReferenceId) {
      const edge = edgesById.get(guide.guideReferenceId);
      if (!edge || (edge.intent && edge.intent !== "generation_input") ||
          edge.referenceBinding === "pinned" || edge.source !== guide.guideSourceNodeId ||
          byId.get(edge.source)?.type !== "video" || edge.target !== node.id)
        return failure("invalid-document", tNow("errors.storage.guideReference"));
    }
    const assembly = node.data.workflowAssembly;
    if (assembly) {
      const timeline = byId.get(assembly.timelineItemId);
      const output = byId.get(assembly.outputItemId);
      const member = (itemId: string) => {
        const item = byId.get(itemId);
        if (item?.type !== "video") return false;
        let parent = item.parentId;
        while (parent && parent !== node.id) parent = byId.get(parent)?.parentId;
        return parent === node.id;
      };
      if (timeline?.type !== "timeline" || !timeline.data.timeline ||
          (output && output.type !== "video") || assembly.clips.some((clip) => !member(clip.itemId)))
        return failure("invalid-document", tNow("canvas.workspace.group.workflowAssemblyConfigInvalid"));
    }
    for (const key of ["firstFrameNodeId", "lastFrameNodeId"] as const) {
      const id = node.data.settings?.[key];
      if (
        id !== undefined &&
        (!nodeIds.has(id) ||
          !edges.some(
            (edge) =>
              edge.intent !== "post_edit_result" &&
              edge.source === id &&
              edge.target === node.id,
          ))
      )
        return failure("invalid-document", tNow("errors.storage.frameReference"));
    }
    if (
      node.data.taskDraft &&
      (node.data.taskDraft.sourceNodeIds.some((id) => !nodeIds.has(id)) ||
        (node.data.taskDraft.selection &&
          !nodeIds.has(node.data.taskDraft.selection.sourceNodeId)))
    )
      return failure("invalid-document", tNow("errors.storage.toolDraft"));
  }
  for (const key of ["firstFrameNodeId", "lastFrameNodeId"] as const)
    if (value.settings[key] !== undefined && !nodeIds.has(value.settings[key]!))
      return failure("invalid-document", tNow("errors.storage.projectFrames"));
  return {
    ok: true,
    value: {
      version: 1,
      id: value.id,
      title: value.title,
      nodes: nodes.filter((node) => !hiddenIds.has(node.id)),
      ...(hiddenIds.size
        ? { hiddenNodes: nodes.filter((node) => hiddenIds.has(node.id)) }
        : {}),
      edges,
      viewport: {
        x: value.viewport.x,
        y: value.viewport.y,
        zoom: value.viewport.zoom,
      },
      settings: copyGenerationSettings(value.settings),
    },
  };
}

const transientMedia = (src: string | undefined) =>
  Boolean(src?.startsWith("blob:") || parseAssetSource(src));

function persistentDocument(document: CanvasDocument): Result<CanvasDocument> {
  const parsed = parseDocument(document);
  if (!parsed.ok) return parsed;
  const transient = [
    ...parsed.value.nodes,
    ...(parsed.value.hiddenNodes ?? []),
  ].find(
    (node) =>
      transientMedia(node.data.src) ||
      transientMedia(node.data.imageCrop?.src) ||
      nodeResources(node.data).some((resource) =>
        transientMedia(resource.src),
      ) ||
      node.data.layers?.layers.some(
        (layer) =>
          layer.content.kind === "image" && transientMedia(layer.content.src),
      ),
  );
  return transient
    ? failure(
        "transient-media",
        tNow("errors.storage.transientBlob", {
          title: transient.data.title,
        }),
      )
    : parsed;
}

export function serializeDocument(document: CanvasDocument): Result<string> {
  const parsed = persistentDocument(document);
  if (!parsed.ok) return parsed;
  try {
    return {
      ok: true,
      value: JSON.stringify(compactMedia(parsed.value), null, 2),
    };
  } catch (error) {
    return failure(
      "storage",
      tNow("errors.storage.serialize", { reason: errorMessage(error) }),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error || error instanceof DOMException
    ? error.message
    : String(error ?? tNow("errors.storage.unknown"));
}
