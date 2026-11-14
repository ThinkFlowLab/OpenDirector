/** Presentation copy for tool errors returned by the local Agent gateway. */
import type { Translate } from "../i18n/I18nProvider.tsx";
import { getActiveLocale } from "../i18n/messages.ts";
import type { MessageKey } from "../i18n/types.ts";
import { defaultTranslate } from "./assistantTranslate.ts";

const CJK = /[\u3400-\u9fff]/;

// Stable receipts from `unsuccessful_job`. The catalog supplies zh-CN and en-US.
const JOB_WAIT_DETAIL = {
  failed: "assistant.activity.jobWaitFailedDetail",
  cancelled: "assistant.activity.jobWaitCancelledDetail",
  interrupted: "assistant.activity.jobWaitInterruptedDetail",
} as const satisfies Record<string, MessageKey>;

const JOB_WAIT_BARE = {
  failed: "assistant.activity.jobWaitFailed",
  cancelled: "assistant.activity.jobWaitCancelled",
  interrupted: "assistant.activity.jobWaitInterrupted",
} as const satisfies Record<string, MessageKey>;

function jobWaitActivityError(text: string, t: Translate): string | undefined {
  const detailed = /^Job (failed|cancelled|interrupted): ([\s\S]+)$/.exec(text);
  if (detailed) {
    const message = detailed[2]!;
    // An English UI must not reveal an untranslated provider message.
    if (getActiveLocale() === "en-US" && CJK.test(message)) return undefined;
    const status = detailed[1] as keyof typeof JOB_WAIT_DETAIL;
    return t(JOB_WAIT_DETAIL[status], { message });
  }
  const bare = /^Job (failed|cancelled|interrupted)\.$/.exec(text);
  if (!bare) return undefined;
  const status = bare[1] as keyof typeof JOB_WAIT_BARE;
  return t(JOB_WAIT_BARE[status]);
}

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
  "未知业务工具。": "assistant.reply.toolUnknown",
  "批量命令包含未开放的 Agent 操作。": "assistant.reply.toolForbidden",
};

/** Keep English tool errors and codes; replace known receipts for the active locale. */
export function assistantToolText(
  text: string,
  t: Translate = defaultTranslate,
): string {
  const jobWait = jobWaitActivityError(text, t);
  if (jobWait !== undefined) return jobWait;
  if (getActiveLocale() !== "en-US" || !CJK.test(text)) return text;
  return t(BY_MESSAGE[text] ?? "assistant.reply.toolError");
}
