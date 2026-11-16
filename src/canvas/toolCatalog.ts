/** Authored local task contract. These descriptors are not a private API client.
 * Unverified dynamic model, price, distance, brightness and resolution options require capabilities.
 */
import { getActiveLocale, tNow } from "../i18n/messages.ts";
import { translateToolText } from "./toolText.ts";

export type CanvasToolId =
  | "layers"
  | "crop"
  | "smart-edit"
  | "outpaint"
  | "cutout"
  | "inpainting-remove"
  | "image-hd"
  | "view-control"
  | "lighting"
  | "layer-decompose"
  | "panorama"
  | "product-replacement"
  | "multi-size"
  | "dynamic-poster"
  | "ecommerce-main"
  | "image-presets"
  | "grid-split"
  | "composition"
  | "annotation"
  | "video-edit"
  | "video-extend"
  | "video-partial-reshoot"
  | "video-upscale"
  | "video-frame-interpolation"
  | "video-depth-capture"
  | "video-subtitle-erasure"
  | "video-matting"
  | "video-crop"
  | "video-translation"
  | "extract-audio"
  | "audio-separation"
  | "video-trim"
  | "audio-trim"
  | "video-frame-capture"
  | "director-stage";
export type ToolValue = string | number | boolean;
export type ToolParameters = Record<string, ToolValue>;
export interface ToolField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "color" | "boolean";
  default?: ToolValue;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly { value: string | number; label: string }[];
  capabilityOptions?: boolean;
  hint?: string;
}
export interface CanvasToolDefinition {
  id: CanvasToolId;
  title: string;
  description: string;
  category: "image" | "video" | "audio" | "director";
  execution: "local-editor" | "remote";
  sources: readonly ("image" | "video" | "audio")[];
  minSources: number;
  maxSources: number;
  /** Task protocol coverage. Observed UI choices can be present while the protocol remains entry-only. */
  parameterCoverage: "verified" | "partial" | "entry-only";
  fields: readonly ToolField[];
}
export interface ToolSource {
  nodeId: string;
  kind: string;
  title: string;
  src?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}
export interface ToolSelection {
  sourceNodeId: string;
  width: number;
  height: number;
  /** The integration owns producing a full-resolution mask, not a preview thumbnail. */
  maskDataUrl?: string;
  boxes?: readonly { x: number; y: number; width: number; height: number }[];
}
export interface CanvasToolTask {
  version: 1;
  tool: CanvasToolId;
  sourceNodeIds: string[];
  parameters: ToolParameters;
  selection?: ToolSelection;
}
export interface ToolCapability {
  available: boolean;
  reason?: string;
  /** Adapter-supplied fields own dynamic model/option constraints. */
  fields?: readonly ToolField[];
  parametersConfirmed?: boolean;
  models?: Readonly<Record<string, readonly { id: string; label: string }[]>>;
}
export type ToolCapabilities = Partial<Record<CanvasToolId, ToolCapability>>;
const prompt: ToolField = {
  key: "prompt",
  label: "提示词",
  type: "textarea",
  default: "",
};
const dynamic = (key: string, label: string): ToolField => ({
  key,
  label,
  type: "select",
  capabilityOptions: true,
  required: true,
  hint: "由已连接服务提供可用选项",
});
const number = (
  key: string,
  label: string,
  value: number,
  min?: number,
  max?: number,
  step = 1,
): ToolField => ({
  key,
  label,
  type: "number",
  default: value,
  required: true,
  min,
  max,
  step,
});
const choice = (
  key: string,
  label: string,
  values: string[],
  value = values[0]!,
): ToolField => ({
  key,
  label,
  type: "select",
  default: value,
  options: values.map((value) => ({ value, label: value })),
  required: true,
});

