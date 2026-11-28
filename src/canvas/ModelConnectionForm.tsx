import { useId, useState, type FormEvent } from "react";
import { errorMessage } from "../backend/api.ts";
import {
  MODEL_KINDS,
  type BackendModels,
  type ConnectionKind,
  type ConnectionSaveReceipt,
} from "../backend/models.ts";
import type { ModelConfig } from "../backend/rules.ts";
import { useT } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";
import { CanvasIcon } from "./CanvasIcon";

type Protocol = NonNullable<ModelConfig["protocol"]>;
type KindState = {
  enabled: boolean;
  protocol: Protocol;
  models: string[];
  selected: string[];
  error: string;
  fetched: boolean;
};

const KIND_PROTOCOLS: Record<ConnectionKind, readonly Protocol[]> = {
  agent: ["openai"],
  image: ["openai", "volcengine"],
  audio: ["openai", "volcengine"],
  video: ["minimax_video_v2", "kling_video", "bigmodel_video", "higgsfield_open", "vllm_omni"],
};
const PROTOCOL_LABELS: Record<string, MessageKey> = {
  openai: "models.protocolOption.openaiAgent",
  volcengine: "models.protocolOption.volcengine",
  minimax_video_v2: "models.protocolOption.minimaxVideo",
  kling_video: "models.protocolOption.klingVideo",
  bigmodel_video: "models.protocolOption.bigmodelVideo",
  higgsfield_open: "models.protocolOption.higgsfieldOpen",
  vllm_omni: "models.protocolOption.videos",
};

function initialKinds(): Record<ConnectionKind, KindState> {
  const state = {} as Record<ConnectionKind, KindState>;
  for (const { id } of MODEL_KINDS) {
    state[id] = {
      enabled: id === "agent",
      protocol: KIND_PROTOCOLS[id][0],
      models: [],
      selected: [],
      error: "",
      fetched: false,
    };
  }
  return state;
}

/**
 * Adds one connection (address + credential) that carries several modalities.
 * Discovery and saving stay per kind so a modality can fail without discarding
 * the ones that succeeded.
 */
