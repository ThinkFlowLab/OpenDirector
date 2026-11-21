import type { ModelConfigInput } from "../backend/models.ts";
import type { ModelConfig, ModelKind } from "../backend/rules.ts";
import { getActiveLocale } from "../i18n/messages.ts";

/** Preset labels are product copy; ids, protocols and URLs stay stable. */
const EN_NAMES: Record<string, string> = {
  "智谱 BigModel 视频": "Zhipu BigModel video",
  "OpenAI 兼容": "OpenAI compatible",
  "MiniMax 官方视频": "MiniMax official video",
  "智谱 BigModel": "Zhipu BigModel",
  "阿里云百炼（北京）": "Alibaba Cloud Model Studio (Beijing)",
  "月之暗面 Kimi 开放平台": "Moonshot Kimi Open Platform",
  "月之暗面 Kimi Code 订阅": "Moonshot Kimi Code subscription",
  "可灵官方视频": "Kling official video",
  "MiniMax 官方图片": "MiniMax Official Images",
  "MiniMax 官方语音": "MiniMax Official Speech",
  "MOSS 开放平台": "MOSS Open Platform",
  "火山方舟 / Agent Plan": "Volcano Ark / Agent Plan",
  "vLLM-Omni 本地服务": "vLLM-Omni local service",
};

