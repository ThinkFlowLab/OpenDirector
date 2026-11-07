import { indexNodes, ancestors, isNodeLocked } from "./hierarchy.ts";
import { mapCanvasToolTaskReferences } from "./toolCatalog.ts";
import type { CanvasToolTask } from "./toolCatalog.ts";
import type { LocalStageDocument } from "./stageDocument.ts";
import type { LayerDocument } from "./layerDocument.ts";
import { referenceIssue } from "./connectionPolicy.ts";
import { SUBJECT_BASE_HEIGHT } from "./subjectLayout.ts";
import { tNow } from "../i18n/messages.ts";
import type { MessageKey } from "../i18n/types.ts";
import {
  assembleNode,
  assemblyResource,
  isAssemblyTarget,
  removeAssembly,
} from "./editorAssembly.ts";
import {
  generationContent,
  generationContentPatch,
} from "./generationReferenceContent.ts";
import {
  fillConnectedFrames,
  frameImageLimitIssue,
  type FrameCapabilities,
} from "./frameReferences.ts";
/** Authored local canvas model, compatible with React Flow's node/edge shape. */
export type CanvasNodeKind =
  | "image"
  | "video"
  | "audio"
  | "file"
  | "text"
  | "group"
  | "timeline"
  | "subject"
  | "stack"
  | "tool"
  | "external";
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
export interface Viewport extends Point {
  zoom: number;
}

export interface GenerationSettings {
  mode: "image" | "video" | "audio";
  model: string;
  aspectRatio: string;
  durationSeconds: number;
  resolution: string;
  prompt: string;
  count?: number;
  audioEnabled?: boolean;
  videoMode?: "reference" | "first-last" | "continuation";
  firstFrameNodeId?: string;
  lastFrameNodeId?: string;
  frameSlotsInitialized?: boolean;
  audioCreationType?: "audio" | "music";
  audioMode?: "unified" | "tts";
  voiceName?: string;
  /** Music models: words to sing; empty asks for an instrumental piece. */
  lyrics?: string;
  /** Music with a reference recording: follow its melody, or its melody and chords. */
  scoreMode?: "melody" | "full";
  /** Music with a reference recording: cap the length at the recording's own (unset follows it). */
  durationFromReference?: boolean;
  imagePreset?: "none" | "product-views";
  /** A model configured in the local API; catalog models leave it unset. */
  modelConfigId?: string;
}

