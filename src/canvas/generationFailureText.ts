/** Localize persisted generation failures from their stable category and text. */
import type { GenerationFailure } from "../contracts/generated.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import { defaultTranslate } from "./assistantTranslate.ts";

/**
 * The backend stores Chinese diagnostics in the job record. Known messages map
 * to a specific translation; category and status cover new or provider-defined
 * messages without ever showing Chinese in the English interface.
 */
const BY_MESSAGE: Record<string, MessageKey> = {
  "供应商判定提示词或参考图片违反内容政策，已拒绝生成。": "errors.generationFailure.policy",
  "生成服务拒绝了输入内容或参数。": "errors.generationFailure.input",
  "生成服务拒绝了参考素材。": "errors.generationFailure.reference",
  "生成服务鉴权失败。": "errors.generationFailure.authentication",
  "当前账户没有调用该模型的权限。": "errors.generationFailure.permission",
  "模型账户余额或套餐额度不足。": "errors.generationFailure.quota",
  "模型调用频率或配额受限。": "errors.generationFailure.rateLimit",
  "生成服务暂时不可用。": "errors.generationFailure.temporary",
  "生成服务未能完成当前操作。": "errors.generationFailure.provider",
  "音频参考不能单独使用，请搭配参考图片。":
    "errors.generationFailure.referenceAudio",
  "供应商拒绝了参考类型或输入组合。":
    "errors.generationFailure.referenceUnsupported",
  "供应商判定参考图片可能包含真人，已拒绝生成。":
    "errors.generationFailure.privacy",
  "供应商判定输入内容涉及敏感信息，已拒绝生成。":
    "errors.generationFailure.sensitiveInput",
  "供应商判定生成内容涉及敏感信息，已拒绝交付。":
    "errors.generationFailure.sensitiveOutput",
  "供应商任务已取消。": "errors.generationFailure.cancelled",
  "供应商任务已过期。": "errors.generationFailure.expired",
  "供应商未找到该任务。": "errors.generationFailure.notFoundTask",
  "生成接口或模型不存在。": "errors.generationFailure.notFoundEndpoint",
  "生成结果下载失败。": "errors.generationFailure.download",
  "生成服务任务已失败。": "errors.generationFailure.failed",
  "生成请求的提交结果不明。": "errors.generationFailure.submissionUnknown",
  "生成服务连接超时或中断。": "errors.generationFailure.temporary",
  "生成服务返回了无法识别或不完整的结果。":
    "errors.generationFailure.protocol",
};

const BY_CATEGORY: Record<string, MessageKey> = {
  input: "errors.generationFailure.input",
  reference: "errors.generationFailure.reference",
  authentication: "errors.generationFailure.authentication",
  permission: "errors.generationFailure.permission",
  quota: "errors.generationFailure.quota",
  rate_limit: "errors.generationFailure.rateLimit",
  temporary: "errors.generationFailure.temporary",
  submission_unknown: "errors.generationFailure.submissionUnknown",
  local: "errors.generationFailure.local",
  protocol: "errors.generationFailure.protocol",
  provider: "errors.generationFailure.provider",
};

export function generationFailureMessage(
  failure: GenerationFailure,
  t: Translate = defaultTranslate,
): string {
  if (failure.providerCode === "voice_not_found")
    return t("errors.generationFailure.voiceNotFound");
  const exact = BY_MESSAGE[failure.message];
  if (exact) return t(exact);
  if (failure.stage === "download")
    return t("errors.generationFailure.download");
  if (failure.providerStatus === "cancelled")
    return t("errors.generationFailure.cancelled");
  if (failure.providerStatus === "expired")
    return t("errors.generationFailure.expired");
  if (failure.httpStatus === 404)
    return t(
      failure.stage === "poll" || failure.stage === "cancel"
        ? "errors.generationFailure.notFoundTask"
        : "errors.generationFailure.notFoundEndpoint",
    );
  return t(
    BY_CATEGORY[failure.category] ?? "errors.generationFailure.provider",
  );
}
