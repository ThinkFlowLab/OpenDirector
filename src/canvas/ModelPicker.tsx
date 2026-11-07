import { ModelLogo } from "./ModelLogo";
import { useState, type ReactNode } from "react";
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
  error,
  disabled,
  canFetch,
  onFetch,
  onChange,
  onTest,
  results,
  renderDetails,
  fetchLabel,
}: {
  modelPlaceholder: string;
  available: string[];
  selected: string[];
  loaded: boolean;
  loading: boolean;
  error: string;
  disabled: boolean;
  canFetch: boolean;
  onFetch: () => void;
  onChange: (ids: string[]) => void;
  onTest?: (id: string) => void;
  results: Record<string, ModelTestResult>;
  renderDetails?: (id: string) => ReactNode;
  fetchLabel?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualModels, setManualModels] = useState<string[]>([]);
  const [manualError, setManualError] = useState("");
  const ids = [...new Set([...available, ...manualModels, ...selected])];
  const visible = ids.filter(
    (id) =>
      (!onlySelected || selected.includes(id)) &&
      id.toLowerCase().includes(query.toLowerCase().trim()),
  );
  const allSelected =
    visible.length > 0 && visible.every((id) => selected.includes(id));
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
    setQuery("");
  };
  return (
    <section
      className={`cw-model-picker${renderDetails ? " has-capability-cards" : ""}`}
      aria-label={t("generation.picker.label")}
    >
      <div className="cw-model-picker-heading">
        <div>
          <h4>{t("generation.picker.heading")}</h4>
          <span>
            {t("generation.picker.selectedCount", { count: selected.length })}
          </span>
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
            disabled={disabled || !canFetch}
            onClick={onFetch}
          >
            {loading
              ? t("generation.picker.loading")
              : (fetchLabel ??
                (loaded
                  ? t("generation.picker.refresh")
                  : t("generation.picker.fetch")))}
          </button>
        </div>
      </div>
      {manualOpen && (
        <div className="cw-model-manual">
          <label htmlFor="manual-model-id">
            {t("generation.picker.modelId")}
          </label>
          <div>
            <input
              id="manual-model-id"
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
      {error && (
        <p className="cw-model-feedback" role="alert">
          {t("generation.picker.retry", { error })}
        </p>
      )}
      {ids.length > 4 && (
        <>
          <div className="cw-model-filterbar">
            <label className="cw-model-search">
              <CanvasIcon name="search" size={15} />
              <input
                aria-label={t("generation.picker.search")}
                placeholder={t("generation.picker.searchPlaceholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="cw-settings-button cw-model-filter"
              aria-pressed={onlySelected}
              onClick={() => setOnlySelected(!onlySelected)}
            >
              {t("generation.picker.onlySelected")}
            </button>
          </div>
          <div className="cw-model-bulk">
            <span>
              {t("generation.picker.count", { count: visible.length })}
            </span>
            <button
              type="button"
              className="cw-settings-button cw-settings-button-quiet"
              disabled={disabled || !visible.length}
              onClick={() =>
                onChange(
                  allSelected
                    ? selected.filter((id) => !visible.includes(id))
                    : [...new Set([...selected, ...visible])],
                )
              }
            >
              {allSelected ? t("generation.picker.deselectAll") : t("generation.picker.selectAll")}
            </button>
          </div>
        </>
      )}
      <div className="cw-model-options" aria-busy={loading}>
        {loading && !ids.length ? (
          <div className="cw-model-empty-state" role="status">
            <span className="cw-model-spinner" />
            <strong>{t("generation.picker.fetching")}</strong>
            <p>{t("generation.picker.connecting")}</p>
          </div>
        ) : !ids.length ? (
          <div className="cw-model-empty-state">
            <CanvasIcon name="model" size={26} />
            <strong>{loaded ? t("generation.picker.noReturned") : t("generation.picker.noneAdded")}</strong>
            <p>
              {loaded
                ? t("generation.picker.manualHint")
                : t("generation.picker.fetchHint")}
            </p>
          </div>
        ) : !visible.length ? (
          <div className="cw-model-empty-state">
            <strong>
              {onlySelected && !selected.length
                ? t("generation.picker.noSelection")
                : t("generation.picker.noMatch")}
            </strong>
            <button
              className="cw-settings-button cw-settings-button-quiet"
              type="button"
              onClick={() => {
                setQuery("");
                setOnlySelected(false);
              }}
            >
              {t("generation.picker.showAll")}
            </button>
          </div>
        ) : (
          visible.map((id) => (
            <div
              key={id}
              className="cw-model-option"
              data-selected={selected.includes(id)}
            >
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(id)}
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
                  aria-label={t("generation.picker.testAria", { id })}
                  onClick={() => onTest(id)}
                >
                  {results[id]?.status === "running"
                    ? t("generation.picker.testing")
                    : results[id]?.status === "passed"
                      ? results[id].message
                      : t("generation.picker.test")}
                </button>
              )}
              {selected.includes(id) && renderDetails?.(id)}
              {results[id]?.status === "failed" && (
                <p className="cw-model-feedback" role="alert">
                  {results[id].message}
                </p>
              )}
            </div>
          ))
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
