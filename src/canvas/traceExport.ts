/** Read-only, user-initiated report of conversation trace metadata and safe event summaries. */
import { normalizeTrace, traceRuntime, traceSources, type ConversationTurn } from "./traceTurns.ts";

const MAX_LOG_CHARS = 1_000_000;
const MAX_EVENTS_PER_SOURCE = 400;
const EVENT_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]{0,72}$/;
const JOB_STATES = new Set(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]);

type TraceEvent = { kind: string; status?: string };
type SourceReport = { name: string; state: "available" | "missing" | "unavailable"; events: TraceEvent[]; truncated: boolean };
type JobReport = { id: string; status: string; adopted: boolean };
type TurnReport = { turn: ConversationTurn; sources: SourceReport[]; jobs: JobReport[] | null };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const eventCode = (value: unknown): string | null =>
  typeof value === "string" && EVENT_PATTERN.test(value) ? value : null;

/** Extract event codes and fixed states only; never include prompts, arguments, outputs or raw JSON. */
export function traceEventSummary(body: string): { events: TraceEvent[]; truncated: boolean } {
  const clipped = body.length > MAX_LOG_CHARS;
  const lines = body.slice(0, MAX_LOG_CHARS).split("\n");
  if (clipped) lines.pop(); // Last line may contain incomplete JSON.
  const events: TraceEvent[] = [];
  let truncated = clipped;
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const outer = record(parsed);
    const native = record(outer.native);
    const part = record(native.part);
    const item = record(native.item);
    const state = record(part.state);
    const kind = eventCode(native.event_type) ?? eventCode(native.type) ??
      eventCode(outer.event) ?? eventCode(outer.type);
    if (!kind) continue;
    const rawStatus = state.status ?? item.status;
    const status = eventCode(rawStatus);
    events.push(status ? { kind, status } : { kind });
    if (events.length >= MAX_EVENTS_PER_SOURCE) { truncated = true; break; }
  }
  return { events, truncated };
}

const inline = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\s+/g, " ").replace(/[\\`*_{}\[\]()#+.!|]/g, "\\$&");

async function sourceReport(fetcher: typeof fetch, base: string, turn: ConversationTurn, source: string): Promise<SourceReport> {
  try {
    const response = await fetcher(base + "/traces/" + encodeURIComponent(turn.id) + "/" + encodeURIComponent(source),
      { headers: { "X-OpenDirector-Request": "1" } });
    if (response.status === 404) return { name: source, state: "missing", events: [], truncated: false };
    if (!response.ok) return { name: source, state: "unavailable", events: [], truncated: false };
    const body = await response.text();
    const normalized = normalizeTrace(source, body.slice(0, MAX_LOG_CHARS));
    const summary = traceEventSummary(normalized);
    return { name: source, state: "available", events: summary.events,
      truncated: summary.truncated || body.length > MAX_LOG_CHARS };
  } catch {
    return { name: source, state: "unavailable", events: [], truncated: false };
  }
}

async function jobReport(fetcher: typeof fetch, base: string, turn: ConversationTurn): Promise<JobReport[] | null> {
  try {
    const response = await fetcher(base + "/turns/" + encodeURIComponent(turn.id) + "/jobs",
      { headers: { "X-OpenDirector-Request": "1" } });
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) return null;
    return raw.flatMap((entry: unknown) => {
      const job = record(entry);
      if (typeof job.jobId !== "string") return [];
      return [{ id: job.jobId, status: typeof job.status === "string" && JOB_STATES.has(job.status)
        ? job.status : "unknown", adopted: job.adopted === true }];
    });
  } catch {
    return null;
  }
}

/** Every turn is fetched independently, including collapsed turns; no project writes or provider calls. */
export async function conversationTraceReport(project: string, conversationId: string, turns: ConversationTurn[],
  fetcher: typeof fetch = fetch, generatedAt = new Date().toISOString()): Promise<string> {
  const base = "/api/creation/projects/" + encodeURIComponent(project) + "/assistant";
  const reports: TurnReport[] = [];
  for (const turn of turns) {
    const sources = traceSources(traceRuntime(turn.runtime)).filter((name) => name !== "model");
    const [logs, jobs] = await Promise.all([
      Promise.all(sources.map((source) => sourceReport(fetcher, base, turn, source))),
      jobReport(fetcher, base, turn),
    ]);
    reports.push({ turn, sources: logs, jobs });
  }
  const lines = [
    "# OpenDirector Agent Trace Report", "",
    "- Project ID: " + inline(project),
    "- Conversation ID: " + inline(conversationId),
    "- Generated at: " + inline(generatedAt), "",
    "> This is a read-only execution summary. Raw model requests, prompts, tool arguments/results and asset data are not exported. Review user request previews and identifiers before sharing.", "",
  ];
  for (const { turn, sources, jobs } of reports) {
    lines.push("## Turn " + turn.number, "",
      "- Turn ID: " + inline(turn.id),
      "- Request preview: " + inline(turn.text),
      "- Runtime: " + inline(turn.runtime),
      "- Model: " + inline(turn.model ?? "not recorded"),
      "- Status: " + inline(turn.status) + (turn.status === "streaming" ? " (partial snapshot)" : ""), "",
      "### Trace events (metadata only)", "");
    for (const source of sources) {
      lines.push("#### " + inline(source.name), "");
      if (source.state !== "available") {
        lines.push("- Trace " + (source.state === "missing" ? "not recorded" : "unavailable"), "");
      } else if (!source.events.length) {
        lines.push("- No readable events", "");
      } else {
        for (const event of source.events)
          lines.push("- " + inline(event.kind) + (event.status ? " (" + inline(event.status) + ")" : ""));
        if (source.truncated) lines.push("- Event list truncated at the report limit");
        lines.push("");
      }
    }
    lines.push("### Linked generation jobs", "");
    if (jobs === null) lines.push("- Job data unavailable");
    else if (!jobs.length) lines.push("- No linked jobs");
    else for (const job of jobs)
      lines.push("- " + inline(job.id) + ": " + inline(job.status) +
        (job.adopted ? " (adopted)" : " (not adopted)"));
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