/** A retained media snapshot. nodeId records provenance, not ownership of the source. */
export interface CanvasResource {
  assetId?: string;
  id: string;
  kind: "image" | "video" | "audio" | "text" | "file";
  title: string;
  src?: string;
  mimeType?: string;
  text?: string;
  byteSize?: number;
  nodeId?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export interface TimelineClip {
  id: string;
  resource: CanvasResource;
  /** Audio placement only. Visual placement is derived from the track's clip order. */
  start?: number;
  /** Source trim uses seconds in this local model; original runtime tick units are not assumed. */
  inPoint: number;
  outPoint: number;
  speed: number;
  volume: number;
  muted: boolean;
}

export interface TimelineTrack {
  id: string;
  kind: "visual" | "audio";
  title: string;
  muted: boolean;
  clips: TimelineClip[];
}

export interface TimelineData {
  tracks: TimelineTrack[];
  /** Retained independently of clip use; omitted only by older documents. */
  importedAssets?: CanvasResource[];
  fps: number;
  width: number;
  height: number;
}

export interface SubjectData {
  /** User-facing annotation; excluded from subject content and all model references. */
  description: string;
  category: string;
  main?: CanvasResource;
  auxiliaries: CanvasResource[];
  voice?: CanvasResource;
  librarySource?: { itemId: string; revision: number; importId: string };
}

export interface StackData {
  nodeIds: string[];
  /** Local presentation state; the observed source schema only owns nodeIds. */
  activeIndex: number;
}

export interface ToolData {
  kind: "camera" | "style" | "palette" | "camera_motion";
  fields: { name: string; values: string[] }[];
  provenance?: { paletteId: string; version: number };
  palette?: { name?: string; sourceImageUri?: string };
}

export interface ExternalData {
  externalType: "director-stage";
  /** Decimal uint64 identity from the external director stage; absent for a local draft. */
  current?: { versionId: string };
}

export interface AgentNodeSettings {
  modelConfigId?: string;
  thinking: "auto" | "low" | "medium" | "high";
  maxTokens: number;
}

export interface CanvasNodeData extends Record<string, unknown> {
  backendAssetId?: string;
  /** Temporary clipboard origin, consumed by the unified save adapter. */
  copiedSourceId?: string;
  kind: CanvasNodeKind;
  title: string;
  prompt: string;
  byteSize?: number;
  promptMentions?: import("./promptMentions.ts").PromptMention[];
  promptContent?: import("./chatReferenceContent.ts").ReferenceContent;
  src?: string;
  mimeType?: string;
  text?: string;
  assetState?: "ready" | "missing";
  /** Imported/derived assets have editing controls, not an automatic generator.
   * Omitted in older documents; keep their existing generator behavior. */
  mediaRole?: "asset" | "generation";
  /** Where this node's media came from, carried so archives round-trip a
   * generation node with real provenance instead of a fabricated one. */
  generationProvenance?: {
    source:
      | "generated"
      | "edited"
      | "rendered"
      | "upload"
      | "manual"
      | "agent_written"
      | "imported";
    jobId?: string;
    inputFingerprint?: string;
    editorDocumentId?: string;
    editorRevision?: number;
  };
  settings?: GenerationSettings;
  agentSettings?: AgentNodeSettings;
  generationEvidence?: {
    output: string;
    references: Record<string, string>;
    placeholder?: boolean;
  };
  timeline?: TimelineData;
  subject?: SubjectData;
  stack?: StackData;
  tool?: ToolData;
  external?: ExternalData;
  layers?: LayerDocument;
  imageCrop?: import("./imageCrop.ts").ImageCropState;
  localStage?: LocalStageDocument;
  taskDraft?: CanvasToolTask;
  media?: { width?: number; height?: number; durationSeconds?: number };
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeKind;
  position: Point;
  data: CanvasNodeData;
  width: number;
  height: number;
  locked?: boolean;
  zIndex?: number;
  /** Child positions are relative to their parent's top-left corner. */
  parentId?: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  /** Missing on legacy documents means generation_input; result provenance is not a reference. */
  intent?: "generation_input" | "post_edit_result" | "assembly_input";
  /** Retained subject slot or timeline clip, independent of generation references. */
  assemblySlotId?: string;
  /** Pinned edge is provenance for a fixed input, never a live source insertion. */
  referenceBinding?: "follow_current" | "pinned";
  /** Read-only business query projection, never an editable relationship. */
  referenceState?: "used" | "pending" | "unknown" | "unavailable";
}

export interface CanvasDocument {
  version: 1;
  id: string;
  title: string;
  nodes: CanvasNode[];
  /** Logical sources remain usable when their presentation is hidden. */
  hiddenNodes?: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  /** False when the server has no saved view for this client yet. */
  viewPersisted?: boolean;
  settings: GenerationSettings;
}

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 8;
export const LOCAL_DEMO_MODEL = "本地交互演示";
export const DEFAULT_SETTINGS: Readonly<GenerationSettings> = {
  mode: "image",
  model: LOCAL_DEMO_MODEL,
  aspectRatio: "1:1",
  durationSeconds: 5,
  resolution: "1024",
  prompt: "",
};

export function createDocument(title = tNow("errors.model.untitled")): CanvasDocument {
  return {
    version: 1,
    id: crypto.randomUUID(),
    title,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Image and video blocks start as a 16:9 preview. */
export const PREVIEW_SIZE = { width: 352, height: 198 } as const;
/** Waveform and native playback controls fit without the old square card. */
export const AUDIO_CARD_SIZE = { width: 300, height: 112 } as const;
const MEDIA_KINDS: readonly CanvasNodeKind[] = ["image", "video"];

/** Once a file's pixel size is known the block takes its aspect ratio and keeps its long edge. */
export function mediaNodeSize(
  box: { width: number; height: number },
  media: CanvasNodeData["media"],
) {
  if (!media?.width || !media.height) return { ...box };
  const long = Math.max(box.width, box.height);
  const ratio = media.width / media.height;
  return {
    // Keep media cards readable; extreme panoramas letterbox inside these minimum dimensions.
    width: Math.max(160, Math.round(ratio >= 1 ? long : long * ratio)),
    height: Math.max(120, Math.round(ratio >= 1 ? long / ratio : long)),
  };
}

/** Allocate a default title without renaming existing or hidden sources. */
export function nextNodeTitle(
  document: Pick<CanvasDocument, "nodes" | "hiddenNodes">,
  kind: CanvasNodeKind,
  label: string,
): string {
  const nodes = [...document.nodes, ...(document.hiddenNodes ?? [])];
  const titles = new Set(nodes.map((node) => node.data.title));
  const prefix = `${label} `;
  let next = 1n;
  for (const node of nodes) {
    if (node.type !== kind || !node.data.title.startsWith(prefix)) continue;
    const suffix = node.data.title.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(suffix)) continue;
    const number = BigInt(suffix);
    if (number >= next) next = number + 1n;
  }
  while (titles.has(`${prefix}${next}`)) next++;
  return `${prefix}${next}`;
}

/** A copy or a derived result keeps its own name, but never the source's exact one.
 * `taken` is updated in place so a batch of copies numbers itself as it goes.
 */
export function derivedNodeTitle(title: string, taken: Set<string>): string {
  if (!taken.has(title)) {
    taken.add(title);
    return title;
  }
  const numbered = /^(.*\S)\s([1-9]\d*)$/.exec(title);
  const stem = numbered ? numbered[1]! : title;
  let next = numbered ? BigInt(numbered[2]!) + 1n : 2n;
  while (taken.has(`${stem} ${next}`)) next += 1n;
  const derived = `${stem} ${next}`;
  taken.add(derived);
  return derived;
}

/** Titles already in use by visible and hidden items alike. */
export function takenNodeTitles(
  document: Pick<CanvasDocument, "nodes" | "hiddenNodes">,
): Set<string> {
  return new Set(
    [...document.nodes, ...(document.hiddenNodes ?? [])].map(
      (node) => node.data.title,
    ),
  );
}

export function createNode(
  kind: CanvasNodeKind,
  position: Point = { x: 0, y: 0 },
  data: Partial<Omit<CanvasNodeData, "kind">> = {},
): CanvasNode {
  const sizes: Record<CanvasNodeKind, [number, number]> = {
    image: [300, 300],
    video: [540, 300],
    audio: [AUDIO_CARD_SIZE.width, AUDIO_CARD_SIZE.height],
    file: [260, 110],
    text: [300, 300],
    group: [640, 480],
    timeline: [600, 280],
    subject: [320, SUBJECT_BASE_HEIGHT],
    stack: [320, 270],
    tool: [300, 180],
    external: [340, 180],
  };
  const titles: Record<CanvasNodeKind, MessageKey> = {
    image: "canvasNodes.kind.image",
    video: "canvasNodes.kind.video",
    audio: "canvasNodes.kind.audio",
    file: "canvasNodes.kind.file",
    text: "canvasNodes.kind.text",
    group: "canvasNodes.kind.group",
    timeline: "canvasNodes.kind.timeline",
    subject: "canvasNodes.kind.subject",
    stack: "canvasNodes.kind.stack",
    tool: "canvasNodes.kind.tool",
    external: "canvasNodes.kind.external",
  };
  const { width, height } = MEDIA_KINDS.includes(kind)
    ? mediaNodeSize(
        { width: sizes[kind][0], height: sizes[kind][1] },
        data.media as CanvasNodeData["media"],
      )
    : { width: sizes[kind][0], height: sizes[kind][1] };
  return {
    id: crypto.randomUUID(),
    type: kind,
    position: { ...position },
    width,
    height,
    data: {
      title: tNow(titles[kind]),
      prompt: "",
      ...(["image", "video", "audio"].includes(kind) && !data.src
        ? { mediaRole: "generation" as const }
        : {}),
      ...(kind === "timeline"
        ? {
            timeline: {
              tracks: [
                {
                  id: "visual",
                  kind: "visual",
                  title: tNow("timeline.track.video"),
                  muted: false,
                  clips: [],
                },
              ],
              fps: 30,
              width: 1920,
              height: 1080,
            },
          }
        : {}),
      ...(kind === "subject"
        ? {
            subject: {
              description: "",
              category: "character",
              auxiliaries: [],
            },
          }
        : {}),
      ...(kind === "stack" ? { stack: { nodeIds: [], activeIndex: 0 } } : {}),
      ...(kind === "tool" ? { tool: { kind: "camera", fields: [] } } : {}),
      ...(kind === "external"
        ? { external: { externalType: "director-stage" } }
        : {}),
      ...data,
      kind,
    },
    locked: false,
  };
}

export type NodePatch = Partial<Omit<CanvasNode, "id" | "data">> & {
  data?: Partial<CanvasNodeData>;
};
export type CanvasCommand =
  | {
      type: "add-nodes";
      nodes: CanvasNode[];
      /** Assign default titles against the latest state when applying. */
      titlePrefix?: string;
    }
  | { type: "update-node"; id: string; patch: NodePatch }
  | {
      type: "resize-node";
      id: string;
      width: number;
      height: number;
      position?: Point;
    }
  | { type: "remove-nodes"; ids: string[] }
  | { type: "hide-nodes"; ids: string[] }
  | { type: "reference-sources"; nodes: CanvasNode[] }
  | { type: "move-nodes"; ids: string[]; delta: Point }
  | {
      type: "reorder-nodes";
      ids: string[];
      direction: "front" | "back" | "forward" | "backward";
    }
  | { type: "add-edge"; edge: CanvasEdge }
  | { type: "remove-edges"; ids: string[] }
  | { type: "settings"; patch: Partial<GenerationSettings> }
  | { type: "title"; title: string }
  | { type: "viewport"; viewport: Viewport }
  | { type: "batch"; commands: CanvasCommand[] };

/** Shared by the port preview and every reference-creation command. */
export function canAddReference(
  document: Pick<CanvasDocument, "nodes" | "edges">,
  source: string | null | undefined,
  target: string | null | undefined,
  intent: CanvasEdge["intent"] = "generation_input",
): boolean {
  return referenceIssue(document, source, target, intent) === null;
}

/** Applies a document command; UI-only selection and dragging flags stay outside this model. */
export function applyCommand(
  document: CanvasDocument,
  command: CanvasCommand,
  frames?: FrameCapabilities,
): CanvasDocument {
  let next = applyCanvasCommand(document, command, frames);
  if (
    next !== document &&
    (command.type === "remove-edges" ||
      (command.type === "update-node" &&
        command.patch.data &&
        ("subject" in command.patch.data || "timeline" in command.patch.data)))
  ) {
    const logical = [...next.nodes, ...(next.hiddenNodes ?? [])];
    const previous = [...document.nodes, ...(document.hiddenNodes ?? [])];
    const edges = next.edges.filter((edge) => {
      if (edge.intent !== "assembly_input") return true;
      const current = assemblyResource(
        logical.find((node) => node.id === edge.target),
        edge.assemblySlotId,
      );
      const before = assemblyResource(
        previous.find((node) => node.id === edge.target),
        edge.assemblySlotId,
      );
      return Boolean(
        current &&
        before &&
        current.id === before.id &&
        current.kind === before.kind &&
        current.src === before.src &&
        current.assetId === before.assetId,
      );
    });
    if (edges.length !== next.edges.length) next = { ...next, edges };
  }
  if (
    next === document ||
    !(
      command.type === "add-edge" ||
      (command.type === "update-node" &&
        command.patch.data &&
        ["title", "src", "text", "subject", "assetState"].some((key) =>
          Object.hasOwn(command.patch.data!, key),
        ))
    )
  )
    return next;
  const logical = [...next.nodes, ...(next.hiddenNodes ?? [])];
  const sync = (node: CanvasNode) => {
    if (isAssemblyTarget(node)) return node;
    if (
      node.data.promptContent === undefined &&
      !(
        command.type === "add-edge" &&
        command.edge.target === node.id &&
        command.edge.intent !== "post_edit_result"
      )
    )
      return node;
    const incoming = logical.filter((source) =>
      next.edges.some(
        (edge) =>
          edge.intent !== "post_edit_result" &&
          edge.referenceBinding !== "pinned" &&
          edge.target === node.id &&
          edge.source === source.id,
      ),
    );
    if (!incoming.length && node.data.promptContent === undefined) return node;
    const patch = generationContentPatch(
      generationContent(
        node,
        incoming,
        (source) =>
          next.edges.find(
            (edge) =>
              edge.intent !== "post_edit_result" &&
              edge.target === node.id &&
              edge.source === source,
          )?.id,
      ),
    );
    if (
      JSON.stringify(patch.promptContent) ===
      JSON.stringify(node.data.promptContent)
    )
      return node;
    return {
      ...node,
      data: {
        ...node.data,
        ...patch,
        ...(node.data.settings
          ? { settings: { ...node.data.settings, prompt: patch.prompt } }
          : {}),
      },
    };
  };
  return {
    ...next,
    nodes: next.nodes.map(sync),
    ...(next.hiddenNodes ? { hiddenNodes: next.hiddenNodes.map(sync) } : {}),
  };
}

function applyCanvasCommand(
  document: CanvasDocument,
  command: CanvasCommand,
  frames?: FrameCapabilities,
): CanvasDocument {
  if (command.type === "batch")
    return command.commands.reduce(
      (current, item) => applyCommand(current, item, frames),
      document,
    );
  if (command.type === "reference-sources") {
    const ids = new Set(
      [...document.nodes, ...(document.hiddenNodes ?? [])].map(
        (node) => node.id,
      ),
    );
    return {
      ...document,
      hiddenNodes: [
        ...(document.hiddenNodes ?? []),
        ...command.nodes.filter((node) => !ids.has(node.id)),
      ],
    };
  }
  if (command.type === "hide-nodes") {
    const removed = applyCommand(document, {
      type: "remove-nodes",
      ids: command.ids,
    });
    const visible = new Set(removed.nodes.map((node) => node.id));
    if (visible.size === document.nodes.length) return document;
    return {
      ...document,
      nodes: document.nodes.filter((node) => visible.has(node.id)),
      hiddenNodes: [
        ...(document.hiddenNodes ?? []),
        ...document.nodes.filter((node) => !visible.has(node.id)),
      ],
    };
  }
  if (command.type === "title")
    return document.title === command.title
      ? document
      : { ...document, title: command.title };
  if (command.type === "settings")
    return {
      ...document,
      settings: { ...document.settings, ...command.patch },
    };
  if (command.type === "viewport")
    return { ...document, viewport: { ...command.viewport } };
  if (command.type === "add-nodes") {
    const titlePrefix = command.titlePrefix;
    if (titlePrefix !== undefined) {
      return command.nodes.reduce(
        (current, node) =>
          applyCanvasCommand(current, {
            type: "add-nodes",
            nodes: [
              {
                ...node,
                data: {
                  ...node.data,
                  title: nextNodeTitle(current, node.type, titlePrefix),
                },
              },
            ],
          }),
        document,
      );
    }
    const ids = new Set(document.nodes.map((node) => node.id));
    for (const node of command.nodes) {
      if (ids.has(node.id))
        throw new Error(tNow("errors.model.duplicateNode", { id: node.id }));
      ids.add(node.id);
    }
    return command.nodes.length
      ? {
          ...document,
          nodes: [...document.nodes, ...command.nodes],
          ...(document.hiddenNodes
            ? {
                hiddenNodes: document.hiddenNodes.filter(
                  (node) =>
                    !ids.has(node.id) ||
                    !command.nodes.some((added) => added.id === node.id),
                ),
              }
            : {}),
        }
      : document;
  }
  const byId = indexNodes(document.nodes);
  const locked = (node: CanvasNode) => isNodeLocked(node, byId);
  if (command.type === "resize-node") {
    const source = document.nodes.find((node) => node.id === command.id);
    if (!source || locked(source)) return document;
    const position = command.position ?? source.position;
    if (
      ![position.x, position.y, command.width, command.height].every(
        Number.isFinite,
      ) ||
      command.width <= 0 ||
      command.height <= 0
    )
      throw new Error(tNow("errors.model.nodeSize"));
    const dx = source.position.x - position.x,
      dy = source.position.y - position.y;
    if (
      !dx &&
      !dy &&
      source.width === command.width &&
      source.height === command.height
    )
      return document;
    return {
      ...document,
      nodes: document.nodes.map((node) => {
        if (node.id === source.id)
          return {
            ...node,
            position: { ...position },
            width: command.width,
            height: command.height,
          };
        // Resizing the frame changes its local origin, not its children's world positions.
        // This coordinate compensation also applies to locked children.
        if (node.parentId === source.id && (dx || dy))
          return {
            ...node,
            position: { x: node.position.x + dx, y: node.position.y + dy },
          };
        return node;
      }),
    };
  }
  if (command.type === "update-node") {
    let changed = false;
    const nodes = document.nodes.map((node) => {
      if (node.id !== command.id) return node;
      // A child cannot override a parent lock. Only the explicit lock owner can unlock itself.
      if (ancestors(node, byId).some((parent) => parent.locked)) return node;
      if (node.locked && command.patch.locked !== false) return node;
      const type = command.patch.type ?? node.type;
      let base = node.data;
      if (type !== node.type) {
        // Only title/prompt survive a kind change; type-specific editors own their payloads.
        base = {
          kind: type,
          title: node.data.title,
          prompt: node.data.prompt,
        };
      } else if (
        command.patch.data &&
        "src" in command.patch.data &&
        command.patch.data.src !== node.data.src
      ) {
        // Layers, masks and dimensions belong to the previous pixels. A producer may
        // supply a new layer document or metadata in this same atomic patch.
        base = { ...node.data };
        for (const key of [
          "backendAssetId",
          "byteSize",
          "layers",
          "imageCrop",
          "taskDraft",
          "media",
          "mimeType",
          "assetState",
        ] as const)
          delete base[key];
      }
      if (
        command.patch.data &&
        "text" in command.patch.data &&
        command.patch.data.text !== node.data.text
      ) {
        base = { ...base, backendAssetId: undefined, byteSize: undefined };
      }
      let data = command.patch.data ? { ...base, ...command.patch.data } : base;
      if (
        command.patch.data &&
        Object.hasOwn(command.patch.data, "prompt") &&
        command.patch.data.prompt !== node.data.prompt &&
        !Object.hasOwn(command.patch.data, "promptContent")
      ) {
        data = { ...data, promptContent: undefined, promptMentions: [] };
      }
      if (data.settings) {
        let settings = data.settings;
        if (
          command.patch.data?.settings &&
          (Object.hasOwn(command.patch.data.settings, "firstFrameNodeId") ||
            Object.hasOwn(command.patch.data.settings, "lastFrameNodeId"))
        )
          settings = { ...settings, frameSlotsInitialized: true };
        const sources = new Set(
          document.edges
            .filter(
              (edge) =>
                edge.target === node.id && edge.intent !== "post_edit_result",
            )
            .map((edge) => edge.source),
        );
        const incoming = [...sources].flatMap(
          (id) => document.nodes.find((item) => item.id === id) ?? [],
        );
        if (frameImageLimitIssue(settings, incoming)) return node;
        if (
          settings.videoMode === "first-last" &&
          node.data.settings?.videoMode !== "first-last"
        )
          settings = fillConnectedFrames(settings, incoming, frames);
        if (settings !== data.settings) data = { ...data, settings };
      }
      changed = true;
      // New pixels (upload, generation, edit, or decoded metadata) reshape the block.
      const reshaped =
        MEDIA_KINDS.includes(type) &&
        command.patch.width === undefined &&
        command.patch.height === undefined &&
        data.media?.width &&
        data.media.height &&
        (data.media.width !== node.data.media?.width ||
          data.media.height !== node.data.media?.height)
          ? mediaNodeSize(node, data.media)
          : {};
      return {
        ...node,
        ...command.patch,
        ...reshaped,
        type,
        data: { ...data, kind: type },
      };
    });
    return changed ? { ...document, nodes } : document;
  }
  if (command.type === "move-nodes") {
    if (!Number.isFinite(command.delta.x) || !Number.isFinite(command.delta.y))
      throw new Error(tNow("errors.model.move"));
    if (!command.delta.x && !command.delta.y) return document;
    const selected = new Set(command.ids);
    let changed = false;
    const nodes = document.nodes.map((node) => {
      if (
        !selected.has(node.id) ||
        locked(node) ||
        ancestors(node, byId).some((parent) => selected.has(parent.id))
      )
        return node;
      changed = true;
      return {
        ...node,
        position: {
          x: node.position.x + command.delta.x,
          y: node.position.y + command.delta.y,
        },
      };
    });
    return changed ? { ...document, nodes } : document;
  }
  if (command.type === "remove-nodes") {
    const requested = new Set(command.ids);
    const removed = new Set(
      document.nodes
        .filter((node) => requested.has(node.id) && !locked(node))
        .map((node) => node.id),
    );
    // Locked content retains live references and their ancestors; no indirect mutation via deletion.
    const protectedIds = new Set<string>();
    for (const node of document.nodes.filter(locked)) {
      protectedIds.add(node.id);
      for (const id of node.data.stack?.nodeIds ?? []) protectedIds.add(id);
      for (const key of ["firstFrameNodeId", "lastFrameNodeId"] as const) {
        const id = node.data.settings?.[key];
        if (id) protectedIds.add(id);
      }
      for (const id of node.data.taskDraft?.sourceNodeIds ?? [])
        protectedIds.add(id);
      if (node.data.taskDraft?.selection)
        protectedIds.add(node.data.taskDraft.selection.sourceNodeId);
    }
    for (const id of protectedIds) {
      removed.delete(id);
      let parent = document.nodes.find((node) => node.id === id)?.parentId;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        removed.delete(parent);
        parent = document.nodes.find((node) => node.id === parent)?.parentId;
      }
    }
    let added = true;
    while (added) {
      added = false;
      for (const node of document.nodes)
        if (
          node.parentId &&
          removed.has(node.parentId) &&
          !removed.has(node.id)
        ) {
          removed.add(node.id);
          added = true;
        }
    }
    if (!removed.size) return document;
    return {
      ...document,
      nodes: document.nodes
        .filter((node) => !removed.has(node.id))
        .map((node) => {
          const settings =
            node.data.settings &&
            mapSettingsNodeReferences(node.data.settings, (id) =>
              removed.has(id) ? undefined : id,
            );
          const taskDraft =
            node.data.taskDraft &&
            (node.data.taskDraft.sourceNodeIds.some((id) => removed.has(id)) ||
              (node.data.taskDraft.selection &&
                removed.has(node.data.taskDraft.selection.sourceNodeId)))
              ? mapCanvasToolTaskReferences(node.data.taskDraft, (id) =>
                  removed.has(id) ? undefined : id,
                )
              : node.data.taskDraft;
          const stack = node.data.stack;
          const nodeIds = stack?.nodeIds.filter((id) => !removed.has(id));
          if (
            taskDraft === node.data.taskDraft &&
            settings === node.data.settings &&
            (!stack || nodeIds!.length === stack.nodeIds.length)
          )
            return node;
          return {
            ...node,
            data: {
              ...node.data,
              ...(settings ? { settings } : {}),
              ...(taskDraft ? { taskDraft } : {}),
              ...(stack && nodeIds
                ? {
                    stack: {
                      nodeIds,
                      activeIndex: Math.min(
                        stack.activeIndex,
                        Math.max(0, nodeIds.length - 1),
                      ),
                    },
                  }
                : {}),
            },
          };
        }),
      settings: mapSettingsNodeReferences(document.settings, (id) =>
        removed.has(id) ? undefined : id,
      ),
      edges: document.edges.filter(
        (edge) => !removed.has(edge.source) && !removed.has(edge.target),
      ),
    };
  }
  if (command.type === "reorder-nodes") {
    const selected = new Set(command.ids);
    const nodes = [...document.nodes].sort(
      (a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0),
    );
    const movable = (node: CanvasNode) =>
      selected.has(node.id) && !locked(node);
    if (!nodes.some(movable)) return document;
    let ordered = [...nodes];
    if (command.direction === "front")
      ordered = [
        ...nodes.filter((node) => !movable(node)),
        ...nodes.filter(movable),
      ];
    if (command.direction === "back")
      ordered = [
        ...nodes.filter(movable),
        ...nodes.filter((node) => !movable(node)),
      ];
    if (command.direction === "forward") {
      for (let i = ordered.length - 2; i >= 0; i--)
        if (movable(ordered[i]!) && !movable(ordered[i + 1]!))
          [ordered[i], ordered[i + 1]] = [ordered[i + 1]!, ordered[i]!];
    }
    if (command.direction === "backward") {
      for (let i = 1; i < ordered.length; i++)
        if (movable(ordered[i]!) && !movable(ordered[i - 1]!))
          [ordered[i], ordered[i - 1]] = [ordered[i - 1]!, ordered[i]!];
    }
    if (ordered.every((node, index) => node === nodes[index])) return document;
    return {
      ...document,
      nodes: ordered.map((node, zIndex) => ({ ...node, zIndex })),
    };
  }
  if (command.type === "add-edge") {
    if (document.edges.some((edge) => edge.id === command.edge.id))
      throw new Error(tNow("errors.model.duplicateEdge", { id: command.edge.id }));
    const logicalNodes = [...document.nodes, ...(document.hiddenNodes ?? [])];
    const ids = new Set(logicalNodes.map((node) => node.id));
    if (!ids.has(command.edge.source) || !ids.has(command.edge.target))
      throw new Error(tNow("errors.model.edgeEnds"));
    if (
      !canAddReference(
        document,
        command.edge.source,
        command.edge.target,
        command.edge.intent,
      )
    )
      return document;
    const target = logicalNodes.find(
      (node) => node.id === command.edge.target,
    )!;
    const source = logicalNodes.find(
      (node) => node.id === command.edge.source,
    )!;
    if (
      command.edge.intent !== "post_edit_result" &&
      isAssemblyTarget(target)
    ) {
      const assembled = assembleNode(source, target);
      const edge: CanvasEdge = {
        ...command.edge,
        intent: "assembly_input",
        assemblySlotId: assembled.slotId,
      };
      const replace = (nodes: CanvasNode[]) =>
        nodes.map((node) => (node.id === target.id ? assembled.node : node));
      return {
        ...document,
        edges: [...document.edges, edge],
        nodes: replace(document.nodes),
        ...(document.hiddenNodes
          ? { hiddenNodes: replace(document.hiddenNodes) }
          : {}),
      };
    }
    const edges = [...document.edges, { ...command.edge }];
    if (
      command.edge.intent === "post_edit_result" ||
      source.type !== "image" ||
      !target.data.settings
    )
      return { ...document, edges };
    const incomingIds = [
      ...new Set(
        edges
          .filter(
            (edge) =>
              edge.target === target.id && edge.intent !== "post_edit_result",
          )
          .map((edge) => edge.source),
      ),
    ];
    const incoming = incomingIds.flatMap(
      (id) => logicalNodes.find((node) => node.id === id) ?? [],
    );
    const settings = fillConnectedFrames(
      target.data.settings,
      incoming,
      frames,
    );
    return {
      ...document,
      edges,
      nodes:
        settings === target.data.settings
          ? document.nodes
          : document.nodes.map((node) =>
              node.id === target.id
                ? { ...node, data: { ...node.data, settings } }
                : node,
            ),
    };
  }
  const removed = new Set(command.ids);
  for (const edge of document.edges) {
    const target = document.nodes.find((node) => node.id === edge.target);
    const source = document.nodes.find((node) => node.id === edge.source);
    if (
      edge.intent === "assembly_input" &&
      ((target && locked(target)) || (source && locked(source)))
    )
      removed.delete(edge.id);
    if (
      target &&
      locked(target) &&
      edge.intent !== "post_edit_result" &&
      (target.data.settings?.firstFrameNodeId === edge.source ||
        target.data.settings?.lastFrameNodeId === edge.source)
    )
      removed.delete(edge.id);
  }
  const edges = document.edges.filter((edge) => !removed.has(edge.id));
  if (edges.length === document.edges.length) return document;
  const disconnected = document.edges.filter(
    (edge) => removed.has(edge.id) && edge.intent !== "post_edit_result",
  );
  return {
    ...document,
    edges,
    nodes: document.nodes.map((node) => {
      const unlinked = disconnected.filter((edge) => edge.target === node.id);
      if (isAssemblyTarget(node))
        return removeAssembly(
          node,
          unlinked.filter((edge) => edge.intent === "assembly_input"),
        );
      if (unlinked.length) {
        const logicalNodes = [
          ...document.nodes,
          ...(document.hiddenNodes ?? []),
        ];
        const incoming = logicalNodes.filter((source) =>
          document.edges.some(
            (edge) =>
              edge.intent !== "post_edit_result" &&
              edge.referenceBinding !== "pinned" &&
              edge.source === source.id &&
              edge.target === node.id,
          ),
        );
        const content = generationContent(node, incoming).filter(
          (part) =>
            part.type !== "reference" ||
            !unlinked.some(
              (edge) =>
                edge.source === part.nodeId || edge.id === part.referenceId,
            ),
        );
        node = {
          ...node,
          data: { ...node.data, ...generationContentPatch(content) },
        };
      }
      if (!node.data.settings) return node;
      const settings = mapSettingsNodeReferences(node.data.settings, (id) =>
        disconnected.some(
          (edge) => edge.source === id && edge.target === node.id,
        ) &&
        !edges.some(
          (edge) =>
            edge.intent !== "post_edit_result" &&
            edge.source === id &&
            edge.target === node.id,
        )
          ? undefined
          : id,
      );
      return settings === node.data.settings
        ? node
        : { ...node, data: { ...node.data, settings } };
    }),
  };
}

/** Node references are identities, unlike retained timeline/subject source snapshots. */
export function mapSettingsNodeReferences(
  settings: GenerationSettings,
  resolve: (id: string) => string | undefined,
): GenerationSettings {
  let next = settings;
  for (const key of ["firstFrameNodeId", "lastFrameNodeId"] as const) {
    const before = settings[key];
    if (before === undefined) continue;
    const after = resolve(before);
    if (after === before) continue;
    if (next === settings) next = { ...settings };
    if (after === undefined) delete next[key];
    else next[key] = after;
  }
  return next;
}
