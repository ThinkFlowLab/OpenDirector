import { useState, type FormEvent } from "react";
import { errorMessage } from "../backend/api.ts";
import {
  MODEL_KINDS,
  discoverModels,
  readModelCapabilities,
  testAgentModel,
  type BackendModels,
  type ModelConfigInput,
} from "../backend/models.ts";
import {
  isSegmentationModel,
  type ModelConfig,
  type ModelKind,
} from "../backend/rules.ts";
import { createVideoCapabilities } from "../backend/videoCapabilities.ts";
import {
  VideoCapabilitiesEditor,
  capabilityDraft,
} from "./VideoCapabilitiesEditor";
import { CanvasIcon } from "./CanvasIcon";
import { ModelPicker, type ModelTestResult } from "./ModelPicker";

export type SettingsModelKind = Exclude<ModelKind, "vision">;
const PROTOCOLS: Record<
  SettingsModelKind,
  readonly [ModelConfigInput["protocol"], string][]
> = {
  agent: [["openai", "OpenAI 兼容接口（含 vLLM）"]],
  image: [
    ["openai", "OpenAI 兼容接口（含 vLLM-Omni Z-Image-Turbo）"],
    ["volcengine", "火山方舟 / Agent Plan"],
    ["vllm_omni_segmentation", "vLLM-Omni 分割接口（SAM 3）"],
  ],
  video: [
    ["vllm_omni", "异步 /videos 接口（含 vLLM-Omni）"],
    ["volcengine", "火山方舟 / Agent Plan"],
    ["vllm_omni_segmentation", "vLLM-Omni 分割接口（SAM 3）"],
  ],
  audio: [
    ["openai", "OpenAI 兼容语音合成（含 vLLM-Omni TTS）"],
    ["volcengine", "火山引擎语音 / Agent Plan"],
    ["vllm_omni_music", "vLLM-Omni 音乐生成（MiniMax Music 3、YuE2）"],
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
    videoAdapter: existing?.videoAdapter ?? "auto",
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
  const [outputDraft, setOutputDraft] = useState(() =>
    capabilityDraft(
      existing?.videoCapabilities ?? existing?.inputRules.videoCapabilities,
      Boolean(existing?.videoCapabilities),
    ),
  );
  const [connectionOpen, setConnectionOpen] = useState(!existing);
  const locked = busy || discovering || testing;
  const segmentation = value.protocol === "vllm_omni_segmentation";
  const placeholders =
    value.protocol === "vllm_omni_music"
      ? MUSIC_PLACEHOLDERS
      : PLACEHOLDERS[segmentation ? "vision" : kind];
  const hasSavedKey = Boolean(
    existing &&
    existing.authMode === "bearer" &&
    existing.url === value.url.trim(),
  );
  const canFetch = Boolean(
    value.url.trim() &&
    (value.authMode === "none" || value.apiKey.trim() || hasSavedKey),
  );
  const update = (patch: Partial<ModelConfigInput>) => {
    setValue((current) => ({ ...current, ...patch }));
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
    setError("");
  };
  const loadModels = async () => {
    setDiscovering(true);
    setDiscoveryError("");
    try {
      const result = await discoverModels(value, existing?.id);
      setModelIds(result.models);
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
      [id]: { status: "running", message: "测试中…" },
    }));
    try {
      const result = await testAgentModel(
        { ...value, modelId: id },
        existing?.id,
      );
      setResults((current) => ({
        ...current,
        [id]: {
          status: "passed",
          message: `通过 ${(result.elapsedMs / 1000).toFixed(2)} s`,
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
    if (!selectedModels.length || locked) return;
    setBusy(true);
    setError("");
    try {
      const videoCapabilities =
        kind === "video" && !segmentation && outputDraft.custom
          ? createVideoCapabilities(
              outputDraft.outputs,
              outputDraft.defaultResolution,
              Number(outputDraft.defaultDuration),
              outputDraft.dimensionStep,
              value.videoAdapter,
            )
          : null;
      await catalog.saveMany(
        { ...value, videoCapabilities },
        selectedModels,
        existing?.id,
      );
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const loadCapabilities = async (source: "preset" | "service") => {
    setBusy(true);
    setError("");
    try {
      const result = await readModelCapabilities(
        { ...value, modelId: selectedModels[0] ?? "" },
        existing?.id,
        source,
      );
      if (!result.videoCapabilities)
        throw new Error("未识别到输出预设，请开启自定义输出规格并填写。");
      setOutputDraft(
        capabilityDraft(result.videoCapabilities, source === "service"),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="cw-model-editor"
      aria-label={existing ? "编辑服务" : "添加服务"}
      autoComplete="off"
      onSubmit={(event) => void submit(event)}
      onInvalid={() => setConnectionOpen(true)}
    >
      <header className="cw-model-editor-header">
        <button
          type="button"
          className="cw-settings-button cw-settings-button-icon"
          aria-label="返回服务列表"
          onClick={onClose}
          disabled={locked}
        >
          <CanvasIcon name="back" size={18} />
        </button>
        <div>
          <h3>{existing ? "编辑服务" : "添加服务"}</h3>
          <p>{MODEL_KINDS.find((item) => item.id === kind)?.label}</p>
        </div>
      </header>
      <div className="cw-model-editor-scroll">
        <details
          className="cw-model-connection-details"
          open={connectionOpen}
          onToggle={(event) => setConnectionOpen(event.currentTarget.open)}
        >
          <summary>
            <span>连接设置</span>
            <span title={value.url}>
              {connectionOpen ? "地址与鉴权" : value.url || "尚未配置"}
            </span>
            <CanvasIcon name="chevron" size={16} />
          </summary>
          <fieldset
            className="cw-model-connection"
            aria-label="连接信息"
            disabled={locked}
          >
            <div className="cw-model-connection-grid">
              <label>
                接口协议
                <select
                  value={value.protocol}
                  onChange={(event) =>
                    update({
                      protocol: event.target
                        .value as ModelConfigInput["protocol"],
                      videoAdapter: "auto",
                    })
                  }
                >
                  {PROTOCOLS[kind].map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                接入方式
                <select
                  value={value.connectionType}
                  onChange={(event) => {
                    const connectionType = event.target
                      .value as ModelConfigInput["connectionType"];
                    update({
                      connectionType,
                      authMode:
                        connectionType === "self_hosted" ? "none" : "bearer",
                    });
                  }}
                >
                  <option value="self_hosted">
                    自部署服务（vLLM / vLLM-Omni）
                  </option>
                  <option value="api">服务商 API</option>
                </select>
              </label>
            </div>
            <label>
              服务地址（Base URL）
              <input
                type="url"
                required
                maxLength={2048}
                value={value.url}
                placeholder={placeholders[0]}
                onChange={(event) => update({ url: event.target.value })}
              />
            </label>
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
                无需密钥
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
                    ? "此服务无需鉴权"
                    : hasSavedKey
                      ? "已保存密钥，留空保持不变"
                      : "输入服务提供的 API Key"
                }
                onChange={(event) => update({ apiKey: event.target.value })}
              />
              <button
                type="button"
                disabled={value.authMode === "none"}
                aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
            <p className="cw-model-note">
              自部署服务通常填写 /v1 地址；通过 SSH 隧道连接时填写本地转发地址。
            </p>
          </fieldset>
        </details>
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
        />
        {segmentation && (
          <p className="cw-model-note">
            分割模型用于选区、图层拆分和抠像，不参与图片或视频生成。
          </p>
        )}
        {kind === "video" && !segmentation && (
          <details className="cw-video-config">
            <summary>
              <span>视频适配方式</span>
              <CanvasIcon name="chevron" size={16} />
            </summary>
            {value.protocol === "vllm_omni" && (
              <label className="cw-domain-field">
                视频适配方式
                <select
                  value={value.videoAdapter}
                  onChange={(event) =>
                    update({
                      videoAdapter: event.target
                        .value as ModelConfigInput["videoAdapter"],
                    })
                  }
                >
                  <option value="auto">
                    自动识别已知模型；其他使用通用首帧接口
                  </option>
                  <option value="fasth3">
                    FastH3-Omni（8 步、多素材参考）
                  </option>
                  <option value="minimax_h3">
                    原生 MiniMax-H3（首帧、素材参考、接续）
                  </option>
                  <option value="standard">
                    通用 /videos（文本、单张首帧）
                  </option>
                </select>
              </label>
            )}
            <div className="cw-capability-actions">
              <button
                type="button"
                className="cw-settings-button"
                onClick={() => void loadCapabilities("preset")}
              >
                载入适配预设
              </button>
              <button
                type="button"
                className="cw-settings-button"
                onClick={() => void loadCapabilities("service")}
              >
                读取服务声明
              </button>
            </div>
            <p className="cw-capability-help">
              服务需在 /models 中返回该模型的 videoCapabilities
              扩展；仅返回模型名称时，请手动配置。
            </p>
            <VideoCapabilitiesEditor
              value={outputDraft}
              adapter={value.videoAdapter}
              onChange={setOutputDraft}
            />
          </details>
        )}
      </div>
      <footer className="cw-model-editor-footer">
        <div className="cw-model-save-status" role={error ? "alert" : "status"}>
          {error ||
            (selectedModels.length > 200
              ? "每个服务最多启用 200 个模型"
              : selectedModels.length
                ? `将启用 ${selectedModels.length} 个模型`
                : "请选择至少一个模型")}
        </div>
        <button
          className="cw-settings-button"
          type="button"
          disabled={locked}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className="cw-settings-button cw-settings-button-primary"
          type="submit"
          disabled={
            locked ||
            !canFetch ||
            !selectedModels.length ||
            selectedModels.length > 200
          }
        >
          {busy ? "保存中…" : "保存服务"}
        </button>
      </footer>
    </form>
  );
}
