import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, json, request } from "./api.ts";
import type {
  ModelConfig,
  ModelKind,
  VideoAdapter,
  VideoCapabilities,
} from "./rules.ts";
import {
  availabilityModelKey,
  availabilityMatchesModel,
  currentAvailability,
  failedAvailability,
  nextAvailabilityDelay,
  receiveAvailability,
  type ModelAvailability,
} from "./availability.ts";
import type { AvailabilityCatalog } from "../contracts/generated.ts";
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

export type ModelOptions = Pick<
  ModelConfigInput,
  "inputModalities" | "videoAdapter" | "videoCapabilities"
>;

export interface ModelConfigInput {
  capabilityAutoCheck?: boolean | null;
  kind: ModelKind;
  url: string;
  modelId: string;
  apiKey: string;
  connectionType: "api" | "self_hosted";
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

export function checkDraftAvailability(
  value: ModelConfigInput,
  configId?: string,
) {
  return request<ModelAvailability>(
    "/model-configs/availability/check",
    json("POST", { ...value, configId }),
  ).then((value) => receiveAvailability(value));
}

/** Saved configurations remain distinct from disposable capability observations. */
export function useBackendModels() {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const modelsRef = useRef<ModelConfig[]>([]);
  const epoch = useRef(0);
  const querySequence = useRef(0);
  const latestQuery = useRef(new Map<string, number>());
  const alive = useRef(true);
  const [availabilityRevision, setAvailabilityRevision] = useState(0);
  const [availabilityError, setAvailabilityError] = useState("");
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const storeModels = useCallback((next: ModelConfig[]) => {
    if (!alive.current) return;
    modelsRef.current = next;
    setModels(next);
    setAvailabilityRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current += 1;
    };
  }, []);
  const refreshAvailability = useCallback(
    async (ids: readonly string[], manual = false) => {
      if (!ids.length) return;
      const serial = ++querySequence.current;
      const initialEpoch = epoch.current;
      const initial = new Map(
        modelsRef.current
          .filter((model) => ids.includes(model.id))
          .map((model) => [
            model.id,
            {
              key: availabilityModelKey(model),
              identity: model.availability?.identity,
            },
          ]),
      );
      if (!initial.size) return;
      initial.forEach((_, id) => latestQuery.current.set(id, serial));
      setCheckingIds((current) => new Set([...current, ...initial.keys()]));
      try {
        const result = await request<AvailabilityCatalog>(
          "/model-configs/availability",
          json("POST", { configIds: [...initial.keys()], manual }),
        );
        result.models.forEach((value) => receiveAvailability(value));
        if (!alive.current || epoch.current !== initialEpoch) return;
        const received = new Map(
          result.models.map((item) => [item.configId, item]),
        );
        storeModels(
          modelsRef.current.map((model) => {
            const observation = received.get(model.id);
            const expected = initial.get(model.id);
            return expected?.key === availabilityModelKey(model) &&
              latestQuery.current.get(model.id) === serial &&
              observation &&
              availabilityMatchesModel(model, observation, expected.identity)
              ? { ...model, availability: observation }
              : model;
          }),
        );
        setAvailabilityError("");
      } catch (failure) {
        if (!alive.current || epoch.current !== initialEpoch) return;
        // An unsuccessful check cannot keep an earlier denial active.
        storeModels(
          modelsRef.current.map((model) =>
            initial.get(model.id)?.key === availabilityModelKey(model) &&
            latestQuery.current.get(model.id) === serial
              ? {
                  ...model,
                  availability: model.availability
                    ? failedAvailability(model.availability)
                    : undefined,
                }
              : model,
          ),
        );
        setAvailabilityError(errorMessage(failure));
      } finally {
        if (alive.current)
          setCheckingIds(
            (current) =>
              new Set(
                [...current].filter(
                  (id) =>
                    !initial.has(id) || latestQuery.current.get(id) !== serial,
                ),
              ),
          );
      }
    },
    [storeModels],
  );
  const refresh = useCallback(async () => {
    const initialEpoch = ++epoch.current;
    try {
      const [list, general] = await Promise.all([
        request<ModelConfig[]>("/model-configs").then((list) => {
          list.forEach((model) => {
            if (model.availability) receiveAvailability(model.availability);
          });
          return list;
        }),
        request<GeneralSettings>("/settings"),
      ]);
      if (!alive.current || initialEpoch !== epoch.current) return;
      storeModels(list);
      setSettings(general);
      setConnected(true);
      setError("");
    } catch (failure) {
      if (!alive.current || initialEpoch !== epoch.current) return;
      setConnected(false);
      setError(errorMessage(failure));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [storeModels]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const delay = nextAvailabilityDelay(models);
    if (delay === null) return;
    const timer = setTimeout(
      () => {
        storeModels(
          modelsRef.current.map((model) =>
            model.availability
              ? {
                  ...model,
                  availability: currentAvailability(model.availability),
                }
              : model,
          ),
        );
      },
      Math.max(1, delay + 1),
    );
    return () => clearTimeout(timer);
  }, [models, storeModels]);
  const save = async (value: ModelConfigInput, id?: string) => {
    epoch.current += 1;
    const saved = await request<ModelConfig>(
      `/model-configs${id ? `/${id}` : ""}`,
      json(id ? "PATCH" : "POST", value),
    );
    // The directory supplies the opaque server identity, including credentials.
    await refresh();
    void refreshAvailability([saved.id]);
  };
  const saveMany = async (
    value: ModelConfigInput,
    modelIds: string[],
    id?: string,
    modelOptions: Record<string, ModelOptions> = {},
  ) => {
    epoch.current += 1;
    const saved = await request<ModelConfig[]>(
      "/model-configs/batch",
      json("POST", { ...value, modelIds, modelOptions, configId: id }),
    );
    await refresh();
    void refreshAvailability(saved.map((model) => model.id));
  };
  const removeService = async (id: string) => {
    epoch.current += 1;
    await request(`/model-services/${id}`, { method: "DELETE" });
    await refresh();
  };
  const remove = async (id: string) => {
    epoch.current += 1;
    await request(`/model-configs/${id}`, { method: "DELETE" });
    storeModels(modelsRef.current.filter((item) => item.id !== id));
  };
  const updateSettings = async (patch: GeneralSettings) => {
    try {
      setSettings(
        await request<GeneralSettings>("/settings", json("PATCH", patch)),
      );
    } catch (failure) {
      setSettings(null);
      try {
        setSettings(await request<GeneralSettings>("/settings"));
      } catch {
        /* A later refresh reconciles the save. */
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
    availabilityRevision,
    availabilityError,
    checkingIds,
    refreshAvailability,
  };
}

export type BackendModels = ReturnType<typeof useBackendModels>;
