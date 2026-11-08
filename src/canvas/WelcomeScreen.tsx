import { useLayoutEffect, useRef, useState } from "react";
import type { BackendModels } from "../backend/models";
import { ModelSettings } from "./ModelSettings";
import "./settings.css";
import { useI18n } from "../i18n/I18nProvider";
import animatedLogo from "../assets/open_director_logo_anim.gif";
import staticLogo from "../assets/open_director_logo.png";
import "./welcome-screen.css";

export function WelcomeScreen({ catalog, onSkip, onGuide }: { catalog: BackendModels; onSkip: () => void; onGuide: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const configureButton = useRef<HTMLButtonElement>(null);
  const [configuring, setConfiguring] = useState(false);
  const [completed, setCompleted] = useState(false);
  function finishSetup() { setCompleted(true); }
  const previous = useRef<DOMRect[]>([]);
  const panel = useRef<HTMLElement>(null);
  const transitioning = useRef(false);
  async function beginSetup() {
    if (transitioning.current) return;
    transitioning.current = true;
    const actions = dialog.current?.querySelector<HTMLElement>(".cw-welcome-intro-actions");
    if (actions && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      await actions.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(8px)" }], { duration: 160, fill: "forwards" }).finished;
    }
    previous.current = Array.from(dialog.current!.querySelectorAll("[data-welcome-shared]")).map(element => element.getBoundingClientRect());
    setConfiguring(true);
  }
  useLayoutEffect(() => {
    if (!configuring) return;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dialog.current!.querySelectorAll<HTMLElement>("[data-welcome-shared]").forEach((element, index) => {
        const before = previous.current[index];
        const after = element.getBoundingClientRect();
        if (!before || !after.width) return;
        element.animate([
          { transformOrigin: "top left", transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})` },
          { transformOrigin: "top left", transform: "none" },
        ], { duration: 760, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      });
    }
    panel.current?.focus({ preventScroll: true });
  }, [configuring]);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    configureButton.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className={`cw-welcome${configuring ? " is-configuring" : ""}`} aria-labelledby="welcome-title" onCancel={event => { event.preventDefault(); if (configuring && !completed) finishSetup(); else onSkip(); }}>
    <div className="cw-welcome-language">
      <label htmlFor="welcome-language">{t("modelSetup.language")}</label>
      <select id="welcome-language" value={locale} onChange={event => setLocale(event.target.value as "zh-CN" | "en-US")}>
        <option value="zh-CN">{t("common.chinese")}</option><option value="en-US">{t("common.english")}</option>
      </select>
    </div>
    <main className="cw-welcome-content">
      <header className="cw-welcome-hero">
      <div data-welcome-shared className="cw-welcome-logo" aria-hidden="true">
        <img className="cw-welcome-animation" src={animatedLogo} alt="" />
        <img className="cw-welcome-static" src={staticLogo} alt="" />
      </div>
      <h1 data-welcome-shared id="welcome-title">{t("modelSetup.welcomeTitle")}</h1>
      <p data-welcome-shared className="cw-welcome-description">{t("modelSetup.welcomeDescription")}</p>
      </header>
      {!configuring && <div className="cw-welcome-intro-actions">
      <div className="cw-welcome-actions">
        <button className="cw-welcome-primary" onClick={onGuide}>{t("guide.start")}</button>
        <button ref={configureButton} className="cw-welcome-primary" onClick={beginSetup}>{t("modelSetup.welcomeConfigure")}</button>
        <button className="cw-welcome-secondary" onClick={onSkip}>{t("modelSetup.welcomeSkip")}</button>
      </div>
      <p className="cw-welcome-note">{t("modelSetup.welcomeNote")}</p>
      </div>}
      {configuring && !completed && <section ref={panel} tabIndex={-1} aria-label={t("settings.models")} className="cw-settings-dialog cw-welcome-setup">
        <div className="cw-settings-body"><ModelSettings catalog={catalog} onClose={finishSetup} guided /></div>
      </section>}
      {completed && <section className="cw-welcome-complete" aria-labelledby="setup-complete-title">
        <span className="cw-welcome-complete-check" aria-hidden="true">✓</span>
        <h2 id="setup-complete-title">{t("modelSetup.finishedTitle")}</h2>
        <p>{t("modelSetup.finishedHint")}</p>
        <button autoFocus className="cw-welcome-primary" onClick={onSkip}>{t("modelSetup.done")}</button>
      </section>}
    </main>
    <footer className="cw-welcome-footer">{configuring && !completed && <button className="cw-welcome-skip-all" onClick={finishSetup}>{t("modelSetup.skipAll")}</button>}<span>OpenDirector</span></footer>
  </dialog>;
}
