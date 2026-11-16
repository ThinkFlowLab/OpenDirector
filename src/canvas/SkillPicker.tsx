import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { chatSkills, type AgentRuntime, type ChatSkill } from "../backend/chat.ts";
import { PLUGINS_CHANGED } from "../backend/plugins.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import { CanvasIcon } from "./CanvasIcon.tsx";

const SOURCE_LABELS: Record<NonNullable<ChatSkill["source"]>, MessageKey> = {
  builtin: "assistant.skills.source.builtin",
  workspace: "assistant.skills.source.workspace",
  project: "assistant.skills.source.project",
  plugin: "plugins.skillSource",
};

export function SkillPicker({
  projectId,
  runtime = "default",
  selected,
  slashQuery,
  disabled,
  onChange,
}: {
  projectId: string;
  runtime?: AgentRuntime;
  selected: string[];
  slashQuery: string | null;
  disabled: boolean;
  onChange: (names: string[], fromSlash: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const [skills, setSkills] = useState<ChatSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useId();
  const slash = slashQuery !== null && !dismissed;
  const open = !disabled && (manual || slash);
  const search = slash ? (slashQuery ?? "") : query;
  const shown = skills.filter((skill) =>
    `${skill.name} ${skill.displayName?.[locale] ?? ""} ${skill.localizedDescription?.[locale] ?? skill.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const index = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    setManual(false);
    setQuery("");
    setSkills([]);
    setError("");
  }, [projectId, runtime]);
  useEffect(() => {
    const refresh = () => setAttempt((value) => value + 1);
    window.addEventListener(PLUGINS_CHANGED, refresh);
    return () => window.removeEventListener(PLUGINS_CHANGED, refresh);
  }, []);
  useEffect(() => {
    setDismissed(false);
    setActive(0);
  }, [slashQuery]);
  useEffect(() => {
    setActive(0);
  }, [search]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setSkills([]);
    setError("");
    void chatSkills(projectId, abort.signal, runtime)
      .then((value) => {
        if (!abort.signal.aborted) setSkills(value);
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : t("assistant.skills.loadFailed"),
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [projectId, runtime, attempt]);

  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const popover = root.current.querySelector<HTMLElement>(".cw-skill-popover")!;
    const bounds = root.current.closest(".cw-assistant-composer")!.getBoundingClientRect();
    const width = Math.min(420, bounds.width, window.innerWidth - 16);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`;
    popover.style.bottom = `${window.innerHeight - bounds.top + 8}px`;
    popover.style.maxHeight = `${Math.max(120, bounds.top - 24)}px`;
    popover.showPopover();
    if (!slash) popover.querySelector<HTMLInputElement>("input")?.focus({preventScroll: true});
    const dismiss = () => {setManual(false); setDismissed(true);};
    window.addEventListener("resize", dismiss);
    return () => window.removeEventListener("resize", dismiss);
  }, [open, slash]);

  function close() {
    setManual(false);
    setDismissed(true);
  }
  function choose(skill: ChatSkill) {
    const next = selected.includes(skill.name)
      ? selected.filter((name) => name !== skill.name)
      : [skill.name];
    if (next.length > 1) return;
    onChange(next, slash);
    close();
  }
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) close();
    }
    function focusOutside(event: FocusEvent) {
      if (!slash && !root.current?.contains(event.target as Node)) close();
    }
    function key(event: KeyboardEvent) {
      const element = event.target as HTMLElement;
      if (
        !root.current?.contains(element) &&
        !(slash && element.isContentEditable)
      )
        return;
      if (event.isComposing) return;
      if (
        event.key !== "Escape" &&
        !element.matches('input, [role="option"]') &&
        !(slash && element.isContentEditable)
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        if (!slash) trigger.current?.focus();
      } else if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Enter") {
          if (!error && shown[index]) choose(shown[index]);
        } else
          setActive((current) =>
            shown.length
              ? (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  shown.length) %
                shown.length
              : 0,
          );
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, slash, shown, selected, index]);

  return (
    <div className="chat-picker cw-skill-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="chat-picker-trigger cw-skill-trigger"
        title={t("assistant.skills.triggerTitle")}
        aria-label={t("assistant.skills.trigger")}
        aria-expanded={open}
        aria-controls={list}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          setManual(!open);
          setDismissed(open);
          setQuery("");
        }}
      >
        <CanvasIcon name="sparkle" size={16} />
        <span>{t("assistant.skills.trigger")}</span>
        {selected.length > 0 && <small>{selected.length}</small>}
      </button>
      {open && (
        <div
          className="cw-skill-popover"
          popover="manual"
          role="dialog"
          aria-label={t("assistant.skills.trigger")}
          id={list}
        >
          <div className="cw-skill-search">
            {!slash ? <>
              <CanvasIcon name="search" size={18} />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("assistant.skills.search")} aria-label={t("assistant.skills.search")} aria-controls={`${list}-options`} aria-activedescendant={shown[index] ? `${list}-${index}` : undefined} />
            </> : <span>{t("assistant.skills.trigger")}</span>}
            <button type="button" aria-label={t("assistant.skills.refresh")} title={t("assistant.skills.refreshTitle")} disabled={loading} onClick={() => setAttempt(value => value + 1)}>↻</button>
          </div>
          {loading && !skills.length ? (
            <p role="status">{t("assistant.skills.loading")}</p>
          ) : error ? (
            <div className="cw-skill-status" role="alert">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t("assistant.skills.retry")}
              </button>
            </div>
          ) : (
            <div
              className="cw-skill-options"
              role="listbox"
              id={`${list}-options`}
              aria-label={t("assistant.skills.list")}
              aria-multiselectable="true"
            >
              {shown.map((skill, position) => (
                <button
                  type="button"
                  role="option"
                  id={`${list}-${position}`}
                  key={skill.name}
                  aria-selected={selected.includes(skill.name)}
                  className={position === index ? "is-active" : ""}
                  onFocus={() => setActive(position)}
                  onMouseEnter={() => setActive(position)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(skill)}
                >
                  <CanvasIcon name="sparkle" size={16} />
                  <span>
                    <span className="cw-skill-title"><strong>{skill.displayName?.[locale] ?? skill.name}</strong>{skill.source && <em>{t(SOURCE_LABELS[skill.source])}</em>}</span>
                    <small title={skill.localizedDescription?.[locale] ?? skill.description}>{skill.localizedDescription?.[locale] ?? skill.description}</small>
                  </span>
                  {selected.includes(skill.name) && (
                    <CanvasIcon name="check" size={14} />
                  )}
                </button>
              ))}
              {!shown.length && (
                <p>{skills.length ? t("assistant.skills.noMatch") : t("assistant.skills.empty")}</p>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
