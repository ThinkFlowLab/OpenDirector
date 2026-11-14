import type {
  CanvasDocument,
  CanvasNode,
  GenerationSettings,
} from "./model.ts";
import { tNow } from "../i18n/messages.ts";
import type { ModelConfig } from "../backend/rules.ts";
import { assetKind, type ReferenceAsset } from "./chatReferenceContent.ts";
import { RULE_FACTS } from "../contracts/ruleFacts.generated.ts";

export const FRAME_IMAGE_LIMIT = RULE_FACTS.frameImageLimit;
export const frameImageLimitMessage = () =>
  tNow("errors.connection.frameCapacity");

export function frameImageLimitIssue(
  settings: GenerationSettings,
  incoming: readonly CanvasNode[],
) {
  return settings.mode === "video" &&
    settings.videoMode === "first-last" &&
    new Set(
      incoming.filter((node) => node.type === "image").map((node) => node.id),
    ).size > FRAME_IMAGE_LIMIT
    ? frameImageLimitMessage()
    : null;
}

/**
 * What the canvas command layer needs to know about the selected model. The
 * document model has no access to the configured service catalog, so the
 * workspace supplies it. Without it, a configured service model is treated as
 * first-frame only: filling a slot the model rejects would block generation.
 */
export interface FrameCapabilities {
  supportsLastFrame(settings: GenerationSettings): boolean;
}

/** Read last-frame support from the configured model's input rules. */
export function modelFrameCapabilities(
  models: readonly Pick<ModelConfig, "id" | "inputRules">[],
): FrameCapabilities {
  return {
    supportsLastFrame: (settings) => {
      if (!settings.modelConfigId) return true;
      const config = models.find(
        (model) => model.id === settings.modelConfigId,
      );
      return Boolean(config?.inputRules.frameRoles?.includes("last_frame"));
    },
  };
}

function supportsLastFrame(
  settings: GenerationSettings,
  capabilities?: FrameCapabilities,
) {
  if (capabilities) return capabilities.supportsLastFrame(settings);
  return !settings.modelConfigId;
}

/** Connection/mode-change default only; rendering and manual clearing never
 * refill a slot. Keep explicit selections and the order of incoming edges. */
export function fillConnectedFrames(
  settings: GenerationSettings,
  incoming: readonly CanvasNode[],
  capabilities?: FrameCapabilities,
): GenerationSettings {
  if (
    settings.mode !== "video" ||
    settings.videoMode !== "first-last" ||
    frameImageLimitIssue(settings, incoming)
  )
    return settings;
  const images = incoming.filter(
    (node) =>
      node.type === "image" &&
      node.data.src &&
      node.data.assetState !== "missing",
  );
  let next = settings.frameSlotsInitialized
    ? settings
    : { ...settings, frameSlotsInitialized: true };
  for (const field of ["firstFrameNodeId", "lastFrameNodeId"] as const) {
    if (
      field === "lastFrameNodeId" &&
      !supportsLastFrame(settings, capabilities)
    )
      continue;
    if (next[field]) continue;
    // A slot already holding a fixed asset keeps it.
    if (
      next[
        field === "firstFrameNodeId"
          ? "firstFrameReferenceId"
          : "lastFrameReferenceId"
      ]
    )
      continue;
    const image = images.find(
      (node) =>
        node.id !== next.firstFrameNodeId && node.id !== next.lastFrameNodeId,
    );
    if (image) next = { ...next, [field]: image.id };
  }
  return next;
}

/** Upgrade older local canvas documents once. Subsequent reloads must preserve
 * intentionally empty slots instead of assigning a frame the user cleared. */
export function initializeConnectedFrames(
  document: CanvasDocument,
): CanvasDocument {
  let changed = false;
  const nodes = document.nodes.map((node) => {
    const settings = node.data.settings;
    if (
      node.type !== "video" ||
      !settings ||
      settings.frameSlotsInitialized ||
      settings.videoMode !== "first-last"
    )
      return node;
    const sources = [
      ...new Set(
        document.edges
          .filter(
            (edge) =>
              edge.target === node.id && edge.intent !== "post_edit_result",
          )
          .map((edge) => edge.source),
      ),
    ];
    const incoming = sources.flatMap(
      (id) => document.nodes.find((item) => item.id === id) ?? [],
    );
    const initialized = fillConnectedFrames(settings, incoming);
    if (initialized === settings) return node;
    changed = true;
    return { ...node, data: { ...node.data, settings: initialized } };
  });
  return changed ? { ...document, nodes } : document;
}

