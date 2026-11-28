type AcpUpdate = {
  sessionUpdate: string;
  messageId?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  entries?: { content: string; status: string }[];
};

type AcpRecord = {
  timestamp?: number;
  native?: {
    jsonrpc?: string;
    error?: unknown;
    result?: { stopReason?: string };
    params?: { update?: AcpUpdate };
  };
};

type DisplayRecord = {
  timestamp?: number;
  native: {
    type: string;
    part: {
      text?: string;
      tool?: string;
      reason?: string;
      state?: { status: string; input?: unknown; output?: unknown };
    };
  };
  raw: AcpRecord[];
};

function textContent(content: unknown): string {
  if (typeof content !== "object" || content === null) return "";
  const block = content as { type?: string; text?: string };
  return block.type === "text" && typeof block.text === "string" ? block.text : "";
}

/** Project ACP updates into trace rows while retaining their original records. */
export function createDeepseekTraceProjection() {
  const rows: (DisplayRecord | AcpRecord)[] = [];
  const messages = new Map<string, number>();
  const calls = new Map<string, number>();
  let plan: number | undefined;
  function append(lines: string[]) {
    const changed = new Map<number, DisplayRecord>();
    function edit(index: number | undefined, create: () => DisplayRecord) {
      const current = index === undefined ? undefined : changed.get(index);
      if (current) return current;
      const previous = index === undefined ? undefined : rows[index];
      const row = previous && "raw" in previous ? {
        ...previous, raw: previous.raw.slice(),
        native: { ...previous.native, part: { ...previous.native.part } },
      } : create();
      const position = index ?? rows.length;
      rows[position] = row;
      changed.set(position, row);
      return row;
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      let record: AcpRecord;
      try {
        record = JSON.parse(line) as AcpRecord;
      } catch {
        // Ignore malformed JSONL lines.
        continue;
      }
      if (!record || typeof record !== "object") continue;
      if (!record.native?.jsonrpc) {
        rows.push(record);
        continue;
      }
      const update = record.native.params?.update;
      if (!update) {
        if (record.native.error) {
          rows.push({ timestamp: record.timestamp, native: { type: "error",
            part: { text: JSON.stringify(record.native.error) } }, raw: [record] });
        } else if (record.native.result?.stopReason) {
          rows.push({ timestamp: record.timestamp, native: { type: "step_finish",
            part: { reason: record.native.result.stopReason } }, raw: [record] });
        }
        continue;
      }
      const kind = update.sessionUpdate;
      if (kind === "agent_thought_chunk" || kind === "agent_message_chunk") {
        const text = textContent(update.content);
        if (!text) continue;
        const type = kind === "agent_thought_chunk" ? "reasoning" : "text";
        const identity = update.messageId ? type + ":" + update.messageId : undefined;
        const last = rows.at(-1);
        const index = identity ? messages.get(identity) :
          last && "raw" in last && last.native.type === type ? rows.length - 1 : undefined;
        const row = edit(index, () => ({
          timestamp: record.timestamp, native: { type, part: { text: "" } }, raw: [],
        }));
        if (identity && index === undefined) messages.set(identity, rows.length - 1);
        row.native.part.text += text;
        row.raw.push(record);
      } else if ((kind === "tool_call" || kind === "tool_call_update") && update.toolCallId) {
        const index = calls.get(update.toolCallId);
        const row = edit(index, () => ({
          timestamp: record.timestamp, native: { type: "tool_use", part: {
            tool: update.title ?? update.toolCallId, state: { status: "in_progress" },
          } }, raw: [],
        }));
        if (index === undefined) calls.set(update.toolCallId, rows.length - 1);
        if (update.title !== undefined) row.native.part.tool = update.title;
        row.native.part.state = {
          ...row.native.part.state,
          status: update.status ?? row.native.part.state!.status,
          ...(update.rawInput === undefined ? {} : { input: update.rawInput }),
          ...(update.content === undefined ? {} : { output: update.content }),
          ...(update.rawOutput === undefined ? {} : { output: update.rawOutput }),
        };
        row.raw.push(record);
      } else if (kind === "plan") {
        const row = edit(plan, () => ({
          timestamp: record.timestamp, native: { type: "plan", part: {} }, raw: [],
        }));
        plan ??= rows.length - 1;
        row.native.part.text = (update.entries ?? []).map((entry) => entry.content + " · " + entry.status).join("\n");
        row.raw.push(record);
      }
    }
  }
  return { rows, append };
}