const multiSizePresets = [
  { ratio: "1:1", width: 1200, height: 1200 },
  { ratio: "3:4", width: 1200, height: 1600 },
  { ratio: "9:16", width: 1080, height: 1920 },
  { ratio: "16:9", width: 1920, height: 1080 },
  { ratio: "4:3", width: 1600, height: 1200 },
  { ratio: "21:9", width: 2520, height: 1080 },
  { ratio: "2:3", width: 1200, height: 1800 },
  { ratio: "3:2", width: 1800, height: 1200 },
] as const;
function tool(
  id: CanvasToolId,
  title: string,
  description: string,
  fields: readonly ToolField[],
  options: Partial<CanvasToolDefinition> = {},
): CanvasToolDefinition {
  return {
    id,
    title,
    description,
    category: "image",
    execution: "remote",
    sources: ["image"],
    minSources: 1,
    maxSources: 1,
    parameterCoverage: "partial",
    fields,
    ...options,
  };
}
export const CANVAS_TOOLS: readonly CanvasToolDefinition[] = [
  tool(
    "layers",
    "图层工作台",
    "新增图层、变换、手绘蒙版、撤销与 PNG 合成。",
    [],
    { execution: "local-editor", parameterCoverage: "verified" },
  ),
  tool("crop", "裁剪与调色", "本地裁剪、旋转、翻转和色彩调整。", [], {
    execution: "local-editor",
    parameterCoverage: "verified",
  }),
  tool(
    "smart-edit",
    "智能改图",
    "通过提示词与标记修改图像；绘图工具受模型能力限制。",
    [
      dynamic("imageModelConfigId", "模型"),
      prompt,
      choice("resolution", "清晰度", ["2K"]),
    ],
  ),
  tool(
    "outpaint",
    "扩图",
    "按四边扩展比例生成画面之外的内容。",
    [
      prompt,
      ...["top", "bottom", "left", "right"].map((key, i) =>
        number(
          key,
          ["上方比例", "下方比例", "左侧比例", "右侧比例"][i]!,
          0.25,
          0,
          undefined,
          0.05,
        ),
      ),
      number("outputWidth", "输出宽度", 1536, 1),
      number("outputHeight", "输出高度", 1536, 1),
    ],
    { parameterCoverage: "verified" },
  ),
  tool("cutout", "抠图", "自动识别主体或使用你提供的蒙版，输出透明背景素材。", [
    choice(
      "selectionMode",
      "选择方式",
      ["auto-subject", "manual"],
      "auto-subject",
    ),
  ]),
  tool(
    "inpainting-remove",
    "消除笔",
    "用有效蒙版指定要消除的区域；填补内容依赖生成服务。",
    [],
  ),
  tool(
    "image-hd",
    "智能超清",
    "普通超清或增加细节的 Pro 超清，可批量处理图片。",
    [
      choice("kind", "模式", ["normal", "pro"]),
      dynamic("resolution", "清晰度"),
      number("detailStrength", "细节强度", 0.5, 0.01, 1, 0.01),
    ],
    { maxSources: 20 },
  ),
  tool("view-control", "多角度", "调节相机水平角、俯仰角与距离。", [
    number("yaw", "水平角", 0),
    number("pitch", "俯仰角", 0),
    dynamic("distance", "距离"),
  ]),
  tool("lighting", "智能打光", "设置主光方向、软硬光、强度与颜色。", [
    number("yaw", "主光水平角", 0),
    number("pitch", "主光俯仰角", 30, -90, 90),
    dynamic("brightness", "亮度"),
    choice("texture", "光质", ["soft", "hard"]),
    {
      key: "lightColor",
      label: "光源颜色",
      type: "color",
      default: "#ffffff",
      required: true,
    },
  ]),
  tool(
    "layer-decompose",
    "图层分解",
    "原站实测提供智能拆分、框选拆分和按描述拆分。框选需原图矩形选区；实际拆分及报价由真实服务提供。",
    [
      {
        key: "mode",
        label: "拆分模式",
        type: "select",
        required: true,
        default: "smart",
        options: [
          { value: "smart", label: "智能拆分" },
          { value: "boxes", label: "框选拆分" },
          { value: "description", label: "按描述拆分" },
        ],
        hint: "智能拆分识别常见对象；框选拆分需先编辑选区；按描述拆分需填写对象。",
      },
      { ...prompt, hint: "按描述拆分时必须填写；智能拆分无需描述。" },
      choice("resolution", "清晰度", ["auto"]),
    ],
    { parameterCoverage: "entry-only" },
  ),
  tool(
    "panorama",
    "720 全景",
    "从单张图片生成 2:1 全景；模型和清晰度由服务提供。",
    [
      dynamic("imageModelConfigId", "模型"),
      dynamic("resolution", "清晰度"),
      prompt,
    ],
  ),
  tool(
    "product-replacement",
    "商品替换",
    "使用场景图和商品图替换主体，支持选区与提示词；原站已实测自动主体识别和 2K 结果。",
    [prompt, choice("resolution", "清晰度", ["2K", "4K"])],
    { minSources: 2, maxSources: 2 },
  ),
  tool(
    "multi-size",
    "智能多尺寸",
    "按原站实测画幅和像素尺寸创建草稿；自定义范围与实际服务协议尚未接入。",
    [
      {
        key: "aspectRatio",
        label: "输出尺寸",
        type: "select",
        required: true,
        default: "1:1",
        options: [
          ...multiSizePresets.map((size) => ({
            value: size.ratio,
            label: `${size.ratio} · ${size.width}×${size.height}`,
          })),
          { value: "custom", label: "自定义" },
        ],
      },
      {
        key: "outputWidth",
        label: "自定义宽度",
        type: "number",
        min: 1,
        step: 1,
        hint: "仅自定义画幅使用，单位像素；服务上限未确认。",
      },
      {
        key: "outputHeight",
        label: "自定义高度",
        type: "number",
        min: 1,
        step: 1,
        hint: "仅自定义画幅使用，单位像素；服务上限未确认。",
      },
    ],
    { parameterCoverage: "entry-only" },
  ),
  tool(
    "dynamic-poster",
    "动态海报",
    "基于原图比例创建动态海报请求；本轮原站入口仅提供 Seedance 2.5，实际生成需连接服务。",
    [
      prompt,
      choice("model", "模型", ["Seedance 2.5"]),
      choice("resolution", "清晰度", ["480P", "720P", "1080P"]),
    ],
    { parameterCoverage: "entry-only" },
  ),
  tool(
    "ecommerce-main",
    "电商主图",
    "整理电商主图请求；支持最多 6 张参考图，实际生成需连接服务。",
    [
      choice("view", "视角", ["默认", "正视", "侧视", "俯视"]),
      choice("resolution", "清晰度", ["1.5K", "2K"]),
      {
        ...choice("aspectRatio", "画幅", ["1:1"]),
        hint: "本轮只核对 1:1；其他画幅待服务确认。",
      },
    ],
    { maxSources: 6, parameterCoverage: "entry-only" },
  ),
  tool(
    "image-presets",
    "图像预设",
    "三视图、连续分镜、多机位等预设由模型能力加载。",
    [dynamic("preset", "预设")],
  ),
  tool(
    "grid-split",
    "九宫格拆图",
    "在本地按可调行列网格实际裁切图片，不自动推断分镜边界。",
    [],
    { execution: "local-editor", parameterCoverage: "entry-only" },
  ),
  tool("composition", "构图", "调整构图的独立编辑入口。", [], {
    execution: "local-editor",
    parameterCoverage: "entry-only",
  }),
  tool("annotation", "标注", "矩形、椭圆、箭头、画笔与文字标注。", [], {
    execution: "local-editor",
    parameterCoverage: "entry-only",
  }),
  ...(
    [
      ["video-extend", "视频延长"],
      ["video-partial-reshoot", "局部重拍"],
    ] as const
  ).map(([id, title]) =>
    tool(
      id,
      title,
      "此功能有独立任务与能力约束，参数需由已连接服务提供。",
      [],
      {
        category: "video",
        sources: ["video"],
        parameterCoverage: "entry-only",
      },
    ),
  ),
  tool(
    "video-edit",
    "视频编辑",
    "原站实测支持 4–30 秒素材、提示词及矩形/画笔/箭头/文字/橡皮擦/标记；本轮未见模型选择。这里只记录意图，视频标注数据尚未接入。",
    [
      { ...prompt, required: true },
      {
        key: "annotationTool",
        label: "原站标注工具",
        type: "select",
        options: [
          { value: "rectangle", label: "矩形" },
          { value: "brush", label: "画笔" },
          { value: "arrow", label: "箭头" },
          { value: "text", label: "文字" },
          { value: "eraser", label: "橡皮擦" },
          { value: "marker", label: "标记" },
        ],
        hint: "仅保存拟用工具，不会生成视频标注数据。",
      },
    ],
    { category: "video", sources: ["video"], parameterCoverage: "entry-only" },
  ),
  tool(
    "video-depth-capture",
    "深度动作捕捉",
    "输出 480P / 720P 灰度深度视频（近处亮、远处暗），素材最长 30 秒；需要接入 vLLM-Omni 深度接口。",
    [choice("resolution", "清晰度", ["480P", "720P"])],
    { category: "video", sources: ["video"], parameterCoverage: "entry-only" },
  ),
  tool(
    "video-subtitle-erasure",
    "字幕擦除",
    "本轮原站实测没有额外设置；实际视频处理依赖真实服务。",
    [],
    { category: "video", sources: ["video"], parameterCoverage: "entry-only" },
  ),
  tool(
    "video-matting",
    "视频抠像",
    "原站实测可选黑色、绿色或透明背景；输出格式与处理协议由真实服务确定。",
    [
      {
        key: "background",
        label: "输出背景",
        type: "select",
        required: true,
        options: [
          { value: "black", label: "黑色" },
          { value: "green", label: "绿色" },
          { value: "transparent", label: "透明" },
        ],
      },
    ],
    { category: "video", sources: ["video"], parameterCoverage: "entry-only" },
  ),
  tool(
    "video-translation",
    "视频翻译",
    "静态代码存在候选入口，本轮原站未见；当前可用性和参数未知。",
    [],
    { category: "video", sources: ["video"], parameterCoverage: "entry-only" },
  ),
  tool(
    "video-upscale",
    "视频超清",
    "视频增强有 2K 与 4K 输出路径，支持条件由服务判断。",
    [choice("resolution", "清晰度", ["2K", "4K"])],
    { category: "video", sources: ["video"] },
  ),
  tool(
    "video-frame-interpolation",
    "视频补帧",
    "补帧能力和输出帧率由服务提供。",
    [dynamic("fps", "输出帧率")],
    { category: "video", sources: ["video"] },
  ),
  ...(
    [
      ["video-trim", "时长修剪"],
      ["video-crop", "画面裁剪"],
      ["video-frame-capture", "视频取帧"],
    ] as const
  ).map(([id, title]) =>
    tool(
      id,
      title,
      id === "video-crop"
        ? "按原视频像素裁剪画幅，保留可捕获音轨，本地重编码 WebM。"
        : "打开对应的本地媒体编辑器。",
      [],
      {
        category: "video",
        sources: ["video"],
        execution: "local-editor",
        parameterCoverage: "entry-only",
      },
    ),
  ),
  tool(
    "extract-audio",
    "提取音频",
    "将视频音轨另存为音频素材；对应本轮原站「声音分离 → 分离音频」。",
    [],
    {
      category: "audio",
      sources: ["video"],
      execution: "local-editor",
      parameterCoverage: "entry-only",
    },
  ),
  tool(
    "audio-separation",
    "音频分离",
    "仅保留静态候选入口。本轮未见人声/伴奏分离；视频「声音分离」实测仅为提取音频，不能据此确认此能力。",
    [],
    {
      category: "audio",
      sources: ["video", "audio"],
      parameterCoverage: "entry-only",
    },
  ),
  tool("audio-trim", "音频裁剪", "裁剪音频时长并导出新素材。", [], {
    category: "audio",
    sources: ["audio"],
    execution: "local-editor",
    parameterCoverage: "entry-only",
  }),
  tool(
    "director-stage",
    "导演台",
    "布景、角色、相机、灯光与运镜预演；这是 3D 工作台入口。",
    [
      choice("mode", "工作模式", ["staging", "performance"]),
      choice("source", "导出来源", ["storyboard", "camera"]),
      number("longEdge", "导出长边", 1280, 1),
      dynamic("fps", "导出帧率"),
      {
        key: "abstractCharacters",
        label: "简化角色",
        type: "boolean",
        default: false,
      },
    ],
    {
      category: "director",
      execution: "local-editor",
      sources: [],
      minSources: 0,
      maxSources: 0,
      parameterCoverage: "partial",
    },
  ),
];
/** Stage preview outputs are projections of an editable director stage;
 * generative and audio transforms target the stage, not the render, and the
 * render has no audio track. */
