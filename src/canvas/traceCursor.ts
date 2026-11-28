import { createClaudeTraceProjection } from "./claudeTrace.ts";
import { createCodexTraceProjection } from "./codexTrace.ts";
import { createDeepseekTraceProjection } from "./deepseekTrace.ts";

function rawProjection() {
  const rows: unknown[] = [];
  return {
    rows,
    append(lines: string[]) {
      for (const line of lines) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { rows.push(line); }
      }
    },
  };
}

function projectionFor(source: string) {
  switch (source) {
    case "claude": return createClaudeTraceProjection();
    case "codex": return createCodexTraceProjection();
    case "deepseek": return createDeepseekTraceProjection();
    default: return rawProjection();
  }
}

export type TraceSnapshot = {
  generation: number;
  rows: readonly unknown[];
};

export function createTraceCursor(source: string) {
  let cursor = "";
  let decoder = new TextDecoder();
  let pending = "";
  let projection = projectionFor(source);
  let snapshot: TraceSnapshot = { generation: 0, rows: [] };

  async function read(url: string, options: RequestInit, live: boolean) {
    const response = await fetch(`${url}/${encodeURIComponent(source)}?cursor=${encodeURIComponent(cursor)}`, options);
    const running = response.headers.get("X-Trace-Running");
    if ((running !== "0" && running !== "1") || (!response.ok && response.status !== 404)) {
      throw new Error("Trace unavailable");
    }
    const next = response.headers.get("X-Trace-Cursor");
    if (response.ok && next === null) throw new Error("Missing trace cursor");
    const more = response.headers.get("X-Trace-More") === "1";
    const follow = live && running === "1";
    const bytes = response.ok ? await response.arrayBuffer() : undefined;
    if (options.signal?.aborted) throw new Error("Trace read aborted");

    const reset = response.headers.get("X-Trace-Reset") === "1" || (!response.ok && cursor !== "");
    if (reset) {
      decoder = new TextDecoder();
      pending = "";
      projection = projectionFor(source);
      snapshot = { generation: snapshot.generation + 1, rows: [] };
    }
    cursor = next ?? "";
    if (bytes) {
      const stream = more || follow;
      const lines = decoder.decode(bytes, { stream }).split("\n");
      lines[0] = pending + lines[0];
      pending = stream ? lines.pop() ?? "" : "";
      if (lines.some((line) => line.trim())) {
        projection.append(lines);
        snapshot = { ...snapshot, rows: projection.rows.slice() };
      }
    }
    return { status: response.status, more, follow, snapshot };
  }

  return { read };
}
