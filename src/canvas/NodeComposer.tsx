import { useEffect, useRef, useState } from "react";
import type { CanvasNode, CanvasNodeData, GenerationSettings } from "./model";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { ComposerPopover } from "./ComposerPopover";
import { DurationControl } from "./DurationControl";
import { ReferenceThumbnail } from "./ReferenceThumbnail";
import {
  changeGenerationSettings,
  generationBlocker,
  generationDefaults,
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
  MUSIC_SECONDS,
  serviceAudioSettings,
  type ModelConfig,
} from "../backend/rules.ts";
import {
  applyModelResolution,
  resolveGenerationModel,
} from "./modelResolution.ts";
import { copyGenerationSettings } from "./dataBoundary";
import { GenerationComposerShell } from "./GenerationComposerShell";
import { generationPrompt } from "./generationReferenceContent.ts";
import {
  GenerationReferenceEditor,
  type GenerationReferenceHandle,
  type GenerationReferenceControls,
} from "./GenerationReferenceEditor";
import "./nodes.css";
import {
  frameImageLimitIssue,
  FRAME_IMAGE_LIMIT_MESSAGE,
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
  referenceControls?: GenerationReferenceControls;
}

export type ComposerSettings = GenerationSettings;
const ratios = GENERATION_RATIOS;
type Panel = "parameters" | "duration" | "voices" | null;
const UNCONFIGURED_MODEL = "尚未配置可用的生成模型，请到“设置 → 模型接入”添加。";

/** Shared defaults let the workspace run the same parameters that the controls display. */
export function getNodeGenerationSettings(
  node: CanvasNode,
  models?: readonly ModelConfig[],
): ComposerSettings {
  const mode =
    node.data.kind === "video"
      ? "video"
      : node.data.kind === "audio"
        ? "audio"
        : "image";
  const previous = node.data.settings
    ? copyGenerationSettings(node.data.settings)
    : undefined;
  // Older saved projects may retain settings from a previous media kind.
  // Model, resolution and duration belong to their original media mode.
  const sameMode = previous?.mode === mode ? previous : undefined;
  const defaults = generationDefaults(mode);
  const legacyModel = [
    "本地交互演示",
    "本地音频工作流",
    "配乐创意",
    "环境音创意",
  ].includes(sameMode?.model ?? "");
  const next: ComposerSettings = {
    ...defaults,
    ...sameMode,
    mode,
    model: sameMode?.model && !legacyModel ? sameMode.model : defaults.model,
    aspectRatio:
      previous?.aspectRatio === "自动" ||
      ratios.some((ratio) => ratio === previous?.aspectRatio)
        ? previous!.aspectRatio
        : defaults.aspectRatio,
    resolution:
      mode === "audio"
        ? "自动"
        : sameMode?.resolution && sameMode.resolution !== "1024"
          ? sameMode.resolution
          : defaults.resolution,
    prompt: generationPrompt(node),
    count: previous?.count ?? 1,
    audioEnabled: sameMode?.audioEnabled ?? true,
    voiceName: sameMode?.modelConfigId
      ? sameMode.voiceName
      : (sameMode?.voiceName ?? defaults.voiceName),
  };
  // The creator only offers configured service models, so the displayed model
  // has to be the resolved one: reading and running then agree, and reopening a
  // node never drifts to whatever the catalog happens to define.
  if (!models) return next;
  const resolved = applyModelResolution(
    next,
    resolveGenerationModel(next, mode, models),
  );
  const config = backendModel(resolved, models);
  return config ? serviceAudioSettings(resolved, config) : resolved;
}

