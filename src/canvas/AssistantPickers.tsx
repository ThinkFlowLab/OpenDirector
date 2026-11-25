import { modelDescription } from "./modelDescriptions";
import { ModelLogo } from "./ModelLogo";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CanvasIcon as Icon } from "./CanvasIcon";
import type { ModelConfig, ModelKind } from "../backend/rules";
import { isGenerationModel } from "../backend/rules";
import type { ModelSelections } from "../backend/chat";
import { useT } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";

// Preserve OpenDirector's keyboard-accessible model and thinking pickers.
const MODEL_KINDS = [
  { id: "agent", labelKey: "assistant.kind.agent" },
  { id: "image", labelKey: "assistant.kind.image" },
  { id: "video", labelKey: "assistant.kind.video" },
  { id: "audio", labelKey: "assistant.kind.audio" },
] as const satisfies readonly { id: string; labelKey: MessageKey }[];
// Vision models serve canvas tools only; the assistant never picks one.
type AssistantKind = (typeof MODEL_KINDS)[number]["id"];
function modelOptions(models: ModelConfig[], kind: ModelKind) {
  const options = models.filter(
    (model) => model.kind === kind && isGenerationModel(model),
  );
  return options.map((model) => {
    const host = new URL(model.url).host;
    const duplicate = options.some(
      (item) => item.id !== model.id && item.modelId === model.modelId,
    );
    return {
      id: model.id,
      modelId: model.modelId,
      label: duplicate ? `${model.modelId} · ${host}` : model.modelId,
      description: [modelDescription(model), host].filter(Boolean).join(" · "),
    };
  });
}
interface Option {
  id: string;
  label: string;
  description: string;
}

export function ModelPicker({
  models,
  selections,
  onChange,
  onConfigure,
  disabled,
  includeAgent = true,
}: {
  models: ModelConfig[];
  selections: ModelSelections;
  onChange: (kind: AssistantKind, id: string) => void;
  onConfigure: (kind: AssistantKind) => void;
  disabled: boolean;
  includeAgent?: boolean;
}) {
  const t = useT();
  const kinds = includeAgent ? MODEL_KINDS : MODEL_KINDS.filter(item => item.id !== "agent");
  const [open, setOpen] = useState(false);
  const [selection, setKind] = useState<AssistantKind>("agent");
  const kind = !includeAgent && selection === "agent" ? "image" : selection;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const category = kinds.find((item) => item.id === kind)!;
  const options = modelOptions(models, kind);
  const agent = modelOptions(models, "agent").find(
    (item) => item.id === selections.agent,
  );
  const focusIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selections[kind]),
  );

  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.focus();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function configure() {
    setOpen(false);
    onConfigure(kind);
  }
  function tabKeys(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ),
    ];
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      event.key === "ArrowRight"
        ? (current + 1) % kinds.length
        : event.key === "ArrowLeft"
          ? (current - 1 + kinds.length) % kinds.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? kinds.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      setKind(kinds[next].id);
      buttons[next].focus();
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      panel.current
        ?.querySelector<HTMLButtonElement>('[role="option"][tabindex="0"]')
        ?.focus();
    }
  }
  function optionKeys(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ),
    ];
    if (!buttons.length) return;
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % buttons.length
        : event.key === "ArrowUp"
          ? (current - 1 + buttons.length) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      buttons[next].focus();
    }
  }

  return (
    <div ref={root} className="chat-picker model-picker">
      <button
        ref={trigger}
        type="button"
        className="chat-picker-trigger"
        disabled={disabled}
        aria-label={t("assistant.modelPicker.aria", {
          name: includeAgent
            ? agent?.label ?? t("assistant.modelPicker.unconfiguredAgent")
            : t("assistant.modelPicker.mediaModels"),
        })}
        title={includeAgent ? t("assistant.modelPicker.chooseHint") : t("assistant.modelPicker.chooseMediaHint")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="cube" />
        <span>
          {includeAgent
            ? agent?.label ?? t("assistant.modelPicker.choose")
            : t("assistant.modelPicker.mediaModels")}
        </span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          className="model-picker-panel"
          role="dialog"
          aria-label={t("assistant.modelPicker.label")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <header className="model-picker-header">
            <span>{t("assistant.modelPicker.label")}</span>
            <button
              type="button"
              className="model-picker-configure"
              aria-haspopup="dialog"
              aria-controls="settings-dialog"
              onClick={configure}
            >
              <Icon name="settings" />
              <span>{t("assistant.modelPicker.configure")}</span>
            </button>
          </header>
          <div
            className="model-picker-tabs"
            role="tablist"
            aria-label={t("assistant.modelPicker.tabs")}
            onKeyDown={tabKeys}
          >
            {kinds.map((tab) => (
              <button
                key={tab.id}
                id={`${id}-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={kind === tab.id}
                aria-controls={`${id}-content`}
                tabIndex={kind === tab.id ? 0 : -1}
                onClick={() => setKind(tab.id)}
              >
                {t(tab.labelKey)}
                <span>{modelOptions(models, tab.id).length}</span>
              </button>
            ))}
          </div>
          <div
            id={`${id}-content`}
            className="model-picker-content"
            role="tabpanel"
            aria-labelledby={`${id}-${kind}`}
          >
            {options.length === 0 ? (
              <div className="model-picker-empty">
                <p>{t("assistant.modelPicker.empty", { kind: t(category.labelKey) })}</p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={configure}
                >
                  {t("assistant.modelPicker.add")}
                </button>
              </div>
            ) : (
              <div
                role="listbox"
                aria-label={t("assistant.modelPicker.listAria", { kind: t(category.labelKey) })}
                onKeyDown={optionKeys}
              >
                {options.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-label={option.label}
                    aria-selected={selections[kind] === option.id}
                    tabIndex={index === focusIndex ? 0 : -1}
                    onClick={() => {
                      onChange(kind, option.id);
                      close();
                    }}
                  >
                    <span className="model-picker-icon">
                      <ModelLogo modelId={option.modelId} />
                    </span>
                    <span className="model-picker-copy">
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    {selections[kind] === option.id && <Icon name="check" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChoicePicker({
  label,
  icon,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  icon: "model" | "thinking";
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.id === value);
  useEffect(() => {
    if (!open) return;
    (
      menu.current?.querySelector<HTMLButtonElement>(
        '[aria-selected="true"]',
      ) ?? menu.current?.querySelector<HTMLButtonElement>("button")
    )?.focus();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      if (event.key === "Tab") {
        setOpen(false);
        return;
      }
      trigger.current?.focus();
      setOpen(false);
      return;
    }
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    ];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % items.length
        : event.key === "ArrowUp"
          ? (current - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  }
  return (
    <div ref={root} className="chat-picker">
      <button
        ref={trigger}
        type="button"
        className="chat-picker-trigger"
        disabled={disabled}
        aria-label={t("assistant.choice.aria", {
          label,
          value: selected?.label ?? t("assistant.choice.unset"),
        })}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name={icon} />
        <span>{selected?.label ?? t("assistant.choice.unset")}</span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div ref={menu} className="chat-picker-menu" onKeyDown={keys}>
          <div className="picker-heading">{label}</div>
          <div role="listbox" aria-label={label}>
            {options.map((option) => (
              <button
                type="button"
                key={option.id}
                role="option"
                tabIndex={-1}
                aria-selected={value === option.id}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                {value === option.id && <Icon name="check" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
