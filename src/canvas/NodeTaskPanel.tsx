import { useId, useState } from "react";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { SelectionToolbarMenu } from "./SelectionToolbarMenu";
import type { CanvasNode } from "./model";
import {
  CANVAS_TOOLS,
  createCanvasToolTask,
  initialToolParameters,
  toolFields,
  validateToolTask,
  type CanvasToolId,
  type CanvasToolTask,
  type ToolCapability,
  type ToolParameters,
} from "./toolCatalog";
import { translateTool, translateToolText } from "./toolText.ts";
import { displayNodeTitle } from "./nodeTitle.ts";
import { useI18n } from "../i18n/I18nProvider";
import "./node-task-panel.css";

/** A single source-bound operation using the service's capability catalog. */
export function NodeTaskPanel({
  node,
  nodes,
  tool,
  draft,
  initialParameters,
  onDraftChange,
  onImportResults,
  onClose,
  onEditSelection,
  capability,
  onGenerate,
}: {
  node: CanvasNode;
  nodes: readonly CanvasNode[];
  tool: CanvasToolId;
  draft?: CanvasToolTask;
  initialParameters?: ToolParameters;
  onDraftChange: (task: CanvasToolTask) => void;
  onImportResults: (task: CanvasToolTask) => void;
  onClose: () => void;
  onEditSelection: () => void;
  /** Service availability and options from the local API's tool catalog. */
  capability?: ToolCapability;
  onGenerate?: (task: CanvasToolTask) => void;
}) {
  const { t, locale } = useI18n();
  const spec = translateTool(
    locale,
    CANVAS_TOOLS.find((item) => item.id === tool)!,
  );
  const saved =
    draft?.tool === tool && draft.sourceNodeIds[0] === node.id
      ? draft
      : undefined;
  const [edits, setParameters] = useState<ToolParameters>({
    ...saved?.parameters,
    ...initialParameters,
  });
  // Catalog options may arrive after the panel opens. Defaults follow the catalog;
  // explicit user/saved values remain intact so unavailable choices are reported.
  const parameters = { ...initialToolParameters(spec, capability), ...edits };
  const [extraSource, setExtraSource] = useState(saved?.sourceNodeIds[1] ?? "");
  const [notice, setNotice] = useState("");
  const [moreAnchor, setMoreAnchor] = useState<HTMLButtonElement | null>(null);
  const moreId = useId();
  const task = createCanvasToolTask(
    tool,
    [node.id, ...(extraSource ? [extraSource] : [])],
    parameters,
    saved?.selection,
  );
  const errors = validateToolTask(
    task,
    nodes.map((item) => ({
      nodeId: item.id,
      kind: item.type,
      title: item.data.title,
      src: item.data.src,
      mimeType: item.data.mimeType,
      width: item.data.media?.width,
      height: item.data.media?.height,
      durationSeconds: item.data.media?.durationSeconds,
    })),
    capability,
  ).map((error) => translateToolText(locale, error));
  const runnable = Boolean(onGenerate && capability?.available);
  const change = (key: string, value: string | number | boolean) => {
    setParameters((current) => ({ ...current, [key]: value }));
    setNotice("");
  };
  if (tool === "image-presets") {
    const preset = capability?.fields
      ?.find((field) => field.key === "preset")
      ?.options?.find((option) => option.value === parameters.preset);
    const presetName = translateToolText(
      locale,
      preset?.label ?? String(parameters.preset ?? ""),
    );
    const note =
      errors[0] ??
      (runnable
        ? t("tools.nodeTask.presetNote")
        : (capability?.reason ?? t("tools.nodeTask.notConnected")));
    const models = capability?.models?.["image.edit"] ?? [];
    return (
      <section
        className="cw-node-task-panel cw-preset-task-panel"
        aria-label={presetName}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="cw-preset-task-head">
          <strong>{presetName}</strong>
          <TooltipButton
            label={t("tools.nodeTask.close", { title: presetName })}
            onClick={onClose}
          >
            <CanvasIcon name="close" size={14} />
          </TooltipButton>
        </header>
        <div className="cw-preset-task-row">
          {models.length > 0 && (
            <select
              className="cw-preset-task-model"
              aria-label={t("tools.imageEditor.model.aria")}
              value={String(parameters.imageModelConfigId ?? "")}
              onChange={(event) =>
                change("imageModelConfigId", event.target.value)
              }
            >
              {!parameters.imageModelConfigId && (
                <option value="">
                  {t("tools.imageEditor.model.auto", { model: models[0]!.label })}
                </option>
              )}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          )}
          <span className="cw-preset-task-note" role="status">
            {note}
          </span>
          <button
            type="button"
            className="cw-node-task-primary"
            disabled={!runnable || errors.length > 0}
            title={!runnable || errors.length ? note : undefined}
            onClick={() => {
              onDraftChange(task);
              onGenerate?.(task);
            }}
          >
            <CanvasIcon name="sparkle" size={15} />
            {t("tools.nodeTask.generate")}
          </button>
        </div>
      </section>
    );
  }
  return (
    <section
      className="cw-node-task-panel"
      aria-label={t("tools.nodeTask.panelAria", { title: spec.title })}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <strong>{spec.title}</strong>
        <span>{displayNodeTitle(node.type, node.data.title, locale)}</span>
        <TooltipButton
          label={t("tools.nodeTask.close", { title: spec.title })}
          onClick={onClose}
        >
          <CanvasIcon name="close" size={16} />
        </TooltipButton>
      </header>
      {spec.minSources > 1 && (
        <label className="cw-node-task-source">
          {t("tools.nodeTask.productReference")}
          <select
            aria-label={t("tools.nodeTask.productReference")}
            value={extraSource}
            onChange={(event) => setExtraSource(event.target.value)}
          >
            <option value="">{t("tools.nodeTask.chooseImage")}</option>
            {nodes
              .filter(
                (item) =>
                  item.id !== node.id && item.type === "image" && item.data.src,
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.data.title}
                </option>
              ))}
          </select>
        </label>
      )}
      <div className="cw-node-task-fields">
        {[...toolFields(spec, capability)]
          .sort(
            (a, b) =>
              Number(b.type === "textarea") - Number(a.type === "textarea"),
          )
          .map((field) => {
            if (
              tool === "multi-size" &&
              parameters.aspectRatio !== "custom" &&
              ["outputWidth", "outputHeight"].includes(field.key)
            )
              return null;
            const value = parameters[field.key];
            return (
              <label
                key={field.key}
                className={field.type === "textarea" ? "is-wide" : ""}
              >
                <span>{field.label}</span>
                {field.type === "select" ? (
                  <select
                    aria-label={`${spec.title}${field.label}`}
                    disabled={!field.options?.length}
                    value={String(value ?? "")}
                    onChange={(event) =>
                      change(
                        field.key,
                        field.options?.find(
                          (option) =>
                            String(option.value) === event.target.value,
                        )?.value ?? event.target.value,
                      )
                    }
                  >
                    {!field.options?.length && (
                      <option value="">
                        {t("tools.nodeTask.connectToChoose")}
                      </option>
                    )}
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : field.type === "textarea" ? (
                  <textarea
                    aria-label={`${spec.title}${field.label}`}
                    rows={4}
                    value={String(value ?? "")}
                    onChange={(event) => change(field.key, event.target.value)}
                  />
                ) : field.type === "boolean" ? (
                  <input
                    aria-label={`${spec.title}${field.label}`}
                    type="checkbox"
                    checked={value === true}
                    onChange={(event) =>
                      change(field.key, event.target.checked)
                    }
                  />
                ) : (
                  <input
                    aria-label={`${spec.title}${field.label}`}
                    type={field.type}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={
                      typeof value === "number" && !Number.isFinite(value)
                        ? ""
                        : String(value ?? "")
                    }
                    onChange={(event) =>
                      change(
                        field.key,
                        field.type === "number" &&
                          Number.isFinite(event.target.valueAsNumber)
                          ? event.target.valueAsNumber
                          : event.target.value,
                      )
                    }
                  />
                )}
              </label>
            );
          })}
      </div>
      <p className="cw-node-task-note">
        {runnable
          ? (errors[0] ?? t("tools.nodeTask.remoteNote"))
          : `${capability?.reason ?? t("tools.nodeTask.unavailable")}${t("tools.nodeTask.saveHint")}`}
      </p>
      <footer>
        <TooltipButton
          className="cw-node-task-more"
          label={t("tools.nodeTask.more", { title: spec.title })}
          aria-haspopup="menu"
          aria-expanded={Boolean(moreAnchor)}
          aria-controls={moreAnchor ? moreId : undefined}
          onClick={(event) =>
            setMoreAnchor(moreAnchor ? null : event.currentTarget)
          }
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              setMoreAnchor(event.currentTarget);
            }
          }}
        >
          <CanvasIcon name="more" size={16} />
        </TooltipButton>
        {(tool === "product-replacement" ||
          (tool === "layer-decompose" && parameters.mode === "boxes")) && (
          <button
            type="button"
            onClick={() => {
              onDraftChange(task);
              onEditSelection();
            }}
          >
            {saved?.selection
              ? t("tools.nodeTask.modifySelection")
              : t("tools.nodeTask.editSelection")}
          </button>
        )}
        {notice && (
          <span className="cw-node-task-status" role="status">
            {notice}
          </span>
        )}
        <button
          type="button"
          className="cw-node-task-primary"
          disabled={!runnable || errors.length > 0}
          title={
            runnable
              ? errors[0]
              : (capability?.reason ?? t("tools.nodeTask.notConnected"))
          }
          onClick={() => {
            onDraftChange(task);
            onGenerate?.(task);
          }}
        >
          {t("tools.nodeTask.generate")}
        </button>
      </footer>
      {moreAnchor && (
        <SelectionToolbarMenu
          anchor={moreAnchor}
          id={moreId}
          label={t("tools.nodeTask.more", { title: spec.title })}
          onClose={() => setMoreAnchor(null)}
        >
          <button
            type="button"
            role="menuitem"
            className="cw-selection-menu-item"
            onClick={() => {
              onDraftChange(task);
              setNotice(t("tools.nodeTask.saved"));
              moreAnchor.focus({ preventScroll: true });
              setMoreAnchor(null);
            }}
          >
            {t("tools.nodeTask.save")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="cw-selection-menu-item"
            onClick={() => {
              moreAnchor.focus({ preventScroll: true });
              setMoreAnchor(null);
              onImportResults(task);
            }}
          >
            {t("tools.nodeTask.import")}
          </button>
        </SelectionToolbarMenu>
      )}
    </section>
  );
}
