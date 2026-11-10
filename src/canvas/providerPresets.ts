import type { ModelConfigInput } from "../backend/models.ts";
import type { ModelConfig, ModelKind } from "../backend/rules.ts";
import { getActiveLocale } from "../i18n/messages.ts";

/** Preset labels are product copy; ids, protocols and URLs stay stable. */
const EN_NAMES: Record<string, string> = {
  "OpenAI 兼容": "OpenAI compatible",
  "MiniMax 官方视频": "MiniMax official video",
  "可灵官方视频": "Kling official video",
  "MiniMax 官方图片": "MiniMax Official Images",
  "MOSS 开放平台": "MOSS Open Platform",
  "火山方舟 / Agent Plan": "Volcano Ark / Agent Plan",
  "vLLM-Omni 图片接口": "vLLM-Omni image API",
  "vLLM-Omni 语音合成接口": "vLLM-Omni speech synthesis API",
  "vLLM-Omni 音乐生成接口": "vLLM-Omni music generation API",
  "vLLM-Omni 扒谱接口": "vLLM-Omni transcription API",
  "vLLM-Omni 视频接口": "vLLM-Omni video API",
  "vLLM-Omni 分割接口": "vLLM-Omni segmentation API",
  "vLLM-Omni 深度接口": "vLLM-Omni depth API",
};

const EN_OPTION_LABELS: Record<string, string> = {
  图片接口: "Image API",
  语音合成接口: "Speech synthesis API",
  音乐生成接口: "Music generation API",
  扒谱接口: "Transcription API",
  视频接口: "Video API",
  分割接口: "Segmentation API",
  深度接口: "Depth API",
};

const EN_GROUPS: Record<string, string> = {
  "vLLM-Omni 兼容": "vLLM-Omni compatible",
  "自定义 API": "Custom API",
};

function providerName(value: string): string {
  return getActiveLocale() === "en-US" ? (EN_NAMES[value] ?? value) : value;
}

function optionLabel(value: string): string {
  return getActiveLocale() === "en-US"
    ? (EN_OPTION_LABELS[value] ?? value)
    : value;
}

function groupLabel(value: string | undefined): string | undefined {
  if (!value) return value;
  return getActiveLocale() === "en-US" ? (EN_GROUPS[value] ?? value) : value;
}

export interface ProviderPreset {
  id: string;
  name: string;
  logoOrganization?: string;
  group?: string;
  optionLabel?: string;
  kinds: ModelKind[];
  url: string;
  protocol: ModelConfigInput["protocol"];
  connectionType: ModelConfigInput["connectionType"];
  authMode: ModelConfigInput["authMode"];
  modelsByKind?: Partial<Record<ModelKind, readonly string[]>>;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "custom",
    name: "OpenAI 兼容",
    logoOrganization: "openai",
    kinds: ["agent", "image", "audio"],
    url: "https://api.openai.com/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
  },

  {
    id: "minimax-agent",
    logoOrganization: "MiniMaxAI",
    name: "MiniMax (minimax.cn)",
    kinds: ["agent"],
    url: "https://api.minimax.cn/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
  },
  {
    id: "minimax-image",
    logoOrganization: "MiniMaxAI",
    name: "MiniMax 官方图片",
    kinds: ["image"],
    url: "https://api.minimax.cn/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
    modelsByKind: { image: ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"] },
  },
  {
    id: "minimax-video",
    logoOrganization: "MiniMaxAI",
    name: "MiniMax 官方视频",
    kinds: ["video"],
    url: "https://api.minimax.cn/v2",
    protocol: "minimax_video_v2",
    connectionType: "api",
    authMode: "bearer",
    modelsByKind: {
      video: ["MiniMax-H3", "MiniMax-H3-Highspeed", "MiniMax-H3-Lite", "MiniMax-H3-Max"],
    },
  },
  {
    id: "kling-video",
    logoOrganization: "KlingAI",
    name: "可灵官方视频",
    kinds: ["video"],
    url: "https://api-beijing.klingai.com",
    protocol: "kling_video",
    connectionType: "api",
    authMode: "bearer",
    modelsByKind: { video: ["kling-4.0", "kling-4.0-flash"] },
  },
  {
    id: "deepseek",
    logoOrganization: "deepseek-ai",
    name: "DeepSeek",
    kinds: ["agent"],
    url: "https://api.deepseek.com/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
  },
  {
    id: "moss",
    logoOrganization: "OpenMOSS-Team",
    name: "MOSS 开放平台",
    kinds: ["image", "audio"],
    url: "https://api.mosi.cn/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
    modelsByKind: {
      image: ["moss-image-sft-1.0", "moss-image-base-1.0"],
      audio: [
        "moss-tts-1.5-flash",
        "moss-tts-1.0-pro",
        "moss-tts-1.5-flash-2026-06-26",
        "moss-tts-1.0-pro-2026-02-07",
      ],
    },
  },

  {
    id: "ark",
    logoOrganization: "ByteDance-Seed",
    name: "火山方舟 / Agent Plan",
    kinds: ["image", "video", "audio"],
    url: "https://ark.cn-beijing.volces.com/api/plan/v3",
    protocol: "volcengine",
    connectionType: "api",
    authMode: "bearer",
  },
  ...(
    [
      ["vllm-omni-image", "vLLM-Omni 图片接口", "openai", ["image"]],
      ["vllm-omni-speech", "vLLM-Omni 语音合成接口", "openai", ["audio"]],
      [
        "vllm-omni-music",
        "vLLM-Omni 音乐生成接口",
        "vllm_omni_music",
        ["audio"],
      ],
      ["vllm-omni-score", "vLLM-Omni 扒谱接口", "vllm_omni_score", ["audio"]],
      ["vllm-omni-video", "vLLM-Omni 视频接口", "vllm_omni", ["video"]],
      [
        "vllm-omni-segmentation",
        "vLLM-Omni 分割接口",
        "vllm_omni_segmentation",
        ["image", "video", "vision"],
      ],
      ["vllm-omni-depth", "vLLM-Omni 深度接口", "vllm_omni_depth", ["video"]],
    ] as const
  ).map(([id, name, protocol, kinds]) => ({
    id,
    name,
    group: "vLLM-Omni",
    logoOrganization: "vllm-project",
    optionLabel: name.replace("vLLM-Omni ", ""),
    protocol,
    kinds: [...kinds],
    url: "",
    connectionType: "self_hosted" as const,
    authMode: "none" as const,
  })),
];

