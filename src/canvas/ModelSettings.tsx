import { ModelSetup, modelSetupMissing, type SetupKind } from "./ModelSetup";
import { ModelLogo } from "./ModelLogo";
import { isBigModelConnection, providerLabel } from "./providerPresets";
import { useState } from "react";
import { errorMessage } from "../backend/api.ts";
import { MODEL_KINDS, type BackendModels } from "../backend/models.ts";
import type { ModelConfig } from "../backend/rules.ts";
import { useT } from "../i18n/I18nProvider";
import { ModelServiceForm, type SettingsModelKind } from "./ModelServiceForm";
import { CanvasIcon } from "./CanvasIcon";
import "./model-settings.css";

export function ModelSettings({ catalog, onClose, guided = false }: { catalog: BackendModels; onClose: () => void; guided?: boolean }) {
  const t = useT();
  const [category, setCategory] = useState<SettingsModelKind | null>(null);
  const [editing, setEditing] = useState<{
    kind: SettingsModelKind;
    model?: ModelConfig;
  } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await catalog.removeService(id);
      setDeleting(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const models = catalog.models.filter(
    (model) =>
      model.kind === category ||
      ((category === "image" || category === "video") &&
        model.kind === "vision"),
  );
  const services = models.filter(
    (model, index) =>
      !model.providerId ||
      models.findIndex((item) => item.providerId === model.providerId) ===
        index,
  );
  const [skipped, setSkipped] = useState<SetupKind[]>([]);
  const missing = modelSetupMissing(catalog.models);
  const pending = missing.filter(kind => !skipped.includes(kind));
  function skipItem(kind: SetupKind) {
    setSkipped(current => current.includes(kind) ? current : [...current, kind]);
    const next = pending.find(item => item !== kind);
    if (!next) { onClose(); return; }
    setEditing(null);
    setCategory(next ?? null);
    setDeleting(null);
    setError("");
  }
  const currentMissing = category !== null && missing.includes(category);
  if (category === null) return <div className="cw-model-settings">
    <ModelSetup catalog={catalog} onClose={onClose} onConfigure={setCategory} skipped={skipped} onSkipItem={guided ? skipItem : undefined} />
  </div>;
  return (
    <div className="cw-model-settings">
      {guided && <div className="cw-model-guide-progress" role="status">
        <span>{t("modelSetup.count", { count: 4 - missing.length, total: 4 })}</span>
        <p>{t(editing ? "modelSetup.guideSave" : currentMissing ? "modelSetup.guideAdd" : "modelSetup.guideNext")}</p>
      </div>}
      {!catalog.connected && (
        <div className="cw-settings-notice" role="alert">
          <span>{catalog.error || t("models.readFailed")}</span>
          <button
            className="cw-settings-button"
            onClick={() => void catalog.refresh()}
          >
            {t("models.reload")}
          </button>
        </div>
      )}
      {catalog.connected &&
        (editing ? (
          <ModelServiceForm
            key={editing.model?.id ?? editing.kind}
            kind={editing.kind}
            existing={editing.model}
            catalog={catalog}
            onClose={() => setEditing(null)}
          />
        ) : (
          <>
            <nav
              className="cw-model-categories"
              aria-label={t("models.categories")}
            >
              <button type="button" onClick={() => setCategory(null)}>{t("modelSetup.overview")}</button>
              {MODEL_KINDS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={category === item.id}
                  onClick={() => {
                    setCategory(item.id);
                    setDeleting(null);
                    setError("");
                  }}
                >
                  {t(item.shortLabelKey)}
                </button>
              ))}
            </nav>
            <div className="cw-model-overview-heading">
              <div>
                <h3>
                  {t("models.services.heading")} <span>{services.length}</span>
                </h3>
                <p>{t("models.services.hint")}</p>
              </div>
              {services.length > 0 && (
                <button
                  className="cw-settings-button cw-settings-button-primary"
                  onClick={() => setEditing({ kind: category })}
                >
                  <CanvasIcon name="plus" size={15} />
                  {t("models.services.add")}
                </button>
              )}
            </div>
            {error && (
              <p className="cw-model-feedback" role="alert">
                {error}
              </p>
            )}
            <div className="cw-model-service-list">
              {!services.length && (
                <div className="cw-model-empty-state">
                  <CanvasIcon name="connections" size={30} />
                  <strong>{t("models.services.empty")}</strong>
                  <p>{t("models.services.support")}</p>
                  <button
                    className="cw-settings-button"
                    onClick={() => setEditing({ kind: category })}
                  >
                    {t("models.services.add")}
                  </button>
                </div>
              )}
              {services.map((model) => {
                const members = model.providerId
                  ? models.filter(
                      (item) => item.providerId === model.providerId,
                    )
                  : [model];
                return (
                  <article className="cw-model-service" key={model.id}>
                    <div className="cw-model-service-top">
                      <span className="cw-model-service-icon">
                        <CanvasIcon name="connections" size={20} />
                      </span>
                      <div className="cw-model-service-name">
                        <h4>{new URL(model.url).host}</h4>
                        <p title={model.url}>{model.url}</p>
                      </div>
                      <button
                        type="button"
                        className="cw-settings-button"
                        disabled={busy}
                        onClick={() => setEditing({ kind: category, model })}
                      >
                        {t("models.services.manage")}
                      </button>
                    </div>
                    <div className="cw-model-service-models">
                      <span>
                        {t("models.services.count", { count: members.length })}
                      </span>
                      {members.slice(0, 3).map((item) => (
                        <span
                          className="cw-model-chip"
                          title={item.modelId}
                          key={item.id}
                        >
                          <ModelLogo modelId={item.modelId} />
                          {item.modelId}
                        </span>
                      ))}
                      {members.length > 3 && <span>+{members.length - 3}</span>}
                    </div>
                    <div className="cw-model-service-bottom">
                      <span>
                        {providerLabel(model)}
                        {isBigModelConnection(model) && ` · ${(model.providerId ?? model.id).slice(0, 8)}`}{" "}
                        ·{" "}
                        {model.authMode === "none"
                          ? t("models.service.noKey")
                          : t("models.service.keyConfigured")}
                      </span>
                      <button
                        type="button"
                        className="cw-settings-button cw-settings-button-quiet"
                        disabled={busy}
                        onClick={() => setDeleting(model.id)}
                      >
                        {t("models.services.remove")}
                      </button>
                    </div>
                    {deleting === model.id && (
                      <div className="cw-model-delete-confirm" role="alert">
                        <span>
                          {t("models.services.removeConfirm", {
                            count: members.length,
                          })}
                        </span>
                        <button
                          className="cw-settings-button cw-settings-button-quiet"
                          disabled={busy}
                          onClick={() => setDeleting(null)}
                        >
                          {t("models.cancel")}
                        </button>
                        <button
                          className="cw-settings-button"
                          disabled={busy}
                          onClick={() => void remove(model.id)}
                        >
                          {busy
                            ? t("models.services.removing")
                            : t("models.services.confirmRemove")}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        ))}
      {guided && !editing && <footer className="cw-model-guide-footer">
        {currentMissing && <button className="cw-settings-button cw-settings-button-quiet" onClick={() => skipItem(category)}>{t("modelSetup.skipItem")}</button>}
        <button className="cw-settings-button cw-settings-button-primary" disabled={!catalog.connected} onClick={() => {
          if (currentMissing) setEditing({ kind: category });
          else if (pending[0]) { setCategory(pending[0]); setDeleting(null); setError(""); }
          else onClose();
        }}>{currentMissing ? t("models.services.add") : pending[0] ? t("modelSetup.nextModel", { model: t(`modelSetup.${pending[0]}`) }) : t("modelSetup.done")}</button>
      </footer>}
    </div>
  );
}
