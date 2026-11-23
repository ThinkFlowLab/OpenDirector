/** Translate backend tool availability reasons without touching capability ids. */
import type { Translate } from "../i18n/I18nProvider.tsx";
import { getActiveLocale } from "../i18n/messages.ts";
import { defaultTranslate } from "./assistantTranslate.ts";
import { capabilityErrorText } from "./capabilityErrorText.ts";
import { availabilityReason } from "../backend/availability.ts";

const CAPABILITY: Record<string, string> = {
  对话: "chat",
  文生图: "text-to-image",
  "图生图/图片编辑": "image editing",
  图像编辑: "image editing",
  主体抠图: "subject cutout",
  文生视频: "text-to-video",
  首帧生视频: "first-frame to video",
  语音合成: "speech synthesis",
  音乐生成: "music generation",
  音乐扒谱: "music transcription",
  图像分割: "image segmentation",
  视频局部重绘: "video inpainting",
  视频抠像: "video matting",
  音轨分离: "audio separation",
  深度动作捕捉: "depth motion capture",
};

const NEED = /^需要接入具备「(.+)」能力的模型。$/;

/** Keep English reasons; replace the two Chinese reasons produced by /tools. */
export function toolReasonText(
  text: string | undefined,
  t: Translate = defaultTranslate,
  reasonCode?: string,
): string | undefined {
  if (!text || getActiveLocale() !== "en-US" || !/[\u3400-\u9fff]/.test(text))
    return text;
  const capability = capabilityErrorText(text, t);
  if (capability) return capability;
  if (reasonCode) return availabilityReason(reasonCode);
  if (text.startsWith("接入图像分割模型")) {
    return t("errors.tools.needSelectionModel");
  }
  const match = NEED.exec(text);
  if (!match) return t("errors.tools.needCapabilities", { capabilities: "—" });
  const capabilities = match[1]!
    .split("、")
    .map((label) => CAPABILITY[label] ?? "required model capability")
    .join(", ");
  return t("errors.tools.needCapabilities", { capabilities });
}
