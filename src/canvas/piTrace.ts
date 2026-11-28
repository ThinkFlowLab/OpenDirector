type ContentBlock = { type?: string; text?: string; thinking?: string };
type PiMessage = {
  role?: string;
  content?: string | ContentBlock[];
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
};
type PiEvent = {
  type?: string;
  message?: PiMessage;
  messages?: PiMessage[];
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: { content?: ContentBlock[] };
  partialResult?: { content?: ContentBlock[] };
  isError?: boolean;
  durationMs?: number;
};
type PiRecord = { timestamp?: number; native?: PiEvent; [key: string]: unknown };
type Part = { text?: string; tool?: string; state?: { status: string; input?: unknown; output?: unknown } };
type Row = {
  native: { type: string; role?: string; timestamp?: number; durationMs?: number; part: Part };
  [key: string]: unknown;
};

/** Events that only describe the run's bookkeeping; the message and tool rows say what happened.
 * Streaming deltas repeat the finished message, so a text row appears once that message ends. */
const LIFECYCLE = new Set([
  "session", "agent_start", "turn_start", "message_start", "message_update", "turn_end",
  "agent_settled", "queue_update", "thinking_level_changed", "session_info_changed", "entry_appended",
]);

const contentText = (value: PiMessage["content"] | undefined) =>
  typeof value === "string" ? value
    : (Array.isArray(value) ? value : []).filter((block) => block?.type === "text" && block.text)
      .map((block) => block.text).join("");

/**
 * `message_*` records become one row per message with its own role, and `tool_execution_*`
 * records collapse into one row per call. pi reports a retried attempt as an ordinary
 * `message_end` with `stopReason: 'error'`, so only the settled `agent_end` fails the turn.
 */
export function normalizePiTrace(trace: string): string {
  const rows: Row[] = [];
  const calls = new Map<string, Row>();
  for (const line of trace.split("\n")) {
    if (!line.trim()) continue;
    let record: PiRecord;
    try { record = JSON.parse(line); } catch { continue; }
    const event = record?.native;
    if (!event || typeof event !== "object") continue;
    const timestamp = event.message?.timestamp;
    const row = (part: Part, type: string, role?: string) => {
      const created: Row = { native: { type, part, ...(role ? { role } : {}), ...(timestamp === undefined ? {} : { timestamp }) } };
      rows.push(created);
      return created;
    };
    if (LIFECYCLE.has(event.type ?? "")) continue;
    if (event.type === "message_end") {
      const message = event.message;
      if (message?.role === "user") {
        const text = contentText(message.content);
        if (text.trim()) row({ text }, "text", "user");
        continue;
      }
      if (message?.role !== "assistant" || message.stopReason === "error") continue;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "text" && block.text?.trim()) row({ text: block.text }, "text", "assistant");
        else if (block?.type === "thinking" && block.thinking?.trim()) row({ text: block.thinking }, "reasoning");
        // Tool calls are reported by their execution records, so the call is shown once.
      }
      continue;
    }
    if (event.type === "agent_end") {
      const assistant = (event.messages ?? []).filter((message) => message?.role === "assistant");
      const settled = assistant.at(-1)?.errorMessage;
      if (settled) row({ text: settled }, "error");
      else if (assistant.at(-1)?.stopReason === "error") rows.push(record as Row);
      continue;
    }
    if (event.type === "tool_execution_start") {
      const call = row({ tool: event.toolName ?? event.toolCallId ?? "", state: { status: "in_progress", input: event.args } }, "tool_use");
      if (event.toolCallId) calls.set(event.toolCallId, call);
      continue;
    }
    if (event.type === "tool_execution_update") {
      const state = calls.get(event.toolCallId ?? "")?.native.part.state;
      const output = contentText(event.partialResult?.content);
      if (state?.status === "in_progress" && output) state.output = output;
      continue;
    }
    if (event.type === "tool_execution_end") {
      const known = calls.get(event.toolCallId ?? "");
      const call = known ?? row({ tool: event.toolName ?? event.toolCallId ?? "", state: { status: "in_progress" } }, "tool_use");
      if (event.toolCallId) calls.set(event.toolCallId, call);
      call.native.part.state = {
        status: event.isError ? "failed" : "completed",
        ...(call.native.part.state?.input === undefined ? {} : { input: call.native.part.state.input }),
        output: contentText(event.result?.content),
      };
      if (event.durationMs !== undefined) call.native.durationMs = event.durationMs;
      continue;
    }
    rows.push(record as Row);
  }
  return rows.map((row) => JSON.stringify(row)).join("\n");
}
