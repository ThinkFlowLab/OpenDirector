import type { ChatMessage, ChatTool } from "../backend/chat.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import { defaultTranslate } from "./assistantTranslate.ts";

const TOOL_NAMES: Readonly<Partial<Record<string, MessageKey>>> = {
  voice_list: "voiceLibrary.tool.list",
  voice_create: "voiceLibrary.tool.create",
  voice_delete: "voiceLibrary.tool.delete",
  query: "assistant.tool.query",
  read: "assistant.tool.read",
  command_schema: "assistant.tool.command_schema",
  execute_command: "assistant.tool.execute_command",
  read_project: "assistant.tool.read_project",
  read_canvas_item: "assistant.tool.read_canvas_item",
  preview_asset: "assistant.tool.preview_asset",
  read_text_asset: "assistant.tool.read_text_asset",
  save_text_asset: "assistant.tool.save_text_asset",
  generate_asset: "assistant.tool.generate_asset",
  get_generation_task: "assistant.tool.get_generation_task",
  read_skill: "assistant.tool.read_skill",
  bash: "assistant.tool.bash",
  web_search: "assistant.tool.web_search",
  web_fetch: "assistant.tool.web_fetch",
};

export function toolLabel(
  tool: ChatTool,
  t: Translate = defaultTranslate,
): string {
  const key = TOOL_NAMES[tool.name];
  // An unknown tool keeps its technical name; only known tools get a label.
  const name = key ? t(key) : tool.name;
  const operation = tool.arguments?.type;
  return typeof operation === "string" ? `${name} ${operation}` : name;
}

export type ReplyPart =
  | { type: "text"; id: string; text: string }
  | { type: "tools"; id: string; tools: ChatTool[] };

export function replyParts(
  message: Pick<ChatMessage, "text" | "tools">,
): ReplyPart[] {
  // The backend records textOffset in Unicode code points, as Python len does.
  const text = Array.from(message.text);
  const parts: ReplyPart[] = [];
  let offset = 0;
  for (const tool of message.tools ?? []) {
    const end = Math.max(offset, Math.min(tool.textOffset, text.length));
    if (end > offset) {
      parts.push({
        type: "text",
        id: `text-${tool.id}`,
        text: text.slice(offset, end).join(""),
      });
    }
    const previous = parts.at(-1);
    if (previous?.type === "tools") previous.tools.push(tool);
    else parts.push({ type: "tools", id: tool.id, tools: [tool] });
    offset = end;
  }
  if (offset < text.length) parts.push({ type: "text", id: "tail", text: text.slice(offset).join("") });
  return parts;
}

export function activityProgress(
  message: ChatMessage,
  thinking: boolean,
  t: Translate = defaultTranslate,
): string {
  const running = message.tools?.filter((tool) => tool.status === "running") ?? [];
  if (running.length) {
    const label = toolLabel(running.at(-1)!, t);
    return running.length > 1
      ? t("assistant.activity.running", { label }) +
          t("assistant.activity.runningCount", { count: running.length })
      : t("assistant.activity.running", { label });
  }
  if (thinking) return t("assistant.activity.thinking");
  const step = message.plan?.find((entry) => entry.status === "in_progress");
  return step
    ? t("assistant.activity.plan", { step: step.content })
    : t("assistant.activity.replying");
}

/** Intermediate narration belongs to execution history; only the final tail is public reply. */
export function replySections(
  message: Pick<ChatMessage, "text" | "tools" | "status">,
) {
  const parts = replyParts(message);
  if (!message.tools?.length) return { activity: [], reply: parts };
  const tail = parts.at(-1);
  const hasReply = message.status !== "streaming" && tail?.type === "text";
  return {
    activity: hasReply ? parts.slice(0, -1) : parts,
    reply: hasReply ? [tail] : [],
  };
}
