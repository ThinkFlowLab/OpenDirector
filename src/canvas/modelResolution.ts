import {
  backendModel,
  isGenerationModel,
  modelLabel,
  serviceGenerationSettings,
  type ModelConfig,
} from "../backend/rules.ts";
import { generationDefaults } from "./generationCatalog.ts";
import type { GenerationSettings } from "./model.ts";

export type GenerationKind = "image" | "video" | "audio";

/** Per-kind model choices made in the assistant model picker. */
export type PreferredModels = Partial<Record<GenerationKind, string | null>>;

/**
 * How a node's stored model maps onto the configured service models.
 *
 * - `current`: the stored configuration still exists and matches the node kind.
 * - `default`: the node had no model, so it takes the project preference or the
 *   deterministic default.
 * - `orphaned`: the node names a configuration that no longer exists; switching
 *   silently would submit with a model the viewer never chose.
 * - `unconfigured`: no service model of this kind is configured at all.
 */
export type ModelResolution =
  | { status: "current"; model: string; modelConfigId: string }
  | { status: "default"; model: string; modelConfigId: string }
  | { status: "orphaned"; modelConfigId: string }
  | { status: "unconfigured" };

/**
 * The API does not promise an order, so sort by model name first. Ties fall back
 * to the configuration id, which keeps the default stable across reloads.
 */
function candidates(mode: GenerationKind, models: readonly ModelConfig[]) {
  return models
    .filter((model) => model.kind === mode && isGenerationModel(model))
    .sort(
      (a, b) => a.modelId.localeCompare(b.modelId) || a.id.localeCompare(b.id),
    );
}

/**
 * Resolve only; persisting the outcome is the caller's decision.
 *
 * `preferred` carries the model the assistant picker is using for this kind.
 * A node without its own model follows it, so creating a node and opening the
 * chat never disagree about which model will run.
 */
export function resolveGenerationModel(
  settings: Pick<GenerationSettings, "modelConfigId">,
  mode: GenerationKind,
  models: readonly ModelConfig[],
  preferred?: PreferredModels,
): ModelResolution {
  const available = candidates(mode, models);
  const id = settings.modelConfigId;
  if (id) {
    const current = available.find((model) => model.id === id);
    return current
      ? {
          status: "current",
          model: modelLabel(current),
          modelConfigId: current.id,
        }
      : { status: "orphaned", modelConfigId: id };
  }
  const chosen = available.find((model) => model.id === preferred?.[mode]);
  const fallback = chosen ?? available[0];
  return fallback
    ? {
        status: "default",
        model: modelLabel(fallback),
        modelConfigId: fallback.id,
      }
    : { status: "unconfigured" };
}

/** Apply a usable resolution; orphaned and unconfigured keep the stored value. */
export function applyModelResolution<
  T extends Pick<GenerationSettings, "model" | "modelConfigId">,
>(settings: T, resolution: ModelResolution): T {
  if (resolution.status === "current" || resolution.status === "default")
    return {
      ...settings,
      model: resolution.model,
      modelConfigId: resolution.modelConfigId,
    };
  return settings;
}

/**
 * Settings for a node created on the canvas. The catalog defaults describe no
 * particular service, so once a configured model is chosen its published
 * outputs decide the ratio and size, exactly as picking that model in the
 * composer would. Otherwise a new image node could save a ratio the adapter
 * cannot produce.
 */
export function newNodeGenerationSettings(
  mode: GenerationKind,
  models: readonly ModelConfig[],
  preferred?: PreferredModels,
): GenerationSettings {
  const settings = applyModelResolution(
    generationDefaults(mode),
    resolveGenerationModel(
      { modelConfigId: undefined },
      mode,
      models,
      preferred,
    ),
  );
  const config = backendModel(settings, [...models]);
  return config
    ? serviceGenerationSettings(settings, config, [], true)
    : settings;
}