export function NodeComposer({
  selectedNode,
  incomingNodes,
  onUpdate,
  onRun,
  onCancel,
  onPickReference,
  running = false,
  backendModels = [],
  referenceControls,
}: NodeComposerProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelAnchor = useRef<HTMLElement | null>(null);
  const mentions = useRef<GenerationReferenceHandle>(null);
  useEffect(() => {
    setPanel(null);
  }, [selectedNode?.id]);

  if (
    !selectedNode ||
    !["image", "video", "audio"].includes(selectedNode.data.kind)
  )
    return null;
  const settings = getNodeGenerationSettings(selectedNode, backendModels);
  const mode = settings.mode;
  const backend = Boolean(settings.modelConfigId);
  const config = backendModel(settings, backendModels);
  const serviceModels = backendModels.filter(
    (item) => item.kind === mode && isGenerationModel(item),
  );
  const resolution = resolveGenerationModel(settings, mode, backendModels);
  const unconfigured = resolution.status === "unconfigured";
  const referenceIssue = (node: CanvasNode) =>
    !backend
      ? generationReferenceIssue(node, settings)
      : config
        ? backendReferenceIssue(node, settings, config)
        : "所选模型配置不可用";
  const blocker = unconfigured
    ? UNCONFIGURED_MODEL
    : backend
      ? backendBlocker(settings, incomingNodes, backendModels)
      : generationBlocker(settings, incomingNodes);
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
    ["reference", "全能参考"],
    ["first-last", "首尾帧"],
    ...(serviceModes.includes("continuation")
      ? [["continuation", "接续"] as const]
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
      label={`${selectedNode.data.title}创作参数`}
      running={running}
      onEscape={() => setPanel(null)}
    >
      <div className="cw-composer-body">
        {firstLast && (
          <div className="cw-frame-slots" aria-label="首尾帧参考">
            {(
              [
                ["firstFrameNodeId", "首帧"],
                ["lastFrameNodeId", "尾帧"],
              ] as const
            ).map(([field, label], index) => {
              const id = settings[field];
              const node = frameCandidates.find((item) => item.id === id);
              // The local service accepts a first frame only; offering a tail frame
              // here would permanently block submission.
              const blocked = backend && field === "lastFrameNodeId";
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
                  title={offCanvas ? "未显示在画布上，仍作为参考" : undefined}
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
                    aria-label={`选择${label}`}
                    value={id ?? ""}
                    disabled={running || (blocked && !id)}
                    title={
                      blocked
                        ? "当前服务仅支持首帧"
                        : unavailable
                          ? `${label}素材已不可用，请重新选择`
                          : `${label}${node ? `：${node.data.title}` : "：选择图片"}`
                    }
                    onChange={(event) =>
                      event.target.value === "__add_reference__"
                        ? onPickReference()
                        : updateSettings({
                            [field]: event.target.value || undefined,
                          })
                    }
                  >
                    <option value="">不使用{label}</option>
                    {id && !node && (
                      <option value={id}>原素材未连接，请重选</option>
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
                          ? "（素材不可用）"
                          : ""}
                      </option>
                    ))}
                    <option value="__add_reference__" disabled={blocked}>
                      添加图片参考…
                    </option>
                  </select>
                </div>
              );
            })}
            <TooltipButton
              type="button"
              className="cw-frame-swap"
              aria-label="互换首尾帧"
              label="互换首尾帧 · 两个槽位都有素材时可互换"
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
          !music &&
          (mode === "video" || incomingNodes.length > 0) && (
            <div className="cw-reference-strip">
              <TooltipButton
                type="button"
                className="cw-add-reference"
                onClick={() => mentions.current?.openUpload()}
                aria-label="添加参考素材"
                label="添加参考素材"
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
                  title={`${generationReferenceRole(node)}：${node.data.title}${referenceIssue(node) ? ` · ${referenceIssue(node)}` : ""}`}
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
          label={reading ? "朗读文本" : music ? "音乐风格" : "生成提示词"}
          placeholder={
            mode === "image"
              ? "上传参考图、输入文字或 @ 主体，描述你想要生成的图片"
              : mode === "video"
                ? firstLast
                  ? "输入文字，描述你想创作的画面内容、运动方式等。例如：一个3D形象的小男孩，在公园滑滑板。"
                  : "上传参考素材、输入文字或 @ 参考内容，描述画面的运动、镜头和故事"
                : reading
                  ? "输入需要朗读的文本…"
                  : music
                    ? "描述音乐风格：流派、乐器、速度、情绪和人声…"
                    : "描述台词、音色和声音场景，可添加音频参考…"
          }
        />
        {backend && music && (
          <textarea
            className="cw-prompt-input cw-lyrics-input"
            aria-label="歌词"
            value={settings.lyrics ?? ""}
            maxLength={5000}
            disabled={running}
            spellCheck={false}
            placeholder={
              "歌词（可选，留空生成纯音乐）。段落标签单独成一行，例如：\n[verse]\n雨落在窗前\n[chorus]\n说不出的话，让旋律回答"
            }
            onChange={(event) => updateSettings({ lyrics: event.target.value })}
          />
        )}
      </div>

      <div className="cw-composer-footer">
        <div className="cw-composer-options">
          <div className="cw-model-select">
            <select
              aria-label="生成模型"
              title={settings.model}
              value={
                backend ? `config:${settings.modelConfigId}` : "unconfigured"
              }
              disabled={running || serviceModels.length === 0}
              onChange={(event) => chooseModel(event.target.value)}
            >
              {serviceModels.length === 0 && (
                <option value="unconfigured">未配置生成模型</option>
              )}
              {backend && !config && (
                <option value={`config:${settings.modelConfigId}`}>
                  {settings.model}（配置不可用）
                </option>
              )}
              {serviceModels.length > 0 && (
                <optgroup label="本地服务">
                  {serviceModels.map((item) => (
                    <option key={item.id} value={`config:${item.id}`}>
                      {modelLabel(item)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <CanvasIcon name="chevronDown" size={12} />
          </div>
          <button
            type="button"
            className={`cw-parameter-trigger${panel === "parameters" ? " cw-is-active" : ""}`}
            aria-label="生成参数"
            aria-expanded={panel === "parameters"}
            onClick={(event) => togglePanel("parameters", event.currentTarget)}
          >
            <CanvasIcon name="sliders" size={15} />
            <span>
              {mode === "audio"
                ? music
                  ? `${backend ? "最长 " : ""}${settings.durationSeconds} 秒`
                  : reading
                    ? "文本朗读"
                    : "全能配音"
                : `${settings.aspectRatio} · ${settings.resolution}${mode === "image" ? ` · ${settings.count} 张` : ""}`}
            </span>
          </button>
          <div className="cw-generation-mode-controls">
            {mode === "image" && (
              <select
                aria-label="图片创作预设"
                value={settings.imagePreset ?? "none"}
                disabled={running}
                onChange={(event) =>
                  updateSettings({
                    imagePreset: event.target
                      .value as ComposerSettings["imagePreset"],
                  })
                }
              >
                <option value="none">自由创作</option>
                <option
                  value="product-views"
                  disabled={backend || settings.model !== "Seedream 5.0 Pro"}
                >
                  产品三视图
                </option>
              </select>
            )}
            {mode === "video" && (
              <select
                aria-label="视频创作模式"
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
                        ? FRAME_IMAGE_LIMIT_MESSAGE
                        : undefined
                    }
                  >
                    {value === "first-last" &&
                    frameImageLimitIssue(
                      { ...settings, videoMode: "first-last" },
                      incomingNodes,
                    )
                      ? `${label}（最多 2 张图片，请先断开多余连线）`
                      : label}
                  </option>
                ))}
              </select>
            )}
            {mode === "audio" && !backend && (
              <>
                <select
                  aria-label="音频创作类型"
                  value={settings.audioCreationType ?? "audio"}
                  disabled={running}
                  onChange={(event) =>
                    updateSettings({
                      audioCreationType: event.target
                        .value as ComposerSettings["audioCreationType"],
                    })
                  }
                >
                  <option value="audio">音频生成</option>
                  <option value="music">音乐生成</option>
                </select>
                {!music && (
                  <select
                    aria-label="音频创作模式"
                    value={settings.audioMode ?? "unified"}
                    disabled={running}
                    onChange={(event) =>
                      updateSettings({
                        audioMode: event.target
                          .value as ComposerSettings["audioMode"],
                      })
                    }
                  >
                    <option value="unified">全能配音</option>
                    <option value="tts">文本朗读</option>
                  </select>
                )}
              </>
            )}
            {mode === "audio" && backend && !music && (
              <input
                aria-label="服务音色"
                value={settings.voiceName ?? ""}
                placeholder="默认音色"
                disabled={running}
                spellCheck={false}
                onChange={(event) =>
                  updateSettings({
                    voiceName: event.target.value.trim() || undefined,
                  })
                }
              />
            )}
            {reading && !backend && (
              <button
                type="button"
                className="cw-voice-trigger"
                aria-label="语音库"
                aria-expanded={panel === "voices"}
                onClick={(event) => togglePanel("voices", event.currentTarget)}
              >
                <CanvasIcon name="audio" size={15} />
                <span>{settings.voiceName || "语音库"}</span>
                <CanvasIcon name="chevronDown" size={12} />
              </button>
            )}
          </div>
          {!firstLast && !reading && !music && incomingNodes.length === 0 && (
            <TooltipButton
              type="button"
              className="cw-reference-trigger"
              aria-label="添加参考素材"
              label="添加参考素材"
              onClick={() => mentions.current?.openUpload()}
            >
              <CanvasIcon name="plus" size={16} />
            </TooltipButton>
          )}
          {mode === "video" && (
            <button
              type="button"
              className={`cw-duration-trigger${panel === "duration" ? " cw-is-active" : ""}`}
              aria-label="视频生成时长"
              aria-haspopup="dialog"
              aria-expanded={panel === "duration"}
              disabled={running || !durationValues.length}
              title={
                !durationValues.length
                  ? "该模型尚未提供可选生成时长"
                  : "选择视频生成时长"
              }
              onClick={(event) => togglePanel("duration", event.currentTarget)}
            >
              <span>
                {durationValues.length
                  ? `${settings.durationSeconds} 秒`
                  : "服务默认时长"}
              </span>
              <CanvasIcon name="chevronDown" size={12} />
            </button>
          )}
          {!reading && !music && (
            <TooltipButton
              type="button"
              className="cw-reference-trigger"
              aria-label="引用已连接节点"
              label="引用已连接节点"
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
          aria-label={running ? "取消生成" : "提交生成"}
          label={
            running
              ? "取消生成"
              : canRun
                ? backend
                  ? "提交到本地服务"
                  : "生成 · 请先接入模型服务"
                : (blocker ?? "请补全创作参数")
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
          label="视频生成时长设置"
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
          label="生成参数设置"
        >
          <div className="cw-popover-heading">
            <strong>生成参数</strong>
            <TooltipButton
              type="button"
              className="cw-icon-button"
              label="关闭参数"
              onClick={() => setPanel(null)}
            >
              <CanvasIcon name="close" size={15} />
            </TooltipButton>
          </div>
          {mode !== "audio" && (
            <div className="cw-parameter-section">
              <span className="cw-field-label">比例</span>
              <div className="cw-ratio-options">
                {(backend ? ["自动", ...ratios] : ratios).map((ratio) => {
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
                          width: `${ratio === "自动" ? 21 : Math.min(23, (21 * w!) / h!)}px`,
                          height: `${ratio === "自动" ? 21 : Math.min(23, (21 * h!) / w!)}px`,
                        }}
                      />
                      <span>{ratio}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {mode !== "audio" && (
            <div className="cw-parameter-section">
              <span className="cw-field-label">分辨率</span>
              <div className="cw-segment-options">
                {resolutions.map((resolution) => (
                  <button
                    type="button"
                    key={resolution}
                    aria-label={`分辨率 ${resolution}`}
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
                    {resolution}
                  </button>
                ))}
                {!resolutions.length && (
                  <span className="cw-parameter-unknown">
                    等待服务能力，尚未核实
                  </span>
                )}
              </div>
            </div>
          )}
          {music && (
            <div className="cw-parameter-section">
              <span className="cw-field-label">
                {backend ? "最长时长（模型可能提前结束）" : "时长"}
              </span>
              {duration ? (
                <DurationControl
                  values={durationValues}
                  value={settings.durationSeconds}
                  disabled={running}
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
                  该模型普通生成的时长范围尚未核实
                </span>
              )}
            </div>
          )}
          <div className="cw-parameter-section">
            <span className="cw-field-label">数量</span>
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
                  {backend ? "生成音频" : "请求包含音频（服务能力待确认）"}
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
          label="语音库"
        >
          <div className="cw-popover-heading">
            <strong>语音库</strong>
            <TooltipButton
              type="button"
              className="cw-icon-button"
              label="关闭语音库"
              onClick={() => setPanel(null)}
            >
              <CanvasIcon name="close" size={15} />
            </TooltipButton>
          </div>
          <button
            type="button"
            className={`cw-observed-voice${settings.voiceName === "动漫海绵" ? " cw-is-active" : ""}`}
            aria-pressed={settings.voiceName === "动漫海绵"}
            onClick={() => {
              updateSettings({ voiceName: "动漫海绵" });
              setPanel(null);
            }}
          >
            <CanvasIcon name="audio" size={22} />
            <span>
              <strong>动漫海绵</strong>
            </span>
          </button>
        </ComposerPopover>
      )}
    </GenerationComposerShell>
  );
}

export default NodeComposer;
