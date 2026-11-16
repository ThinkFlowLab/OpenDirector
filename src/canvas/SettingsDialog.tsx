import { useLayoutEffect, useRef, useState } from "react";
import { CanvasIcon } from "./CanvasIcon";
import { ModelSettings } from "./ModelSettings";
import { PluginSettings } from "./PluginSettings";
import { errorMessage } from "../backend/api";
import type { BackendModels } from "../backend/models";
import type { Theme, ThemeControls } from "./theme";
import { useI18n, useT } from "../i18n/I18nProvider";
import type { Locale } from "../i18n/types";

const categories = [
  { id: "models", labelKey: "settings.models", icon: "model" },
  { id: "general", labelKey: "settings.general", icon: "settings" },
  { id: "plugins", labelKey: "plugins.title", icon: "sparkle" },
] as const;

function GeneralSettings({
  catalog,
  theme,
}: {
  catalog: BackendModels;
  theme: ThemeControls;
}) {
  const { locale, setLocale, t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const toggleWatermark = async () => {
    if (saving.current || !catalog.settings) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await catalog.updateSettings({
        removeWatermark: !catalog.settings.removeWatermark,
      });
    } catch (reason) {
      setError(
        t("settings.watermarkSaveFailed", {
          reason: errorMessage(reason),
        }),
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="cw-settings-fields">
      <div className="cw-settings-field">
        <div>
          <label htmlFor="settings-language">{t("common.language")}</label>
          <p>{t("common.languageHint")}</p>
        </div>
        <select
          id="settings-language"
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          <option value="zh-CN">{t("common.chinese")}</option>
          <option value="en-US">{t("common.english")}</option>
        </select>
      </div>
      <div className="cw-settings-field">
        <div>
          <label htmlFor="settings-theme">{t("common.theme")}</label>
          <p>{t("common.themeHint")}</p>
        </div>
        <select
          id="settings-theme"
          value={theme.theme}
          onChange={(event) => theme.setTheme(event.target.value as Theme)}
        >
          <option value="light">{t("common.light")}</option>
          <option value="dark">{t("common.dark")}</option>
        </select>
      </div>
      <div className="cw-settings-field cw-settings-watermark">
        <div>
          <label id="settings-watermark-label" htmlFor="settings-watermark">
            {t("settings.watermark")}
          </label>
          <p id="settings-watermark-hint">{t("settings.watermarkHint")}</p>
        </div>
        <div className="cw-settings-switch-control">
          <button
            id="settings-watermark"
            className="cw-settings-switch"
            role="switch"
            aria-checked={catalog.settings?.removeWatermark ?? false}
            aria-labelledby="settings-watermark-label"
            aria-describedby="settings-watermark-hint settings-watermark-status"
            disabled={busy || catalog.settings === null}
            onClick={() => void toggleWatermark()}
          >
            <span />
          </button>
          <p id="settings-watermark-status" role="status">
            {busy
              ? t("settings.watermarkSaving")
              : catalog.settings === null
                ? t("settings.watermarkUnknown")
                : catalog.settings.removeWatermark
                  ? t("settings.watermarkOn")
                  : t("settings.watermarkOff")}
          </p>
        </div>
      </div>
      {(error || catalog.settings === null) && (
        <div className="cw-settings-notice" role="alert">
          <span>{error || catalog.error || t("settings.readFailed")}</span>
          <button
            disabled={busy}
            onClick={() => {
              setError("");
              void catalog.refresh();
            }}
          >
            {t("settings.reload")}
          </button>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog({
  catalog,
  theme,
  initialCategory,
  onClose,
}: {
  catalog: BackendModels;
  theme: ThemeControls;
  initialCategory: "general" | "models";
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPressed = useRef(false);
  const [category, setCategory] = useState<"general" | "models" | "plugins">(
    initialCategory,
  );
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const isBackdrop = (event: {
    target: EventTarget;
    currentTarget: HTMLDialogElement;
    clientX: number;
    clientY: number;
  }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      event.target === event.currentTarget &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    );
  };
  return (
    <dialog
      id="settings-dialog"
      ref={dialog}
      className="cw-settings-dialog"
      aria-labelledby="settings-title"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        backdropPressed.current = isBackdrop(event);
      }}
      onPointerCancel={() => {
        backdropPressed.current = false;
      }}
      onClick={(event) => {
        if (backdropPressed.current && isBackdrop(event)) onClose();
        backdropPressed.current = false;
      }}
    >
      <div className="cw-settings-layout">
        <aside className="cw-settings-sidebar">
          <h1 id="settings-title">{t("settings.title")}</h1>
          <nav
            className="cw-settings-navigation"
            aria-label={t("settings.categories")}
          >
            {categories.map((item) => (
              <button
                key={item.id}
                type="button"
                autoFocus={item.id === initialCategory}
                aria-current={category === item.id ? "page" : undefined}
                aria-controls="settings-content"
                onClick={() => setCategory(item.id)}
              >
                <CanvasIcon name={item.icon} size={16} />
                <span>{t(item.labelKey)}</span>
              </button>
            ))}
          </nav>
        </aside>
        <section
          className="cw-settings-main"
          id="settings-content"
          aria-labelledby="settings-section-title"
        >
          <header className="cw-settings-header">
            <h2 id="settings-section-title">
              {t(categories.find((item) => item.id === category)!.labelKey)}
            </h2>
          </header>
          <div className="cw-settings-body">
            {theme.error && (
              <div className="cw-settings-notice" role="alert">
                <span>{theme.error}</span>
                <button
                  aria-label={t("settings.closeThemeError")}
                  onClick={theme.clearError}
                >
                  <CanvasIcon name="close" />
                </button>
              </div>
            )}
            {category === "plugins" ? <PluginSettings /> : category === "general" ? (
              <GeneralSettings catalog={catalog} theme={theme} />
            ) : (
              <ModelSettings catalog={catalog} onClose={onClose} />
            )}
          </div>
        </section>
        <button
          className="cw-settings-close"
          aria-label={t("settings.close")}
          onClick={onClose}
        >
          <CanvasIcon name="close" size={20} />
        </button>
      </div>
    </dialog>
  );
}