export type FrameSlot = "first" | "last";
const SLOT_FIELDS = {
  first: ["firstFrameNodeId", "firstFrameReferenceId"],
  last: ["lastFrameNodeId", "lastFrameReferenceId"],
} as const;
/** Select value prefix for a fixed asset; node IDs never take this form. */
export const PINNED_FRAME_PREFIX = "pinned:";

/** A fixed image in the prompt that a frame slot can use. */
export interface PinnedFrameCandidate {
  referenceId: string;
  assetId: string;
  name: string;
}

/** Fixed image references in a generation prompt, in prompt order. */
export function pinnedFrameCandidates(
  content: CanvasNode["data"]["promptContent"],
  assets: readonly ReferenceAsset[] = [],
): PinnedFrameCandidate[] {
  const seen = new Set<string>();
  return (content ?? []).flatMap((part) => {
    if (
      part.type !== "reference" ||
      part.binding !== "asset" ||
      !part.referenceId ||
      seen.has(part.referenceId)
    )
      return [];
    const asset =
      assets.find((item) => item.referenceId === part.referenceId) ??
      assets.find((item) => item.id === part.assetId);
    if (!asset || assetKind(asset) !== "image") return [];
    seen.add(part.referenceId);
    return [
      { referenceId: part.referenceId, assetId: part.assetId, name: part.name },
    ];
  });
}

/** The select value a slot currently shows: a node ID or a prefixed reference. */
export function frameSlotValue(settings: GenerationSettings, slot: FrameSlot) {
  const [node, reference] = SLOT_FIELDS[slot];
  return (
    settings[node] ??
    (settings[reference] ? PINNED_FRAME_PREFIX + settings[reference] : "")
  );
}

/** Settings patch for choosing a slot value; a slot holds one kind of frame. */
export function frameSlotPatch(
  slot: FrameSlot,
  value: string,
): Partial<GenerationSettings> {
  const [node, reference] = SLOT_FIELDS[slot];
  return value.startsWith(PINNED_FRAME_PREFIX)
    ? { [node]: undefined, [reference]: value.slice(PINNED_FRAME_PREFIX.length) }
    : { [node]: value || undefined, [reference]: undefined };
}

/** Exchange the first and last frame, whichever kind each slot holds. */
export function swapFramePatch(
  settings: GenerationSettings,
): Partial<GenerationSettings> {
  return {
    firstFrameNodeId: settings.lastFrameNodeId,
    lastFrameNodeId: settings.firstFrameNodeId,
    firstFrameReferenceId: settings.lastFrameReferenceId,
    lastFrameReferenceId: settings.firstFrameReferenceId,
  };
}

/** Mode-change default for fixed images, after connected nodes had their turn:
 * entering first-last fills each still-empty slot with the next fixed image in
 * prompt order, as connected images do. Rendering never calls this, so a slot
 * the user cleared stays empty until the mode changes again. */
export function fillPinnedFrames(
  settings: GenerationSettings,
  candidates: readonly PinnedFrameCandidate[],
  capabilities?: FrameCapabilities,
): GenerationSettings {
  if (settings.mode !== "video" || settings.videoMode !== "first-last")
    return settings;
  let next = settings;
  for (const slot of ["first", "last"] as const) {
    const [node, reference] = SLOT_FIELDS[slot];
    if (slot === "last" && !supportsLastFrame(settings, capabilities)) continue;
    if (next[node] || next[reference]) continue;
    const used = new Set([next.firstFrameReferenceId, next.lastFrameReferenceId]);
    const candidate = candidates.find((item) => !used.has(item.referenceId));
    if (candidate) next = { ...next, [reference]: candidate.referenceId };
  }
  return next;
}
