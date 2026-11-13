import {
  backendModel,
  serviceAudioSettings,
  type ModelConfig,
} from "../backend/rules.ts";
import { copyGenerationSettings } from "./dataBoundary.ts";
import {
  GENERATION_RATIOS,
  generationDefaults,
} from "./generationCatalog.ts";
import type { ReferenceContent } from "./chatReferenceContent.ts";
import { generationPrompt } from "./generationReferenceContent.ts";
import type { CanvasNode, GenerationSettings } from "./model.ts";
import {
  applyModelResolution,
  resolveGenerationModel,
} from "./modelResolution.ts";

const LEGACY_MODELS = [
  "本地交互演示",
  "本地音频工作流",
  "配乐创意",
  "环境音创意",
];

/** Shared defaults let the workspace run the same parameters that the controls display. */
export function getNodeGenerationSettings(
  node: CanvasNode,
  models?: readonly ModelConfig[],
): GenerationSettings {
  const mode =
    node.data.kind === "video"
      ? "video"
      : node.data.kind === "audio"
        ? "audio"
        : "image";
  const previous = node.data.settings
    ? copyGenerationSettings(node.data.settings)
    : undefined;
  // Older saved projects may retain settings from a previous media kind.
  // Model, resolution and duration belong to their original media mode.
  const sameMode = previous?.mode === mode ? previous : undefined;
  const defaults = generationDefaults(mode);
  const legacyModel = LEGACY_MODELS.includes(sameMode?.model ?? "");
  const next: GenerationSettings = {
    ...defaults,
    ...sameMode,
    mode,
    model: sameMode?.model && !legacyModel ? sameMode.model : defaults.model,
    aspectRatio:
      previous?.aspectRatio === "auto" ||
      GENERATION_RATIOS.some((ratio) => ratio === previous?.aspectRatio)
        ? previous!.aspectRatio
        : defaults.aspectRatio,
    resolution:
      mode === "audio"
        ? "auto"
        : sameMode?.resolution && sameMode.resolution !== "1024"
          ? sameMode.resolution
          : defaults.resolution,
    prompt: generationPrompt(node),
    count: previous?.count ?? 1,
    audioEnabled: sameMode?.audioEnabled ?? true,
    voiceName: sameMode?.modelConfigId
      ? sameMode.voiceName
      : (sameMode?.voiceName ?? defaults.voiceName),
  };
  // The creator only offers configured service models, so the displayed model
  // has to be the resolved one: reading and running then agree, and reopening a
  // node never drifts to whatever the catalog happens to define.
  if (!models) return next;
  const resolved = applyModelResolution(
    next,
    resolveGenerationModel(next, mode, models),
  );
  const config = backendModel(resolved, models);
  return config ? serviceAudioSettings(resolved, config) : resolved;
}

/** Save receipts may fill defaults and replace display labels without an edit. */
export function generationEditSettings(node: CanvasNode) {
  if (!["image", "video", "audio"].includes(node.type)) return node.data.settings;
  const settings = getNodeGenerationSettings(node);
  if (settings.videoMode !== "first-last") delete settings.frameSlotsInitialized;
  return { ...settings, model: settings.modelConfigId ? "" : settings.model };
}

/** Server acknowledgements canonicalize labels/assets without changing intent. */
export function generationEditIdentity(
  node: CanvasNode,
  content: ReferenceContent,
) {
  const { prompt: _projection, ...settings } = generationEditSettings(node) ?? {};
  return JSON.stringify({
    kind: node.type,
    title: node.data.title,
    src: node.data.src,
    text: node.data.text,
    settings: Object.fromEntries(
      Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)),
    ),
    agentSettings: node.data.agentSettings
      ? Object.fromEntries(
          Object.entries(node.data.agentSettings).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : undefined,
    content: content.map((part) =>
      part.type !== "reference"
        ? part
        : part.binding === "asset"
          ? {
              binding: "asset",
              assetId: part.assetId,
              fingerprint: part.fingerprint,
              referenceId: part.referenceId,
            }
          : { nodeId: part.nodeId, referenceId: part.referenceId },
    ),
  });
}
