import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../backend/api";
import {
  chatRuntimeInventory, chatRuntimeStatus, conversation, saveChatDraft,
  type RuntimeInfo,
} from "../backend/chat";
import type { BackendModels } from "../backend/models";
import type { ModelConfig } from "../backend/rules";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";
import staticLogo from "../assets/open_director_logo.png";
import welcomeCanvasZh from "../assets/welcome/canvas-zh-CN.webp";
import welcomeCanvasEn from "../assets/welcome/canvas-en-US.webp";
import { rememberAgentSelection, restoreAgentSelection } from "./agentPreferences";
import { CanvasIcon } from "./CanvasIcon";
import { HarnessLogo } from "./HarnessLogo";
import { firstRunCapabilities, firstRunModelIssue, firstRunModelKind, type FirstRunCapability, type FirstRunMedia, type FirstRunSelection } from "./firstRunModels";
import { ModelServiceForm } from "./ModelServiceForm";
import { exampleFailureText, examplePercent } from "./workspace/example/exampleFailure";
import type { ExampleStatus } from "./workspace/example/useExampleImport";
import type { WorkspaceMode } from "./workspaceMode";
import "./settings.css";
import "./welcome-screen.css";

const taskChoices = [
  { id: "video", icon: "video", capability: "video_generation" },
  { id: "image", icon: "image", capability: "text_to_image" },
  { id: "speech", icon: "audio", capability: "text_to_speech" },
  { id: "music", icon: "audio", capability: "lyrics_to_music" },
] as const satisfies readonly { id: string; icon: string; capability: FirstRunMedia }[];
const shortcutChoices = [
  { id: "import", icon: "rail-upload" },
  { id: "examples", icon: "canvas" },
] as const;
type Screen = "intro" | "assistant" | "language" | "harness" | "tasks";
const screenDepth: Record<Screen, number> = { intro: 0, assistant: 1, language: 2, harness: 2, tasks: 3 };
type ModelEditor = { capability: FirstRunCapability; existing?: ModelConfig };
type SelectedTask = { type: "models" } | { type: "configure"; existing?: ModelConfig };
type TaskAction = "create" | "import" | "examples";
type BlockedModel = { model: ModelConfig; reason: string };
const taskProgressKeys: Record<TaskAction, MessageKey> = {
  create: "firstRun.creating",
  import: "firstRun.importing",
  examples: "firstRun.loadingExamples",
};

const runtimeStatusKeys: Record<RuntimeInfo["status"], MessageKey> = {
  checking: "assistant.agent.status.checking",
  ready: "firstRun.harnessDetected",
  not_installed: "assistant.agent.status.notInstalled",
  needs_login: "assistant.agent.status.needsLogin",
  needs_configuration: "assistant.agent.status.needsConfiguration",
  unsupported_version: "assistant.agent.status.unsupportedVersion",
  unknown: "assistant.agent.status.unknown",
};

function TaskOption({ capability, icon, title, description, checked, onChange }: {
  capability: FirstRunMedia;
  icon: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="cw-welcome-option cw-welcome-task-card">
      <span className="cw-welcome-task-icon"><CanvasIcon name={icon} size={24} /></span>
      <span><strong id={id}>{title}</strong><small id={`${id}-hint`}>{description}</small></span>
      <input type="checkbox" data-first-run-choice={capability} aria-labelledby={id} aria-describedby={`${id}-hint`}
        checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>
  );
}

