/** Translate stored diagnostics without discarding their operation, input, or count. */
import type { Translate } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import { defaultTranslate } from "./assistantTranslate.ts";

const EXACT: Record<string, string> = {
  "服务已暂停，请恢复后重试。": "paused",
  "请补充所需素材。": "required",
  "图片文件过大，请压缩后重试。": "imageBytes",
  "图片总大小超出限制，请减少图片或压缩后重试。": "totalBytes",
  "标注参考图片需要配合选区使用。": "annotationSelection",
  "当前图片尺寸或数量不支持选区输入。": "selectionInputs",
  "选区与图片的尺寸不一致。": "selectionDimensions",
  "请先选择需要修改的区域。": "selectionRequired",
  "无法读取图片或选区，请重新选择。": "selectionUnreadable",
  "来源素材必须是图片。": "sourceType",
  "图片尺寸不符合服务要求。": "dimensions",
};
const LABELS: Record<string, string> = {
  文字回复: "textReplies",
  图片回复: "imageReplies",
  图片生成: "imageGeneration",
  图片编辑: "imageEditing",
  文字生成视频: "textVideo",
  图片生成视频: "imageVideo",
  视频编辑: "videoEditing",
  语音合成: "speech",
  音乐生成: "music",
  此操作: "operation",
  图片: "image",
  音频: "audio",
  视频: "video",
  文字: "text",
  音色: "voice",
  参考音频: "referenceAudio",
  风格说明: "style",
  参考文本: "transcript",
  选区: "selection",
  标注参考图片: "annotation",
  参考图片: "referenceImage",
  首帧图片: "firstFrame",
  尾帧图片: "lastFrame",
  参考视频: "referenceVideo",
  编辑源视频: "sourceVideo",
  视频编辑蒙版: "videoMask",
  音频编辑蒙版: "audioMask",
  视频生成模式: "videoTask",
  画面比例: "aspectRatio",
  素材: "inputs",
  所需素材: "inputs",
  图片宽度: "width",
  图片高度: "height",
  图片尺寸: "size",
  时长: "duration",
  语速: "speed",
  语言: "language",
  帧率: "fps",
  帧数: "frames",
  音频生成选项: "generateAudio",
  所选参数: "parameter",
};

export function capabilityErrorText(
  text: string,
  t: Translate = defaultTranslate,
): string | undefined {
  const key = (name: string) => `errors.capability.${name}` as MessageKey;
  if (EXACT[text]) return t(key(EXACT[text]));
  let match = /^最多支持 (\d+) 张图片，当前为 (\d+) 张。$/.exec(text);
  if (match)
    return t(key("imageCount"), { limit: match[1]!, current: match[2]! });
  match = /^该工具需要 (\d+) 张来源图片。$/.exec(text);
  if (match) return t(key("sourceCount"), { count: match[1]! });
  match = /^最多支持 (\d+) 个(.+)输入，当前为 (\d+) 个。$/.exec(text);
  if (match && LABELS[match[2]!])
    return t(key("inputCount"), {
      limit: match[1]!,
      input: t(key(`label.${LABELS[match[2]!]}`)),
      current: match[3]!,
    });
  for (const [pattern, template] of [
    [/^该模型不支持(.+)输入。$/, "inputUnsupported"],
    [/^该模型不支持(.+)。$/, "unsupported"],
    [/^服务未开放(.+)。$/, "disabled"],
    [/^请添加(.+)。$/, "add"],
    [/^(.+)不符合服务要求。$/, "parameter"],
  ] as const) {
    match = pattern.exec(text);
    if (match && LABELS[match[1]!])
      return t(key(template), { label: t(key(`label.${LABELS[match[1]!]}`)) });
  }
  match = /^请提供(.+)。$/.exec(text);
  if (match) {
    const labels = match[1]!.split("或");
    if (labels.every((label) => LABELS[label]))
      return t(key("provide"), {
        inputs: labels
          .map((label) => t(key(`label.${LABELS[label]}`)))
          .join(t(key("or"))),
      });
  }
  return undefined;
}
