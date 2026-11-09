/** Localize persisted tool-task progress and errors for the UI. */
import type { Translate } from "../i18n/I18nProvider.tsx";
import type { MessageKey, MessageParams } from "../i18n/types.ts";
import { defaultTranslate } from "./assistantTranslate.ts";
import { getActiveLocale } from "../i18n/messages.ts";
import { translateToolText } from "./toolText.ts";

const CJK = /[\u3400-\u9fff]/;

export interface ToolTaskFailure {
  code: string;
  params?: MessageParams;
}

const CODE: Record<string, MessageKey> = {
  tool_concept_translation: "errors.tools.error.conceptTranslation",
  tool_no_video_match: "errors.tools.error.noVideoMatch",
};

const PHASE: Record<string, MessageKey> = {
  准备素材: "errors.tools.phase.prepare",
  停止处理中: "errors.tools.phase.stopping",
  正在扩展画面: "errors.tools.phase.outpaint",
  正在按描述改图: "errors.tools.phase.describeEdit",
  正在应用选区: "errors.tools.phase.selection",
  正在识别并抠出主体: "errors.tools.phase.cutout",
  正在补全背景: "errors.tools.phase.background",
  正在消除并填补: "errors.tools.phase.removeFill",
  正在生成新视角: "errors.tools.phase.newView",
  正在重新布光: "errors.tools.phase.relight",
  正在融合商品与场景: "errors.tools.phase.productScene",
  正在生成动态海报: "errors.tools.phase.poster",
  正在重绘: "errors.tools.phase.redraw",
  正在合成结果: "errors.tools.phase.compose",
  正在整理视频: "errors.tools.phase.organizeVideo",
  正在合成抠像视频: "errors.tools.phase.matteVideo",
  正在估计每一帧的深度: "errors.tools.phase.depth",
  正在分离音轨: "errors.tools.phase.separateAudio",
  正在放大视频: "errors.tools.phase.upscaleVideo",
  正在保存结果: "errors.tools.phase.save",
};

const ERROR: Record<string, MessageKey> = {
  "服务重启，任务已中断，请重新提交。": "errors.tools.error.interrupted",
  "已取消。": "errors.tools.error.cancelled",
  "工具执行出错，请检查素材和参数后重试。": "errors.tools.error.failed",
  "生成结果处理失败，请检查服务协议；不会自动重新提交。":
    "errors.tools.error.resultProcessing",
  "已接受工具任务的模型配置已变化，请新建尝试。":
    "errors.tools.error.modelChanged",
  "供应商取消未确认。": "errors.tools.error.cancelUnconfirmed",
  "已停止本地处理。": "errors.tools.error.localStopped",
  "服务中断，原执行记录已保留；不会自动重新生成。":
    "errors.tools.error.serviceInterrupted",
  "服务中断，原执行记录已保留；远端状态需核对，不会自动重新生成。":
    "errors.tools.error.serviceInterruptedRemote",
};

function phaseParts(text: string): { key: MessageKey; params: MessageParams } | null {
  let match = /^正在增强细节（(\d+)\/(\d+)）$/.exec(text);
  if (match)
    return {
      key: "errors.tools.phase.detail",
      params: { current: match[1]!, total: match[2]! },
    };
  match = /^正在放大到 (.+)px$/.exec(text);
  if (match)
    return { key: "errors.tools.phase.upscaleEdge", params: { edge: match[1]! } };
  match = /^正在识别框选对象（(\d+)\/(\d+)）$/.exec(text);
  if (match)
    return {
      key: "errors.tools.phase.boxObjects",
      params: { current: match[1]!, total: match[2]! },
    };
  match = /^正在识别「(.+)」$/.exec(text);
  if (match)
    return {
      key: "errors.tools.phase.recognize",
      params: { label: match[1]! },
    };
  match = /^正在生成(.+)（(\d+)\/(\d+)）$/.exec(text);
  if (match)
    return {
      key: "errors.tools.phase.generateTitle",
      params: { title: translateToolText(getActiveLocale(), match[1]!), current: match[2]!, total: match[3]! },
    };
  match = /^正在重绘（(\d+)\/(\d+)）$/.exec(text);
  if (match)
    return {
      key: "errors.tools.phase.redrawCount",
      params: { current: match[1]!, total: match[2]! },
    };
  match = /^正在识别并跟踪「(.+)」$/.exec(text);
  if (match)
    return {
      key: "errors.tools.phase.track",
      params: { labels: match[1]! },
    };
  match = /^正在补帧到 (.+) fps$/.exec(text);
  if (match)
    return {
      key: "errors.tools.phase.interpolate",
      params: { fps: match[1]! },
    };
  return null;
}

/** Keep codes and English progress text; translate Chinese progress messages. */
export function toolTaskPhase(
  text: string | null | undefined,
  t: Translate = defaultTranslate,
): string | undefined {
  if (!text) return undefined;
  if (!CJK.test(text)) return text;
  const exact = PHASE[text];
  if (exact) return t(exact);
  const parts = phaseParts(text);
  if (parts) return t(parts.key, parts.params);
  return t("errors.tools.phase.generic");
}

/** Replace a persisted Chinese tool error; unknown errors stay actionable. */
export function toolTaskError(
  text: string | null | undefined,
  t: Translate = defaultTranslate,
  failure?: ToolTaskFailure,
): string | undefined {
  const key = failure && CODE[failure.code];
  if (key) return t(key, failure?.params);
  if (!text) return undefined;
  if (!CJK.test(text)) return text;
  if (text.startsWith("生成请求的提交结果不明。"))
    return t("errors.tools.error.submissionUnknown");
  const concept = /^无法识别「(.+)」，请改用英文描述，或在“模型接入”中添加对话模型以自动翻译。$/.exec(text);
  if (concept) return t("errors.tools.error.conceptTranslation", { label: concept[1]! });
  const missing = /^视频中没有识别到「(.+)」，请换一种描述后重试。$/.exec(text);
  if (missing) return t("errors.tools.error.noVideoMatch", { label: missing[1]! });
  return t(ERROR[text] ?? "errors.tools.error.generic");
}
