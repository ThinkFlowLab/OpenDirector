/** English copy for tool errors returned by the local Agent gateway. */
import type { Translate } from "../i18n/I18nProvider.tsx";
import { getActiveLocale } from "../i18n/messages.ts";
import type { MessageKey } from "../i18n/types.ts";
import { defaultTranslate } from "./assistantTranslate.ts";

const CJK = /[\u3400-\u9fff]/;

const BY_MESSAGE: Record<string, MessageKey> = {
  "本轮工具入口已关闭。": "assistant.reply.toolClosed",
  "工具调用标识被用于不同输入。": "assistant.reply.toolIdConflict",
  "查询身份与工程范围由宿主提供。": "assistant.reply.toolHostScope",
  "只能读取不超过 64 KB 的文本素材。": "assistant.reply.toolTextLimit",
  "只能读取已发现技能目录内的文本资源。":
    "assistant.reply.toolSkillOutside",
  "技能资源必须是不超过 64 KB 的文本文件。":
    "assistant.reply.toolSkillLimit",
  "所选模型不可用。": "assistant.reply.toolModelUnavailable",
  "当前模型不支持所选图片质量，请选择自动或切换模型。":
    "errors.rules.imageQualityUnsupported",
  "未知业务工具。": "assistant.reply.toolUnknown",
  "批量命令包含未开放的 Agent 操作。": "assistant.reply.toolForbidden",
};

/** Keep English tool errors and codes; replace Chinese detail in English UI. */
export function assistantToolText(
  text: string,
  t: Translate = defaultTranslate,
): string {
  if (getActiveLocale() !== "en-US" || !CJK.test(text)) return text;
  return t(BY_MESSAGE[text] ?? "assistant.reply.toolError");
}
