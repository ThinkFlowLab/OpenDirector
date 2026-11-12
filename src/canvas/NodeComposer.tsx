import { VoiceLibrary } from "./VoiceLibrary";
import { modelDescription } from "./modelDescriptions";
import { SearchableSelect } from "./SearchableSelect";
import { providerLabel } from "./providerPresets";
import { useEffect, useRef, useState } from "react";
import type { CanvasNode, CanvasNodeData, GenerationSettings } from "./model";
import { LOCAL_DEMO_MODEL } from "./model";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { ComposerPopover } from "./ComposerPopover";
import { DurationControl } from "./DurationControl";
import { ReferenceThumbnail } from "./ReferenceThumbnail";
import {
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
  MUSIC_SECONDS,
  type ModelConfig,
} from "../backend/rules.ts";
import { resolveGenerationModel } from "./modelResolution.ts";
import { GenerationComposerShell } from "./GenerationComposerShell";
import { useI18n } from "../i18n/I18nProvider";
import { getNodeGenerationSettings } from "./generationSettings.ts";
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

export interface NodeComposerProps {
  selectedNode: CanvasNode | null;
  incomingNodes: CanvasNode[];
  onUpdate: (data: Partial<CanvasNodeData>) => void;
  onRun: () => void;
  onCancel: () => void;
  onPickReference: () => void;
  running?: boolean;
  /** Models configured in the local API, usable alongside the catalog. */
  backendModels?: readonly ModelConfig[];
  removeWatermark?: boolean;
  referenceControls?: GenerationReferenceControls;
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

export function NodeComposer({
  selectedNode,
  incomingNodes,
  onUpdate,
  onRun,
  onCancel,
  onPickReference,
  running = false,
  backendModels = [],
  removeWatermark = false,
  referenceControls,
}: NodeComposerProps) {
  const { t } = useI18n();
  const [openPanel, setPanel] = useState<Panel>(null);
  const panel = running ? null : openPanel;
  const rootRef = useRef<HTMLDivElement>(null);
  const panelAnchor = useRef<HTMLElement | null>(null);
  const mentions = useRef<GenerationReferenceHandle>(null);
  useEffect(() => {
    setPanel(null);
  }, [selectedNode?.id, running]);

  if (
    !selectedNode ||
    !["image", "video", "audio"].includes(selectedNode.data.kind)
  )
    return null;
  const settings = getNodeGenerationSettings(selectedNode, backendModels);
  const mode = settings.mode;
  const backend = Boolean(settings.modelConfigId);
  const config = backendModel(settings, backendModels);
  const voiceRequired = Boolean(config?.inputRules.voiceRequired);
  const voiceLibrary = config?.inputRules.voiceLibrary;
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
  const blocker = unconfigured
    ? t("generation.model.unconfigured")
    : backend
      ? backendBlocker(settings, incomingNodes, backendModels)
      : generationBlocker(settings, incomingNodes, t);
  const canRun = !blocker;
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
  const serviceSeconds = backendDurations(config);
  const duration =
    backend && mode === "video"
      ? serviceSeconds.length
        ? { min: serviceSeconds[0]!, max: serviceSeconds.at(-1)!, step: 1 }
        : undefined
      : backend && music
        ? { min: MUSIC_SECONDS.min, max: MUSIC_SECONDS.max, step: 1 }
        : model?.duration;
  const durationValues =
    backend && mode === "video"
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
  const serviceModes = config?.inputRules.videoModes ?? [];
  const videoModes = [
    ["reference", t("generation.mode.reference")],
    ["first-last", t("generation.mode.firstLast")],
    ...(serviceModes.includes("continuation")
      ? [["continuation", t("generation.mode.continuation")] as const]
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
      ? !(value === "continuation"
          ? serviceModes.includes("continuation")
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
        ...(settings.videoMode === "continuation"
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
    const next = changeGenerationSettings(settings, patch);
    const target = backendModel(next, backendModels);
    onUpdate({
      settings: target
        ? serviceGenerationSettings(next, target, incomingNodes)
        : next,
    });
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
      running={running}
      onEscape={() => setPanel(null)}
    >
      <div className="cw-composer-body">
        {firstLast && (
          <div className="cw-frame-slots" aria-label={t("generation.frame.title")}>
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
                  title={offCanvas ? t("generation.frame.offCanvas") : undefined}
                >
                  <span className="cw-frame-thumbnail">
                    {node?.data.src && node.data.assetState !== "missing" ? (
                      <img
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
                      <option value={id}>{t("generation.frame.missingOriginal")}</option>
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
        {!firstLast &&
          !reading &&
          (!music || musicReferences) &&
          (mode === "video" || incomingNodes.length > 0) && (
            <div className="cw-reference-strip">
              <TooltipButton
                type="button"
                className="cw-add-reference"
                disabled={running}
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
                  disabled={running || Boolean(referenceIssue(node))}
                  removalDisabled={running}
                  title={`${t("generation.reference.title", {
                    role: generationReferenceRole(node, t),
                    title: node.data.title,
                  })}${referenceIssue(node) ? ` · ${referenceIssue(node)}` : ""}`}
                />
              ))}
            </div>
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
          running={running}
          onRun={() => {
            if (canRun && !running) onRun();
          }}
          label={reading ? t("generation.prompt.reading") : music ? t("generation.prompt.music") : t("generation.prompt.image")}
          placeholder={
            mode === "image"
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
        {backend && music && (
          <textarea
            className="cw-prompt-input cw-lyrics-input"
            aria-label={t("generation.lyrics")}
            value={settings.lyrics ?? ""}
            maxLength={5000}
            disabled={running}
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
        ["bigmodel-glm-image", "bigmodel-cogvideox-3"].includes(config?.inputRules.profile ?? "") && (
          <p className="cw-composer-provider-note" role="note">
            {t("generation.bigmodel.watermarkWaiver")}
          </p>
        )}
      <div className="cw-composer-footer">
        <div className="cw-composer-options">
          <SearchableSelect
            compact
            label={t("generation.model.select")}
            value={
              backend ? `config:${settings.modelConfigId}` : "unconfigured"
            }
            disabled={running || serviceModels.length === 0}
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
                description: modelDescription(item),
                group: providerLabel(item),
              })),
            ]}
          />
          <button
            type="button"
            className={`cw-parameter-trigger${panel === "parameters" ? " cw-is-active" : ""}`}
            aria-label={t("generation.field.signature")}
            disabled={running}
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
              <select
                aria-label={t("generation.imagePreset")}
                value={settings.imagePreset ?? "none"}
                disabled={running}
                onChange={(event) =>
                  updateSettings({
                    imagePreset: event.target
                      .value as ComposerSettings["imagePreset"],
                  })
                }
              >
                <option value="none">{t("generation.preset.none")}</option>
                <option
                  value="product-views"
                  disabled={backend || settings.model !== "Seedream 5.0 Pro"}
                >
                  {t("generation.preset.productViews")}
                </option>
              </select>
            )}
            {mode === "video" && (
              <select
                aria-label={t("generation.videoMode")}
                value={settings.videoMode ?? "reference"}
                disabled={running}
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
                disabled={running}
                onChange={(event) =>
                  updateSettings({
                    scoreMode: event.target
                      .value as ComposerSettings["scoreMode"],
                  })
                }
              >
                <option value="melody">{t("generation.referenceMode.melody")}</option>
                <option value="full">{t("generation.referenceMode.full")}</option>
              </select>
            )}
            {mode === "audio" && !backend && (
              <>
                <select
                  aria-label={t("generation.audioType")}
                  value={settings.audioCreationType ?? "audio"}
                  disabled={running}
                  onChange={(event) =>
                    updateSettings({
                      audioCreationType: event.target
                        .value as ComposerSettings["audioCreationType"],
                    })
                  }
                >
                  <option value="audio">{t("generation.audioType.audio")}</option>
                  <option value="music">{t("generation.audioType.music")}</option>
                </select>
                {!music && (
                  <select
                    aria-label={t("generation.audioMode")}
                    value={settings.audioMode ?? "unified"}
                    disabled={running}
                    onChange={(event) =>
                      updateSettings({
                        audioMode: event.target
                          .value as ComposerSettings["audioMode"],
                      })
                    }
                  >
                    <option value="unified">{t("generation.audioMode.unified")}</option>
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
                disabled={running}
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
                disabled={running}
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
          {!firstLast &&
            !reading &&
            (!music || musicReferences) &&
            incomingNodes.length === 0 && (
              <TooltipButton
                type="button"
                className="cw-reference-trigger"
                aria-label={musicReferences ? t("generation.reference.addMusic") : t("generation.reference.add")}
                label={musicReferences ? t("generation.reference.addMusic") : t("generation.reference.add")}
                disabled={running}
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
              disabled={running || !durationValues.length}
              title={
                !durationValues.length
                  ? t("generation.duration.unavailable")
                  : t("generation.duration.choose")
              }
              onClick={(event) => togglePanel("duration", event.currentTarget)}
            >
              <span>
                {durationValues.length
                  ? t("generation.duration.seconds", {
                      count: settings.durationSeconds,
                    })
                  : t("generation.duration.default")}
              </span>
              <CanvasIcon name="chevronDown" size={12} />
            </button>
          )}
          {!reading && !music && (
            <TooltipButton
              type="button"
              className="cw-reference-trigger"
              aria-label={t("generation.reference.connected")}
              label={t("generation.reference.connected")}
              disabled={running}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setPanel(null);
                mentions.current?.openPicker();
              }}
            >
              @
            </TooltipButton>
          )}
        </div>
        <TooltipButton
          type="button"
          className={`cw-run-button${running ? " cw-run-button-cancel" : ""}`}
          aria-label={running ? t("generation.action.cancel") : t("generation.action.submit")}
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
          disabled={!running && !canRun}
          onClick={running ? onCancel : onRun}
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
          <DurationControl
            values={durationValues}
            value={settings.durationSeconds}
            disabled={running}
            scale={{ min: 0, max: 30, step: 5 }}
            onChange={(durationSeconds) => updateSettings({ durationSeconds })}
          />
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
              <span className="cw-field-label">{t("generation.field.ratio")}</span>
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
                      <span>
                        {ratio === "auto" ? t("common.auto") : ratio}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {mode !== "audio" && (
            <div className="cw-parameter-section">
              <span className="cw-field-label">{t("generation.field.resolution")}</span>
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
                    disabled={running}
                    onChange={(event) =>
                      updateSettings({
                        durationFromReference: event.target.checked,
                      })
                    }
                  />
                </label>
              )}
              <span className="cw-field-label">
                {backend ? t("generation.field.maxDuration") : t("generation.field.duration")}
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
            <span className="cw-field-label">{t("generation.field.count")}</span>
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
            (!backend || config?.protocol === "volcengine") && (
              <label className="cw-audio-toggle">
                <span>
                  <CanvasIcon name="volume" size={16} />
                  {backend ? t("generation.field.audio") : t("generation.field.audioPending")}
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
    </GenerationComposerShell>
  );
}

export default NodeComposer;
