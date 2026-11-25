import { ModelLogo } from "./ModelLogo";
import { useId, useState, type ReactNode } from "react";
import { CanvasIcon } from "./CanvasIcon";
import { useT } from "../i18n/I18nProvider.tsx";

export interface ModelTestResult {
  status: "running" | "passed" | "failed";
  message: string;
}

export function ModelPicker({
  modelPlaceholder,
  available,
  selected,
  loaded,
  loading,
  loadsPreset,
  error,
  disabled,
  canFetch,
  onFetch,
  onChange,
  onTest,
  results,
  renderDetails,
}: {
  modelPlaceholder: string;
  available: string[];
  selected: string[];
  loaded: boolean;
  loading: boolean;
  loadsPreset: boolean;
  error: string;
  disabled: boolean;
  canFetch: boolean;
  onFetch: () => void;
  onChange: (ids: string[]) => void;
  onTest?: (id: string) => void;
  results: Record<string, ModelTestResult>;
  renderDetails?: (id: string) => ReactNode;
}) {
  const t = useT();
  const manualFieldId = useId();
  const [manualOpen, setManualOpen] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [manualId, setManualId] = useState("");
  const [manualModels, setManualModels] = useState<string[]>([]);
  const [manualError, setManualError] = useState("");
  // Fetching already selects every model a new service returns, so the list
  // needs no search box and no bulk selection row: the checkboxes are the
  // selection, and a saved service keeps the subset the user chose.
  const ids = [...new Set([...available, ...manualModels, ...selected])];
  const fetchLabel = loadsPreset
    ? "models.service.loadSupportedModels"
    : loaded ? "generation.picker.refresh" : "generation.picker.fetch";
  let status = "";
  if (loading) {
    status = t("generation.picker.fetching");
  } else if (loaded && !error) {
    status = available.length
      ? t(
          loadsPreset
            ? "generation.picker.loadedPreset"
            : "generation.picker.fetched",
          { count: available.length },
        )
      : t("generation.picker.noReturned");
  }
  const addManual = () => {
    const id = manualId.trim();
    if (!id || id.length > 200 || /[\x00-\x1f]/.test(id)) {
      setManualError(t("generation.picker.invalidId"));
      return;
    }
    if (selected.includes(id)) {
      setManualError(t("generation.picker.duplicate"));
      return;
    }
    setManualModels((current) => [...new Set([...current, id])]);
    onChange([...selected, id]);
    setManualId("");
    setManualError("");
    setManualOpen(false);
  };
  return (
    <section
      className={`cw-model-picker${renderDetails ? " has-capability-cards" : ""}`}
      aria-label={t("generation.picker.label")}
    >
      <div className="cw-model-picker-heading">
        <div className="cw-model-picker-title">
          <h4>{t("generation.picker.heading")}</h4>
          <div className="cw-model-picker-status" role="status">
            {status && <span>{status}</span>}
          </div>
        </div>
        <div className="cw-model-picker-actions">
          <button
            type="button"
            className="cw-settings-button cw-settings-button-quiet"
            disabled={disabled}
            aria-expanded={manualOpen}
            onClick={() => {
              setManualOpen(!manualOpen);
              setManualError("");
            }}
          >
            <CanvasIcon name="plus" size={14} />
            {t("generation.picker.manual")}
          </button>
          <button
            type="button"
            className="cw-settings-button"
            disabled={disabled}
            onClick={onFetch}
          >
            {t(loading ? "generation.picker.loading" : fetchLabel)}
          </button>
        </div>
      </div>
      {error && (
        <p className="cw-model-feedback" role="alert">
          {error}
        </p>
      )}
      {manualOpen && (
        <div className="cw-model-manual">
          <label htmlFor={manualFieldId}>
            {t("generation.picker.modelId")}
          </label>
          <div>
            <input
              id={manualFieldId}
              autoFocus
              value={manualId}
              maxLength={200}
              placeholder={modelPlaceholder}
              disabled={disabled}
              onChange={(event) => {
                setManualId(event.target.value);
                setManualError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addManual();
                }
              }}
            />
            <button
              className="cw-settings-button"
              type="button"
              disabled={disabled || !manualId.trim()}
              onClick={addManual}
            >
              {t("generation.picker.add")}
            </button>
            <button
              className="cw-settings-button cw-settings-button-quiet"
              type="button"
              onClick={() => setManualOpen(false)}
            >
              {t("generation.picker.cancel")}
            </button>
          </div>
          {manualError && (
            <p className="cw-model-feedback" role="alert">
              {manualError}
            </p>
          )}
        </div>
      )}
      <div className="cw-model-options" aria-busy={loading}>
        {loading && !ids.length ? (
          <div className="cw-model-empty-state">
            <span className="cw-model-spinner" />
            <p>{t("generation.picker.connecting")}</p>
          </div>
        ) : !ids.length ? (
          <div className="cw-model-empty-state">
            <CanvasIcon name="model" size={26} />
            {!loaded && <strong>{t("generation.picker.noneAdded")}</strong>}
            <p>
              {loaded
                ? t("generation.picker.manualHint")
                : t("generation.picker.fetchHint")}
            </p>
          </div>
        ) : (
          ids.map((id) => {
            const isSelected = selected.includes(id);
            // Per-model details stay collapsed so every row keeps one line and
            // the list shows as many models as possible. A saved row keeps its
            // own open state while the user edits its capabilities.
            const details = isSelected && renderDetails ? renderDetails : null;
            const open = expanded.includes(id);
            return (
            <div
              key={id}
              className="cw-model-option"
              data-selected={isSelected}
            >
              <label>
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, id]
                        : selected.filter((item) => item !== id),
                    )
                  }
                />
                <ModelLogo modelId={id} />
                <span title={id}>{id}</span>
              </label>
              {onTest && (
                <button
                  type="button"
                  className="cw-settings-button cw-settings-button-quiet cw-model-row-test"
                  disabled={disabled || !canFetch}
                  aria-busy={results[id]?.status === "running" || undefined}
                  aria-label={t("generation.picker.testAria", { id })}
                  onClick={() => onTest(id)}
                >
                  <span key={results[id]?.status ?? "idle"} className="cw-model-row-result">
                    {results[id]?.status === "running"
                      ? t("generation.picker.testing")
                      : results[id]?.status === "passed"
                        ? results[id].message
                        : t("generation.picker.test")}
                  </span>
                </button>
              )}
              {details && (
                <button
                  type="button"
                  className="cw-settings-button cw-settings-button-quiet cw-model-row-toggle"
                  aria-expanded={open}
                  aria-label={t(
                    open
                      ? "generation.picker.hideDetails"
                      : "generation.picker.showDetails",
                    { id },
                  )}
                  disabled={disabled}
                  onClick={() =>
                    setExpanded((current) =>
                      current.includes(id)
                        ? current.filter((item) => item !== id)
                        : [...current, id],
                    )
                  }
                >
                  <CanvasIcon name={open ? "chevronDown" : "chevronRight"} size={14} />
                </button>
              )}
              {details && open && (
                <div className="cw-model-option-details">{details(id)}</div>
              )}
              {results[id]?.status === "failed" && (
                <p className="cw-model-feedback" role="alert">
                  {results[id].message}
                </p>
              )}
            </div>
            );
          })
        )}
      </div>
      {onTest && ids.length > 0 && (
        <p className="cw-model-note">
          {t("generation.picker.testNote")}
        </p>
      )}
    </section>
  );
}
