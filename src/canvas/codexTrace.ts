type CodexRecord = {
  id?: string;
  type?: string;
  native?: { type?: string; item?: { id?: string; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
};

/** Replace lifecycle updates in place so commands stay readable and stable during polling. */
export function createCodexTraceProjection() {
  const rows: CodexRecord[] = [];
  const identities = new Map<string, number>();
  function append(lines: string[]) {
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: CodexRecord;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== "object") continue;
      const type = record.native?.type;
      if (type === "thread.started" || type === "turn.started") continue;
      const item = record.native?.item;
      const identity = item?.id && type?.startsWith("item.") ? `item:${item.id}`
        : record.type === "tool" && record.id ? `tool:${record.id}` : undefined;
      const index = identity ? identities.get(identity) : undefined;
      if (index !== undefined) {
        const previous = rows[index];
        rows[index] = { ...previous, ...record,
          ...(record.native ? { native: { ...previous.native, ...record.native,
            ...(item ? { item: { ...previous.native?.item, ...item } } : {}) } } : {}) };
      } else {
        if (identity) identities.set(identity, rows.length);
        rows.push(record);
      }
    }
  }
  return { rows, append };
}
