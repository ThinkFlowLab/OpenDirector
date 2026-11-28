import { availabilitySummary } from "./availabilityPresentation.ts";
import { VoiceLibrary } from "./VoiceLibrary";
import { modelDescription } from "./modelDescriptions";
import { SearchableSelect } from "./SearchableSelect";
import { providerLabel } from "./providerPresets";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  normalizeContent,
  presetOnlyContent,
  type ReferenceContent,
} from "./chatReferenceContent.ts";
import { generationContent } from "./generationReferenceContent.ts";
import {
  presetImageTitles,
  presetPart,
  presetSkillText,
  promptWithPreset,
  supportsFaceEmphasis,
  withPresetPart,
  type PromptSkillPreset,
} from "./promptSkill.ts";
import { translateToolText } from "./toolText.ts";
import type { MessageKey } from "../i18n/types.ts";

import type { CanvasNode, CanvasNodeData, GenerationSettings } from "./model";
import { LOCAL_DEMO_MODEL } from "./model";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { ComposerPopover } from "./ComposerPopover";
import { DurationControl } from "./DurationControl";
import { ReferenceThumbnail } from "./ReferenceThumbnail";
import {
  h3FrameCount,
  changeGenerationSettings,
  generationBlocker,
  generationModel,
  generationReferenceIssue,
  generationReferenceRole,
  GENERATION_RATIOS,
} from "./generationCatalog.ts";
import {
  backendBlocker,
  referenceBudgetIssue,
  backendModel,
  backendResolutions,
  backendDurations,
  serviceGenerationSettings,
  backendAspectRatios,
  backendReferenceIssue,
  backendReferences,
  modelLabel,
  isGenerationModel,
  isMusicModel,
  hasMusicReference,
  hasImplicitTextPrompt,
  MUSIC_SECONDS,
  type ModelConfig,
} from "../backend/rules.ts";
import { resolveGenerationModel } from "./modelResolution.ts";
import { GenerationComposerShell } from "./GenerationComposerShell";
import { useI18n } from "../i18n/I18nProvider";
import {
  generationEditIdentity,
  getNodeGenerationSettings,
} from "./generationSettings.ts";
import { AssetMedia } from "./useAssetMedia.tsx";
export { getNodeGenerationSettings };
import {
  GenerationReferenceEditor,
  type GenerationReferenceHandle,
  type GenerationReferenceControls,
} from "./GenerationReferenceEditor";
import "./nodes.css";
import {
  frameImageLimitIssue,
  frameImageLimitMessage,
} from "./frameReferences.ts";
import { composerReferenceVisibility } from "./composerReferenceVisibility.ts";

export interface NodeComposerProps {
  selectedNode: CanvasNode | null;
  incomingNodes: CanvasNode[];
  /** Pinned assets included in run-before reference checks, not frame-slot limits. */
  pinnedPrecheck?: CanvasNode[];
  /** Images available for the preset preview, including sources hidden on the canvas. */
  presetSources?: readonly CanvasNode[];
  onUpdate: (data: Partial<CanvasNodeData>) => void;
  onRun: () => void;
  lastOptimizedText?: string;
  onPromptOptimized?: (text: string) => void;
  onOptimizePrompt?: (
    data: { prompt: string; inlineReferences: string[] },
    signal: AbortSignal,
  ) => Promise<{ prompt: string; audioOmitted: boolean }>;
  onCancel: () => void;
  onPickReference: () => void;
  /** Failures and warnings worth a canvas toast instead of an inline note. */
  onOptimizationNotice?: (message: string, error: boolean) => void;
  running?: boolean;
  /** Image presets published by the tool catalog; applied as prompt skills. */
  imagePresets?: readonly PromptSkillPreset[];

  /** Models configured in the local API, usable alongside the catalog. */
  backendModels?: readonly ModelConfig[];
  onCheckModels?: (ids: readonly string[]) => Promise<void>;
  removeWatermark?: boolean;
  referenceControls?: GenerationReferenceControls;
  /** Opens model settings on the category the node needs when none is configured. */
  onConfigureModel?: (kind: "image" | "video" | "audio") => void;
}

export type ComposerSettings = GenerationSettings;
const ratios = GENERATION_RATIOS;
type Panel = "parameters" | "duration" | "voices" | null;
/** 239 s → "3:59", for reference lengths. */
function clockTime(seconds: number) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Built-in demo voice id; the visible label is localized separately. */
const DEMO_VOICE = "动漫海绵";

/** Help shown beside a preset chip while the prompt is empty. */
const PRESET_HELP: Record<string, { description: MessageKey; ratios: readonly string[] }> = {
  "three-view": { description: "generation.preset.description.three-view", ratios: ["16:9", "3:2"] },
  "four-view": { description: "generation.preset.description.four-view", ratios: ["21:9", "16:9", "3:2"] },
  "face-three-view": { description: "generation.preset.description.face-three-view", ratios: ["21:9", "16:9", "3:2"] },
  "product-three-view": { description: "generation.preset.description.product-three-view", ratios: ["16:9", "3:2"] },
  storyboard: { description: "generation.preset.description.storyboard", ratios: ["16:9", "3:2"] },
  "multi-camera": { description: "generation.preset.description.multi-camera", ratios: ["16:9", "3:2"] },
};

