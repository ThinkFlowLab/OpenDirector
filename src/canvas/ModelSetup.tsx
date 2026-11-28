import type { BackendModels } from "../backend/models";
import { isGenerationModel, type ModelConfig } from "../backend/rules";
import { useI18n } from "../i18n/I18nProvider";
import { CanvasIcon } from "./CanvasIcon";
import "./model-setup.css";

const kinds = ["agent", "image", "video", "audio"] as const;
type SetupKind = typeof kinds[number];
const preference = "opendirector.modelSetup.v1";
let dismissed = false;
export function dismissModelSetup() {
  dismissed = true;
  try { localStorage.setItem(preference, "dismissed"); } catch { /* Session fallback. */ }
}
export function shouldShowModelSetup() {
  if (dismissed) return false;
  try { return !localStorage.getItem(preference); } catch { return true; }
}
function modelSetupMissing(models: ModelConfig[]) {
  return kinds.filter(kind => !models.some(model => model.kind === kind && isGenerationModel(model)));
}

export function ModelSetup({ catalog, onClose, onConfigure }: {
  catalog: BackendModels;
  onClose: () => void;
  onConfigure: (kind: SetupKind) => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const missing = modelSetupMissing(catalog.models);
  const next = missing[0];
  return <div className="cw-model-setup">
    <div className="cw-model-setup-language">
      <label htmlFor="model-setup-language">{t("modelSetup.language")}</label>
      <select id="model-setup-language" value={locale} onChange={event => setLocale(event.target.value as "zh-CN" | "en-US")}>
        <option value="zh-CN">{t("common.chinese")}</option><option value="en-US">{t("common.english")}</option>
      </select>
    </div>
    <div className="cw-model-setup-intro">
      <p>{t("modelSetup.hint")}</p>
    </div>
    {catalog.loading ? <p role="status">{t("modelSetup.loading")}</p> : !catalog.connected ?
      <div className="cw-settings-notice" role="alert"><span>{catalog.error || t("modelSetup.failed")}</span>
        <button className="cw-settings-button" onClick={() => void catalog.refresh()}>{t("modelSetup.retry")}</button>
      </div> : <>
      <p className="cw-model-setup-progress" role="status">{t("modelSetup.count", { count: kinds.length - missing.length, total: kinds.length })}</p>
      <div className="cw-model-setup-list">{kinds.map(kind => {
        const configured = !missing.includes(kind);
        return <div className="cw-model-setup-row" key={kind}>
          <span className="cw-model-setup-icon"><CanvasIcon name={kind === "agent" ? "model" : kind === "image" ? "image" : kind === "audio" ? "audio" : "video"} size={20} /></span>
          <div className="cw-model-setup-copy"><strong>{t(`modelSetup.${kind}`)}</strong><p>{t(`modelSetup.${kind}Hint`)}</p></div>
          <span className={`cw-model-setup-status${configured ? " is-configured" : ""}`}>{configured && <span aria-hidden="true">✓ </span>}{t(configured ? "modelSetup.configured" : "modelSetup.missing")}</span>
          <button className="cw-settings-button" onClick={() => onConfigure(kind)}>{t(configured ? "modelSetup.manage" : "modelSetup.configure")}</button>
        </div>;
      })}</div>

    </>}
    <footer className="cw-model-setup-footer">
      <p>{t("modelSetup.external")}</p>
      <div>
        <button className="cw-settings-button cw-settings-button-primary" disabled={!catalog.connected} onClick={() => next ? onConfigure(next) : onClose()}>
          {t(next ? `modelSetup.${next}Action` : "modelSetup.done")}
        </button></div>
    </footer>
  </div>;
}
