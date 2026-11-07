/**
 * English copy for the authored tool catalog.
 *
 * Tool definitions are data, not React components, and the same definition is
 * used by validation and by several panels. Keeping the Chinese source and
 * translating on read preserves stable ids/values and avoids cloning the whole
 * catalog for every locale.
 */
import type { Locale } from "../i18n/types.ts";
import type { CanvasToolDefinition, ToolField } from "./toolCatalog.ts";

const EN: Record<string, string> = {
  "仅自定义画幅使用，单位像素；服务上限未确认。":
    "Only used for custom aspect ratios, in pixels; the service limit is unconfirmed.",
  "选区矩形数据无效。": "Invalid selection rectangle data.",
  "提示词": "Prompt",
  "由已连接服务提供可用选项": "Options come from the connected service",
  "模型": "Model",
  "清晰度": "Resolution",
  "图层工作台": "Layer Studio",
  "新增图层、变换、手绘蒙版、撤销与 PNG 合成。":
    "Add layers, transform, paint masks, undo, and composite PNG.",
  "裁剪与调色": "Crop & Color",
  "本地裁剪、旋转、翻转和色彩调整。":
    "Crop, rotate, flip, and adjust color locally.",
  "智能改图": "Smart Edit",
  "通过提示词与标记修改图像；绘图工具受模型能力限制。":
    "Edit images with prompts and marks; drawing tools depend on model capabilities.",
  "扩图": "Outpaint",
  "按四边扩展比例生成画面之外的内容。":
    "Extend beyond the frame using per-edge expansion ratios.",
  "上方比例": "Top ratio",
  "下方比例": "Bottom ratio",
  "左侧比例": "Left ratio",
  "右侧比例": "Right ratio",
  "输出宽度": "Output width",
  "输出高度": "Output height",
  "抠图": "Cutout",
  "自动识别主体或使用你提供的蒙版，输出透明背景素材。":
    "Detect the subject automatically or use your mask, then output transparent media.",
  "选择方式": "Selection method",
  "消除笔": "Eraser",
  "用有效蒙版指定要消除的区域；填补内容依赖生成服务。":
    "Use a valid mask to mark the area to remove; filling depends on the generation service.",
  "智能超清": "AI Upscale",
  "普通超清或增加细节的 Pro 超清，可批量处理图片。":
    "Standard upscale or detail-enhancing Pro upscale; batch image processing is supported.",
  "模式": "Mode",
  "细节强度": "Detail strength",
  "多角度": "Multi-angle",
  "调节相机水平角、俯仰角与距离。":
    "Adjust camera azimuth, elevation, and distance.",
  "水平角": "Azimuth",
  "俯仰角": "Elevation",
  "距离": "Distance",
  "近": "Near",
  "标准": "Standard",
  "远": "Far",
  "分离方式": "Separation mode",
  "完整音轨": "Full soundtrack",
  "人声（近似）": "Voice (approximate)",
  "背景声（近似）": "Background (approximate)",
  "三视图": "Three-view",
  "人物三视图": "Character three-view",
  "面部三视图": "Face three-view",
  "产品三视图": "Product three-view",
  "连续分镜图": "Storyboard sequence",
  "多机位": "Multi-camera",
  "智能打光": "AI Lighting",
  "设置主光方向、软硬光、强度与颜色。":
    "Set key light direction, hardness, intensity, and color.",
  "主光水平角": "Key light azimuth",
  "主光俯仰角": "Key light elevation",
  "亮度": "Brightness",
  "光质": "Light quality",
  "光源颜色": "Light color",
  "图层分解": "Layer Decompose",
  "原站实测提供智能拆分、框选拆分和按描述拆分。框选需原图矩形选区；实际拆分及报价由真实服务提供。":
    "The source site provides smart, box, and description-based splitting. Box splitting needs a rectangle on the original image; actual splitting and pricing come from the live service.",
  "拆分模式": "Split mode",
  "智能拆分": "Smart split",
  "框选拆分": "Box split",
  "按描述拆分": "Description split",
  "智能拆分识别常见对象；框选拆分需先编辑选区；按描述拆分需填写对象。":
    "Smart split detects common objects; box split needs an edited selection; description split needs the target description.",
  "按描述拆分时必须填写；智能拆分无需描述。":
    "Required for description split; not needed for smart split.",
  "720 全景": "720 Panorama",
  "从单张图片生成 2:1 全景；模型和清晰度由服务提供。":
    "Generate a 2:1 panorama from one image; the service provides models and resolution.",
  "商品替换": "Product Replacement",
  "使用场景图和商品图替换主体，支持选区与提示词；原站已实测自动主体识别和 2K 结果。":
    "Replace the subject using a scene and product image, with selection and prompt support; the source site verified automatic subject detection and 2K results.",
  "智能多尺寸": "Smart Multi-size",
  "按原站实测画幅和像素尺寸创建草稿；自定义范围与实际服务协议尚未接入。":
    "Create drafts from the aspect ratios and pixel sizes verified on the source site; custom ranges and the live service protocol are not connected yet.",
  "输出尺寸": "Output size",
  "自定义": "Custom",
  "自定义宽度": "Custom width",
  "自定义高度": "Custom height",
  "动态海报": "Dynamic Poster",
  "基于原图比例创建动态海报请求；本轮原站入口仅提供 Seedance 2.5，实际生成需连接服务。":
    "Create a dynamic poster request at the source aspect ratio; the source entry only offers Seedance 2.5, and generation requires a connected service.",
  "电商主图": "E-commerce Hero",
  "整理电商主图请求；支持最多 6 张参考图，实际生成需连接服务。":
    "Prepare an e-commerce hero request; up to 6 references are supported, and generation requires a connected service.",
  "视角": "View",
  "默认": "Default",
  "正视": "Front",
  "侧视": "Side",
  "俯视": "Top",
  "画幅": "Aspect ratio",
  "本轮只核对 1:1；其他画幅待服务确认。":
    "Only 1:1 is verified; other ratios await service confirmation.",
  "图像预设": "Image Presets",
  "三视图、连续分镜、多机位等预设由模型能力加载。":
    "Presets such as three-view, storyboard, and multi-camera come from model capabilities.",
  "预设": "Preset",
  "九宫格拆图": "Grid Split",
  "在本地按可调行列网格实际裁切图片，不自动推断分镜边界。":
    "Crop images locally on an adjustable row/column grid without inferring shot boundaries.",
  "构图": "Composition",
  "调整构图的独立编辑入口。": "A dedicated editor for adjusting composition.",
  "标注": "Annotate",
  "矩形、椭圆、箭头、画笔与文字标注。":
    "Rectangle, ellipse, arrow, brush, and text annotations.",
  "视频延长": "Video Extend",
  "局部重拍": "Partial Reshoot",
  "此功能有独立任务与能力约束，参数需由已连接服务提供。":
    "This feature has its own task and capability constraints; parameters come from a connected service.",
  "视频编辑": "Video Edit",
  "原站实测支持 4–30 秒素材、提示词及矩形/画笔/箭头/文字/橡皮擦/标记；本轮未见模型选择。这里只记录意图，视频标注数据尚未接入。":
    "The source site supports 4–30 second media, prompts, and rectangle/brush/arrow/text/eraser/mark tools; no model selection was seen. This only records intent; video annotation data is not connected yet.",
  "原站标注工具": "Source annotation tools",
  "矩形": "Rectangle",
  "画笔": "Brush",
  "箭头": "Arrow",
  "文字": "Text",
  "橡皮擦": "Eraser",
  "标记": "Mark",
  "仅保存拟用工具，不会生成视频标注数据。":
    "Only the intended tool is saved; no video annotation data is generated.",
  "深度动作捕捉": "Depth Motion Capture",
  "输出 480P / 720P 灰度深度视频（近处亮、远处暗），素材最长 30 秒；需要接入 vLLM-Omni 深度接口。":
    "Outputs 480P/720P grayscale depth video (near is bright, far is dark) for media up to 30 seconds; requires the vLLM-Omni depth endpoint.",
  "字幕擦除": "Subtitle Erasure",
  "本轮原站实测没有额外设置；实际视频处理依赖真实服务。":
    "No extra settings were found on the source site; actual video processing depends on the live service.",
  "视频抠像": "Video Matting",
  "原站实测可选黑色、绿色或透明背景；输出格式与处理协议由真实服务确定。":
    "The source site offers black, green, or transparent backgrounds; the live service defines output formats and protocol.",
  "输出背景": "Output background",
  "黑色": "Black",
  "绿色": "Green",
  "透明": "Transparent",
  "视频翻译": "Video Translation",
  "静态代码存在候选入口，本轮原站未见；当前可用性和参数未知。":
    "A candidate entry exists in static code but was not seen on the source site; availability and parameters are unknown.",
  "视频超清": "Video Upscale",
  "视频增强有 2K 与 4K 输出路径，支持条件由服务判断。":
    "Video enhancement offers 2K and 4K outputs; the service decides whether they are supported.",
  "视频补帧": "Frame Interpolation",
  "补帧能力和输出帧率由服务提供。":
    "Frame interpolation and output frame rate come from the service.",
  "输出帧率": "Output frame rate",
  "时长修剪": "Trim",
  "画面裁剪": "Video Crop",
  "视频取帧": "Frame Capture",
  "按原视频像素裁剪画幅，保留可捕获音轨，本地重编码 WebM。":
    "Crop to source pixels, keep a capturable audio track, and re-encode WebM locally.",
  "打开对应的本地媒体编辑器。": "Open the matching local media editor.",
  "提取音频": "Extract Audio",
  "将视频音轨另存为音频素材；对应本轮原站「声音分离 → 分离音频」。":
    "Save the video audio track as an audio asset; corresponds to the source site's \"Audio Separation → Extract Audio\".",
  "音频分离": "Audio Separation",
  "仅保留静态候选入口。本轮未见人声/伴奏分离；视频「声音分离」实测仅为提取音频，不能据此确认此能力。":
    "Static candidate entry only. Vocal/accompaniment separation was not seen; the video \"audio separation\" flow only extracts audio, which does not confirm this capability.",
  "音频裁剪": "Audio Trim",
  "裁剪音频时长并导出新素材。": "Trim audio duration and export a new asset.",
  "导演台": "Director Stage",
  "布景、角色、相机、灯光与运镜预演；这是 3D 工作台入口。":
    "Set, characters, camera, lighting, and camera-move preview; this is the 3D workspace entry.",
  "工作模式": "Work mode",
  "导出来源": "Export source",
  "导出长边": "Export long edge",
  "导出帧率": "Export frame rate",
  "简化角色": "Simplify characters",
  "未知工具。": "Unknown tool.",
  "任务参数版本不受支持。": "Unsupported task parameter version.",
  "来源节点不能重复。": "Source nodes cannot repeat.",
  "来源素材缺失，或媒体类型与工具不匹配。":
    "Source media is missing, or its type does not match the tool.",
  "整数": "integer",
  "数字": "number",
  "预设画幅的输出尺寸必须与实测尺寸一致。":
    "Output dimensions for preset aspect ratios must match the verified dimensions.",
  "自定义尺寸需要填写正整数宽度和高度；服务支持范围仍待确认。":
    "Custom size needs positive integer width and height; the supported range is still unconfirmed.",
  "无法确认视频时长，请先读取来源素材的真实时长。":
    "Cannot confirm video duration; read the source media duration first.",
  "视频编辑仅支持 4–30 秒素材。":
    "Video editing supports only 4–30 second media.",
  "请填写视频编辑提示词。": "Enter a prompt for video editing.",
  "按描述拆分需要填写拆分描述。":
    "Description split needs a split description.",
  "请至少扩展一个方向。": "Expand at least one direction.",
  "扩图固定生成 1 张 2K 图片，长边必须与输出尺寸一致。":
    "Outpaint always generates one 2K image; the long edge must match the output size.",
  "打光亮度必须是能力列表中的整数。":
    "Lighting brightness must be an integer from the capability list.",
  "图层分解已知输入格式只支持 PNG / JPEG。":
    "Layer decompose accepts only PNG / JPEG input.",
  "图层分解图片至少需要 262,144 像素。":
    "Layer decompose images need at least 262,144 pixels.",
  "请先编辑并提供有效的选区蒙版。":
    "Edit and provide a valid selection mask first.",
  "选区不属于当前来源节点，请重新编辑选区。":
    "The selection does not belong to the current source node; edit it again.",
  "选区尺寸必须是正整数。": "Selection dimensions must be positive integers.",
  "蒙版尺寸必须与原图尺寸一致。":
    "Mask dimensions must match the source image.",
  "请选择原场景中的商品区域。":
    "Select the product area in the source scene.",
  "框选拆分需要提供原图中的矩形选区。":
    "Box split needs a rectangle selection on the source image.",
  "商品区域超出原图或尺寸不正确。":
    "The product area is outside the image or has invalid dimensions.",
  "拆分区域超出原图或尺寸不正确。":
    "The split area is outside the image or has invalid dimensions.",
  "此工具的参数协议尚未接入，不能提交任务。":
    "This tool's parameter protocol is not connected yet, so the task cannot be submitted.",
  "工具任务草稿格式不正确。": "Invalid tool task draft format.",
  "工具任务草稿版本或工具不受支持。":
    "Unsupported tool task draft version or tool.",
  "工具任务来源无效。": "Invalid tool task source.",
  "工具任务参数无效。": "Invalid tool task parameters.",
  "工具参数数量超过上限。": "Too many tool parameters.",
  "工具参数包含无效值。": "Tool parameters contain an invalid value.",
  "选区格式不正确。": "Invalid selection format.",
  "选区来源或尺寸无效。": "Invalid selection source or dimensions.",
  "选区蒙版无效。": "Invalid selection mask.",
  "选区矩形尺寸无效。": "Invalid selection rectangle size.",
};

export function translateToolText(locale: Locale, value: string): string {
  return locale === "en-US" ? (EN[value] ?? value) : value;
}

function translateField(locale: Locale, field: ToolField): ToolField {
  return {
    ...field,
    label: translateToolText(locale, field.label),
    ...(field.hint ? { hint: translateToolText(locale, field.hint) } : {}),
    ...(field.options
      ? {
          options: field.options.map((option) => ({
            ...option,
            label: translateToolText(locale, option.label),
          })),
        }
      : {}),
  };
}

/** Return a display copy; ids, defaults, and parameter values are untouched. */
export function translateTool(
  locale: Locale,
  tool: CanvasToolDefinition,
): CanvasToolDefinition {
  if (locale === "zh-CN") return tool;
  return {
    ...tool,
    title: translateToolText(locale, tool.title),
    description: translateToolText(locale, tool.description),
    fields: tool.fields.map((field) => translateField(locale, field)),
  };
}