export const STAGE_PREVIEW_EXCLUDED_VIDEO_TOOLS: ReadonlySet<CanvasToolId> =
  new Set([
    "video-partial-reshoot",
    "video-upscale",
    "video-edit",
    "video-extend",
    "video-depth-capture",
    "extract-audio",
    "audio-separation",
    "video-frame-interpolation",
    "video-subtitle-erasure",
    "video-matting",
  ]);
export function isStagePreviewOutput(node: {
  type: string;
  data: { generationProvenance?: { stagePreview?: boolean } };
}): boolean {
  return (
    node.type === "video" &&
    node.data.generationProvenance?.stagePreview === true
  );
}
export function toolFields(
  tool: CanvasToolDefinition,
  capability?: ToolCapability,
): readonly ToolField[] {
  const fields = capability?.fields ?? [];
  const overridden = new Set(fields.map((field) => field.key));
  const locale = getActiveLocale();
  const display = (field: ToolField): ToolField => ({
    ...field,
    label: translateToolText(locale, field.label),
    ...(field.hint
      ? { hint: translateToolText(locale, field.hint) }
      : {}),
    ...(field.options
      ? {
          options: field.options.map((option) => ({
            ...option,
            label: translateToolText(locale, option.label),
          })),
        }
      : {}),
  });
  return [
    ...tool.fields.filter((field) => !overridden.has(field.key)),
    ...fields,
  ].map((field) => {
    const shown = display(field);
    const models = capability?.models?.["image.edit"];
    if (shown.key !== "imageModelConfigId" || !models) return shown;
    return {
      ...shown,
      options: models.map((model) => ({ value: model.id, label: model.label })),
    };
  });
}
export function initialToolParameters(
  tool: CanvasToolDefinition,
  capability?: ToolCapability,
): ToolParameters {
  return Object.fromEntries(
    toolFields(tool, capability).flatMap((field) =>
      field.default !== undefined
        ? [[field.key, field.default]]
        : field.type === "select" && field.options?.length
          ? [[field.key, field.options[0]!.value]]
          : [],
    ),
  );
}
export function createCanvasToolTask(
  tool: CanvasToolId,
  sourceNodeIds: string[],
  values: ToolParameters,
  selection?: ToolSelection,
): CanvasToolTask {
  let parameters = { ...values };
  if (tool === "multi-size") {
    const preset = multiSizePresets.find(
      (size) => size.ratio === values.aspectRatio,
    );
    if (preset)
      parameters = {
        ...parameters,
        outputWidth: preset.width,
        outputHeight: preset.height,
      };
  }
  if (tool === "outpaint")
    parameters = {
      ...parameters,
      resolution: "2K",
      candidateCount: 1,
      maxSize: Math.max(
        Number(values.outputWidth),
        Number(values.outputHeight),
      ),
    };
  if (tool === "panorama") parameters = { ...parameters, aspectRatio: "2:1" };
  if (
    tool === "view-control" &&
    typeof values.yaw === "number" &&
    Number.isFinite(values.yaw) &&
    typeof values.pitch === "number" &&
    Number.isFinite(values.pitch)
  )
    parameters = {
      ...parameters,
      yaw: ((Math.round(values.yaw) % 360) + 360) % 360,
      pitch: Math.round(values.pitch),
      resolution: "2K",
    };
  if (tool === "lighting") parameters = { ...parameters, resolution: "2K" };
  if (tool === "image-hd" && values.kind === "normal") {
    delete parameters.resolution;
    delete parameters.detailStrength;
  }
  return {
    version: 1,
    tool,
    sourceNodeIds: [...sourceNodeIds],
    parameters,
    ...(selection ? { selection } : {}),
  };
}
/** Validates a local request. Capability/authorization/server validation remain the adapter's job. */
export function validateToolTask(
  task: CanvasToolTask,
  sources: readonly ToolSource[],
  capability?: ToolCapability,
): string[] {
  const definition = CANVAS_TOOLS.find((tool) => tool.id === task.tool);
  if (!definition) return [tNow("errors.tool.unknown")];
  const errors: string[] = [];
  if (task.version !== 1) errors.push(tNow("errors.tool.version"));
  if (new Set(task.sourceNodeIds).size !== task.sourceNodeIds.length)
    errors.push(tNow("errors.tool.duplicateSource"));
  const selected = task.sourceNodeIds.map((id) =>
    sources.find((source) => source.nodeId === id),
  );
  if (
    selected.length < definition.minSources ||
    selected.length > definition.maxSources
  )
    errors.push(
      tNow("errors.tool.sources", {
        range:
          definition.minSources === definition.maxSources
            ? definition.minSources
            : `${definition.minSources}–${definition.maxSources}`,
      }),
    );
  if (
    selected.some(
      (source) =>
        !source ||
        !definition.sources.includes(
          source.kind as "image" | "video" | "audio",
        ) ||
        !source.src,
    )
  )
    errors.push(tNow("errors.tool.sourceMissing"));
  for (const field of toolFields(definition, capability)) {
    // Ordinary upscaling does not submit Pro-only detail/resolution fields.
    if (
      task.tool === "image-hd" &&
      task.parameters.kind === "normal" &&
      ["detailStrength", "resolution"].includes(field.key)
    )
      continue;
    if (
      task.tool === "multi-size" &&
      task.parameters.aspectRatio !== "custom" &&
      ["outputWidth", "outputHeight"].includes(field.key)
    )
      continue;
    const value = task.parameters[field.key];
    if (value === undefined || value === "") {
      if (field.required)
        errors.push(tNow("errors.tool.fieldRequired", { label: field.label }));
      continue;
    }
    if (field.type === "number") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max) ||
        (field.step === 1 && !Number.isInteger(value))
      )
        errors.push(
          tNow("errors.tool.fieldNumber", {
            label: field.label,
            type:
              field.step === 1 ? tNow("errors.tool.integer") : tNow("errors.tool.number"),
          }),
        );
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean")
        errors.push(tNow("errors.tool.fieldBoolean", { label: field.label }));
    } else if (field.type === "select") {
      if (!field.options?.some((option) => option.value === value))
        errors.push(tNow("errors.tool.fieldSelect", { label: field.label }));
    } else if (typeof value !== "string")
      errors.push(tNow("errors.tool.fieldFormat", { label: field.label }));
    else if (field.type === "color" && !/^#[\da-f]{6}$/.test(value))
      errors.push(tNow("errors.tool.fieldColor", { label: field.label }));
  }
  const p = task.parameters;
  if (task.tool === "multi-size") {
    const preset = multiSizePresets.find(
      (size) => size.ratio === p.aspectRatio,
    );
    if (
      preset &&
      (p.outputWidth !== preset.width || p.outputHeight !== preset.height)
    )
      errors.push(tNow("errors.tool.multiPreset"));
    if (
      p.aspectRatio === "custom" &&
      ![p.outputWidth, p.outputHeight].every(
        (value) =>
          typeof value === "number" && Number.isSafeInteger(value) && value > 0,
      )
    )
      errors.push(tNow("errors.tool.multiCustom"));
  }
  if (task.tool === "video-edit") {
    const duration = selected[0]?.durationSeconds;
    if (duration === undefined || !Number.isFinite(duration))
      errors.push(tNow("errors.tool.videoDurationUnknown"));
    else if (duration < 4 || duration > 30)
      errors.push(tNow("errors.tool.videoDurationRange"));
    if (typeof p.prompt !== "string" || !p.prompt.trim())
      errors.push(tNow("errors.tool.videoPrompt"));
  }
  if (
    task.tool === "layer-decompose" &&
    p.mode === "description" &&
    (typeof p.prompt !== "string" || !p.prompt.trim())
  )
    errors.push(tNow("errors.tool.splitPrompt"));
  if (
    task.tool === "outpaint" &&
    [p.top, p.bottom, p.left, p.right].every((value) => value === 0)
  )
    errors.push(tNow("errors.tool.outpaintDirection"));
  if (
    task.tool === "outpaint" &&
    (p.candidateCount !== 1 ||
      p.resolution !== "2K" ||
      p.maxSize !== Math.max(Number(p.outputWidth), Number(p.outputHeight)))
  )
    errors.push(tNow("errors.tool.outpaintFixed"));
  if (task.tool === "lighting" && !Number.isInteger(p.brightness))
    errors.push(tNow("errors.tool.lightBrightness"));
  if (task.tool === "layer-decompose" && selected[0]) {
    const source = selected[0];
    if (
      source.mimeType &&
      !["image/png", "image/jpeg", "image/jpg"].includes(source.mimeType)
    )
      errors.push(tNow("errors.tool.layerFormat"));
    if (
      source.width !== undefined &&
      source.height !== undefined &&
      source.width * source.height < 262144
    )
      errors.push(tNow("errors.tool.layerPixels"));
  }
  if (
    task.tool === "inpainting-remove" ||
    (task.tool === "cutout" && p.selectionMode === "manual")
  ) {
    if (!task.selection?.maskDataUrl?.startsWith("data:image/"))
      errors.push(tNow("errors.tool.maskRequired"));
  }
  if (task.selection && task.selection.sourceNodeId !== selected[0]?.nodeId)
    errors.push(tNow("errors.tool.maskOwner"));
  if (
    task.selection &&
    (!Number.isSafeInteger(task.selection.width) ||
      !Number.isSafeInteger(task.selection.height) ||
      task.selection.width < 1 ||
      task.selection.height < 1)
  )
    errors.push(tNow("errors.tool.selectionSize"));
  if (
    task.selection &&
    selected[0]?.width !== undefined &&
    selected[0]?.height !== undefined &&
    (task.selection.width !== selected[0].width ||
      task.selection.height !== selected[0].height)
  )
    errors.push(tNow("errors.tool.maskSize"));
  if (
    task.tool === "product-replacement" ||
    (task.tool === "layer-decompose" && p.mode === "boxes")
  ) {
    const source = selected[0];
    if (!task.selection?.boxes?.length)
      errors.push(
        task.tool === "product-replacement"
          ? tNow("errors.tool.productRegion")
          : tNow("errors.tool.boxesRequired"),
      );
    else if (
      task.selection.boxes.some(
        (box) =>
          ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
          box.x < 0 ||
          box.y < 0 ||
          box.width <= 0 ||
          box.height <= 0 ||
          (source?.width !== undefined && box.x + box.width > source.width) ||
          (source?.height !== undefined && box.y + box.height > source.height),
      )
    )
      errors.push(
        task.tool === "product-replacement"
          ? tNow("errors.tool.regionOut")
          : tNow("errors.tool.splitRegionOut"),
      );
  }
  if (
    definition.parameterCoverage === "entry-only" &&
    !capability?.parametersConfirmed
  )
    errors.push(tNow("errors.tool.entryOnly"));
  return errors;
}