export function WelcomeScreen({ catalog, projectId, workspaceMode, onChooseMode, onEnterWorkspace, onCreate, onImport, exampleStatus, onExamples, onCancelExample }: {
  catalog: BackendModels;
  projectId: string;
  workspaceMode: WorkspaceMode;
  onChooseMode: (mode: WorkspaceMode) => boolean;
  onEnterWorkspace: () => void;
  onCreate: (selections: FirstRunSelection[]) => Promise<void>;
  onImport: (files: File[]) => Promise<void>;
  exampleStatus?: ExampleStatus;
  onExamples: () => Promise<void>;
  onCancelExample: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const taskFocus = useRef<{ capability: FirstRunMedia; target: "configuration" | "choice" } | null>(null);
  const cancelModelButtons = useRef(new Map<FirstRunCapability, HTMLButtonElement>());
  const catalogRetryButton = useRef<HTMLButtonElement>(null);
  const focusAfterCatalogRetry = useRef(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const exampleButton = useRef<HTMLButtonElement>(null);
  const focusAfterExample = useRef(false);
  const fieldGroup = useId();
  const [screen, setScreen] = useState<Screen>("intro");
  const [selectedMode, setSelectedMode] = useState(workspaceMode);
  const [modeSaveFailed, setModeSaveFailed] = useState(false);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [importReturns, setImportReturns] = useState(0);
  const [editing, setEditing] = useState<ModelEditor | null>(null);
  const [lockedEditor, setLockedEditor] = useState<FirstRunCapability | null>(null);
  const [assistant, setAssistant] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Partial<Record<FirstRunMedia, SelectedTask>>>({});
  const [modelSelections, setModelSelections] = useState<Partial<Record<FirstRunMedia, string>>>({});
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const [assistantError, setAssistantError] = useState("");
  const taskRunning = useRef(false);
  const [taskAction, setTaskAction] = useState<TaskAction | null>(null);
  const [taskError, setTaskError] = useState("");
  const findModels = (kind: FirstRunCapability) => {
    const ready: ModelConfig[] = [];
    const blocked: BlockedModel[] = [];
    for (const model of catalog.models) {
      if (!firstRunModelKind(model, kind)) continue;
      const reason = firstRunModelIssue(model, kind);
      if (reason === null) ready.push(model);
      else blocked.push({ model, reason });
    }
    return { ready, blocked };
  };
  const languageModels = findModels("text_response");
  const agents = languageModels.ready;
  const isIntro = screen === "intro";
  const isTaskStep = screen === "tasks";
  const selected = taskChoices.flatMap(({ capability }) => {
    const task = tasks[capability];
    if (!task) return [];
    const { ready, blocked } = findModels(capability);
    const model = ready.find((item) => item.id === modelSelections[capability]) ?? (ready.length === 1 ? ready[0] : undefined);
    return [{ capability, task, ready, blocked, model }];
  });
  const selections = selected.flatMap(({ capability, model }) => model ? [{ capability, model }] : []);
  const openEditors = selected.filter(({ task }) => task.type === "configure");
  const canUseCatalog = catalog.connected && !catalog.loading;
  const taskDisabled = !canUseCatalog || Boolean(taskAction) || lockedEditor !== null;
  const downloadingExample = taskAction === "examples" && exampleStatus?.phase === "downloading";
  const exampleProgress = downloadingExample ? examplePercent(exampleStatus) : null;
  const updateEditorLock = useCallback((capability: FirstRunCapability, locked: boolean) => {
    setLockedEditor((previous) => locked ? capability : previous === capability ? null : previous);
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useLayoutEffect(() => {
    heading.current?.focus();
    if (dialog.current) dialog.current.scrollTop = 0;
  }, [screen, editing]);
  useLayoutEffect(() => {
    const pending = taskFocus.current;
    if (!pending || !isTaskStep) return;
    taskFocus.current = null;
    const { capability, target } = pending;
    const element = dialog.current?.querySelector<HTMLElement>(`[data-first-run-${target}="${capability}"]`);
    if (target === "configuration") element?.scrollIntoView({ block: "nearest" });
    else element?.focus({ preventScroll: true });
  }, [isTaskStep, tasks]);
  useLayoutEffect(() => {
    if (catalog.loading || !focusAfterCatalogRetry.current) return;
    focusAfterCatalogRetry.current = false;
    if (document.activeElement === document.body) {
      (catalog.connected ? heading.current : catalogRetryButton.current)?.focus();
    }
  }, [catalog.loading, catalog.connected]);

  useLayoutEffect(() => {
    if (taskAction || !focusAfterExample.current) return;
    focusAfterExample.current = false;
    if (document.activeElement === document.body) exampleButton.current?.focus({ preventScroll: true });
  }, [taskAction]);

  useEffect(() => {
    const input = filePicker.current;
    if (!isTaskStep || !input) return;
    const onCancel = () => setImportReturns((count) => count + 1);
    input.addEventListener("cancel", onCancel);
    return () => input.removeEventListener("cancel", onCancel);
  }, [isTaskStep]);

  useEffect(() => {
    if (screen !== "harness") return;
    const abort = new AbortController();
    setRuntimes([]);
    setRuntimeLoading(true);
    setRuntimeError(false);
    void (async () => {
      try {
        const rows = (await chatRuntimeInventory(projectId, abort.signal)).filter((item) => item.group === "harness");
        if (abort.signal.aborted) return;
        setRuntimes(rows);
        await Promise.all(rows.map(async (item) => {
          if (!item.available || (item.status !== "checking" && runtimeAttempt === 0)) return;
          const status = await chatRuntimeStatus(projectId, item.id, abort.signal, runtimeAttempt > 0)
            .catch(() => ({ ...item, status: "unknown" as const }));
          if (abort.signal.aborted) return;
          setRuntimes((current) => current.map((row) => row.id === item.id ? status : row));
        }));
      } catch {
        if (!abort.signal.aborted) setRuntimeError(true);
      } finally {
        if (!abort.signal.aborted) setRuntimeLoading(false);
      }
    })();
    return () => abort.abort();
  }, [projectId, runtimeAttempt, screen]);

  function navigate(next: Screen) {
    setDirection(screenDepth[next] < screenDepth[screen] ? "back" : "forward");
    setAssistantError("");
    setTaskError("");
    setScreen(next);
  }

  async function connect(label: string, runtime: RuntimeInfo["id"], agent?: ModelConfig) {
    if (savingNow.current || !catalog.connected || (agent && firstRunModelIssue(agent, "text_response"))) return;
    savingNow.current = true;
    setSaving(true);
    setAssistantError("");
    try {
      const status = await chatRuntimeStatus(projectId, runtime);
      if (status.status !== "ready" || !status.available || (status.modelSource === "settings" && !agent)) {
        setAssistantError(t("firstRun.assistantUnavailable"));
        return;
      }
      const { conversation: stored, activeTurnId } = await conversation(projectId);
      if (activeTurnId) {
        setAssistantError(t("firstRun.assistantBusy"));
        return;
      }
      const selected = restoreAgentSelection(projectId, stored);
      const { messages, ...draft } = stored;
      const runtimeModel = runtime !== "default" && status.modelSource === "cli"
        ? selected.harnessModels?.[runtime] ?? (selected.runtime === runtime ? selected.runtimeModel : null) ?? null
        : null;
      const next = {
        ...draft,
        runtime,
        runtimeModel,
        harnessModels: {
          ...selected.harnessModels,
          ...(runtime === "default" ? {} : { [runtime]: agent?.id ?? runtimeModel }),
        },
        modelSelections: { ...draft.modelSelections, agent: agent?.id ?? draft.modelSelections.agent },
      };
      await saveChatDraft(projectId, next);
      rememberAgentSelection(projectId, { ...next, messages });
      setAssistant(label);
      navigate("tasks");
    } catch (error) {
      setAssistantError(errorMessage(error));
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }

  async function runTask(action: TaskAction, run: () => Promise<void>) {
    if (!assistant || taskDisabled || taskRunning.current) return;
    taskRunning.current = true;
    setTaskAction(action);
    setTaskError("");
    try {
      await run();
    } catch (error) {
      setTaskError(errorMessage(error));
    } finally {
      taskRunning.current = false;
      if (action === "examples") focusAfterExample.current = true;
      setTaskAction(null);
    }
  }

  function setTask(capability: FirstRunMedia, task?: SelectedTask) {
    setTasks((previous) => ({ ...previous, [capability]: task }));
  }

  function toggleTask(capability: FirstRunMedia, checked: boolean) {
    setTaskError("");
    if (!checked) {
      setTask(capability);
      return;
    }
    const { ready, blocked } = findModels(capability);
    if (ready.length || blocked.length) setTask(capability, { type: "models" });
    else editModel({ capability });
  }

  function editModel({ capability, existing }: ModelEditor) {
    if (capability === "text_response") {
      setDirection("forward");
      setEditing({ capability, existing });
    } else {
      taskFocus.current = { capability, target: "configuration" };
      setTask(capability, { type: "configure", existing });
    }
  }

  function closeModelSetup(capability: FirstRunCapability) {
    if (capability === "text_response") {
      setDirection("back");
      setEditing(null);
    } else {
      taskFocus.current = { capability, target: "choice" };
      setTask(capability, { type: "models" });
    }
  }

  function finishModelSetup(capability: FirstRunCapability, saved: ModelConfig[]) {
    closeModelSetup(capability);
    const [item] = saved;
    if (capability !== "text_response") {
      if (saved.length === 1 && firstRunModelIssue(item, capability) === null) {
        setModelSelections(previous => ({ ...previous, [capability]: item.id }));
      }
    } else {
      navigate("language");
      if (saved.length === 1 && firstRunModelIssue(item, "text_response") === null) {
        void connect(item.modelId, "default", item);
      }
    }
  }

  function unavailableModels(models: BlockedModel[], kind: FirstRunCapability) {
    if (!models.length) return null;
    return (
      <div className="cw-welcome-unavailable">
        <p>{t("firstRun.modelsUnavailable")}</p>
        <ul>
          {models.map(({ model: saved, reason }) => (
            <li key={saved.id}>
              <span><strong>{saved.modelId}</strong><small>{reason}</small></span>
              <button type="button" className="cw-welcome-secondary" disabled={taskDisabled || saving}
                onClick={() => editModel({ capability: kind, existing: saved })}>{t("models.service.edit")}</button>
              <button type="button" className="cw-welcome-secondary"
                disabled={taskDisabled || saving || catalog.checkingIds.has(saved.id)}
                onClick={() => void catalog.refreshAvailability([saved.id], true)}>
                {t(catalog.checkingIds.has(saved.id) ? "availability.checking" : "availability.retry")}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  function modelForm(editor: ModelEditor) {
    return <ModelServiceForm
      key={editor.existing?.id ?? editor.capability}
      kind={firstRunCapabilities[editor.capability]}
      capability={editor.capability}
      existing={editor.existing}
      catalog={catalog}
      cancelButtonRef={(button) => {
        if (button) cancelModelButtons.current.set(editor.capability, button);
        else cancelModelButtons.current.delete(editor.capability);
      }}
      onLockChange={updateEditorLock}
      onClose={() => closeModelSetup(editor.capability)}
      onSaved={(saved) => finishModelSetup(editor.capability, saved)}
    />;
  }

  const editingTitle = editing
    ? t("firstRun.configureModel", { model: t(`firstRun.capability.${editing.capability}`) })
    : "";
  const title = editing && !isTaskStep
    ? editingTitle
    : t(screen === "assistant" ? "firstRun.assistantTitle" :
      screen === "language" ? "firstRun.languageTitle" :
      screen === "harness" ? "firstRun.harnessTitle" : "firstRun.tasksTitle");
  const catalogFeedback = catalog.loading
    ? <p className="cw-welcome-feedback cw-welcome-pending" role="status">{t("modelSetup.loading")}</p>
    : !catalog.connected && (
      <div className="cw-welcome-actions" role="alert">
        <span>{t("modelSetup.failed")}</span>
        <button ref={catalogRetryButton} className="cw-welcome-secondary" onClick={() => {
          focusAfterCatalogRetry.current = true;
          void catalog.refresh();
        }}>{t("modelSetup.retry")}</button>
      </div>
    );

  function goBack() {
    if (downloadingExample) {
      onCancelExample();
      return;
    }
    if (savingNow.current || taskRunning.current || lockedEditor) return;
    const activeEditor = openEditors.find(({ capability }) =>
      cancelModelButtons.current.get(capability)?.form?.contains(document.activeElement),
    );
    const cancel = editing?.capability ?? activeEditor?.capability ?? openEditors.at(-1)?.capability;
    if (cancel) cancelModelButtons.current.get(cancel)?.click();
    else if (screen === "assistant") navigate("intro");
    else if (!isIntro) navigate("assistant");
  }

  return (
    <dialog ref={dialog} className="cw-welcome" aria-labelledby="welcome-title" data-motion-direction={direction}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
        event.preventDefault();
        goBack();
      }}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        goBack();
      }}
    >
      <div className={`cw-welcome-shell${isIntro ? " is-intro" : ""}`}>
        <header className="cw-welcome-brand">
          <span><img src={staticLogo} alt="" /> OpenDirector</span>
          <div className="cw-welcome-language">
            <label htmlFor="welcome-language">{t("modelSetup.language")}</label>
            <select id="welcome-language" value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
              <option value="zh-CN">{t("common.chinese")}</option>
              <option value="en-US">{t("common.english")}</option>
            </select>
          </div>
        </header>
        {modeSaveFailed && <p className="cw-welcome-feedback" role="status">{t("workspaceModes.preferenceFailed")}</p>}
        {isIntro ? (
          <main className="cw-welcome-intro">
            <div className="cw-welcome-intro-copy">
              <h1 id="welcome-title" ref={heading} tabIndex={-1}>{t("firstRun.welcomeTitle")}</h1>
              <p>{t("firstRun.welcomeIntro")}</p>
              <fieldset className="cw-welcome-options cw-welcome-modes">
                <legend>{t("workspaceModes.label")}</legend>
                {(["agent", "canvas"] as const).map(mode => (
                  <label key={mode} className="cw-welcome-option">
                    <input type="radio" name={`${fieldGroup}-workspace-mode`} value={mode}
                      checked={selectedMode === mode} onChange={() => setSelectedMode(mode)}
                      aria-labelledby={`${fieldGroup}-${mode}`} aria-describedby={`${fieldGroup}-${mode}-hint`} />
                    <span>
                      <strong id={`${fieldGroup}-${mode}`}>{t(`workspaceModes.${mode}`)}</strong>
                      <small id={`${fieldGroup}-${mode}-hint`}>{t(`firstRun.modeHint.${mode}`)}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="cw-welcome-intro-actions">
                <button type="button" className="cw-welcome-primary" onClick={() => {
                  setModeSaveFailed(!onChooseMode(selectedMode));
                  navigate("assistant");
                }}>{t("firstRun.welcomeStart")}</button>
                <button type="button" className="cw-welcome-secondary" onClick={() => {
                  onChooseMode(selectedMode);
                  onEnterWorkspace();
                }}>{t("firstRun.enterWorkspace")}</button>
              </div>
              {catalogFeedback}
            </div>
            <div className="cw-welcome-art">
              <img
                src={locale === "zh-CN" ? welcomeCanvasZh : welcomeCanvasEn}
                alt={t("firstRun.welcomeCanvasAlt")}
                width={1590}
                height={1218}
              />
            </div>
          </main>
        ) : <main className={`cw-welcome-content${isTaskStep ? " is-task-step" : ""}`}>
          <ol className="cw-welcome-steps" aria-label={t("firstRun.steps")}>
            <li aria-current={!isTaskStep ? "step" : undefined}><span>{isTaskStep ? "✓" : "1"}</span>{t("firstRun.assistantTitle")}</li>
            <li aria-current={isTaskStep ? "step" : undefined}><span>2</span>{t("firstRun.stepTask")}</li>
          </ol>
          <div key={editing ? "language-editor" : screen} className="cw-welcome-stage">
            <h1 id="welcome-title" ref={heading} tabIndex={-1}>{title}</h1>
            {editing ? (
              <section className="cw-welcome-setup">{modelForm(editing)}</section>
            ) : screen === "assistant" ? (
              <>
                <p className="cw-welcome-description">{t("firstRun.assistantWhy")}</p>
                <div className="cw-welcome-options cw-welcome-connection-options">
                  <button
                    type="button"
                    className="cw-welcome-option"
                    disabled={!canUseCatalog}
                    onClick={() => languageModels.ready.length || languageModels.blocked.length
                      ? navigate("language")
                      : editModel({ capability: "text_response" })}
                  >
                    <CanvasIcon name="model" size={18} />
                    <span>{t("firstRun.languageTitle")}</span>
                  </button>
                  <button type="button" className="cw-welcome-option" disabled={!canUseCatalog} onClick={() => navigate("harness")}>
                    <CanvasIcon name="connections" size={18} />
                    <span>{t("firstRun.harnessAction")}</span>
                  </button>
                </div>
                <div className="cw-welcome-actions">
                  <button type="button" className="cw-welcome-secondary" onClick={() => navigate("intro")}>{t("firstRun.back")}</button>
                </div>
              </>
            ) : screen === "language" || screen === "harness" ? (
              <>
                <p className="cw-welcome-description">{t(screen === "language" ? "firstRun.languageListHint" : "firstRun.harnessHint")}</p>
                <div className="cw-welcome-options">
                  {screen === "language" ? agents.map((agent) => (
                    <button key={agent.id} className="cw-welcome-option" disabled={saving || !canUseCatalog} onClick={() => void connect(agent.modelId, "default", agent)}>
                      <CanvasIcon name="model" size={20} />
                      <span><strong>{agent.modelId}</strong><small>{t("firstRun.useSavedModel")}</small></span>
                    </button>
                  )) : runtimes.map((item) => {
                    if (item.id === "default") return null;
                    const agent = item.modelSource === "settings" ? agents[0] : undefined;
                    const needsModel = item.status === "ready" && item.modelSource === "settings" && !agent;
                    return <button key={item.id} className="cw-welcome-option"
                      disabled={saving || !canUseCatalog || !item.available || item.status !== "ready" || needsModel}
                      onClick={() => void connect(item.label, item.id, agent)}>
                      <HarnessLogo harness={item.id} />
                      <span><strong>{item.label}</strong><small key={item.status} className="cw-welcome-runtime-status">{t(needsModel ? "firstRun.harnessNeedsModel" : runtimeStatusKeys[item.status])}</small></span>
                    </button>;
                  })}
                </div>
                {screen === "language" && unavailableModels(languageModels.blocked, "text_response")}
                {screen === "language" && catalog.availabilityError && <p className="cw-welcome-feedback" role="alert">{catalog.availabilityError}</p>}
                {screen === "harness" && runtimeLoading && <p className="cw-welcome-feedback cw-welcome-pending" role="status">{t("firstRun.harnessLoading")}</p>}
                {screen === "harness" && runtimeError && <p className="cw-welcome-feedback" role="alert">{t("firstRun.harnessFailed")}</p>}
                {assistantError && <p className="cw-welcome-feedback" role="alert">{assistantError}</p>}
                {saving && <p className="cw-welcome-feedback cw-welcome-pending" role="status">{t("firstRun.saving")}</p>}
                <div className="cw-welcome-actions">
                  <button className="cw-welcome-secondary" disabled={saving} onClick={() => navigate("assistant")}>{t("firstRun.back")}</button>
                  {screen === "language"
                    ? <button className="cw-welcome-primary" disabled={saving || !canUseCatalog} onClick={() => editModel({ capability: "text_response" })}>{t("firstRun.addLanguageModel")}</button>
                    : <button className="cw-welcome-secondary" disabled={saving || runtimeLoading} onClick={() => setRuntimeAttempt((attempt) => attempt + 1)}>{t("modelSetup.retry")}</button>}
                </div>
              </>
            ) : (
              <>
                <p className="cw-welcome-description">{t("firstRun.tasksHint")}</p>
                {assistant && <p className="cw-welcome-connected">{t("firstRun.assistantSelected", { assistant })}</p>}
                <fieldset className="cw-welcome-task-grid" disabled={taskDisabled}>
                  <legend className="sr-only">{t("firstRun.tasksTitle")}</legend>
                  {taskChoices.map((choice) => (
                    <TaskOption
                      key={choice.id}
                      capability={choice.capability}
                      icon={choice.icon}
                      title={t(`firstRun.${choice.id}.title`)}
                      description={t(`firstRun.${choice.id}.hint`)}
                      checked={Boolean(tasks[choice.capability])}
                      onChange={(checked) => toggleTask(choice.capability, checked)}
                    />
                  ))}
                  {shortcutChoices.map((choice) => (
                    <button key={choice.id} type="button" className="cw-welcome-option cw-welcome-task-card is-compact"
                      ref={choice.id === "examples" ? exampleButton : undefined}
                      aria-labelledby={`${fieldGroup}-${choice.id}`}
                      aria-describedby={`${fieldGroup}-${choice.id}-hint`}
                      onClick={() => {
                        setTaskError("");
                        if (choice.id === "import") filePicker.current?.click();
                        else void runTask("examples", onExamples);
                      }}>
                      <span key={choice.id === "import" ? importReturns : choice.id}
                        className={`cw-welcome-task-icon${choice.id === "import" && importReturns > 0 ? " cw-welcome-file-return" : ""}`}>
                        <CanvasIcon name={choice.icon} size={24} />
                      </span>
                      <span>
                        <strong id={`${fieldGroup}-${choice.id}`}>{t(`firstRun.${choice.id}.title`)}</strong>
                        <small id={`${fieldGroup}-${choice.id}-hint`}>{t(`firstRun.${choice.id}.hint`)}</small>
                      </span>
                      <span className="cw-welcome-shortcut-arrow"><CanvasIcon name="chevronRight" size={16} /></span>
                    </button>
                  ))}
                </fieldset>
                <input type="file" ref={filePicker} multiple hidden onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  if (files.length) void runTask("import", () => onImport(files));
                  else setImportReturns((count) => count + 1);
                }} />
                <p className="cw-welcome-feedback cw-welcome-task-feedback" role="status">
                  {taskAction && <span key={taskAction} className="cw-welcome-pending">
                    {downloadingExample
                      ? exampleProgress === null
                        ? t("canvas.example.state.downloading")
                        : t("canvas.example.state.downloadingPercent", { percent: exampleProgress })
                      : taskAction === "examples" && exampleStatus?.phase === "importing"
                        ? t("canvas.example.state.importing")
                        : t(taskProgressKeys[taskAction])}
                  </span>}
                </p>
                {downloadingExample && (
                  <div className="cw-welcome-actions cw-welcome-example-controls">
                    <progress className="cw-example-progress" aria-label={t("canvas.example.progress.label")}
                      {...(exampleProgress === null ? {} : { value: exampleProgress, max: 100 })} />
                    <button className="cw-welcome-secondary" onClick={onCancelExample}>{t("canvas.example.action.cancelDownload")}</button>
                  </div>
                )}
                {!taskAction && exampleStatus?.phase === "failed" && (
                  <div className="cw-welcome-actions cw-welcome-example-controls">
                    <p className="cw-welcome-feedback" role="alert">{exampleFailureText(t, exampleStatus)}</p>
                    <button className="cw-welcome-secondary" disabled={taskDisabled}
                      onClick={() => void runTask("examples", onExamples)}>{t("canvas.example.action.retry")}</button>
                  </div>
                )}
                {taskError && <p className="cw-welcome-feedback" role="alert">{taskError}</p>}
                {selected.map(({ capability, task, ready, blocked, model }) => {
                  const modelLabel = t(`firstRun.capability.${capability}`);
                  const sectionTitle = t("firstRun.configureModel", { model: modelLabel });
                  return (
                    <section key={capability} className="cw-welcome-setup cw-welcome-task-setup" aria-label={sectionTitle}
                      inert={Boolean(taskAction) || (lockedEditor !== null && lockedEditor !== capability)}>
                      <div key={task.type} className="cw-welcome-task-detail">
                        {task.type === "configure" ? <>
                          <h2 data-first-run-configuration={capability}>{sectionTitle}</h2>
                          {modelForm({ capability, existing: task.existing })}
                        </> : <>
                          {unavailableModels(blocked, capability)}
                          {ready.length === 0 && blocked.length === 0 && (
                            <p className="cw-welcome-feedback">{t("firstRun.needModel", { model: modelLabel })}</p>
                          )}
                          <div className="cw-welcome-actions cw-welcome-task-models">
                            {ready.length > 0 && (
                              <label>
                                <span>{t("firstRun.selectTaskModel", { model: modelLabel })}</span>
                                <select
                                  value={model?.id ?? ""}
                                  disabled={taskDisabled}
                                  onChange={(event) => {
                                    const id = event.currentTarget.value;
                                    setTaskError("");
                                    setModelSelections(previous => ({ ...previous, [capability]: id }));
                                  }}
                                >
                                  <option value="" disabled>{t("firstRun.selectModelPlaceholder")}</option>
                                  {ready.map(item => <option key={item.id} value={item.id}>{item.modelId}</option>)}
                                </select>
                              </label>
                            )}
                            <button type="button" className="cw-welcome-secondary" disabled={taskDisabled} onClick={() => editModel({ capability })}>
                              {t("firstRun.addModel")}
                            </button>
                          </div>
                        </>}
                      </div>
                    </section>
                  );
                })}
                {selected.length > 0 && catalog.availabilityError && <p className="cw-welcome-feedback" role="alert">{catalog.availabilityError}</p>}
                <div className="cw-welcome-actions cw-welcome-task-actions">
                  <button className="cw-welcome-secondary" disabled={Boolean(taskAction) || openEditors.length > 0} onClick={() => navigate("assistant")}>
                    {t("firstRun.back")}
                  </button>
                  {selected.length > 0 && (
                    <button className="cw-welcome-primary"
                      disabled={!assistant || taskDisabled || openEditors.length > 0 || selected.length !== selections.length}
                      onClick={() => void runTask("create", () => onCreate(selections))}>
                      {t("firstRun.start")}
                    </button>
                  )}
                </div>
              </>
            )}
            {catalogFeedback}
          </div>
        </main>}
      </div>
    </dialog>
  );
}