export function ModelConnectionForm({
  catalog,
  onClose,
  onSaved,
}: {
  catalog: BackendModels;
  onClose: () => void;
  onSaved?: (receipt: ConnectionSaveReceipt) => void;
}) {
  const t = useT();
  const fieldId = useId();
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [authMode, setAuthMode] = useState<"none" | "bearer">("bearer");
  const [proxyMode, setProxyMode] = useState<"system" | "direct">("direct");
  const [capabilityAutoCheck, setCapabilityAutoCheck] = useState(true);
  const [kinds, setKinds] = useState(initialKinds);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ConnectionSaveReceipt | null>(null);
  const enabled = (Object.keys(kinds) as ConnectionKind[]).filter((kind) => kinds[kind].enabled);
  const selectedCount = enabled.reduce((total, kind) => total + kinds[kind].selected.length, 0);
  const locked = busy || discovering;
  const update = (kind: ConnectionKind, patch: Partial<KindState>) =>
    setKinds((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }));

  const discover = async () => {
    if (locked || !enabled.length) return;
    setDiscovering(true);
    setDiscoveryError("");
    setError("");
    try {
      const { results } = await catalog.discoverConnectionModels({
        url,
        apiKey: authMode === "none" ? "" : apiKey,
        connectionType: "api",
        authMode,
        proxyMode,
        kinds: enabled.map((kind) => ({ kind, protocol: kinds[kind].protocol })),
      });
      setKinds((current) => {
        const next = { ...current };
        for (const result of results) {
          const state = next[result.kind];
          if (!state) continue;
          next[result.kind] = {
            ...state,
            models: result.models,
            selected: result.error ? [] : result.models.filter((id) => state.selected.includes(id)),
            error: result.error?.message ?? "",
            fetched: !result.error,
          };
        }
        return next;
      });
      if (results.every((result) => result.error)) setDiscoveryError(t("models.connection.discoveryFailed"));
    } catch (failure) {
      setDiscoveryError(errorMessage(failure));
    } finally {
      setDiscovering(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    const entries = enabled
      .filter((kind) => kinds[kind].selected.length)
      .map((kind) => ({ kind, protocol: kinds[kind].protocol, modelIds: kinds[kind].selected }));
    if (!entries.length) {
      setError(t("models.connection.selectAtLeastOne"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await catalog.saveConnection({
        url,
        apiKey: authMode === "none" ? "" : apiKey,
        connectionType: "api",
        authMode,
        proxyMode,
        capabilityAutoCheck,
        providerId: receipt?.providerId,
        entries,
      });
      setReceipt(saved);
      if (!saved.rejected.length) onSaved?.(saved);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="cw-model-editor cw-connection-editor"
      aria-label={t("models.connection.title")}
      autoComplete="off"
      onSubmit={(event) => void submit(event)}
    >
      <header className="cw-model-editor-header">
        <button type="button" className="cw-settings-button cw-settings-button-icon"
          aria-label={t("models.service.back")} onClick={onClose} disabled={locked}>
          <CanvasIcon name="back" size={18} />
        </button>
        <div>
          <h3>{t("models.connection.title")}</h3>
          <p>{t("models.connection.subtitle")}</p>
        </div>
      </header>
      <div className="cw-model-editor-scroll">
        <p className="cw-model-note">{t("models.connection.hint")}</p>
        <fieldset className="cw-model-connection" aria-label={t("models.service.connectionInfo")} disabled={locked}>
          <div className="cw-model-connection-field">
            <label>
              {t("models.service.url")}
              <input type="url" required maxLength={2048} value={url}
                placeholder={t("models.service.urlPlaceholder")}
                onChange={(event) => setUrl(event.target.value)} />
            </label>
          </div>
          <div className="cw-model-connection-field">
            <label>
              {t("models.service.proxyMode")}
              <select value={proxyMode} onChange={(event) => setProxyMode(event.target.value as "system" | "direct")}>
                <option value="system">{t("models.service.proxySystem")}</option>
                <option value="direct">{t("models.service.proxyDirect")}</option>
              </select>
            </label>
          </div>
          <div className="cw-model-connection-field">
            <label>
              <input type="checkbox" checked={capabilityAutoCheck}
                onChange={(event) => setCapabilityAutoCheck(event.target.checked)} />
              {t("availability.autoCheck")}
            </label>
          </div>
        </fieldset>
        <fieldset className="cw-model-connection cw-provider-key" disabled={locked}>
          <div className="cw-model-key-heading">
            <label htmlFor={`${fieldId}-key`}>API Key</label>
            <label className="cw-model-no-auth">
              <input type="checkbox" checked={authMode === "none"}
                onChange={(event) => setAuthMode(event.currentTarget.checked ? "none" : "bearer")} />
              {t("models.service.noKey")}
            </label>
          </div>
          <div className="cw-model-key-input">
            <input id={`${fieldId}-key`} type={showKey ? "text" : "password"}
              disabled={authMode === "none"} required={authMode === "bearer"}
              maxLength={8192} value={authMode === "none" ? "" : apiKey} autoComplete="off" spellCheck={false}
              placeholder={authMode === "none" ? t("models.service.noAuthPlaceholder") : t("models.service.apiKeyPlaceholder")}
              onChange={(event) => setApiKey(event.target.value)} />
            <button type="button" disabled={authMode === "none"}
              aria-label={showKey ? t("models.service.hideKey") : t("models.service.showKey")}
              onClick={() => setShowKey(!showKey)}>
              {showKey ? t("models.service.hide") : t("models.service.show")}
            </button>
          </div>
        </fieldset>
        <fieldset className="cw-connection-kinds" aria-label={t("models.connection.kindsLabel")} disabled={locked}>
          <legend>{t("models.connection.kindsLabel")}</legend>
          {MODEL_KINDS.map((spec) => {
            const state = kinds[spec.id];
            const kindLabel = t(spec.labelKey);
            return (
              <section key={spec.id} className="cw-connection-kind" aria-label={kindLabel}>
                <div className="cw-connection-kind-top">
                  <label className="cw-connection-kind-toggle">
                    <input type="checkbox" checked={state.enabled}
                      onChange={(event) => update(spec.id, { enabled: event.currentTarget.checked })} />
                    <strong>{kindLabel}</strong>
                  </label>
                  {state.enabled && (
                    <label className="cw-connection-kind-protocol">
                      {t("models.connection.protocol")}
                      <select value={state.protocol}
                        onChange={(event) => update(spec.id, { protocol: event.currentTarget.value as Protocol, models: [], selected: [], fetched: false, error: "" })}>
                        {KIND_PROTOCOLS[spec.id].map((protocol) => (
                          <option key={protocol} value={protocol}>{t(PROTOCOL_LABELS[protocol] ?? "models.protocolOption.openaiAgent")}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {state.enabled && state.fetched && (
                    <span className="cw-connection-kind-count">
                      {t("models.connection.kindSelected", { count: state.selected.length })}
                    </span>
                  )}
                </div>
                {state.enabled && state.error && <p className="cw-model-feedback" role="alert">{state.error}</p>}
                {state.enabled && state.models.length > 0 && (
                  <div className="cw-connection-kind-models" role="group" aria-label={t("models.connection.modelsFor", { kind: kindLabel })}>
                    {state.models.map((id) => (
                      <label key={id} className="cw-connection-model">
                        <input type="checkbox" checked={state.selected.includes(id)}
                          onChange={(event) => update(spec.id, {
                            selected: event.currentTarget.checked
                              ? [...state.selected, id]
                              : state.selected.filter((item) => item !== id),
                          })} />
                        {id}
                      </label>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </fieldset>
        {discoveryError && <p className="cw-model-feedback" role="alert">{discoveryError}</p>}
        {receipt && (
          <div className="cw-connection-receipt" role="status">
            <p>{t("models.connection.savedKinds", { count: receipt.saved.length })}</p>
            {receipt.rejected.length > 0 && (
              <ul>
                {receipt.rejected.map((item) => (
                  <li key={item.kind}>{t("models.connection.rejected", {
                    kind: t(MODEL_KINDS.find((spec) => spec.id === item.kind)?.labelKey ?? "models.category.agent"),
                    message: item.message,
                  })}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <footer className="cw-model-editor-footer">
        <p className="cw-model-note" role="status">
          {selectedCount
            ? t("models.service.willEnable", { count: selectedCount })
            : t("models.connection.selectAtLeastOne")}
        </p>
        <button type="button" className="cw-settings-button" disabled={locked} onClick={onClose}>
          {t("models.service.cancel")}
        </button>
        <button type="button" className="cw-settings-button" disabled={locked || !enabled.length}
          onClick={() => void discover()}>
          {t("models.connection.discover")}
        </button>
        <button type="submit" className="cw-settings-button cw-settings-button-primary"
          disabled={locked || selectedCount === 0}>
          {receipt?.rejected.length ? t("models.connection.retryFailed") : t("models.connection.save")}
        </button>
        {error && <p className="cw-model-feedback" role="alert">{error}</p>}
      </footer>
    </form>
  );
}
