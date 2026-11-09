import { useCallback, useEffect, useState } from "react";
import { errorMessage, json, request } from "./api.ts";
import type {
  ModelConfig,
  ModelKind,
  VideoAdapter,
  VideoCapabilities,
} from "./rules.ts";
import type { MessageKey } from "../i18n/types.ts";

export const MODEL_KINDS: readonly {
  id: Exclude<ModelKind, "vision">;
  labelKey: MessageKey;
  shortLabelKey: MessageKey;
}[] = [
  {
    id: "agent",
    labelKey: "models.category.agent",
    shortLabelKey: "models.category.agentShort",
  },
  {
    id: "image",
    labelKey: "models.category.image",
    shortLabelKey: "models.category.imageShort",
  },
  {
    id: "video",
    labelKey: "models.category.video",
    shortLabelKey: "models.category.videoShort",
  },
  {
    id: "audio",
    labelKey: "models.category.audio",
    shortLabelKey: "models.category.audioShort",
  },
];

export type ModelOptions = Pick<ModelConfigInput, "inputModalities" | "videoAdapter" | "videoCapabilities">;

export interface ModelConfigInput {
  kind: ModelKind;
  url: string;
  modelId: string;
  apiKey: string;
  /** Forms echo existing entries back, so builtin is accepted here; the
      backend still rejects builtin saves through its URL validation. */
  connectionType: "api" | "self_hosted" | "builtin";
  protocol: NonNullable<ModelConfig["protocol"]>;
  authMode: "none" | "bearer";
  proxyMode?: "system" | "direct";
  inputModalities?: ("text" | "image")[] | null;
  videoAdapter?: VideoAdapter;
  videoCapabilities?: VideoCapabilities | null;
}

export function discoverModels(value: ModelConfigInput, configId?: string) {
  return request<{ models: string[] }>(
    "/model-configs/discover",
    json("POST", { ...value, configId }),
  );
}

export function testAgentModel(value: ModelConfigInput, configId?: string) {
  return request<{ elapsedMs: number }>(
    "/model-configs/test-agent",
    json("POST", { ...value, configId }),
  );
}

export function readModelCapabilities(
  value: ModelConfigInput,
  configId: string | undefined,
  source: "preset" | "service",
) {
  return request<{ videoCapabilities: VideoCapabilities | null }>(
    "/model-configs/capabilities",
    json("POST", { ...value, configId, source }),
  );
}

export interface GeneralSettings {
  removeWatermark: boolean;
}

/** Model availability is independent of the filesystem project's editable draft. */
export function useBackendModels() {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [list, general] = await Promise.all([
        request<ModelConfig[]>("/model-configs"),
        request<GeneralSettings>("/settings"),
      ]);
      setModels(list);
      setSettings(general);
      setConnected(true);
      setError("");
    } catch (failure) {
      setConnected(false);
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const save = async (value: ModelConfigInput, id?: string) => {
    const saved = await request<ModelConfig>(
      `/model-configs${id ? `/${id}` : ""}`,
      json(id ? "PATCH" : "POST", value),
    );
    setModels((current) =>
      id
        ? current.map((item) => (item.id === id ? saved : item))
        : [...current, saved],
    );
  };
  const saveMany = async (
    value: ModelConfigInput,
    modelIds: string[],
    id?: string,
    modelOptions: Record<string, ModelOptions> = {},
  ) => {
    await request<ModelConfig[]>(
      "/model-configs/batch",
      json("POST", { ...value, modelIds, modelOptions, configId: id }),
    );
    await refresh();
  };
  const removeService = async (id: string) => {
    await request(`/model-services/${id}`, { method: "DELETE" });
    await refresh();
  };
  const remove = async (id: string) => {
    await request(`/model-configs/${id}`, { method: "DELETE" });
    setModels((current) => current.filter((item) => item.id !== id));
  };
  const updateSettings = async (patch: GeneralSettings) => {
    try {
      setSettings(
        await request<GeneralSettings>("/settings", json("PATCH", patch)),
      );
    } catch (failure) {
      // Reconcile a lost response before displaying a previous value as truth.
      setSettings(null);
      try {
        setSettings(await request<GeneralSettings>("/settings"));
      } catch {
        /* Await a successful refresh. */
      }
      throw failure;
    }
  };
  return {
    models,
    settings,
    error,
    connected,
    loading,
    refresh,
    save,
    saveMany,
    remove,
    removeService,
    updateSettings,
  };
}

export type BackendModels = ReturnType<typeof useBackendModels>;