/** Persistence accepts incomplete drafts; service-specific validation happens at submission. */
export function parseCanvasToolTaskValue(value: unknown): CanvasToolTask {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(tNow("errors.tool.draftFormat"));
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !CANVAS_TOOLS.some((tool) => tool.id === raw.tool))
    throw new Error(tNow("errors.tool.draftVersion"));
  if (
    !Array.isArray(raw.sourceNodeIds) ||
    raw.sourceNodeIds.length > 100 ||
    raw.sourceNodeIds.some(
      (id) => typeof id !== "string" || !id || id.length > 200,
    ) ||
    new Set(raw.sourceNodeIds).size !== raw.sourceNodeIds.length
  )
    throw new Error(tNow("errors.tool.draftSource"));
  if (
    !raw.parameters ||
    typeof raw.parameters !== "object" ||
    Array.isArray(raw.parameters)
  )
    throw new Error(tNow("errors.tool.draftParameters"));
  const parameters: ToolParameters = {};
  const entries = Object.entries(raw.parameters);
  if (entries.length > 100) throw new Error(tNow("errors.tool.paramLimit"));
  for (const [key, parameter] of entries) {
    if (
      !key ||
      key.length > 100 ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !["string", "number", "boolean"].includes(typeof parameter) ||
      (typeof parameter === "number" && !Number.isFinite(parameter)) ||
      (typeof parameter === "string" && parameter.length > 100000)
    )
      throw new Error(tNow("errors.tool.paramValue"));
    parameters[key] = parameter as ToolValue;
  }
  let selection: ToolSelection | undefined;
  if (raw.selection !== undefined) {
    if (
      !raw.selection ||
      typeof raw.selection !== "object" ||
      Array.isArray(raw.selection)
    )
      throw new Error(tNow("errors.tool.selectionFormat"));
    const s = raw.selection as Record<string, unknown>;
    if (
      typeof s.sourceNodeId !== "string" ||
      s.sourceNodeId.length > 200 ||
      !Number.isSafeInteger(s.width) ||
      !Number.isSafeInteger(s.height) ||
      (s.width as number) < 1 ||
      (s.height as number) < 1
    )
      throw new Error(tNow("errors.tool.selectionSource"));
    if (
      s.maskDataUrl !== undefined &&
      (typeof s.maskDataUrl !== "string" ||
        !s.maskDataUrl.startsWith("data:image/") ||
        s.maskDataUrl.length > 90_000_000)
    )
      throw new Error(tNow("errors.tool.maskInvalid"));
    let boxes: ToolSelection["boxes"];
    if (s.boxes !== undefined) {
      if (!Array.isArray(s.boxes) || s.boxes.length > 100)
        throw new Error(tNow("errors.tool.boxInvalid"));
      boxes = s.boxes.map((value) => {
        if (!value || typeof value !== "object")
          throw new Error(tNow("errors.tool.boxInvalid"));
        const box = value as Record<string, unknown>;
        if (
          ![box.x, box.y, box.width, box.height].every(
            (n) => typeof n === "number" && Number.isFinite(n),
          ) ||
          (box.x as number) < 0 ||
          (box.y as number) < 0 ||
          (box.width as number) <= 0 ||
          (box.height as number) <= 0
        )
          throw new Error(tNow("errors.tool.boxSize"));
        return {
          x: box.x as number,
          y: box.y as number,
          width: box.width as number,
          height: box.height as number,
        };
      });
    }
    selection = {
      sourceNodeId: s.sourceNodeId,
      width: s.width as number,
      height: s.height as number,
      ...(s.maskDataUrl ? { maskDataUrl: s.maskDataUrl as string } : {}),
      ...(boxes ? { boxes } : {}),
    };
  }
  return {
    version: 1,
    tool: raw.tool as CanvasToolId,
    sourceNodeIds: [...raw.sourceNodeIds] as string[],
    parameters,
    ...(selection ? { selection } : {}),
  };
}
export function sameCanvasToolTask(
  a: CanvasToolTask | undefined,
  b: CanvasToolTask | undefined,
): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    a.version !== b.version ||
    a.tool !== b.tool ||
    a.sourceNodeIds.length !== b.sourceNodeIds.length ||
    a.sourceNodeIds.some((id, index) => id !== b.sourceNodeIds[index])
  )
    return false;
  const keys = Object.keys(a.parameters);
  if (
    keys.length !== Object.keys(b.parameters).length ||
    keys.some((key) => a.parameters[key] !== b.parameters[key])
  )
    return false;
  const x = a.selection,
    y = b.selection;
  if (x === y) return true;
  if (
    !x ||
    !y ||
    x.sourceNodeId !== y.sourceNodeId ||
    x.width !== y.width ||
    x.height !== y.height ||
    x.maskDataUrl !== y.maskDataUrl
  )
    return false;
  return (
    x.boxes === y.boxes ||
    (!!x.boxes &&
      !!y.boxes &&
      x.boxes.length === y.boxes.length &&
      x.boxes.every(
        (box, index) =>
          box.x === y.boxes![index]!.x &&
          box.y === y.boxes![index]!.y &&
          box.width === y.boxes![index]!.width &&
          box.height === y.boxes![index]!.height,
      ))
  );
}
export function mapCanvasToolTaskReferences(
  task: CanvasToolTask,
  resolve: (id: string) => string | undefined,
): CanvasToolTask {
  const sourceNodeIds = task.sourceNodeIds.flatMap((id) => {
    const mapped = resolve(id);
    return mapped ? [mapped] : [];
  });
  const sourceNodeId = task.selection && resolve(task.selection.sourceNodeId);
  const { selection, ...rest } = task;
  return {
    ...rest,
    sourceNodeIds,
    ...(selection && sourceNodeId
      ? { selection: { ...selection, sourceNodeId } }
      : {}),
  };
}
