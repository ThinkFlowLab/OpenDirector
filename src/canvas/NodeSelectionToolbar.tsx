import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { CanvasIcon } from "./CanvasIcon";
import { ToolIcon } from "./ToolIcon";
import type { ToolGlyphName } from "./toolGlyphs";
import { TooltipButton } from "./TooltipButton";
import { GridSplitOptions, SelectionToolbarMenu } from "./SelectionToolbarMenu";
import type { CanvasNode } from "./model";
import type { CanvasToolId } from "./toolCatalog";
import { useT } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import "./node-selection-toolbar.css";

export type SelectionEditorMode =
  | "default"
  | "trim"
  | "frame"
  | "extract-audio";

export interface NodeSelectionToolbarProps {
  node: CanvasNode;
  locked?: boolean;
  /** The caller owns positioning in screen space, outside the zoomed viewport. */
  style?: CSSProperties;
  className?: string;
  /** Opens this operation's dedicated source-bound editing session. */
  onTool?: (tool: CanvasToolId) => void;
  presets?: readonly { value: string | number; label: string }[];
  onPreset?: (preset: string) => void;
  onEdit?: (mode: SelectionEditorMode) => void;
  onCaptureFrame?: (position: "first" | "last") => void;
  onGridSplit?: (rows: number, columns: number) => void;
  onPreview?: () => void;
  onDownload?: () => void;
  onAssistant?: () => void;
  /** Opens the text node in the large editing window; the trailing control in the bar. */
  onExpand?: () => void;
  onRename?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}

type Action = {
  id: string;
  label: string;
  icon: string;
  /** Solid tool glyph; tool actions outweigh the line icons used for chrome. */
  glyph?: ToolGlyphName;
  run?: () => void;
  options?: MenuOption[];
  disabled?: boolean;
  iconOnly?: boolean;
  destructive?: boolean;
};
type MenuOption = {
  id: string;
  label: string;
  icon: string;
  description?: string;
  run?: () => void;
  grid?: boolean;
  disabled?: boolean;
};
type OpenMenu = {
  nodeId: string;
  actionId: string;
  anchor: HTMLButtonElement;
  initialFocus: "first" | "last";
  grid?: boolean;
};

const imageTools: readonly [CanvasToolId, MessageKey, string, ToolGlyphName][] =
  [
    ["smart-edit", "canvas.selection.tool.smartEdit", "sparkle", "smart-edit"],
    ["panorama", "canvas.selection.tool.panorama", "expand", "panorama"],
    ["outpaint", "canvas.selection.tool.outpaint", "expand", "outpaint"],
    ["image-hd", "canvas.selection.tool.upscale", "image", "image-hd"],
    ["cutout", "canvas.selection.tool.cutout", "subject", "cutout"],
  ];
const videoTools: readonly [CanvasToolId, MessageKey, string][] = [
  ["video-partial-reshoot", "canvas.selection.tool.videoReshoot", "camera"],
  ["video-upscale", "canvas.selection.tool.upscale", "video"],
  ["video-edit", "canvas.selection.tool.videoEdit", "edit"],
  ["video-extend", "canvas.selection.tool.videoExtend", "clock"],
];
const editLabels: Partial<Record<CanvasNode["type"], MessageKey>> = {
  text: "canvas.selection.edit.text",
  timeline: "canvas.selection.edit.timeline",
  stack: "canvas.selection.edit.stack",
  tool: "canvas.selection.edit.tool",
  external: "canvas.selection.edit.external",
};

/** Selection actions stay distinct from generation controls. Empty media has no post-edit toolbar.
 * Local editors and tool drafts keep their own capability constraints.
 */
