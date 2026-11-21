import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/I18nProvider";
import type { CanvasNode, CanvasNodeData } from "./model";
import type { ModelConfig } from "../backend/rules";
import { modelLabel, referenceBudgetIssue } from "../backend/rules";
import { agentNodeSettings, agentGenerationBlocker } from "./textGeneration";
import { GenerationComposerShell } from "./GenerationComposerShell";
import { ComposerPopover } from "./ComposerPopover";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { ReferenceThumbnail } from "./ReferenceThumbnail";
import {
  GenerationReferenceEditor,
  type GenerationReferenceHandle,
  type GenerationReferenceControls,
} from "./GenerationReferenceEditor";
import "./nodes.css";

export function TextNodeComposer({
  node,
  incoming,
  models,
  onCheckModels,
  onUpdate,
  onRun,
  onCancel,
  onPickReference,
  running,
  referenceControls,
}: {
  node: CanvasNode;
  incoming: CanvasNode[];
  models: readonly ModelConfig[];
  onCheckModels?: (ids: readonly string[]) => Promise<void>;
  onUpdate: (data: Partial<CanvasNodeData>) => void;
  onRun: () => void;
  onCancel: () => void;
  onPickReference: () => void;
  running: boolean;
  referenceControls?: GenerationReferenceControls;
}) {
  const t = useT();
  const agentIds = models.filter((model) => model.kind === "agent").map((model) => model.id).join(",");
  useEffect(() => { if (agentIds) void onCheckModels?.(agentIds.split(",")); }, [node.id, agentIds, onCheckModels]);
  const root = useRef<HTMLDivElement>(null),
    anchor = useRef<HTMLElement | null>(null);
  const [openPanel, setPanel] = useState<"parameters" | null>(null);
  const panel = running ? null : openPanel;
  const mentions = useRef<GenerationReferenceHandle>(null);
  useEffect(() => setPanel(null), [node.id, running]);
  const settings = agentNodeSettings(node),
    agents = models.filter((m) => m.kind === "agent");
  // The node keeps the model it was created with; the picker only fills a gap.
  const selected = settings.modelConfigId ?? agents[0]?.id,
    model = agents.find((m) => m.id === selected);
  const blocker = agentGenerationBlocker(node, incoming, model);
  const update = (patch: Partial<typeof settings>) =>
    onUpdate({
      agentSettings: { ...settings, modelConfigId: selected, ...patch },
    });
  const toggle = (next: typeof panel, element: HTMLElement) => {
    anchor.current = element;
    setPanel((old) => (old === next ? null : next));
  };
  const referenceIssue = (reference: CanvasNode) =>
    !model
      ? t("generation.model.agentRequired")
      : !model.inputRules.allowedKinds.includes(reference.type)
        ? t("generation.model.agentUnsupported")
        : null;
  const insert = (reference: CanvasNode) => mentions.current?.insert(reference);
  return (
    <GenerationComposerShell
      composerRef={root}
      label={t("generation.composer.title", { title: node.data.title })}
      running={running}
      onEscape={() => setPanel(null)}
    >
      <div className="cw-composer-body">
        {incoming.length > 0 && (
          <div className="cw-reference-strip">
            <TooltipButton
              type="button"
              className="cw-add-reference"
              disabled={running}
              aria-label={t("generation.reference.add")}
              label={t("generation.reference.add")}
              onClick={() => mentions.current?.openUpload()}
            >
              <CanvasIcon name="plus" size={20} />
            </TooltipButton>
            {incoming.map((reference) => (
              <ReferenceThumbnail
                key={reference.id}
                node={reference}
                disabled={running || Boolean(referenceIssue(reference))}
                removalDisabled={running}
                onInsert={() => insert(reference)}
                onRemove={() => mentions.current?.remove(reference)}
              />
            ))}
          </div>
        )}
        <GenerationReferenceEditor
          key={node.id}
          node={node}
          incoming={incoming}
          controls={referenceControls}
          issue={referenceIssue}
          validate={(sources) => {
            if (!model) return null;
            return referenceBudgetIssue(sources, model);
          }}
          onUpdate={onUpdate}
          running={running}
          pickerRef={mentions}
          label={t("generation.prompt.textLabel")}
          placeholder={t("generation.prompt.textPlaceholder")}
          onRun={() => {
            if (!blocker && !running) onRun();
          }}
        />
      </div>
      <div className="cw-composer-footer">
        <div className="cw-composer-options">
          <div className="cw-model-select">
            <select
              aria-label={t("generation.model.agent")}
              title={model ? modelLabel(model) : t("generation.model.agentPlaceholder")}
              value={selected ?? ""}
              disabled={running}
              onChange={(event) =>
                update({ modelConfigId: event.target.value })
              }
            >
              {!agents.length && <option value="">{t("generation.model.agentPlaceholder")}</option>}
              {selected && !model && (
                <option value={selected}>{t("generation.model.agentUnavailable")}</option>
              )}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {modelLabel(agent)}
                </option>
              ))}
            </select>
            <CanvasIcon name="chevronDown" size={12} />
          </div>
          <button
            type="button"
            className="cw-parameter-trigger"
            aria-label={t("generation.agent.title")}
            disabled={running}
            aria-expanded={panel === "parameters"}
            onClick={(event) => toggle("parameters", event.currentTarget)}
          >
            <CanvasIcon name="sliders" size={15} />
            <span>
              {
                { auto: t("common.auto"), low: t("generation.thinking.low"), medium: t("generation.thinking.medium"), high: t("generation.thinking.high") }[
                  settings.thinking
                ]
              }{" "}
              · {settings.maxTokens}
            </span>
          </button>
          {incoming.length === 0 && (
            <TooltipButton
              type="button"
              className="cw-reference-trigger"
              aria-label={t("generation.reference.add")}
              label={t("generation.reference.add")}
              disabled={running}
              onClick={() => mentions.current?.openUpload()}
            >
              <CanvasIcon name="plus" size={16} />
            </TooltipButton>
          )}
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
        </div>
        <TooltipButton
          type="button"
          className={`cw-run-button${running ? " cw-run-button-cancel" : ""}`}
          aria-label={running ? t("generation.action.cancel") : t("generation.action.generateText")}
          label={running ? t("generation.action.cancel") : (blocker ?? t("generation.action.generateText"))}
          disabled={!running && Boolean(blocker)}
          onClick={running ? onCancel : onRun}
        >
          <CanvasIcon name={running ? "stop" : "arrowUp"} size={20} />
        </TooltipButton>
      </div>
      {panel && (
        <ComposerPopover
          anchor={anchor.current}
          composer={root.current}
          onClose={() => setPanel(null)}
          className="cw-parameters-popover cw-agent-parameters"
          label={t("generation.agent.settings")}
        >
          <div className="cw-popover-heading">
            <strong>{t("generation.agent.title")}</strong>
            <button
              type="button"
              className="cw-icon-button"
              aria-label={t("generation.options.close")}
              onClick={() => setPanel(null)}
            >
              <CanvasIcon name="close" size={15} />
            </button>
          </div>
          <>
            <label>
              {t("generation.agent.thinking")}
              <select
                aria-label={t("generation.agent.thinkingLabel")}
                value={settings.thinking}
                disabled={running}
                onChange={(event) =>
                  update({
                    thinking: event.target.value as typeof settings.thinking,
                  })
                }
              >
                <option value="auto">{t("common.auto")}</option>
                <option value="low">{t("generation.thinking.low")}</option>
                <option value="medium">{t("generation.thinking.medium")}</option>
                <option value="high">{t("generation.thinking.high")}</option>
              </select>
            </label>
            <label>
              {t("generation.agent.maxOutput")}
              <input
                type="number"
                aria-label={t("generation.agent.maxOutputLabel")}
                min={1}
                max={32768}
                step={1}
                value={settings.maxTokens}
                disabled={running}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 32768)
                    update({ maxTokens: value });
                }}
              />
            </label>
          </>
        </ComposerPopover>
      )}
    </GenerationComposerShell>
  );
}
