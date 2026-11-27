/** English copy for tool errors returned by the local Agent gateway. */
import type { Translate } from "../i18n/I18nProvider.tsx";
import { getActiveLocale } from "../i18n/messages.ts";
import type { MessageKey } from "../i18n/types.ts";
import { defaultTranslate } from "./assistantTranslate.ts";
import { capabilityErrorText } from "./capabilityErrorText.ts";

const CJK = /[\u3400-\u9fff]/;

const DECISION_ERRORS = new Map<string, MessageKey>([
  ["task_waiting_input", "assistant.reply.toolWaitingForAnswer"],
  ["plan_confirmation_required", "assistant.reply.toolPlanConfirmationRequired"],
  ["plan_revision_stale", "assistant.reply.toolPlanRevisionStale"],
  ["plan_step_kind_mismatch", "assistant.reply.toolPlanStepKindMismatch"],
  ["continuation_status_unknown", "assistant.question.statusUnknownNotice"],
]);

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

/** Translate known decision codes and preserve useful detail for other tools. */
export function assistantToolText(
  text: string,
  t: Translate = defaultTranslate,
  code?: string,
): string {
  const decisionError = code ? DECISION_ERRORS.get(code) : undefined;
  if (decisionError) return t(decisionError);
  if (getActiveLocale() !== "en-US" || !CJK.test(text)) return text;
  const capability = capabilityErrorText(text, t);
  if (capability) return capability;
  // Codes describe the category; known detail above always takes priority.
  if (code === "capability_paused") return t("errors.capability.paused");
  return t(BY_MESSAGE[text] ?? "assistant.reply.toolError");
}