export function NodeSelectionToolbar({
  node,
  locked = false,
  style,
  className = "",
  onTool,
  presets = [],
  onPreset,
  onEdit,
  onCaptureFrame,
  onGridSplit,
  onPreview,
  onDownload,
  onAssistant,
  onExpand,
  onRename,
  onDuplicate,
  onDelete,
}: NodeSelectionToolbarProps) {
  const t = useT();
  const toolbar = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const hasMedia = Boolean(node.data.src) && node.data.assetState !== "missing";
  useEffect(() => setOpenMenu(null), [node.id, node.type, locked, hasMedia]);
  const mediaKind = ["image", "video", "audio", "file"].includes(node.type);
  if (mediaKind && !hasMedia) return null;

  const editing: Action[] = [];
  const toolOption = (
    tool: CanvasToolId,
    label: string,
    icon: string,
    description?: string,
  ): MenuOption => ({
    id: tool,
    label,
    icon,
    description,
    run: () => onTool?.(tool),
    disabled: !onTool,
  });
  const addMenu = (
    id: string,
    label: string,
    icon: string,
    options: MenuOption[],
    glyph?: ToolGlyphName,
  ) => {
    if (options.some((option) => !option.disabled))
      editing.push({ id, label, icon, glyph, options, disabled: locked });
  };
  const addTool = (
    tool: CanvasToolId,
    label: string,
    icon: string,
    glyph?: ToolGlyphName,
  ) => {
    if (onTool)
      editing.push({
        id: tool,
        label,
        icon,
        glyph,
        run: () => onTool(tool),
        disabled: locked,
      });
  };
  const addEditor = (
    id: string,
    label: string,
    icon: string,
    mode: SelectionEditorMode,
  ) => {
    if (onEdit)
      editing.push({
        id,
        label,
        icon,
        run: () => onEdit(mode),
        disabled: locked,
      });
  };
  if (node.type === "image") {
    for (const [tool, labelKey, icon, glyph] of imageTools)
      addTool(tool, t(labelKey), icon, glyph);
    addMenu(
      "image-presets",
      t("canvas.selection.presets"),
      "sparkle",
      presets.map(({ value, label }) => ({
        id: String(value),
        label,
        icon:
          value === "multi-camera"
            ? "camera"
            : value === "storyboard"
              ? "grid"
              : value === "face-three-view"
                ? "face"
                : value === "product-three-view"
                  ? "product"
                  : "subject",
        run: () => onPreset?.(String(value)),
        disabled: !onPreset,
      })),
      "presets",
    );
    addTool(
      "view-control",
      t("canvas.selection.multiAngle"),
      "rotate",
      "view-control",
    );
    addTool("lighting", t("canvas.selection.lighting"), "palette", "lighting");
    addMenu(
      "marketing",
      t("canvas.selection.marketing"),
      "palette",
      [
        toolOption("multi-size", t("canvas.selection.multiSize"), "expand"),
        toolOption(
          "layer-decompose",
          t("canvas.selection.layerDecompose"),
          "stack",
        ),
        toolOption(
          "product-replacement",
          t("canvas.selection.productReplacement"),
          "image",
        ),
        toolOption(
          "dynamic-poster",
          t("canvas.selection.dynamicPoster"),
          "video",
        ),
      ],
      "marketing",
    );
    addMenu(
      "tools",
      t("canvas.selection.tools"),
      "tool",
      [
        toolOption(
          "inpainting-remove",
          t("canvas.selection.inpaintRemove"),
          "edit",
        ),
        toolOption("composition", t("canvas.selection.cropCompose"), "crop"),
        {
          id: "grid-split",
          label: t("canvas.selection.gridSplit"),
          icon: "grid",
          grid: true,
          disabled: !onGridSplit,
        },
        toolOption("annotation", t("canvas.selection.annotate"), "pencil"),
      ],
      "tools",
    );
  } else if (node.type === "video") {
    for (const [tool, labelKey, icon] of videoTools)
      addTool(tool, t(labelKey), icon);
    addMenu(
      "video-frame-capture",
      t("canvas.selection.captureFrame"),
      "image",
      [
        {
          id: "capture-first",
          label: t("canvas.selection.firstFrame"),
          icon: "image",
          run: () => onCaptureFrame?.("first"),
          disabled: !onCaptureFrame,
        },
        {
          id: "capture-last",
          label: t("canvas.selection.lastFrame"),
          icon: "image",
          run: () => onCaptureFrame?.("last"),
          disabled: !onCaptureFrame,
        },
        {
          id: "capture-custom",
          label: t("canvas.selection.customFrame"),
          icon: "camera",
          run: () => onEdit?.("frame"),
          disabled: !onEdit,
        },
      ],
    );
    addTool(
      "video-depth-capture",
      t("canvas.selection.depthCapture"),
      "subject",
    );
    addEditor("video-trim", t("canvas.selection.trimVideo"), "trim", "trim");
    addMenu(
      "sound-separation",
      t("canvas.selection.audioSeparation"),
      "audio",
      [
        {
          id: "extract-audio",
          label: t("canvas.selection.extractAudio"),
          icon: "audio",
          description: t("canvas.selection.extractAudioHint"),
          run: () => onEdit?.("extract-audio"),
          disabled: !onEdit,
        },
        toolOption(
          "audio-separation",
          t("canvas.selection.separateTrack"),
          "sliders",
          t("canvas.selection.separateTrackHint"),
        ),
      ],
    );
    addMenu("tools", t("canvas.selection.tools"), "tool", [
      toolOption(
        "video-frame-interpolation",
        t("canvas.selection.frameInterpolation"),
        "video",
      ),
      toolOption(
        "video-subtitle-erasure",
        t("canvas.selection.subtitleErase"),
        "text",
      ),
      toolOption(
        "video-matting",
        t("canvas.selection.videoMatting"),
        "subject",
      ),
      toolOption("video-crop", t("canvas.selection.videoCrop"), "crop"),
    ]);
  } else if (node.type === "audio") {
    addEditor("audio-trim", t("canvas.selection.trimAudio"), "trim", "trim");
    addTool("audio-separation", t("canvas.selection.separateTrack"), "audio");
  } else if (editLabels[node.type]) {
    addEditor("edit", t(editLabels[node.type]!), node.type, "default");
  }
  if (onAssistant && node.type !== "group")
    editing.push({
      id: "assistant",
      label: t("canvas.selection.assistant"),
      icon: "sparkle",
      glyph: "assistant",
      run: onAssistant,
    });

  const outputs: Action[] = [];
  if (onPreview && hasMedia)
    outputs.push({
      id: "preview",
      label:
        node.type === "file"
          ? t("canvas.selection.previewFile")
          : t("canvas.selection.previewFullscreen"),
      icon: "fullscreen",
      run: onPreview,
      iconOnly: true,
    });
  if (onDownload && (hasMedia || node.type === "text"))
    outputs.push({
      id: "download",
      label: t("common.download"),
      icon: "download",
      run: onDownload,
      iconOnly: true,
    });

  const organization: Action[] = [];
  if (onRename)
    organization.push({
      id: "rename",
      label: t("common.rename"),
      icon: "pencil",
      run: onRename,
      iconOnly: true,
      disabled: locked,
    });
  if (onDuplicate)
    organization.push({
      id: "duplicate",
      label: t("canvas.selection.duplicate"),
      icon: "duplicate",
      run: onDuplicate,
      iconOnly: true,
    });
  if (onDelete)
    organization.push({
      id: "delete",
      label: t("canvas.selection.deleteNode"),
      icon: "trash",
      run: onDelete,
      iconOnly: true,
      destructive: true,
      disabled: locked,
    });
  const groups = [editing, outputs, organization].filter(
    (group) => group.length,
  );
  if (!groups.length) return null;
  const menuAction =
    openMenu?.nodeId === node.id && !locked
      ? editing.find(
          (action) => action.id === openMenu.actionId && action.options,
        )
      : undefined;
  const showMenu = (
    action: Action,
    anchor: HTMLButtonElement,
    initialFocus: "first" | "last" = "first",
  ) => {
    if (action.disabled) return;
    setOpenMenu({ nodeId: node.id, actionId: action.id, anchor, initialFocus });
  };

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    // Canvas shortcuts must not delete or move nodes while operating a toolbar button.
    event.stopPropagation();
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [
      ...(toolbar.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus({ preventScroll: true });
    buttons[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return (
    <>
      <div
        ref={toolbar}
        role="toolbar"
        aria-label={t("canvas.selection.toolbar")}
        aria-orientation="horizontal"
        data-node-id={node.id}
        className={`cw-selection-toolbar nodrag nopan nowheel ${className}`}
        style={style}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={navigate}
      >
        {groups.map((actions, index) => (
          <div className="cw-selection-toolbar-group" key={actions[0]!.id}>
            {index > 0 && (
              <span
                className="cw-selection-toolbar-separator"
                aria-hidden="true"
              />
            )}
            {actions.map((action) => (
              <TooltipButton
                key={action.id}
                data-action={action.id}
                aria-label={action.label}
                aria-haspopup={
                  action.options
                    ? menuAction?.id === action.id && openMenu?.grid
                      ? "dialog"
                      : "menu"
                    : undefined
                }
                aria-expanded={
                  action.options ? menuAction?.id === action.id : undefined
                }
                aria-controls={
                  menuAction?.id === action.id ? menuId : undefined
                }
                label={
                  action.disabled
                    ? t("canvas.selection.locked", { label: action.label })
                    : action.label
                }
                tooltipSide="top"
                // Labelled buttons already show their text; only icons and lock reasons need a tooltip.
                showTooltip={Boolean(action.iconOnly || action.disabled)}
                className={`${action.iconOnly ? "is-icon-only" : ""}${action.destructive ? " is-destructive" : ""}`}
                disabled={action.disabled}
                onClick={(event) => {
                  if (action.options) {
                    if (menuAction?.id === action.id) setOpenMenu(null);
                    else showMenu(action, event.currentTarget);
                  } else {
                    setOpenMenu(null);
                    action.run?.();
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    !action.options ||
                    !["ArrowDown", "ArrowUp"].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  showMenu(
                    action,
                    event.currentTarget,
                    event.key === "ArrowUp" ? "last" : "first",
                  );
                }}
              >
                {action.glyph ? (
                  <ToolIcon name={action.glyph} size={18} />
                ) : (
                  <CanvasIcon name={action.icon} size={16} />
                )}
                {!action.iconOnly && <span>{action.label}</span>}
                {action.options && <CanvasIcon name="chevronDown" size={12} />}
              </TooltipButton>
            ))}
          </div>
        ))}
        {onExpand && node.type === "text" && (
          <div className="cw-selection-toolbar-group cw-selection-toolbar-expand">
            <span
              className="cw-selection-toolbar-separator"
              aria-hidden="true"
            />
            <TooltipButton
              data-action="expand"
              className="is-icon-only"
              aria-label={t("canvas.selection.expandText")}
              aria-haspopup="dialog"
              label={t("canvas.selection.expandText")}
              tooltipSide="top"
              onClick={() => {
                setOpenMenu(null);
                onExpand();
              }}
            >
              <CanvasIcon name="expand" size={16} />
            </TooltipButton>
          </div>
        )}
      </div>
      {openMenu && menuAction && (
        <SelectionToolbarMenu
          key={`${node.id}-${menuAction.id}`}
          anchor={openMenu.anchor}
          id={menuId}
          label={
            openMenu.grid ? t("canvas.selection.gridSplit") : menuAction.label
          }
          role={openMenu.grid ? "dialog" : "menu"}
          initialFocus={openMenu.initialFocus}
          onClose={() => setOpenMenu(null)}
        >
          {openMenu.grid ? (
            <GridSplitOptions
              onCancel={() => {
                setOpenMenu(null);
                openMenu.anchor.focus({ preventScroll: true });
              }}
              onConfirm={(rows, columns) => {
                setOpenMenu(null);
                onGridSplit?.(rows, columns);
              }}
            />
          ) : (
            menuAction.options?.map((option) => (
              <TooltipButton
                key={option.id}
                data-action={option.id}
                role="menuitem"
                aria-label={option.label}
                label={
                  option.disabled
                    ? t("canvas.selection.unavailable", {
                        label: option.label,
                      })
                    : (option.description ?? option.label)
                }
                tooltipSide="right"
                // The item shows its label and description; only an unavailable item explains itself.
                showTooltip={Boolean(option.disabled || locked)}
                disabled={option.disabled || locked}
                className="cw-selection-menu-item"
                onClick={() => {
                  if (option.grid) setOpenMenu({ ...openMenu, grid: true });
                  else {
                    setOpenMenu(null);
                    option.run?.();
                  }
                }}
              >
                <CanvasIcon name={option.icon} size={17} />
                <span>
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </span>
                {option.grid && <CanvasIcon name="chevronRight" size={13} />}
              </TooltipButton>
            ))
          )}
        </SelectionToolbarMenu>
      )}
    </>
  );
}
