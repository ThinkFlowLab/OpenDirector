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