const EN_OPTION_LABELS: Record<string, string> = {
  本地服务: "Local service",
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

/** One stage of a multi-stage self-hosted service: the endpoints it serves. */
export interface ProviderStage {
  /** Endpoint paths appended to the connection URL, e.g. `/images/generations`. */
  paths: readonly string[];
  protocol: ModelConfigInput["protocol"];
}

export interface ProviderPreset {
  id: string;
  name: string;
  logoOrganization?: string;
  group?: string;
  optionLabel?: string;
  kinds: ModelKind[];
  url: string;
  workspaceUrlPattern?: RegExp;
  protocol: ModelConfigInput["protocol"];
  connectionType: ModelConfigInput["connectionType"];
  authMode: ModelConfigInput["authMode"];
  modelsByKind?: Partial<Record<ModelKind, readonly string[]>>;
  /**
   * Per-kind stages of a service that serves several endpoints behind one
   * connection. The first stage is the kind's default. Absent for
   * single-purpose presets, where `url` + `protocol` describe the whole
   * connection.
   */
  stages?: Partial<Record<ModelKind, readonly ProviderStage[]>>;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "bigmodel-video",
    name: "智谱 BigModel 视频",
    logoOrganization: "zai-org",
    kinds: ["video"],
    url: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "bigmodel_video",
    connectionType: "api",
    authMode: "bearer",
    modelsByKind: { video: ["cogvideox-3"] },
  },
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
    id: "bigmodel",
    name: "智谱 BigModel",
    logoOrganization: "zai-org",
    kinds: ["image"],
    url: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
    modelsByKind: { image: ["glm-image"] },
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
    id: "minimax-speech",
    logoOrganization: "MiniMaxAI",
    name: "MiniMax 官方语音",
    kinds: ["audio"],
    url: "https://api.minimax.cn/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
    modelsByKind: { audio: ["speech-2.8-hd", "speech-2.8-turbo"] },
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
    id: "bailian-beijing",
    logoOrganization: "Qwen",
    name: "阿里云百炼（北京）",
    kinds: ["agent"],
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    workspaceUrlPattern: /^https:\/\/[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode\/v1$/,
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
    modelsByKind: { agent: ["qwen3.8-max"] },
  },
  {
    // Token billing on the open platform; keys come from platform.kimi.com.
    id: "kimi",
    logoOrganization: "moonshotai",
    name: "月之暗面 Kimi 开放平台",
    kinds: ["agent"],
    url: "https://api.moonshot.cn/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
  },
  {
    // Subscription quota on Kimi Code; a separate key from the open platform one.
    id: "kimi-coding",
    logoOrganization: "moonshotai",
    name: "月之暗面 Kimi Code 订阅",
    kinds: ["agent"],
    url: "https://api.kimi.com/coding/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
  },
  {
    id: "atlascloud",
    name: "Atlas Cloud",
    kinds: ["agent"],
    url: "https://api.atlascloud.ai/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
  },
  {
    id: "zhipu",
    logoOrganization: "zai-org",
    name: "智谱 BigModel",
    kinds: ["agent", "audio"],
    url: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
    modelsByKind: {
      agent: ["glm-5.3", "glm-5.3-flash", "glm-5.2"],
      audio: ["glm-tts"],
    },
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
  {
    id: "vllm-omni-local",
    logoOrganization: "vllm-project",
    name: "vLLM-Omni 本地服务",
    optionLabel: "本地服务",
    group: "vLLM-Omni",
    kinds: ["agent", "image", "video", "audio", "vision"],
    url: "http://127.0.0.1:8000/v1",
    protocol: "vllm_omni",
    connectionType: "self_hosted",
    authMode: "none",
    // One localhost service serves several stages; each stage keeps the
    // protocol its adapter expects, so a single connection is enough. The
    // first stage of each kind is the default.
    //
    // ASR is deliberately absent: vllm-omni does not serve
    // /audio/transcriptions yet (S1 in #10007) and this application has no ASR
    // adapter. SheetSage2 score shares the path with its own protocol.
    stages: {
      agent: [{ paths: ["/chat/completions"], protocol: "openai" }],
      image: [
        { paths: ["/images/generations", "/images/edits"], protocol: "openai" },
        {
          paths: ["/images/segmentations", "/videos/segmentations"],
          protocol: "vllm_omni_segmentation",
        },
      ],
      video: [
        { paths: ["/videos"], protocol: "vllm_omni" },
        {
          paths: ["/images/segmentations", "/videos/segmentations"],
          protocol: "vllm_omni_segmentation",
        },
        { paths: ["/videos/depth"], protocol: "vllm_omni_depth" },
      ],
      audio: [
        { paths: ["/audio/speech"], protocol: "openai" },
        { paths: ["/audio/speech"], protocol: "vllm_omni_music" },
        { paths: ["/audio/transcriptions"], protocol: "vllm_omni_score" },
      ],
      vision: [
        {
          paths: ["/images/segmentations", "/videos/segmentations"],
          protocol: "vllm_omni_segmentation",
        },
      ],
    },
  },
];

export const LOCAL_OMNI_PRESET_ID = "vllm-omni-local";

/** The stages a preset serves for one kind; empty for single-purpose presets. */
export function presetStages(
  preset: ProviderPreset | undefined,
  kind: ModelKind,
): readonly ProviderStage[] {
  return preset?.stages?.[kind] ?? [];
}

/**
 * The protocol a connection uses for one kind. A protocol that names one of
 * the preset's stages is kept, so reopening a saved specialized connection
 * does not silently switch it back to the kind's default stage.
 */
export function presetProtocol(
  preset: ProviderPreset | undefined,
  kind: ModelKind,
  protocol?: ModelConfigInput["protocol"] | null,
): ModelConfigInput["protocol"] | undefined {
  const stages = presetStages(preset, kind);
  if (protocol && stages.some((stage) => stage.protocol === protocol))
    return protocol;
  return stages[0]?.protocol ?? preset?.protocol;
}

/**
 * `openai` is shared by generic self-hosted services, so it identifies this
 * preset only at the documented loopback default. The specialized vLLM-Omni
 * protocols are unique and need no URL rule.
 */
function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function providerPresetFor(model: ModelConfig): string {
  const explicit = PROVIDER_PRESETS.find(
    (preset) =>
      preset.connectionType === "api" &&
      preset.protocol !== "openai" &&
      preset.protocol === model.protocol &&
      preset.kinds.includes(model.kind),
  );
  if (explicit) return explicit.id;
  const staged = PROVIDER_PRESETS.find(
    (preset) =>
      model.connectionType === "self_hosted" &&
      preset.kinds.includes(model.kind) &&
      presetStages(preset, model.kind).some(
        (stage) => stage.protocol === model.protocol,
      ) &&
      (model.protocol !== "openai" || isLoopbackUrl(model.url)),
  );
  if (staged) return staged.id;
  const deployed = PROVIDER_PRESETS.find(
    (preset) =>
      preset.connectionType === "self_hosted" &&
      preset.protocol === model.protocol &&
      preset.kinds.includes(model.kind),
  );
  if (deployed && model.connectionType === "self_hosted") return deployed.id;
  if (model.connectionType === "self_hosted") return "custom";
  const url = model.url.replace(/\/+$/, "");
  return (
    PROVIDER_PRESETS.find(
      (preset) =>
        preset.kinds.includes(model.kind) &&
        preset.protocol === model.protocol &&
        (preset.url === url || preset.workspaceUrlPattern?.test(url)),
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