export function providerPresetFor(model: ModelConfig): string {
  const explicit = PROVIDER_PRESETS.find(
    (preset) =>
      preset.connectionType === "api" &&
      preset.protocol !== "openai" &&
      preset.protocol === model.protocol &&
      preset.kinds.includes(model.kind),
  );
  if (explicit) return explicit.id;
  const deployed = PROVIDER_PRESETS.find(
    (preset) =>
      preset.connectionType === "self_hosted" &&
      preset.protocol === model.protocol &&
      preset.kinds.includes(model.kind),
  );
  if (deployed && model.connectionType === "self_hosted") return deployed.id;
  if (model.connectionType === "self_hosted") return "custom";
  return (
    PROVIDER_PRESETS.find(
      (preset) =>
        preset.kinds.includes(model.kind) &&
        preset.protocol === model.protocol &&
        preset.url === model.url.replace(/\/+$/, ""),
    )?.id ?? "custom"
  );
}

export function providerOptions(
  kind: ModelKind,
): Pick<
  ProviderPreset,
  "id" | "name" | "logoOrganization" | "group" | "optionLabel"
>[] {
  return PROVIDER_PRESETS.filter((preset) => preset.kinds.includes(kind)).map(
    (preset) => ({
      ...preset,
      name: providerName(preset.name),
      optionLabel: preset.optionLabel
        ? optionLabel(preset.optionLabel)
        : preset.optionLabel,
      group: groupLabel(
        preset.group === "vLLM-Omni" ? "vLLM-Omni 兼容" : "自定义 API",
      ),
    }),
  );
}

export function providerLabel(model: ModelConfig) {
  return (
    providerOptions(model.kind).find(
      (item) => item.id === providerPresetFor(model),
    )?.name ??
    (getActiveLocale() === "en-US" ? "Custom service" : "未预设服务")
  );
}

export function matchingConnections(
  models: ModelConfig[],
  kind: ModelKind,
  value: ModelConfigInput,
): ModelConfig[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const id = model.providerId ?? model.id;
    if (
      model.kind !== kind ||
      model.protocol !== value.protocol ||
      model.url.replace(/\/+$/, "") !== value.url.replace(/\/+$/, "") ||
      seen.has(id)
    )
      return false;
    seen.add(id);
    return true;
  });
}
