import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../backend/api";
import { enablePlugin, installPlugin, PLUGINS_CHANGED, pluginCatalog, removePlugin, type PluginCatalog } from "../backend/plugins";
import { useI18n } from "../i18n/I18nProvider";
import { CanvasIcon } from "./CanvasIcon";
import "./plugin-settings.css";

export function PluginSettings() {
  const { t, locale } = useI18n();
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"plugins.saved" | "plugins.installedHint" | "">("");
  const saving = useRef(false);
  const upload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void pluginCatalog(controller.signal).then(setCatalog).catch((reason) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    });
    return () => controller.abort();
  }, []);

  async function change(action: () => Promise<unknown>, installed = false) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
      window.dispatchEvent(new Event(PLUGINS_CHANGED));
      setStatus(installed ? "plugins.installedHint" : "plugins.saved");
      setCatalog(await pluginCatalog());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return <div className="cw-plugin-settings" aria-busy={busy}>
    <p className="cw-plugin-intro">{t("plugins.intro")}</p>
    <form className="cw-plugin-install" onSubmit={(event) => {
      event.preventDefault();
      if (source.trim()) void change(() => installPlugin(source.trim()), true);
    }}>
      <label htmlFor="plugin-source">{t("plugins.source")}</label>
      <div className="cw-plugin-source-row">
        <input id="plugin-source" value={source} onChange={(event) => setSource(event.target.value)}
          placeholder={t("plugins.sourcePlaceholder")} disabled={busy} autoComplete="off" />
        <button className="cw-settings-button cw-settings-button-primary" disabled={busy || !source.trim()}>
          {t("plugins.install")}
        </button>
      </div>
      <input ref={upload} type="file" accept=".zip,application/zip" hidden disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void change(() => installPlugin(file), true);
        }} />
      <button type="button" className="cw-settings-button" disabled={busy} onClick={() => upload.current?.click()}>
        <CanvasIcon name="upload" size={16} />{t("plugins.upload")}
      </button>
      <p>{t("plugins.trust")}</p>
    </form>
    {busy && <p role="status">{t("plugins.working")}</p>}
    {status && <p role="status">{t(status)}</p>}
    {error && <div className="cw-settings-notice" role="alert"><span>{error}</span>
      <button disabled={busy} onClick={() => void pluginCatalog().then((value) => {
        setCatalog(value); setError("");
      }).catch((reason) => setError(errorMessage(reason)))}>
        {t("settings.reload")}
      </button>
    </div>}
    {!catalog && !error && <p role="status">{t("plugins.loading")}</p>}
    {catalog && <>
      <section aria-labelledby="plugins-installed-title">
        <h3 id="plugins-installed-title">{t("plugins.installed")}</h3>
        {!catalog.installed.length && <p className="cw-plugin-empty">{t("plugins.empty")}</p>}
        {catalog.installed.map((plugin) => <article className="cw-plugin-card" key={plugin.manifest.id}>
          <header><div><h4>{plugin.manifest.name[locale]}</h4>
            <small>{plugin.manifest.id} · {plugin.manifest.version}</small></div>
            <button className="cw-settings-button cw-settings-button-quiet" disabled={busy}
              aria-label={t("plugins.uninstallName", { name: plugin.manifest.name[locale] })}
              onClick={() => void change(() => removePlugin(plugin))}>{t("plugins.uninstall")}</button>
          </header>
          <p>{plugin.manifest.description[locale]}</p>
          {Object.keys(plugin.manifest.dependencies).length > 0 && <p>
            {t("plugins.dependencies")}: {Object.entries(plugin.manifest.dependencies).map(([id, version]) => `${id} ${version}`).join(", ")}
          </p>}
          <fieldset disabled={busy}>
            <legend>{t("plugins.enableFor")}</legend>
            {plugin.manifest.runtimes.map((runtime) => <label key={runtime}>
              <input type="checkbox" checked={plugin.enabledRuntimes.includes(runtime)}
                onChange={(event) => void change(() => enablePlugin(plugin, runtime, event.target.checked))} />
              {runtime === "default" ? t("plugins.defaultRuntime") : runtime === "opencode" ? "OpenCode" : runtime === "codex" ? "Codex" : runtime === "claude" ? "Claude Code" : runtime === "deepseek" ? "DeepSeek Harness" : "JiuwenSwarm"}
            </label>)}
          </fieldset>
        </article>)}
      </section>
      <section aria-labelledby="plugins-examples-title">
        <h3 id="plugins-examples-title">{t("plugins.examples")}</h3>
        <p className="cw-plugin-intro">{t("plugins.examplesHint")}</p>
        {catalog.examples.map((example) => <article className="cw-plugin-card" key={example.manifest.id}>
          <header><div><h4>{example.manifest.name[locale]}</h4><small>{example.manifest.version}</small></div>
            <button className="cw-settings-button" disabled={busy || catalog.installed.some((item) => item.manifest.id === example.manifest.id)}
              aria-label={t("plugins.installName", { name: example.manifest.name[locale] })}
              onClick={() => void change(() => installPlugin(example.source), true)}>
              {catalog.installed.some((item) => item.manifest.id === example.manifest.id) ? t("plugins.alreadyInstalled") : t("plugins.install")}
            </button>
          </header><p>{example.manifest.description[locale]}</p>
        </article>)}
      </section>
    </>}
  </div>;
}
