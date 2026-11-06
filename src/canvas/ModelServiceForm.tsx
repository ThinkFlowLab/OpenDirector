import { ProviderPicker } from "./ProviderPicker";
import { useId, useState, type FormEvent } from "react";
import { errorMessage } from "../backend/api.ts";
import {
  MODEL_KINDS,
  discoverModels,
  testAgentModel,
  type BackendModels,
  type ModelConfigInput,
  type ModelOptions,
} from "../backend/models.ts";
import {
  isSegmentationModel,
  type ModelConfig,
  type ModelKind,
} from "../backend/rules.ts";
import { ModelCapabilityCard } from "./ModelCapabilityCard";
import {
  PROVIDER_PRESETS,
  matchingConnections,
  providerPresetFor,
} from "./providerPresets";
import { CanvasIcon } from "./CanvasIcon";
import { ModelPicker, type ModelTestResult } from "./ModelPicker";
import { useT } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";

export type SettingsModelKind = Exclude<ModelKind, "vision">;
const PROTOCOLS: Record<
  SettingsModelKind,
  readonly [ModelConfigInput["protocol"], MessageKey][]
> = {
  agent: [["openai", "models.protocolOption.openaiAgent"]],
  image: [
    ["openai", "models.protocolOption.openaiImage"],
    ["volcengine", "models.protocolOption.volcengine"],
    ["vllm_omni_segmentation", "models.protocolOption.segmentation"],
  ],
  video: [
    ["vllm_omni", "models.protocolOption.videos"],
    ["minimax_video_v2", "models.protocolOption.minimaxVideo"],
    ["volcengine", "models.protocolOption.volcengine"],
    ["vllm_omni_segmentation", "models.protocolOption.segmentation"],
    ["vllm_omni_depth", "models.protocolOption.depth"],
  ],
  audio: [
    ["openai", "models.protocolOption.tts"],
    ["volcengine", "models.protocolOption.volcengineAudio"],
    ["vllm_omni_music", "models.protocolOption.music"],
    ["vllm_omni_score", "models.protocolOption.score"],
  ],
};

