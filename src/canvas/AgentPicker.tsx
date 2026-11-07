import { ModelLogo } from "./ModelLogo";
import { HarnessLogo } from "./HarnessLogo";
import "./agent-picker.css";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  runtimeModels,
  type RuntimeModel,
  type AgentRuntime,
  type Conversation,
  type RuntimeInfo,
} from "../backend/chat";
import { isGenerationModel, type ModelConfig } from "../backend/rules";
import { useT } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import { CanvasIcon } from "./CanvasIcon";

type Harness = Exclude<AgentRuntime, "default">;

const EFFORT_LABELS: Record<"auto" | "low" | "medium" | "high", MessageKey> = {
  auto: "assistant.agent.effort.auto",
  low: "assistant.agent.effort.low",
  medium: "assistant.agent.effort.medium",
  high: "assistant.agent.effort.high",
};

export function AgentPicker({
  projectId,
  value,
  models,
  runtimes,
  disabled,
  initializing = false,
  onChange,
  onConfigure,
  onRefresh,
  visible,
}: {
  projectId: string;
  value: Conversation;
  models: ModelConfig[];
  runtimes: RuntimeInfo[];
  disabled: boolean;
  initializing?: boolean;
  onChange: (patch: Partial<Conversation>) => void;
  onConfigure: () => void;
  visible: boolean;
  onRefresh: (runtime: AgentRuntime, signal?: AbortSignal, force?: boolean) => Promise<void>;
}) {
  const t = useT();
  const harnesses = runtimes.filter(
    (item): item is RuntimeInfo & { id: Harness } =>
      item.group === "harness" && item.id !== "default",
  ).sort((a, b) => {
    const order: Harness[] = ["opencode", "deepseek", "jiuwenswarm", "codex", "claude"];
    const rank = (id: Harness) => {
      const index = order.indexOf(id);
      return index < 0 ? order.length : index;
    };
    return rank(a.id) - rank(b.id);
  });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Harness | null>(null);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [setup, setSetup] = useState<Harness | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [commandCopied, setCommandCopied] = useState(false);
  const [catalogs, setCatalogs] = useState<
    Partial<Record<Harness, RuntimeModel[]>>
  >({});
  const [choices, setChoices] = useState<RuntimeModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const submenu = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options = models.filter(
    (item) => item.kind === "agent" && isGenerationModel(item),
  );
  const agent = options.find((item) => item.id === value.modelSelections.agent);
  function configuredModel(id: Harness) {
    return (
      options.find((item) => item.id === value.harnessModels?.[id]) ??
      agent ??
      options[0]
    );
  }
  const ready = (item: RuntimeInfo) =>
    item.status === "ready" &&
    (item.modelSource !== "settings" || options.length > 0);
  const setupSpec = harnesses.find((item) => item.id === setup);
  const reason = (item: RuntimeInfo) =>
    item.status === "checking"
      ? t("assistant.agent.status.checking")
      : item.status === "not_installed"
      ? t("assistant.agent.status.notInstalled")
      : item.status === "needs_login"
        ? t("assistant.agent.status.needsLogin")
        : item.status === "needs_configuration"
          ? t("assistant.agent.status.needsConfiguration")
          : item.status === "unsupported_version"
            ? t("assistant.agent.status.unsupportedVersion")
            : item.status === "unknown"
              ? item.id === "jiuwenswarm"
                ? t("assistant.agent.status.catalogUnreadable")
                : t("assistant.agent.status.unknown")
              : t("assistant.agent.status.needsConfiguration");
  const harnessDetail = (item: RuntimeInfo & { id: Harness }) =>
    !ready(item)
      ? reason(item)
      : item.modelSource === "settings"
        ? (configuredModel(item.id)?.modelId ?? t("assistant.agent.modelFallback"))
        : modelLabel(item.id);
  const setupCommand =
    setup === "deepseek"
      ? "dsh --profile acp"
      : setup === "jiuwenswarm"
      ? "jiuwenswarm-init"
      : setup === "codex"
        ? "codex login"
        : setup === "claude"
          ? "claude auth login"
          : "opencode";
  const setupLink =
    setup === "deepseek"
      ? "https://github.com/deepseek-ai/deepseek-harness"
      : setup === "jiuwenswarm"
      ? "https://github.com/openJiuwen-ai/jiuwenswarm"
      : setup === "codex"
        ? "https://developers.openai.com/codex/cli/"
        : setup === "claude"
          ? "https://code.claude.com/docs/en/setup"
          : "https://opencode.ai/docs/";
  const editingSpec = harnesses.find((item) => item.id === editing);
  const runtime = value.runtime ?? "default";
  const harness = harnesses.find((item) => item.id === runtime);
  const title = initializing
    ? t("assistant.agent.loading")
    : !runtimes.some((item) => item.id === runtime)
      ? t("assistant.agent.selectAgain")
    : runtime === "default"
      ? (agent?.modelId ?? t("assistant.agent.modelFallback"))
      : harness?.modelSource === "settings"
        ? (configuredModel(harness.id)?.modelId ?? harness.label)
        : harness
          ? modelLabel(harness.id)
          : t("assistant.agent.defaultModel");

  function selectedModel(id: Harness) {
    return id in (value.harnessModels ?? {})
      ? value.harnessModels?.[id]
      : id === runtime
        ? value.runtimeModel
        : null;
  }
  function modelLabel(id: Harness) {
    const selected = selectedModel(id);
    const rows = catalogs[id] ?? [];
    return selected
      ? (rows.find((item) => item.id === selected)?.label ?? selected)
      : (rows.find((item) => item.isDefault)?.label ?? t("assistant.agent.cliDefault"));
  }
  const nextProbe = open ? runtimes.find((item) => item.id !== runtime && item.status === "checking")?.id : undefined;
  useEffect(() => {
    if (!nextProbe) return;
    const abort = new AbortController();
    void onRefresh(nextProbe, abort.signal).catch(() => {});
    return () => abort.abort();
  }, [nextProbe, onRefresh]);

  const currentCli = visible && harness?.modelSource === "cli" && harness.status === "ready" ? runtime : null;
  useEffect(() => {
    if (!currentCli || editing === currentCli) return;
    const abort = new AbortController();
    void runtimeModels(projectId, currentCli, null, abort.signal).then((items) => {
      if (!abort.signal.aborted) setCatalogs((previous) => ({ ...previous, [currentCli]: items }));
    }).catch(() => {});
    return () => abort.abort();
  }, [currentCli, editing, projectId]);

  function close() {
    setOpen(false);
    setEditingModel(null);
    setEditing(null);
    setSetup(null);
    trigger.current?.focus();
  }
  function chooseHarness(id: Harness, override?: string | null) {
    const spec = harnesses.find((item) => item.id === id)!;
    const fromSettings = spec.modelSource === "settings";
    const modelId = configuredModel(id)?.id;
    if (fromSettings && !modelId) {
      onConfigure();
      close();
      return;
    }
    const configured = fromSettings
      ? (modelId ?? null)
      : override === undefined
        ? selectedModel(id)
        : override;
    onChange({
      runtime: id,
      ...(id === "jiuwenswarm" ? { thinking: "auto" } : {}),
      runtimeModel: fromSettings ? null : configured,
      harnessModels: { ...value.harnessModels, [id]: configured },
      ...(fromSettings
        ? { modelSelections: { ...value.modelSelections, agent: modelId } }
        : {}),
    });
    close();
  }
  function edit(id: Harness) {
    setSetup(null);
    setEditingModel(null);
    setEditing(id);
  }
  useEffect(() => {
    if (!editing || editingSpec?.modelSource !== "cli") return;
    const abort = new AbortController();
    let active = true;
    setLoading(true);
    setChoices([]);
    setModelError("");
    runtimeModels(projectId, editing, editing === "deepseek" ? selectedModel(editing) : null, abort.signal)
      .then((items) => {
        if (active) {
          setChoices(items);
          setCatalogs((previous) => ({ ...previous, [editing]: items }));
        }
      })
      .catch(() => {
        if (active) setModelError(t("assistant.agent.modelListError"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [editing, editingSpec?.modelSource, projectId, checking, value.harnessModels]);
  useEffect(() => {
    if (!open || disabled) return;
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setEditing(null);
        setEditingModel(null);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open, disabled]);
  useEffect(() => {
    if (!open) return;
    if (editing || editingModel)
      submenu.current
        ?.querySelector<HTMLButtonElement>(
          '[aria-checked="true"], button:not(:disabled)',
        )
        ?.focus();
    else
      (
        menu.current?.querySelector<HTMLButtonElement>(
          '[aria-checked="true"]',
        ) ??
        menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      )?.focus();
  }, [open, editing, editingModel, setup]);
  useLayoutEffect(() => {
    if ((!editing && !editingModel) || !submenu.current || !menu.current) return;
    const bounds = menu.current.getBoundingClientRect();
    const layer = submenu.current;
    layer.style.left = `${Math.max(8, bounds.left - 310)}px`;
    layer.style.bottom = `${window.innerHeight - bounds.bottom}px`;
    layer.showPopover();
    const reposition = () => { setEditing(null); setEditingModel(null); };
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("resize", reposition);
    };
  }, [editing, editingModel]);
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (setup) setSetup(null);
      else if (editing || editingModel) { setEditing(null); setEditingModel(null); }
      else close();
      return;
    }
    if (event.key === "ArrowLeft" && (editing || editingModel)) {
      event.preventDefault();
      setEditing(null);
      setEditingModel(null);
      return;
    }
    const scope = editing || editingModel ? submenu.current : menu.current;
    const rows = [
      ...(scope?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
        []),
    ];
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = (current + 1) % rows.length;
    else if (event.key === "ArrowUp")
      next = (current - 1 + rows.length) % rows.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else return;
    event.preventDefault();
    rows[next]?.focus();
  }
  return (
    <div className="chat-picker cw-agent-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="chat-picker-trigger"
        disabled={disabled}
        aria-label={t("assistant.agent.aria", {
          name: harness?.label ?? t("assistant.agent.defaultGroup"),
          model: title,
        })}
        aria-haspopup="menu"
        aria-expanded={open && !disabled}
        onClick={() => {
          setOpen(!open);
          setEditingModel(null);
          setEditing(null);
          setSetup(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{title}</span>
        <CanvasIcon name="chevron" />
      </button>
      {open && !disabled && (
        <div
          className="cw-agent-menu"
          tabIndex={-1}
          role="menu"
          aria-label={t("assistant.agent.menu")}
          ref={menu}
          onKeyDown={keys}
        >
          {setupSpec ? (
            <>
              <button
                type="button"
                className="cw-agent-back"
                onClick={() => setSetup(null)}
              >
                ← {t("assistant.agent.back")}
              </button>
              <h3>{t("assistant.agent.configureTitle", { name: setupSpec.label })}</h3>
              <p>{ready(setupSpec) ? t("assistant.agent.ready") : reason(setupSpec)}</p>
              <p>{t("assistant.agent.configureHint")}</p>
              {setupSpec.id === "jiuwenswarm" && (
                <p>{t("assistant.agent.jiuwenswarmHint")}</p>
              )}
              {setupSpec.modelSource === "settings" && setupSpec.available ? (
                <button
                  type="button"
                  className="cw-agent-configure"
                  onClick={() => {
                    close();
                    onConfigure();
                  }}
                >
                  {t("assistant.agent.configureModel")}
                </button>
              ) : (
                <>
                  {setupSpec.status === "not_installed" ? (
                    <a
                      className="cw-agent-guide"
                      href={setupLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("assistant.agent.installGuide")}
                    </a>
                  ) : (
                    <>
                      <p>{t("assistant.agent.terminal")}</p>
                      <div className="cw-agent-command">
                        <code>{setupCommand}</code>
                        <button
                          type="button"
                          className="cw-agent-command-copy"
                          aria-label={commandCopied ? t("assistant.agent.copied") : t("assistant.agent.copyCommand")}
                          title={commandCopied ? t("assistant.agent.copied") : t("assistant.agent.copyCommand")}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(setupCommand);
                              setCommandCopied(true);
                            } catch {
                              setCheckError(t("assistant.agent.copyFailed"));
                            }
                          }}
                        >
                          <CanvasIcon name={commandCopied ? "check" : "copy"} size={14} />
                          {commandCopied && <span role="status">{t("assistant.agent.copied")}</span>}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              <div className="cw-agent-edit-actions">
                <button
                  type="button"
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true);
                    setCheckError("");
                    try {
                      await onRefresh(setupSpec.id, undefined, true);
                    } catch {
                      setCheckError(t("assistant.agent.checkFailed"));
                    } finally {
                      setChecking(false);
                    }
                  }}
                >
                  {checking ? t("assistant.agent.status.checking") : t("assistant.agent.recheck")}
                </button>
                {ready(setupSpec) && (
                  <button
                    type="button"
                    onClick={() => chooseHarness(setupSpec.id)}
                  >
                    {t("assistant.agent.use", { name: setupSpec.label })}
                  </button>
                )}
              </div>
              {checkError && <p role="alert">{checkError}</p>}
            </>
          ) : (
            <>
              <h3>{t("assistant.agent.harnesses")}</h3>
              {harnesses.map((item) => (
                <div className="cw-agent-row" key={item.id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={runtime === item.id}
                    title={
                      item.id === "jiuwenswarm"
                        ? harnessDetail(item)
                        : undefined
                    }
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight" && ready(item)) {
                        event.preventDefault();
                        edit(item.id);
                      }
                    }}
                    onClick={() => {
                      if (ready(item)) chooseHarness(item.id);
                      else {
                        setEditing(null);
                        setCommandCopied(false);
                        setSetup(item.id);
                      }
                    }}
                  >
                    <HarnessLogo harness={item.id} />
                    <strong>{item.label}</strong>
                    <small>{harnessDetail(item)}</small>
                    {runtime === item.id && <CanvasIcon name="check" />}
                  </button>
                  {ready(item) &&
                    (item.modelSource === "settings" || item.modelOverride) && (
                      <button
                        type="button"
                        className="cw-agent-edit"
                        aria-label={t("assistant.agent.editModels", { name: item.label })}
                        aria-haspopup="menu"
                        aria-expanded={editing === item.id}
                        onClick={() => edit(item.id)}
                      >
                        {t("assistant.agent.edit")}
                      </button>
                    )}
                </div>
              ))}
              <div className="cw-agent-default">
                <h3>
                  {t("assistant.agent.defaultGroup")} <span>· {t("assistant.agent.bundled")}</span>
                </h3>
                {options.map((item) => (
                  <div className="cw-agent-row" key={item.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={
                        runtime === "default" && agent?.id === item.id
                      }
                      onClick={() => {
                        onChange({
                          runtime: "default",
                          runtimeModel: null,
                          modelSelections: {
                            ...value.modelSelections,
                            agent: item.id,
                          },
                        });
                        close();
                      }}
                    >
                      <ModelLogo modelId={item.modelId} />
                      <strong>{item.modelId}</strong>
                      {options.some(
                        (other) =>
                          other.id !== item.id &&
                          other.modelId === item.modelId,
                      ) && <small>{new URL(item.url).host}</small>}
                      {runtime === "default" && agent?.id === item.id && (
                        <CanvasIcon name="check" />
                      )}
                    </button>
                    <button type="button" className="cw-agent-edit"
                      aria-label={t("assistant.agent.editModels", { name: item.modelId })}
                      onClick={() => { setEditing(null); setEditingModel(item.id); }}>
                      {t("assistant.agent.edit")}
                    </button>
                  </div>
                ))}
                {!options.length && <p>{t("assistant.agent.noAgentModels")}</p>}
                <button
                  type="button"
                  className="cw-agent-configure"
                  onClick={() => {
                    close();
                    onConfigure();
                  }}
                >
                  {t("assistant.agent.manageModels")}
                </button>
              </div>
            </>
          )}
          {editingModel && <div className="cw-agent-submenu" popover="manual" role="menu"
            aria-label={t("assistant.agent.editModels", { name: options.find(item => item.id === editingModel)?.modelId ?? "" })}
            ref={submenu}>
            <button type="button" className="cw-agent-back" onClick={() => setEditingModel(null)}>← {options.find(item => item.id === editingModel)?.modelId}</button>
            <h3>{t("assistant.agent.effort")}</h3>
            {(["auto", "low", "medium", "high"] as const).map(effort => <div className="cw-agent-row" key={effort}>
              <button type="button" role="menuitemradio"
                aria-checked={(value.builtinModelThinking?.[editingModel] ?? "auto") === effort}
                onClick={() => onChange({ builtinModelThinking: { ...value.builtinModelThinking, [editingModel]: effort } })}>
                <strong>{t(EFFORT_LABELS[effort])}</strong>
                {(value.builtinModelThinking?.[editingModel] ?? "auto") === effort && <CanvasIcon name="check" />}
              </button>
            </div>)}
          </div>}
          {editingSpec && (
            <div
              className="cw-agent-submenu"
              popover="manual"
              role="menu"
              aria-label={t("assistant.agent.modelsAria", { name: editingSpec.label })}
              ref={submenu}
            >
              <button
                type="button"
                className="cw-agent-back"
                onClick={() => setEditing(null)}
              >
                ← {editingSpec.label}
              </button>
              <h3>{t("assistant.agent.models")}</h3>
              {editingSpec.modelSource === "settings" ? (
                options.map((item) => (
                  <div className="cw-agent-row" key={item.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={
                        runtime === editing &&
                        configuredModel(editingSpec.id)?.id === item.id
                      }
                      onClick={() => {
                        onChange({
                          runtime: editingSpec.id,
                          runtimeModel: null,
                          harnessModels: {
                            ...value.harnessModels,
                            [editingSpec.id]: item.id,
                          },
                          modelSelections: {
                            ...value.modelSelections,
                            agent: item.id,
                          },
                        });
                        close();
                      }}
                    >
                      <ModelLogo modelId={item.modelId} />
                      <strong>{item.modelId}</strong>
                      {configuredModel(editingSpec.id)?.id === item.id && (
                        <CanvasIcon name="check" />
                      )}
                    </button>
                  </div>
                ))
              ) : (
                <>
                  <div className="cw-agent-row">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={!selectedModel(editingSpec.id)}
                      onClick={() => chooseHarness(editingSpec.id, null)}
                    >
                      <strong>
                        {choices.find((item) => item.isDefault)
                          ? t("assistant.agent.followDefault", {
                              name: choices.find((item) => item.isDefault)!.label,
                            })
                          : t("assistant.agent.followCliDefault")}
                      </strong>
                    </button>
                  </div>
                  {loading && <p role="status">{t("assistant.agent.readingModels")}</p>}
                  {choices
                    .filter((item) => item.id !== "default")
                    .map((item) => (
                      <div className="cw-agent-row" key={item.id}>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={
                            selectedModel(editingSpec.id) === item.id
                          }
                          onClick={() => chooseHarness(editingSpec.id, item.id)}
                        >
                          <strong>{item.label}</strong>
                          {value.harnessModels?.[editingSpec.id] ===
                            item.id && <CanvasIcon name="check" />}
                        </button>
                      </div>
                    ))}
                  {modelError && (
                    <>
                      <p role="alert">{modelError}</p>
                      <button
                        type="button"
                        className="cw-agent-configure"
                        onClick={() => setChecking((value) => !value)}
                      >
                        {t("assistant.agent.retry")}
                      </button>
                    </>
                  )}
                  {!loading && !modelError && !choices.length && (
                    <p>{t("assistant.agent.noCliModels")}</p>
                  )}
                </>
              )}
              <div className="cw-agent-default">
                <h3>{t("assistant.agent.effort")}</h3>
                {(["auto", "low", "medium", "high"] as const)
                  .filter((effort) => {
                    const selected = choices.find(
                      (item) =>
                        item.id ===
                        (selectedModel(editingSpec.id) ??
                          choices.find((item) => item.isDefault)?.id),
                    );
                    return (
                      effort === "auto" ||
                      editingSpec.modelSource === "settings" ||
                      editingSpec.id === "claude" ||
                      !!selected?.efforts.includes(effort)
                    );
                  })
                  .map((effort) => (
                    <div className="cw-agent-row" key={effort}>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={value.thinking === effort}
                        onClick={() => onChange({ thinking: effort })}
                      >
                        <strong>
                          {t(EFFORT_LABELS[effort])}
                        </strong>
                        {value.thinking === effort && (
                          <CanvasIcon name="check" />
                        )}
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
