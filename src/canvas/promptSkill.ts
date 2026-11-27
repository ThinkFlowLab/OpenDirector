import type { ContentPart, ReferenceContent } from "./chatReferenceContent.ts";
import { translate } from "../i18n/messages.ts";
import { backendReferences, type ModelConfig } from "../backend/rules.ts";
import { generationReferenceIssue } from "./generationCatalog.ts";
import type { CanvasNode, GenerationSettings } from "./model.ts";
import type { ToolField } from "./toolCatalog.ts";

/** One selectable image preset, as published by the tool catalog. */
export interface PromptSkillPreset {
  value: string;
  label: string;
  prompts: readonly string[];
  textPrompts?: readonly string[];
  /** Alternate instructions for the face-emphasis framing, when offered. */
  faceEmphasisPrompt?: string;
  faceEmphasisTextPrompt?: string;
}

/** A preset is an atom in the prompt, like a reference chip. */
export type PresetPart = Extract<ContentPart, { type: "skill" }> & {
  preset: string;
};

/**
 * Presets published by the tool catalog. Options without instructions are not
 * prompt skills (for example a service-side preset), so they stay out.
 */
export function imagePresetsFromFields(
  fields: readonly Pick<ToolField, "key" | "options">[] | undefined,
): PromptSkillPreset[] {
  const field = fields?.find((item) => item.key === "preset");
  return (field?.options ?? []).flatMap((option) =>
    option.prompts?.length
      ? [
          {
            value: String(option.value),
            label: option.label,
            prompts: option.prompts,
            textPrompts: option.textPrompts ?? (option.textPrompt ? [option.textPrompt] : undefined),
            ...(option.faceEmphasisPrompt
              ? { faceEmphasisPrompt: option.faceEmphasisPrompt }
              : {}),
            faceEmphasisTextPrompt: option.faceEmphasisTextPrompt,
          },
        ]
      : [],
  );
}

/** Presets that offer the face-emphasis framing. */
export function supportsFaceEmphasis(preset: PromptSkillPreset | undefined) {
  return Boolean(preset?.faceEmphasisPrompt);
}

/** Use the images the selected model can actually take, including subject images. */
export function presetImageTitles(
  settings: GenerationSettings,
  sources: readonly CanvasNode[],
  config?: ModelConfig,
): string[] {
  const usable = config
    ? backendReferences(settings, sources, config).map(({ node }) => node)
    : sources.filter((node) => !generationReferenceIssue(node, settings));
  const subjectTitles = new Map(
    sources
      .filter((node) => node.type === "subject")
      .map((node) => [node.id, node.data.title]),
  );
  const images = new Map<string, string>();
  for (const node of usable) {
    if (node.type !== "image") continue;
    const key = node.data.backendAssetId ?? node.data.src ?? node.id;
    if (!images.has(key)) images.set(key, subjectTitles.get(node.id) ?? node.data.title);
  }
  return [...images.values()];
}

/** The preset atom in a prompt, if one is present. */
export function presetPart(content: ReferenceContent): PresetPart | undefined {
  return content.find(
    (part): part is PresetPart => part.type === "skill" && Boolean(part.preset),
  );
}

export function withoutPresetParts(content: ReferenceContent): ReferenceContent {
  return content.filter(
    (part) => !(part.type === "skill" && part.preset),
  );
}

/** Put one preset at the front; another replaces it, so there is only one. */
export function withPresetPart(
  content: ReferenceContent,
  preset: PresetPart | null,
): ReferenceContent {
  const rest = withoutPresetParts(content);
  return preset ? [preset, ...rest] : rest;
}

/**
 * The text a preset contributes to the prompt. It is never written into the
 * editor; the chip stands for it and the text is prepended at submission.
 */
export function presetSkillText(
  preset: PromptSkillPreset,
  references: readonly string[],
  faceEmphasis = false,
): string {
  // Generation freezes instructions in the catalog's language.
  const locale = "zh-CN";
  const lines: string[] = [];
  if (references.length > 1) {
    const list = references
      .map((title, index) =>
        translate(locale, "generation.preset.skill.referenceItem", {
          index: index + 1,
          title,
        }),
      )
      .join(translate(locale, "generation.preset.skill.separator"));
    lines.push(
      translate(locale, "generation.preset.skill.references", {
        count: references.length,
        list,
      }),
    );
  }
  const withImage = references.length > 0;
  const emphasisPrompt = withImage
    ? preset.faceEmphasisPrompt
    : (preset.faceEmphasisTextPrompt ?? preset.faceEmphasisPrompt);
  const prompts = faceEmphasis && emphasisPrompt
    ? [emphasisPrompt]
    : (withImage ? preset.prompts : (preset.textPrompts ?? preset.prompts));
  if (prompts.length > 1) {
    lines.push(translate(locale, "generation.preset.skill.sequence"));
    prompts.forEach((prompt, index) => lines.push(`${index + 1}. ${prompt}`));
  } else if (prompts[0]) {
    lines.push(prompts[0]);
  }
  return lines.join("\n");
}

/** Prompt text for a node, with the selected preset ahead of the user's words. */
export function promptWithPreset(
  prompt: string,
  skill: string | undefined,
): string {
  if (!skill) return prompt;
  return prompt.trim() ? `${skill}\n\n${prompt}` : skill;
}