export function NodeComposer({
  selectedNode,
  incomingNodes,
  pinnedPrecheck,
  presetSources,
  onUpdate,
  onRun,
  lastOptimizedText,
  onPromptOptimized,
  onOptimizePrompt,
  onCancel,
  onPickReference,
  onOptimizationNotice,
  running = false,
  imagePresets = [],
  backendModels = [],
  onCheckModels,
  removeWatermark = false,
  referenceControls,
  onConfigureModel,
}: NodeComposerProps) {
  const { t, locale } = useI18n();
  const [openPanel, setPanel] = useState<Panel>(null);
  const visibleModelIds = backendModels
    .filter((item) => item.kind === selectedNode?.data.kind)
    .map((item) => item.id)
    .join(",");
  useEffect(() => {
    if (selectedNode && visibleModelIds)
      void onCheckModels?.(visibleModelIds.split(","));
  }, [selectedNode?.id, visibleModelIds, onCheckModels]);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelAnchor = useRef<HTMLElement | null>(null);
  const mentions = useRef<GenerationReferenceHandle>(null);
  const pendingOptimization = useRef<AbortController | null>(null);
  const restoreFocus = useRef(false);
  const [optimizing, setOptimizing] = useState(false);
  /** Preset popovers hold their own anchor: they are not composer panels. */
  const [presetPromptAnchor, setPresetPromptAnchor] =
    useState<HTMLElement | null>(null);
  const [presetTuneAnchor, setPresetTuneAnchor] = useState<HTMLElement | null>(
    null,
  );
  const [presetCopied, setPresetCopied] = useState(false);
  /** Hover hint for the preset selector, anchored to its own rect. */
  const [presetHint, setPresetHint] = useState<HTMLElement | null>(
    null,
  );
  const presetHintId = useId();
  const presetHintElement = useRef<HTMLDivElement>(null);
  const presetHintEnabled = selectedNode?.type === "image" && !running && !optimizing;
  const presetValue = selectedNode?.type === "image"
    ? selectedNode.data.settings?.imagePreset ?? "none"
    : "none";
  const panel = running || optimizing ? null : openPanel;
  const [optimizedText, setOptimizedText] = useState(lastOptimizedText);
  const latestRunning = useRef(running);
  latestRunning.current = running;
  const optimizationDraft = useRef("");
  useEffect(
    () => () => {
      pendingOptimization.current?.abort();
      pendingOptimization.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    if (optimizing || !restoreFocus.current) return;
    restoreFocus.current = false;
    mentions.current?.focusPrompt();
  }, [optimizing]);
  useEffect(() => {
    setPanel(null);
  }, [selectedNode?.id, running]);
  useEffect(() => {
    setPresetHint(null);
  }, [selectedNode?.id, presetHintEnabled]);
  useLayoutEffect(() => {
    const tip = presetHintElement.current;
    if (!presetHintEnabled || !presetHint || !tip) return;
    const anchor = presetHint.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();
    const left = anchor.left + (anchor.width - width) / 2;
    const top = anchor.top - height - 8;
    tip.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, left))}px`;
    tip.style.top = `${Math.max(12, Math.min(innerHeight - height - 12, top >= 12 ? top : anchor.bottom + 8))}px`;
    const hide = () => setPresetHint(null);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [presetHint, presetHintEnabled, t]);
  useEffect(() => {
    setPresetPromptAnchor(null);
    setPresetTuneAnchor(null);
  }, [selectedNode?.id, presetValue, running]);

  if (
    !selectedNode ||
    !["image", "video", "audio"].includes(selectedNode.data.kind)
  )
    return null;
  const settings = getNodeGenerationSettings(selectedNode, backendModels);
  const mode = settings.mode;
  const canOptimizeKind = mode === "image" || mode === "video";
  const draft = canOptimizeKind
    ? generationContent(selectedNode, incomingNodes)
    : [];
  const promptText = (content: ReferenceContent) =>
    content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
  const inputText = promptText(draft);
  optimizationDraft.current = canOptimizeKind
    ? generationEditIdentity(selectedNode, draft)
    : "";
  const canOptimize = Boolean(
    onOptimizePrompt &&
    inputText.trim() &&
    inputText !== optimizedText &&
    !running &&
    !optimizing,
  );
  /** The text still is exactly what the last optimization produced. */
  const alreadyOptimized = Boolean(
    optimizedText && inputText.trim() && inputText === optimizedText,
  );
  const optimize = async () => {
    const before = mentions.current?.promptContent();
    if (
      !onOptimizePrompt ||
      !canOptimize ||
      pendingOptimization.current ||
      !before
    )
      return;
    const identity = optimizationDraft.current;
    const references: Extract<
      ReferenceContent[number],
      { type: "reference" }
    >[] = [];
    const prompt = before
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type !== "reference") return "";
        references.push(part);
        return `[[OD_REF_${references.length}]]`;
      })
      .join("");
    const inlineReferences = references.map(
      (part) =>
        part.referenceId ??
        (part.nodeId ? referenceControls?.referenceId(part.nodeId) : undefined),
    );
    if (inlineReferences.some((id) => !id)) {
      onOptimizationNotice?.(t("generation.optimize.changed"), true);
      return;
    }
    const controller = new AbortController();
    pendingOptimization.current = controller;
    setPanel(null);
    setOptimizing(true);
    try {
      const result = await onOptimizePrompt(
        {
          prompt,
          inlineReferences: inlineReferences.filter((id): id is string =>
            Boolean(id),
          ),
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (latestRunning.current || optimizationDraft.current !== identity)
        throw new Error(t("generation.optimize.changed"));
      const output: ReferenceContent = result.prompt
        .split(/(\[\[OD_REF_[1-9][0-9]*\]\])/)
        .flatMap<ReferenceContent[number]>((text) => {
          const index = /^\[\[OD_REF_(\d+)\]\]$/.exec(text)?.[1];
          if (!index) return text ? [{ type: "text" as const, text }] : [];
          const reference = references[Number(index) - 1];
          return reference ? [reference] : [];
        });
      const rewritten = normalizeContent(withPresetPart(output, presetPart(before) ?? null));
      if (!mentions.current?.replacePrompt(rewritten))
        throw new Error(t("generation.optimize.changed"));
      const text = promptText(rewritten);
      setOptimizedText(text);
      onPromptOptimized?.(text);
      // The completion notice is the toast; only an omitted audio caveat is
      // extra, and it is a warning rather than a failure.
      if (result.audioOmitted)
        onOptimizationNotice?.(t("generation.optimize.doneAudioOmitted"), false);
    } catch (error) {
      if (!controller.signal.aborted)
        onOptimizationNotice?.(
          error instanceof Error
            ? error.message
            : t("generation.optimize.failed"),
          true,
        );
    } finally {
      if (pendingOptimization.current === controller) {
        pendingOptimization.current = null;
        restoreFocus.current = true;
        setOptimizing(false);
      }
    }
  };
  const backend = Boolean(settings.modelConfigId);
  const config = backendModel(settings, backendModels);
  const voiceRequired = Boolean(config?.inputRules.voiceRequired);
  const voiceLibrary = config?.inputRules.voiceLibrary;
  const imageQualities =
    mode === "image" ? config?.inputRules.imageQualities : undefined;
  const serviceModels = backendModels.filter(
    (item) => item.kind === mode && isGenerationModel(item),
  );
  const resolution = resolveGenerationModel(settings, mode, backendModels);
  const unconfigured = resolution.status === "unconfigured";
  const referenceIssue = (node: CanvasNode) =>
    !backend
      ? generationReferenceIssue(node, settings, t)
      : config
        ? backendReferenceIssue(node, settings, config)
        : t("generation.model.unavailable");
  // The chip mirrors the saved preset and supplies its own prompt.
  const activePreset = mode === "image"
    ? imagePresets.find((item) => item.value === presetValue)
    : undefined;
  const faceEmphasis =
    settings.faceEmphasis === true && supportsFaceEmphasis(activePreset);
  const presetPromptText = activePreset
    ? presetSkillText(
        activePreset,
        presetImageTitles(settings, presetSources ?? [...incomingNodes, ...(pinnedPrecheck ?? [])], config),
        faceEmphasis,
      )
    : "";
  const checkedSettings = {
    ...settings,
    prompt: promptWithPreset(settings.prompt, presetPromptText),
  };
  const blocker = unconfigured
    ? t("generation.model.unconfigured")
    : backend
      ? backendBlocker(checkedSettings, incomingNodes, backendModels, pinnedPrecheck)
      : generationBlocker(checkedSettings, incomingNodes, t);
  const canRun = !blocker;
  // A blank prompt falls back to connected text references.
  const implicitTextPrompt = Boolean(
    config &&
    hasImplicitTextPrompt(
      settings,
      [...incomingNodes, ...(pinnedPrecheck ?? [])],
      config,
    ),
  );
  const model = backend ? undefined : generationModel(settings);
  const resolutions = backend
    ? backendResolutions(settings, config, incomingNodes)
    : (model?.resolutions ?? []);
  const firstLast = mode === "video" && settings.videoMode === "first-last";
  // Service speech models only read text aloud.
  const music =
    mode === "audio" &&
    (backend
      ? Boolean(config && isMusicModel(config))
      : settings.audioCreationType === "music");
  const reading =
    mode === "audio" && !music && (backend || settings.audioMode === "tts");
  // YuE2-style music models can follow one connected recording.
  const musicReferences =
    music && Boolean(config?.inputRules.allowedKinds.includes("audio"));
  const referenceVisibility = composerReferenceVisibility({
    firstLast,
    reading,
    music,
    musicReferences,
    incomingCount: incomingNodes.length,
    mode,
  });
  const followsReference = Boolean(
    config && hasMusicReference(settings, incomingNodes, config),
  );
  const referenceSeconds = followsReference
    ? incomingNodes.find((node) => node.data.kind === "audio")?.data.media
        ?.durationSeconds
    : undefined;
  // New music nodes follow the reference length until the user turns it off.
  const lengthFromReference =
    followsReference && (settings.durationFromReference ?? true);
  const frameCandidates = incomingNodes.filter(
    (node) => node.data.kind === "image",
  );
  // H3 reference mode: any connected image can also be pinned at a moment of the output.
  // The boxes stay while a time is set, also after a change to a model or mode without keyframes:
  // otherwise the blocker would ask to clear times that nothing on screen can clear.
  const pinnableFrames =
    mode === "video" &&
    backend &&
    frameCandidates.length > 0 &&
    (settings.videoMode ?? "reference") === "reference" &&
    ((config?.inputRules.maxKeyframes ?? 0) > 0 ||
      frameCandidates.some((node) =>
        settings.pinnedFrames?.some((frame) => frame.nodeId === node.id),
      ));
  const serviceSeconds = backendDurations(config);
  const duration =
    backend && mode === "video"
      ? serviceSeconds.length
        ? { min: serviceSeconds[0]!, max: serviceSeconds.at(-1)!, step: 1 }
        : undefined
      : backend && music
        ? { min: MUSIC_SECONDS.min, max: MUSIC_SECONDS.max, step: 1 }
        : model?.duration;
  const serviceModes = config?.inputRules.videoModes ?? [];
  const supportsControl = mode === "video" && serviceModes.includes("control");
  // The adapter derives duration from the control clip and aligns to model frames.
  const followsControl =
    backend && mode === "video" && settings.videoMode === "control";
  const durationValues = followsControl
    ? []
    : backend && mode === "video"
      ? serviceSeconds
      : duration
        ? Array.from(
            {
              length:
                Math.floor((duration.max - duration.min) / duration.step) + 1,
            },
            (_, index) => duration.min + index * duration.step,
          )
        : [];
  const hasDurationPicker = supportsControl || durationValues.length > 0;
  const videoModes = [
    ["reference", t("generation.mode.reference")],
    ["first-last", t("generation.mode.firstLast")],
    ...(serviceModes.includes("continuation")
      ? [["continuation", t("generation.mode.continuation")] as const]
      : []),
    ...(serviceModes.includes("control")
      ? [["control", t("generation.mode.control")] as const]
      : []),
  ] as const;
  const modeUnsupported = (value: NonNullable<ComposerSettings["videoMode"]>) =>
    (value === "first-last" &&
      Boolean(
        frameImageLimitIssue(
          { ...settings, videoMode: "first-last" },
          incomingNodes,
        ),
      )) ||
    (backend
      ? !(value === "continuation" || value === "control"
          ? serviceModes.includes(value)
          : value === "first-last"
            ? serviceModes.includes("first_frame")
            : serviceModes.includes("reference") ||
              serviceModes.includes("first_frame"))
      : Boolean(model?.videoModes && !model.videoModes.includes(value)));
  const chooseModel = (value: string) => {
    const service = serviceModels.find((item) => `config:${item.id}` === value);
    if (!service) {
      updateSettings({
        model: value,
        modelConfigId: undefined,
        ...(settings.videoMode === "continuation" ||
        settings.videoMode === "control"
          ? { videoMode: "reference" as const }
          : {}),
      });
      return;
    }
    const selected = serviceGenerationSettings(
      { ...settings, model: modelLabel(service), modelConfigId: service.id },
      service,
      incomingNodes,
      true,
    );
    updateSettings(selected);
  };
  const updateSettings = (patch: Partial<ComposerSettings>) => {
    if (pendingOptimization.current) return;
    const next = changeGenerationSettings(settings, patch);
    const target = backendModel(next, backendModels);
    onUpdate({
      settings: target
        ? serviceGenerationSettings(next, target, incomingNodes)
        : next,
    });
  };
  const presetHelp = activePreset ? PRESET_HELP[activePreset.value] : undefined;
  const availableRatios = config ? backendAspectRatios(settings, config) : undefined;
  const recommendedRatio = availableRatios
    ? presetHelp?.ratios.find((ratio) => availableRatios.includes(ratio))
    : presetHelp?.ratios[0];
  const presetDescription = presetHelp
    ? [
        t(presetHelp.description),
        ...(recommendedRatio
          ? [t("generation.preset.description.recommendedRatio", { ratio: recommendedRatio })]
          : []),
        ...(faceEmphasis
          ? [t("generation.preset.description.faceEmphasis")]
          : []),
      ].join(locale === "zh-CN" ? "" : " ")
    : "";
  const applyPreset = (value: string) => {
    setPanel(null);
    setPresetPromptAnchor(null);
    setPresetTuneAnchor(null);
    updateSettings({ imagePreset: value, faceEmphasis: false });
  };
  const toggleFaceEmphasis = () => {
    if (!activePreset) return;
    updateSettings({ faceEmphasis: !faceEmphasis });
  };
  const togglePanel = (next: Panel, anchor: HTMLElement) => {
    panelAnchor.current = anchor;
    setPanel((current) => (current === next ? null : next));
  };
  const insertReference = (node: CanvasNode) => mentions.current?.insert(node);
  const popoverProps = {
    anchor: panelAnchor.current,
    composer: rootRef.current,
    onClose: () => setPanel(null),
  };

  return (
    <GenerationComposerShell
      composerRef={rootRef}
      label={t("generation.composer.title", {
        title: selectedNode.data.title,
      })}
      running={running || optimizing}
      optimizing={optimizing}
      onEscape={() => {
        setPanel(null);
        pendingOptimization.current?.abort();
      }}
    >
      <div className="cw-composer-body">
        {firstLast && (
          <div
            className="cw-frame-slots"
            aria-label={t("generation.frame.title")}
          >
            {(
              [
                ["firstFrameNodeId", t("generation.frame.first")],
                ["lastFrameNodeId", t("generation.frame.last")],
              ] as const
            ).map(([field, label], index) => {
              const id = settings[field];
              const node = frameCandidates.find((item) => item.id === id);
              const blocked =
                backend &&
                field === "lastFrameNodeId" &&
                !config?.inputRules.frameRoles?.includes("last_frame");
              const unavailable = Boolean(
                id && (!node?.data.src || node.data.assetState === "missing"),
              );
              const offCanvas =
                !!id &&
                !!referenceControls &&
                !referenceControls.visibleNodes.some(
                  (source) => source.id === id,
                );
              return (
                <div
                  key={field}
                  className={`cw-frame-slot${index === 1 ? " cw-frame-last" : ""}${unavailable ? " cw-frame-unavailable" : ""}${blocked && !id ? " cw-frame-disabled" : ""}${offCanvas ? " is-off-canvas" : ""}`}
                  title={
                    offCanvas ? t("generation.frame.offCanvas") : undefined
                  }
                >
                  <span className="cw-frame-thumbnail">
                    {node?.data.src && node.data.assetState !== "missing" ? (
                      <AssetMedia
                        as="img"
                        src={node.data.src}
                        alt={`${label}：${node.data.title}`}
                        draggable={false}
                      />
                    ) : (
                      <CanvasIcon name="plus" size={20} />
                    )}
                  </span>
                  <select
                    aria-label={t("generation.frame.select", { label })}
                    value={id ?? ""}
                    disabled={running || (blocked && !id)}
                    title={
                      blocked
                        ? t("generation.frame.onlyFirst")
                        : unavailable
                          ? t("generation.frame.sourceUnavailable", { label })
                          : node
                            ? t("generation.frame.chooseImageTitle", {
                                label,
                                title: node.data.title,
                              })
                            : t("generation.frame.chooseImage", { label })
                    }
                    onChange={(event) =>
                      event.target.value === "__add_reference__"
                        ? onPickReference()
                        : updateSettings({
                            [field]: event.target.value || undefined,
                          })
                    }
                  >
                    <option value="">{t("generation.frame.noUse")}</option>
                    {id && !node && (
                      <option value={id}>
                        {t("generation.frame.missingOriginal")}
                      </option>
                    )}
                    {frameCandidates.map((item) => (
                      <option
                        key={item.id}
                        value={item.id}
                        disabled={
                          blocked ||
                          !item.data.src ||
                          item.data.assetState === "missing"
                        }
                      >
                        {item.data.title}
                        {!item.data.src || item.data.assetState === "missing"
                          ? t("generation.frame.unavailableTag")
                          : ""}
                      </option>
                    ))}
                    <option value="__add_reference__" disabled={blocked}>
                      {t("generation.frame.addImage")}
                    </option>
                  </select>
                </div>
              );
            })}
            <TooltipButton
              type="button"
              className="cw-frame-swap"
              aria-label={t("generation.frame.swap")}
              label={t("generation.frame.swapHint")}
              disabled={
                running ||
                !settings.firstFrameNodeId ||
                !settings.lastFrameNodeId ||
                [settings.firstFrameNodeId, settings.lastFrameNodeId].some(
                  (id) =>
                    !frameCandidates.some(
                      (node) =>
                        node.id === id &&
                        node.data.src &&
                        node.data.assetState !== "missing",
                    ),
                )
              }
              onClick={() =>
                updateSettings({
                  firstFrameNodeId: settings.lastFrameNodeId,
                  lastFrameNodeId: settings.firstFrameNodeId,
                })
              }
            >
              <CanvasIcon name="swapHorizontal" size={16} />
            </TooltipButton>
          </div>
        )}
        {pinnableFrames && (
          <div className="cw-keyframes" aria-label={t("generation.keyframes.title")}>
            <span className="cw-keyframes-title">{t("generation.keyframes.title")}</span>
            {frameCandidates.map((node) => {
              const pinned = settings.pinnedFrames?.find((frame) => frame.nodeId === node.id);
              const usable = node.data.src && node.data.assetState !== "missing";
              const name = node.data.title || t("generation.keyframes.untitled");
              return (
                <label
                  key={node.id}
                  className={`cw-keyframe${pinned ? " is-pinned" : ""}`}
                  title={name}
                >
                  <span className="cw-frame-thumbnail">
                    {usable ? (
                      <AssetMedia as="img" src={node.data.src!} alt={name} draggable={false} />
                    ) : (
                      <CanvasIcon name="plus" size={20} />
                    )}
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={settings.durationSeconds}
                    step={0.1}
                    value={pinned?.seconds ?? ""}
                    placeholder={t("generation.keyframes.placeholder")}
                    aria-label={t("generation.keyframes.time", { title: name })}
                    disabled={running || !usable}
                    onChange={(event) => {
                      const text = event.target.value.trim();
                      const seconds = Number(text);
                      const others = (settings.pinnedFrames ?? []).filter((frame) => frame.nodeId !== node.id);
                      const next =
                        text === "" || !Number.isFinite(seconds) || seconds < 0
                          ? others
                          : [...others, { nodeId: node.id, seconds }];
                      updateSettings({ pinnedFrames: next.length ? next : undefined });
                    }}
                  />
                  <span className="cw-keyframe-unit">{t("generation.keyframes.unit")}</span>
                </label>
              );
            })}
          </div>
        )}
        {referenceVisibility.showStrip && (
          <div className="cw-reference-strip">
            <TooltipButton
              type="button"
              className="cw-add-reference"
              disabled={running || optimizing}
              onClick={() => mentions.current?.openUpload()}
              aria-label={t("generation.reference.add")}
              label={t("generation.reference.add")}
            >
              <CanvasIcon name="plus" size={20} />
            </TooltipButton>
            {incomingNodes.map((node) => (
              <ReferenceThumbnail
                key={node.id}
                node={node}
                onInsert={() => insertReference(node)}
                onRemove={() => mentions.current?.remove(node)}
                disabled={
                  running || optimizing || Boolean(referenceIssue(node))
                }
                removalDisabled={running || optimizing}
                title={`${t("generation.reference.title", {
                  role: generationReferenceRole(node, t),
                  title: node.data.title,
                })}${referenceIssue(node) ? ` · ${referenceIssue(node)}` : ""}`}
              />
            ))}
          </div>
        )}
        {referenceVisibility.showReadingContextNote && (
          <p
            className="cw-reference-context-note"
            data-reference-role="reading-context"
          >
            {t("generation.reference.readingContext")}
          </p>
        )}
        <GenerationReferenceEditor
          key={selectedNode.id}
          pickerRef={mentions}
          node={selectedNode}
          incoming={incomingNodes}
          controls={referenceControls}
          issue={referenceIssue}
          validate={(sources) => {
            const frameIssue = frameImageLimitIssue(settings, sources);
            if (frameIssue) return frameIssue;
            if (!config) return null;
            return referenceBudgetIssue(sources, config, settings);
          }}
          onUpdate={onUpdate}
          running={running || optimizing}
          presetNote={
            activePreset && presetOnlyContent(draft) ? presetDescription : undefined
          }
          preset={activePreset ? {
            type: "skill", name: activePreset.label, preset: activePreset.value,
            ...(faceEmphasis ? { faceEmphasis: true } : {}),
          } : undefined}
          presetLabel={
            activePreset
              ? faceEmphasis
                ? t("generation.preset.labelWithEmphasis", {
                    preset: translateToolText(locale, activePreset.label),
                    emphasis: t("generation.preset.faceEmphasis"),
                  })
                : translateToolText(locale, activePreset.label)
              : undefined
          }
          presetTunable={supportsFaceEmphasis(activePreset)}
          presetTuneOpen={Boolean(presetTuneAnchor)}
          onPresetAction={(action, element) => {
            setPresetCopied(false);
            if (action === "tune") {
              setPresetPromptAnchor(null);
              setPresetTuneAnchor((anchor) => anchor === element ? null : element);
            } else {
              setPresetTuneAnchor(null);
              setPresetPromptAnchor(element);
            }
          }}
          onRun={() => {
            if (canRun && !running && !pendingOptimization.current) onRun();
          }}
          label={
            reading
              ? t("generation.prompt.reading")
              : music
                ? t("generation.prompt.music")
                : t("generation.prompt.image")
          }
          placeholder={
            // The preset summary stands in for the hint while the prompt is empty.
            activePreset && presetOnlyContent(draft)
              ? ""
              : implicitTextPrompt
                ? t("generation.prompt.implicitTextPlaceholder")
                : mode === "image"
                  ? t("generation.prompt.imagePlaceholder")
                  : mode === "video"
                    ? firstLast
                      ? t("generation.prompt.videoPlaceholder")
                      : t("generation.prompt.videoReferencePlaceholder")
                    : reading
                      ? t("generation.prompt.readingPlaceholder")
                      : music
                        ? t("generation.prompt.musicPlaceholder")
                        : t("generation.prompt.audioPlaceholder")
          }
        />
        {presetPromptAnchor && activePreset && (
          <ComposerPopover
            anchor={presetPromptAnchor}
            composer={rootRef.current}
            className="cw-preset-popover"
            label={translateToolText(locale, activePreset.label)}
            onClose={() => setPresetPromptAnchor(null)}
          >
            <div className="cw-preset-popover-head">
              <strong>
                {t("generation.preset.promptTitle", {
                  preset: translateToolText(locale, activePreset.label),
                })}
              </strong>
              <TooltipButton
                type="button"
                className="cw-preset-popover-copy"
                label={
                  presetCopied
                    ? t("generation.preset.copied")
                    : t("generation.preset.copy")
                }
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(presetPromptText)
                    .then(() => setPresetCopied(true))
                    .catch(() => setPresetCopied(false));
                }}
              >
                <CanvasIcon name={presetCopied ? "check" : "copy"} size={14} />
              </TooltipButton>
              <TooltipButton
                type="button"
                className="cw-preset-popover-close"
                label={t("generation.preset.close")}
                onClick={() => setPresetPromptAnchor(null)}
              >
                <CanvasIcon name="close" size={14} />
              </TooltipButton>
            </div>
            <div className="cw-preset-popover-body">{presetPromptText}</div>
          </ComposerPopover>
        )}
        {!running && !optimizing && presetTuneAnchor?.isConnected &&
          activePreset &&
          supportsFaceEmphasis(activePreset) && (
            <ComposerPopover
              anchor={presetTuneAnchor}
              composer={rootRef.current}
              className="cw-preset-popover cw-preset-tune"
              label={t("generation.preset.tune")}
              placement="above-anchor"
              onClose={() => setPresetTuneAnchor(null)}
            >
              <div className="cw-preset-tune-row">
                <span>{t("generation.preset.faceEmphasis")}</span>
                <TooltipButton
                  type="button"
                  className="cw-preset-tune-switch"
                  role="switch"
                  aria-checked={faceEmphasis}
                  label={t("generation.preset.faceEmphasis")}
                  // The switch belongs to the popover: clicking it must not
                  // take focus, which would pull the caret into the prompt.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={toggleFaceEmphasis}
                >
                  <span />
                </TooltipButton>
              </div>
            </ComposerPopover>
          )}
        {optimizing && (
          <p className="cw-composer-provider-note" role="status">
            <span className="cw-optimizing-blink">
              {t("generation.optimize.running")}
            </span>
          </p>
        )}
        {backend && music && (
          <textarea
            className="cw-prompt-input cw-lyrics-input"
            aria-label={t("generation.lyrics")}
            value={settings.lyrics ?? ""}
            maxLength={5000}
            disabled={running || optimizing}
            spellCheck={false}
            placeholder={
              followsReference
                ? t("generation.lyricsReferencePlaceholder")
                : t("generation.lyricsPlaceholder")
            }
            onChange={(event) => updateSettings({ lyrics: event.target.value })}
          />
        )}
      </div>

      {removeWatermark &&
        ["bigmodel-glm-image", "bigmodel-cogvideox-3"].includes(
          config?.inputRules.profile ?? "",
        ) && (
          <p className="cw-composer-provider-note" role="note">
            {t("generation.bigmodel.watermarkWaiver")}
          </p>
        )}
      <div className="cw-composer-footer">
        <div className="cw-composer-options">
          {!serviceModels.length && onConfigureModel ? (
            <button
              type="button"
              className="cw-parameter-trigger cw-model-setup-trigger"
              disabled={running || optimizing}
              onClick={() => onConfigureModel(mode)}
            >
              <CanvasIcon name="model" size={15} />
              <span>
                {t(
                  mode === "video"
                    ? "modelSetup.videoAction"
                    : mode === "audio"
                      ? "modelSetup.audioAction"
                      : "modelSetup.imageAction",
                )}
              </span>
            </button>
          ) : (
            <SearchableSelect
              compact
              label={t("generation.model.select")}
              value={
                backend ? `config:${settings.modelConfigId}` : "unconfigured"
              }
              disabled={running || optimizing || serviceModels.length === 0}
              onChange={chooseModel}
              options={[
                ...(!serviceModels.length
                  ? [
                      {
                        id: "unconfigured",
                        name: t("generation.model.unconfiguredOption"),
                      },
                    ]
                  : []),
                ...(backend && !config
                  ? [
                      {
                        id: `config:${settings.modelConfigId}`,
                        name: `${
                          settings.model === LOCAL_DEMO_MODEL
                            ? t("generation.model.localDemo")
                            : settings.model
                        }${t("generation.model.unavailableTag")}`,
                      },
                    ]
                  : []),
                ...serviceModels.map((item) => ({
                  id: `config:${item.id}`,
                  name: modelLabel(item),
                  modelId: item.modelId,
                  description:
                    [
                      modelDescription(item),
                      availabilitySummary(item.availability),
                    ]
                      .filter(Boolean)
                      .join(" · ") || undefined,
                  group: providerLabel(item),
                })),
              ]}
            />
          )}
          <button
            type="button"
            className={`cw-parameter-trigger${panel === "parameters" ? " cw-is-active" : ""}`}
            aria-label={t("generation.field.signature")}
            disabled={running || optimizing}
            aria-expanded={panel === "parameters"}
            onClick={(event) => togglePanel("parameters", event.currentTarget)}
          >
            <CanvasIcon name="sliders" size={15} />
            <span>
              {mode === "audio"
                ? music
                  ? lengthFromReference
                    ? referenceSeconds
                      ? `${t("generation.field.followReference")} ${clockTime(referenceSeconds)}`
                      : t("generation.field.followReference")
                    : backend
                      ? t("generation.field.maxDurationSeconds", {
                          count: settings.durationSeconds,
                        })
                      : t("generation.duration.seconds", {
                          count: settings.durationSeconds,
                        })
                  : reading
                    ? t("generation.audioMode.tts")
                    : t("generation.audioMode.unified")
                : `${settings.aspectRatio === "auto" ? t("common.auto") : settings.aspectRatio} · ${settings.resolution === "auto" ? t("common.auto") : settings.resolution}${mode === "image" ? ` · ${t("generation.field.imageCount", { count: settings.count ?? 1 })}` : ""}`}
            </span>
          </button>
          <div className="cw-generation-mode-controls">
            {mode === "image" && (
              <span
                className="cw-preset-select"
                onPointerEnter={(event) => {
                  if (event.pointerType === "touch" || event.buttons) return;
                  if (presetHintEnabled) setPresetHint(event.currentTarget);
                }}
                onPointerLeave={() => setPresetHint(null)}
                onPointerDown={() => setPresetHint(null)}
              >
              <select
                aria-label={t("generation.imagePreset")}
                aria-describedby={presetHint && presetHintEnabled ? presetHintId : undefined}
                value={presetValue}
                disabled={running || optimizing}
                onFocus={(event) => {
                  if (presetHintEnabled && event.currentTarget.matches(":focus-visible"))
                    setPresetHint(event.currentTarget);
                }}
                onBlur={() => setPresetHint(null)}
                onKeyDown={() => setPresetHint(null)}
                onChange={(event) => applyPreset(event.target.value)}
              >
                <option value="none">{t("generation.preset.none")}</option>
                {imagePresets.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {translateToolText(locale, preset.label)}
                  </option>
                ))}
                {/* A draft saved before presets became prompt skills still
                    selects the legacy generation preset. */}
                {presetValue !== "none" && !activePreset && (
                  <option value={presetValue}>
                    {presetValue === "product-views" ? t("generation.preset.productViews") : presetValue}
                  </option>
                )}
              </select>
              </span>
            )}
            {mode === "video" && (
              <select
                aria-label={t("generation.videoMode")}
                value={settings.videoMode ?? "reference"}
                disabled={running || optimizing}
                onChange={(event) =>
                  updateSettings({
                    videoMode: event.target
                      .value as ComposerSettings["videoMode"],
                  })
                }
              >
                {videoModes.map(([value, label]) => (
                  <option
                    key={value}
                    value={value}
                    disabled={modeUnsupported(value)}
                    title={
                      value === "first-last" &&
                      frameImageLimitIssue(
                        { ...settings, videoMode: "first-last" },
                        incomingNodes,
                      )
                        ? frameImageLimitMessage()
                        : undefined
                    }
                  >
                    {value === "first-last" &&
                    frameImageLimitIssue(
                      { ...settings, videoMode: "first-last" },
                      incomingNodes,
                    )
                      ? t("generation.frame.limitTwo", { label })
                      : label}
                  </option>
                ))}
              </select>
            )}
            {followsReference && (
              <select
                aria-label={t("generation.referenceMode")}
                value={settings.scoreMode ?? "melody"}
                disabled={running || optimizing}
                onChange={(event) =>
                  updateSettings({
                    scoreMode: event.target
                      .value as ComposerSettings["scoreMode"],
                  })
                }
              >
                <option value="melody">
                  {t("generation.referenceMode.melody")}
                </option>
                <option value="full">
                  {t("generation.referenceMode.full")}
                </option>
              </select>
            )}
            {mode === "audio" && !backend && (
              <>
                <select
                  aria-label={t("generation.audioType")}
                  value={settings.audioCreationType ?? "audio"}
                  disabled={running || optimizing}
                  onChange={(event) =>
                    updateSettings({
                      audioCreationType: event.target
                        .value as ComposerSettings["audioCreationType"],
                    })
                  }
                >
                  <option value="audio">
                    {t("generation.audioType.audio")}
                  </option>
                  <option value="music">
                    {t("generation.audioType.music")}
                  </option>
                </select>
                {!music && (
                  <select
                    aria-label={t("generation.audioMode")}
                    value={settings.audioMode ?? "unified"}
                    disabled={running || optimizing}
                    onChange={(event) =>
                      updateSettings({
                        audioMode: event.target
                          .value as ComposerSettings["audioMode"],
                      })
                    }
                  >
                    <option value="unified">
                      {t("generation.audioMode.unified")}
                    </option>
                    <option value="tts">{t("generation.audioMode.tts")}</option>
                  </select>
                )}
              </>
            )}
            {mode === "audio" && backend && !music && !voiceLibrary && (
              <input
                aria-label={t(
                  voiceRequired
                    ? "generation.field.requiredVoiceId"
                    : "generation.field.voice",
                )}
                aria-required={voiceRequired || undefined}
                required={voiceRequired}
                value={settings.voiceName ?? ""}
                placeholder={t(
                  voiceRequired
                    ? "generation.field.voiceIdPlaceholder"
                    : "generation.field.defaultVoice",
                )}
                disabled={running || optimizing}
                spellCheck={false}
                onChange={(event) =>
                  updateSettings({
                    voiceName: event.target.value.trim() || undefined,
                  })
                }
              />
            )}
            {reading && (!backend || voiceLibrary) && (
              <button
                type="button"
                className="cw-voice-trigger"
                aria-label={t("generation.field.voiceLibrary")}
                disabled={running || optimizing}
                aria-expanded={panel === "voices"}
                onClick={(event) => togglePanel("voices", event.currentTarget)}
              >
                <CanvasIcon name="audio" size={15} />
                <span>
                  {settings.voiceSelection?.name ||
                    (!voiceLibrary && settings.voiceName) ||
                    t("generation.field.voiceLibrary")}
                </span>
                <CanvasIcon name="chevronDown" size={12} />
              </button>
            )}
          </div>
          {referenceVisibility.showEmptyAdd && (
            <TooltipButton
              type="button"
              className="cw-reference-trigger"
              aria-label={
                musicReferences
                  ? t("generation.reference.addMusic")
                  : t("generation.reference.add")
              }
              label={
                musicReferences
                  ? t("generation.reference.addMusic")
                  : t("generation.reference.add")
              }
              disabled={running || optimizing}
              onClick={() => mentions.current?.openUpload()}
            >
              <CanvasIcon name="plus" size={16} />
            </TooltipButton>
          )}
          {mode === "video" && (
            <button
              type="button"
              className={`cw-duration-trigger${panel === "duration" ? " cw-is-active" : ""}`}
              aria-label={t("generation.duration")}
              aria-haspopup="dialog"
              aria-expanded={panel === "duration"}
              disabled={running || optimizing || !hasDurationPicker}
              title={
                followsControl
                  ? t("generation.duration.followsControl")
                  : hasDurationPicker
                    ? t("generation.duration.choose")
                    : t("generation.duration.unavailable")
              }
              onClick={(event) => togglePanel("duration", event.currentTarget)}
            >
              <span>
                {followsControl
                  ? t("generation.duration.followsControl")
                  : durationValues.length
                    ? t("generation.duration.seconds", {
                        count: settings.durationSeconds,
                      })
                    : t("generation.duration.default")}
              </span>
              <CanvasIcon name="chevronDown" size={12} />
            </button>
          )}
          {referenceVisibility.showMention && (
            <TooltipButton
              type="button"
              className="cw-reference-trigger"
              aria-label={t("generation.reference.connected")}
              label={t("generation.reference.connected")}
              disabled={running || optimizing}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setPanel(null);
                mentions.current?.openPicker();
              }}
            >
              <span className="cw-reference-trigger-at">@</span>
            </TooltipButton>
          )}
          {canOptimizeKind && (
            <TooltipButton
              type="button"
              className="cw-reference-trigger cw-prompt-optimization"
              aria-label={t(
                alreadyOptimized
                  ? "generation.optimize.alreadyDone"
                  : "generation.optimize.action",
              )}
              label={t(
                alreadyOptimized
                  ? "generation.optimize.alreadyDone"
                  : "generation.optimize.action",
              )}
              aria-disabled={!canOptimize}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void optimize()}
            >
              <CanvasIcon name="promptWand" size={17} />
            </TooltipButton>
          )}
        </div>
        <TooltipButton
          type="button"
          className={`cw-run-button${running ? " cw-run-button-cancel" : ""}`}
          aria-label={
            running
              ? t("generation.action.cancel")
              : t("generation.action.submit")
          }
          label={
            running
              ? t("generation.action.cancel")
              : canRun
                ? backend
                  ? t("generation.action.submitLocal")
                  : t("generation.action.submitNoModel")
                : (blocker ?? t("generation.action.completeParams"))
          }
          shortcut={
            !running && canRun
              ? navigator.platform.includes("Mac")
                ? "⌘ Enter"
                : "Ctrl Enter"
              : undefined
          }
          disabled={optimizing || (!running && !canRun)}
          onClick={
            running
              ? onCancel
              : () => {
                  if (!pendingOptimization.current) onRun();
                }
          }
        >
          <CanvasIcon name={running ? "stop" : "arrowUp"} size={20} />
        </TooltipButton>
      </div>
      {panel === "duration" && mode === "video" && (
        <ComposerPopover
          {...popoverProps}
          className="cw-duration-popover"
          label={t("generation.duration.settings")}
          placement="above-anchor"
        >
          {supportsControl && (
            <label className="cw-audio-toggle cw-duration-follow-control">
              <span>{t("generation.duration.followsControl")}</span>
              <input
                type="checkbox"
                checked={followsControl}
                disabled={running || optimizing}
                onChange={(event) =>
                  updateSettings({
                    videoMode: event.target.checked ? "control" : "reference",
                  })
                }
              />
            </label>
          )}
          {durationValues.length > 0 && (
            <DurationControl
              fractional={!!config?.inputRules.fractionalDuration}
              outputFrames={
                config?.inputRules.profile === "vllm-omni-h3"
                  ? h3FrameCount(settings.durationSeconds)
                  : undefined
              }
              values={durationValues}
              value={settings.durationSeconds}
              disabled={running || optimizing}
              scale={{ min: 0, max: 30, step: 5 }}
              onChange={(durationSeconds) =>
                updateSettings({ durationSeconds })
              }
            />
          )}
        </ComposerPopover>
      )}
      {panel === "parameters" && (
        <ComposerPopover
          {...popoverProps}
          className="cw-parameters-popover"
          label={t("generation.params.settings")}
        >
          <div className="cw-popover-heading">
            <strong>{t("generation.field.signature")}</strong>
            <TooltipButton
              type="button"
              className="cw-icon-button"
              label={t("generation.params.close")}
              onClick={() => setPanel(null)}
            >
              <CanvasIcon name="close" size={15} />
            </TooltipButton>
          </div>
          {mode !== "audio" && (
            <div className="cw-parameter-section">
              <span className="cw-field-label">
                {t("generation.field.ratio")}
              </span>
              <div className="cw-ratio-options">
                {(backend ? ["auto", ...ratios] : ratios).map((ratio) => {
                  const [w, h] = ratio.split(":").map(Number);
                  return (
                    <button
                      type="button"
                      key={ratio}
                      disabled={
                        (backend &&
                          !backendAspectRatios(settings, config).includes(
                            ratio,
                          )) ||
                        (settings.imagePreset === "product-views" &&
                          ratio !== "16:9")
                      }
                      className={
                        settings.aspectRatio === ratio ? "cw-is-active" : ""
                      }
                      onClick={() => updateSettings({ aspectRatio: ratio })}
                      aria-pressed={settings.aspectRatio === ratio}
                    >
                      <span
                        className="cw-ratio-box"
                        style={{
                          width: `${ratio === "auto" ? 21 : Math.min(23, (21 * w!) / h!)}px`,
                          height: `${ratio === "auto" ? 21 : Math.min(23, (21 * h!) / w!)}px`,
                        }}
                      />
                      <span>{ratio === "auto" ? t("common.auto") : ratio}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {mode !== "audio" && (
            <div className="cw-parameter-section">
              <span className="cw-field-label">
                {t("generation.field.resolution")}
              </span>
              <div className="cw-segment-options">
                {resolutions.map((resolution) => (
                  <button
                    type="button"
                    key={resolution}
                    aria-label={t("generation.field.resolutionAria", {
                      value:
                        resolution === "auto" ? t("common.auto") : resolution,
                    })}
                    disabled={
                      settings.imagePreset === "product-views" &&
                      resolution !== "2K"
                    }
                    className={
                      settings.resolution === resolution ? "cw-is-active" : ""
                    }
                    onClick={() => updateSettings({ resolution })}
                    aria-pressed={settings.resolution === resolution}
                  >
                    {resolution === "auto" ? t("common.auto") : resolution}
                  </button>
                ))}
                {!resolutions.length && (
                  <span className="cw-parameter-unknown">
                    {t("generation.field.waitCapabilities")}
                  </span>
                )}
              </div>
            </div>
          )}
          {Boolean(imageQualities?.length) && (
            <div className="cw-parameter-section">
              <span className="cw-field-label">
                {t("generation.field.quality")}
              </span>
              <div className="cw-segment-options">
                {imageQualities?.map((quality) => (
                  <button
                    type="button"
                    key={quality}
                    aria-label={t("generation.field.qualityAria", {
                      value: t(`generation.quality.${quality}`),
                    })}
                    className={
                      (settings.imageQuality ?? "auto") === quality
                        ? "cw-is-active"
                        : ""
                    }
                    onClick={() => updateSettings({ imageQuality: quality })}
                    aria-pressed={(settings.imageQuality ?? "auto") === quality}
                  >
                    {t(`generation.quality.${quality}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {music && (
            <div className="cw-parameter-section">
              {followsReference && (
                <label className="cw-audio-toggle">
                  <span>
                    <CanvasIcon name="audio" size={16} />
                    {t("generation.field.followReference")}
                    {referenceSeconds
                      ? ` (${clockTime(referenceSeconds)})`
                      : ""}
                  </span>
                  <input
                    type="checkbox"
                    checked={lengthFromReference}
                    disabled={running || optimizing}
                    onChange={(event) =>
                      updateSettings({
                        durationFromReference: event.target.checked,
                      })
                    }
                  />
                </label>
              )}
              <span className="cw-field-label">
                {backend
                  ? t("generation.field.maxDuration")
                  : t("generation.field.duration")}
              </span>
              {duration ? (
                <DurationControl
                  values={durationValues}
                  value={settings.durationSeconds}
                  disabled={running || lengthFromReference}
                  scale={
                    backend
                      ? { min: 0, max: MUSIC_SECONDS.max, step: 60 }
                      : undefined
                  }
                  onChange={(durationSeconds) =>
                    updateSettings({ durationSeconds })
                  }
                />
              ) : (
                <span className="cw-parameter-unknown">
                  {t("generation.field.durationUnverified")}
                </span>
              )}
            </div>
          )}
          <div className="cw-parameter-section">
            <span className="cw-field-label">
              {t("generation.field.count")}
            </span>
            <div className="cw-count-options">
              {Array.from({ length: 8 }, (_, index) => index + 1).map(
                (count) => (
                  <button
                    type="button"
                    key={count}
                    disabled={
                      settings.imagePreset === "product-views" && count !== 1
                    }
                    className={settings.count === count ? "cw-is-active" : ""}
                    onClick={() => updateSettings({ count })}
                    aria-pressed={settings.count === count}
                  >
                    {count}
                  </button>
                ),
              )}
            </div>
          </div>
          {mode === "video" &&
            (!backend ||
              config?.protocol === "volcengine" ||
              config?.protocol === "higgsfield_open") && (
              <label className="cw-audio-toggle">
                <span>
                  <CanvasIcon name="volume" size={16} />
                  {backend
                    ? t("generation.field.audio")
                    : t("generation.field.audioPending")}
                </span>
                <input
                  type="checkbox"
                  checked={settings.audioEnabled}
                  onChange={(event) =>
                    updateSettings({ audioEnabled: event.target.checked })
                  }
                />
              </label>
            )}
        </ComposerPopover>
      )}

      {panel === "voices" && (
        <ComposerPopover
          {...popoverProps}
          className="cw-voices-popover"
          label={t("generation.field.voiceLibrary")}
        >
          {config && voiceLibrary ? (
            <VoiceLibrary
              key={`${config.id}:${voiceLibrary.connectionId}`}
              modelConfigId={config.id}
              capabilities={voiceLibrary}
              selected={settings.voiceSelection}
              onSelect={(voice) => {
                updateSettings({
                  voiceName: voice.voiceId,
                  voiceSelection: voice,
                });
                setPanel(null);
              }}
            />
          ) : (
            <>
              <div className="cw-popover-heading">
                <strong>{t("generation.field.voiceLibrary")}</strong>
                <TooltipButton
                  type="button"
                  className="cw-icon-button"
                  label={t("generation.voice.close")}
                  onClick={() => setPanel(null)}
                >
                  <CanvasIcon name="close" size={15} />
                </TooltipButton>
              </div>
              <button
                type="button"
                className={`cw-observed-voice${settings.voiceName === DEMO_VOICE ? " cw-is-active" : ""}`}
                aria-pressed={settings.voiceName === DEMO_VOICE}
                onClick={() => {
                  updateSettings({ voiceName: DEMO_VOICE });
                  setPanel(null);
                }}
              >
                <CanvasIcon name="audio" size={22} />
                <span>
                  <strong>{t("generation.voice.demo")}</strong>
                </span>
              </button>
            </>
          )}
        </ComposerPopover>
      )}
      {presetHint && presetHintEnabled &&
        createPortal(
          <div
            id={presetHintId}
            ref={presetHintElement}
            className="cw-tooltip"
            role="tooltip"
          >
            <span>{t("generation.preset.hint")}</span>
          </div>,
          document.body,
        )}
    </GenerationComposerShell>
  );
}

export default NodeComposer;