const PLACEHOLDERS: Record<ModelKind, [string, string]> = {
  agent: ["http://127.0.0.1:8100/v1", "Qwen/Qwen3-30B-A3B"],
  image: ["http://127.0.0.1:8200/v1", "Tongyi-MAI/Z-Image-Turbo"],
  video: ["http://127.0.0.1:8010/v1", "MiniMaxAI/MiniMax-H3"],
  audio: ["http://127.0.0.1:8220/v1", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"],
  vision: ["http://127.0.0.1:8230/v1", "facebook/sam3"],
};
const MUSIC_PLACEHOLDERS: [string, string] = [
  "http://127.0.0.1:8240/v1",
  "m-a-p/YuE2-3B",
];
const SCORE_PLACEHOLDERS: [string, string] = [
  "http://127.0.0.1:8260/v1",
  "m-a-p/SheetSage2",
];
const DEPTH_PLACEHOLDERS: [string, string] = [
  "http://127.0.0.1:8250/v1",
  "depth-anything/Video-Depth-Anything-Small",
];

export function ModelServiceForm({
  kind,
  existing,
  catalog,
  onClose,
}: {
  kind: SettingsModelKind;
  existing?: ModelConfig;
  catalog: BackendModels;
  onClose: () => void;
}) {
  const t = useT();
  const connectionFieldId = useId();
  const [connection, setConnection] = useState(existing);
  const [presetId, setPresetId] = useState(
    existing
      ? providerPresetFor(existing)
      : kind === "video"
        ? "vllm-omni-video"
        : kind === "image"
          ? "vllm-omni-image"
          : kind === "audio"
            ? "vllm-omni-speech"
            : "custom",
  );
  const [modelOptions, setModelOptions] = useState<
    Record<string, ModelOptions>
  >({});
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [value, setValue] = useState<ModelConfigInput>({
    kind,
    url: existing?.url ?? "",
    modelId: existing?.modelId ?? "",
    apiKey: "",
    connectionType: existing?.connectionType ?? "self_hosted",
    protocol:
      existing && isSegmentationModel(existing)
        ? "vllm_omni_segmentation"
        : (existing?.protocol ?? PROTOCOLS[kind][0][0]),
    authMode: existing?.authMode ?? "none",
    proxyMode: existing ? (existing.proxyMode ?? "system") : "direct",
    videoAdapter: existing?.videoAdapter ?? "auto",
    inputModalities:
      kind === "agent" ? (existing ? existing.inputModalities ?? ["text"] : ["text", "image"]) : undefined,
  });
  const [selectedModels, setSelectedModels] = useState<string[]>(() =>
    existing
      ? catalog.models
          .filter(
            (model) =>
              model.kind === existing.kind &&
              (existing.providerId
                ? model.providerId === existing.providerId
                : model.id === existing.id),
          )
          .map((model) => model.modelId)
      : [],
  );
  const [modelIds, setModelIds] = useState<string[]>(selectedModels);
  const [loaded, setLoaded] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [results, setResults] = useState<Record<string, ModelTestResult>>({});
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(!existing);
  const locked = busy || discovering || testing;
  const segmentation = value.protocol === "vllm_omni_segmentation";
  const depth = value.protocol === "vllm_omni_depth";
  const score = value.protocol === "vllm_omni_score";
  const placeholders =
    value.protocol === "minimax_video_v2"
      ? ["https://api.minimax.cn/v2", "MiniMax-H3"]
      : value.protocol === "vllm_omni_music"
        ? MUSIC_PLACEHOLDERS
        : score
          ? SCORE_PLACEHOLDERS
          : depth
            ? DEPTH_PLACEHOLDERS
            : PLACEHOLDERS[segmentation ? "vision" : kind];
  const hasSavedKey = Boolean(
    connection &&
    connection.authMode === "bearer" &&
    connection.url === value.url.trim(),
  );
  const canFetch = Boolean(
    value.url.trim() &&
    (value.authMode === "none" || value.apiKey.trim() || hasSavedKey),
  );
  const update = (patch: Partial<ModelConfigInput>) => {
    setValue((current) => ({
      ...current,
      ...patch,
      ...(patch.protocol === "minimax_video_v2"
        ? ({
            connectionType: "api",
            authMode: "bearer",
            videoAdapter: "auto",
          } as const)
        : {}),
    }));
    if (
      patch.url !== undefined ||
      patch.apiKey !== undefined ||
      patch.protocol !== undefined ||
      patch.connectionType !== undefined ||
      patch.authMode !== undefined
    ) {
      setModelIds(selectedModels);
      setLoaded(false);
      setDiscoveryError("");
      setResults({});
    }
    if (patch.protocol !== undefined && patch.protocol !== value.protocol) {
      setModelOptions(
        Object.fromEntries(
          selectedModels.map((id) => [
            id,
            { videoAdapter: "auto", videoCapabilities: null },
          ]),
        ),
      );
      setModelErrors({});
    }
    setError("");
  };
  const loadModels = async () => {
    setDiscovering(true);
    setDiscoveryError("");
    try {
      const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
      const presetModels = preset?.modelsByKind?.[kind];
      const models = presetModels
        ? [...presetModels]
        : (await discoverModels(value, connection?.id)).models;
      setModelIds(models);
      if (presetModels && !connection) setSelectedModels(models);
      setLoaded(true);
      setConnectionOpen(false);
    } catch (failure) {
      setDiscoveryError(errorMessage(failure));
    } finally {
      setDiscovering(false);
    }
  };
  const test = async (id: string) => {
    setTesting(true);
    setResults((current) => ({
      ...current,
      [id]: { status: "running", message: t("models.service.testing") },
    }));
    try {
      const result = await testAgentModel(
        { ...value, ...optionsFor(id), modelId: id },
        connection?.id,
      );
      setResults((current) => ({
        ...current,
        [id]: {
          status: "passed",
          message: t("models.service.testPassed", {
            seconds: (result.elapsedMs / 1000).toFixed(2),
          }),
        },
      }));
    } catch (failure) {
      setResults((current) => ({
        ...current,
        [id]: { status: "failed", message: errorMessage(failure) },
      }));
    } finally {
      setTesting(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !selectedModels.length ||
      locked ||
      selectedModels.some((id) => modelErrors[id])
    )
      return;
    setBusy(true);
    setError("");
    try {
      const { inputModalities, videoAdapter, videoCapabilities, ...shared } =
        value;
      await catalog.saveMany(
        shared,
        selectedModels,
        connection?.id,
        Object.fromEntries(
          selectedModels.map((id) => [id, optionsFor(id)]),
        ),
      );
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const chooseProvider = (id: string) => {
    const preset = PROVIDER_PRESETS.find((item) => item.id === id);
    setPresetId(id);
    setConnection(undefined);
    const presetModels = [...(preset?.modelsByKind?.[kind] ?? [])];
    setSelectedModels(presetModels);
    setModelIds(presetModels);
    setModelOptions({});
    setModelErrors({});
    setLoaded(false);
    setResults({});
    setDiscoveryError("");
    setError("");
    setConnectionOpen(id === "custom" || !preset || preset.connectionType === "self_hosted");
    setValue({
      kind,
      modelId: "",
      apiKey: "",
      videoAdapter: "auto",
      url: preset?.url ?? "",
      protocol: preset?.protocol ?? PROTOCOLS[kind][0][0],
      connectionType: preset?.connectionType ?? "self_hosted",
      authMode: preset?.authMode ?? "none",
      proxyMode: "direct",
    });
  };
  const reuseConnection = (model: ModelConfig) => {
    setConnection(model);
    setValue({
      kind,
      url: model.url,
      modelId: model.modelId,
      connectionType: model.connectionType,
      inputModalities: model.inputModalities,
      videoAdapter: model.videoAdapter,
      videoCapabilities: model.videoCapabilities,
      protocol: model.protocol ?? PROTOCOLS[kind][0][0],
      authMode: model.authMode ?? "bearer",
      proxyMode: model.proxyMode ?? "system",
      apiKey: "",
    });
    const peers = catalog.models.filter(
      (item) =>
        item.kind === kind &&
        (model.providerId
          ? item.providerId === model.providerId
          : item.id === model.id),
    );
    setSelectedModels(peers.map((item) => item.modelId));
    setModelIds(peers.map((item) => item.modelId));
    setModelOptions({});
    setModelErrors({});
    setResults({});
    setConnectionOpen(false);
  };
  const connections = matchingConnections(catalog.models, kind, value);
  const savedModel = (id: string) =>
    catalog.models.find(
      (model) =>
        model.modelId === id &&
        connection &&
        (connection.providerId
          ? model.providerId === connection.providerId
          : model.id === connection.id),
    );
  function optionsFor(id: string): ModelOptions {
    if (kind !== "agent") return modelOptions[id] ?? {};
    const saved = savedModel(id);
    return {
      inputModalities: saved ? saved.inputModalities ?? ["text"] : ["text", "image"],
      ...modelOptions[id],
    };
  }
  return (
    <form
      className="cw-model-editor"
      aria-label={existing ? t("models.service.edit") : t("models.service.add")}
      autoComplete="off"
      onSubmit={(event) => void submit(event)}
      onInvalid={() => setConnectionOpen(true)}
    >
      <header className="cw-model-editor-header">
        <button
          type="button"
          className="cw-settings-button cw-settings-button-icon"
          aria-label={t("models.service.back")}
          onClick={onClose}
          disabled={locked}
        >
          <CanvasIcon name="back" size={18} />
        </button>
        <div>
          <h3>{existing ? t("models.service.edit") : t("models.service.add")}</h3>
          <p>
            {(() => {
              const kindSpec = MODEL_KINDS.find((item) => item.id === kind);
              return kindSpec ? t(kindSpec.labelKey) : null;
            })()}
          </p>
        </div>
      </header>
      <div className="cw-model-editor-scroll">
        <ProviderPicker
          kind={kind}
          value={presetId}
          disabled={locked}
          onChange={chooseProvider}
        />
        {!connection && connections.length > 0 && (
          <div className="cw-provider-reuse">
            <span>{t("models.service.existingConnections")}</span>
            {connections.map((model) => (
              <button
                key={model.id}
                type="button"
                className="cw-settings-button"
                onClick={() => reuseConnection(model)}
              >
                {t("models.service.reuseConnection", {
                  model: model.modelId,
                })}
              </button>
            ))}
            <small>{t("models.service.reuseHint")}</small>
          </div>
        )}
        <details
          className="cw-model-connection-details"
          open={connectionOpen}
          onToggle={(event) => setConnectionOpen(event.currentTarget.open)}
        >
          <summary>
            <span>{t("models.service.advancedConnection")}</span>
            <span title={value.url}>
              {connectionOpen
                ? t("models.service.addressAndAuth")
                : value.url || t("models.service.notConfigured")}
            </span>
            <CanvasIcon name="chevron" size={16} />
          </summary>
          <fieldset
            className="cw-model-connection"
            aria-label={t("models.service.connectionInfo")}
            disabled={locked}
          >
            <div className="cw-model-connection-field">
              <label>
                {t("models.service.url")}
                <input
                  type="url"
                  required
                  maxLength={2048}
                  value={value.url}
                  placeholder={placeholders[0]}
                  aria-describedby={`${connectionFieldId}-url-note`}
                  onChange={(event) => update({ url: event.target.value })}
                />
              </label>
              <p className="cw-model-note" id={`${connectionFieldId}-url-note`}>
                {t("models.service.urlNote")}
              </p>
            </div>
            <div className="cw-model-connection-field">
              <label>
                {t("models.service.proxyMode")}
                <select
                  value={value.proxyMode}
                  aria-describedby={`${connectionFieldId}-proxy-note`}
                  onChange={(event) =>
                    update({
                      proxyMode: event.target.value as "system" | "direct",
                    })
                  }
                >
                  <option value="system">
                    {t("models.service.proxySystem")}
                  </option>
                  <option value="direct">
                    {t("models.service.proxyDirect")}
                  </option>
                </select>
              </label>
              <p className="cw-model-note" id={`${connectionFieldId}-proxy-note`}>
                {t("models.service.proxyNote")}
              </p>
            </div>
          </fieldset>
        </details>
        <fieldset
          className="cw-model-connection cw-provider-key"
          disabled={locked}
        >
          <div className="cw-model-key-heading">
            <label htmlFor="service-api-key">API Key</label>
            <label className="cw-model-no-auth">
              <input
                type="checkbox"
                checked={value.authMode === "none"}
                onChange={(event) =>
                  update({
                    authMode: event.target.checked ? "none" : "bearer",
                  })
                }
              />
              {t("models.service.noKey")}
            </label>
          </div>
          <div className="cw-model-key-input">
            <input
              id="service-api-key"
              type={showKey ? "text" : "password"}
              disabled={value.authMode === "none"}
              required={value.authMode === "bearer" && !hasSavedKey}
              maxLength={8192}
              value={value.authMode === "none" ? "" : value.apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                value.authMode === "none"
                  ? t("models.service.noAuthPlaceholder")
                  : hasSavedKey
                    ? t("models.service.savedKeyPlaceholder")
                    : t("models.service.apiKeyPlaceholder")
              }
              onChange={(event) => update({ apiKey: event.target.value })}
            />
            <button
              type="button"
              disabled={value.authMode === "none"}
              aria-label={
                showKey ? t("models.service.hideKey") : t("models.service.showKey")
              }
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? t("models.service.hide") : t("models.service.show")}
            </button>
          </div>
        </fieldset>
        {value.protocol === "minimax_video_v2" && (
          <p className="cw-model-note">{t("models.service.minimaxNote")}</p>
        )}
        <ModelPicker
          modelPlaceholder={placeholders[1]}
          available={modelIds}
          selected={selectedModels}
          loaded={loaded}
          loading={discovering}
          error={discoveryError}
          disabled={locked}
          canFetch={canFetch}
          onFetch={() => void loadModels()}
          onChange={(ids) => {
            setSelectedModels(ids);
            setError("");
          }}
          onTest={kind === "agent" ? (id) => void test(id) : undefined}
          results={results}
          fetchLabel={
            PROVIDER_PRESETS.find((item) => item.id === presetId)?.modelsByKind?.[kind]
              ? t("models.service.loadSupportedModels")
              : undefined
          }
          renderDetails={(id) => (
            <ModelCapabilityCard
              key={`${connection?.id ?? "new"}:${value.protocol}:${id}`}
              modelId={id}
              connection={value}
              configId={connection?.id}
              saved={savedModel(id)}
              options={optionsFor(id)}
              disabled={locked}
              onChange={(patch) =>
                setModelOptions((current) => ({
                  ...current,
                  [id]: { ...current[id], ...patch },
                }))
              }
              onValidity={(message) =>
                setModelErrors((current) => ({ ...current, [id]: message }))
              }
            />
          )}
        />
        {segmentation && (
          <p className="cw-model-note">
            {t("models.service.segmentationNote")}
          </p>
        )}
        {depth && (
          <p className="cw-model-note">{t("models.service.depthNote")}</p>
        )}
        {score && (
          <p className="cw-model-note">{t("models.service.scoreNote")}</p>
        )}
      </div>
      <footer className="cw-model-editor-footer">
        <div className="cw-model-save-status" role={error ? "alert" : "status"}>
          {error ||
            selectedModels.map((id) => modelErrors[id]).find(Boolean) ||
            (selectedModels.length > 200
              ? t("models.service.tooManyModels")
              : selectedModels.length
                ? t("models.service.willEnable", {
                    count: selectedModels.length,
                  })
                : t("models.service.selectAtLeastOne"))}
        </div>
        <button
          className="cw-settings-button"
          type="button"
          disabled={locked}
          onClick={onClose}
        >
          {t("models.service.cancel")}
        </button>
        <button
          className="cw-settings-button cw-settings-button-primary"
          type="submit"
          disabled={
            locked ||
            !canFetch ||
            !selectedModels.length ||
            selectedModels.length > 200 ||
            selectedModels.some((id) => modelErrors[id])
          }
        >
          {busy ? t("models.service.saving") : t("models.service.save")}
        </button>
      </footer>
    </form>
  );
}
