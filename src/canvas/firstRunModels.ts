import { availabilityBlocker } from "../backend/availability.ts";
import { isGenerationModel, isMusicModel, type ModelConfig } from "../backend/rules.ts";
import { effectiveVideoMode } from "../contracts/ruleFacts.generated.ts";
import { tNow } from "../i18n/messages.ts";

export const firstRunCapabilities = {
  text_response: "agent",
  text_to_image: "image",
  video_generation: "video",
  text_to_speech: "audio",
  lyrics_to_music: "audio",
} as const;

export type FirstRunCapability = keyof typeof firstRunCapabilities;
export type FirstRunMedia = Exclude<FirstRunCapability, "text_response">;
export type FirstRunSelection = { capability: FirstRunMedia; model: ModelConfig };

export function firstRunModelKind(
  model: Pick<ModelConfig, "kind" | "protocol">,
  capability: FirstRunCapability,
) {
  return model.kind === firstRunCapabilities[capability] &&
    isGenerationModel(model) &&
    isMusicModel(model) === (capability === "lyrics_to_music");
}

export function firstRunModelIssue(model: ModelConfig, capability: FirstRunCapability) {
  if (capability !== "video_generation") return availabilityBlocker(model, capability);
  const profiles = (["text_to_video", "image_to_video"] as const)
    .filter((profile) => supportsVideoProfile(model, profile));
  if (!profiles.length) return tNow("firstRun.videoUnsupported");
  const issues = profiles.map((profile) => availabilityBlocker(model, profile));
  return issues.some((issue) => issue === null) ? null : issues[0];
}

export function hasFirstCanvasModel(models: readonly ModelConfig[]) {
  return models.some(model => (["text_to_image", "video_generation"] as const).some(capability =>
    firstRunModelKind(model, capability) && firstRunModelIssue(model, capability) === null));
}

function supportsVideoProfile(model: ModelConfig, capability: "text_to_video" | "image_to_video") {
  const hasImage = capability === "image_to_video";
  const rules = model.inputRules;
  const mode = effectiveVideoMode({
    mode: "reference",
    allowedModes: rules.videoModes,
    hasNonTextMedia: hasImage,
    configured: true,
  });
  return rules.videoModes.includes(mode) &&
    (hasImage ? rules.allowedKinds.includes("image") && rules.maxImages > 0 : rules.allowedKinds.includes("text")) &&
    !(model.videoAdapter === "fasth3_dual" && mode === "first_frame");
}
