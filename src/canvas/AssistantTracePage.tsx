import { useT } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { traceCategory, isThinkingTokenEstimate, readableTraceValue } from "./traceCategory.ts";

import { turnTiming, TURN_STATUS_KEYS } from "./turnTiming.ts";
import { initialTurn, runtimeName, traceRuntime, traceSources, type ConversationTurn } from "./traceTurns.ts";

import { createTraceCursor, type TraceSnapshot } from "./traceCursor.ts";
import { readTurnJobs, turnJobView, type TurnJob } from "./traceJobs.ts";
import { downloadFile } from "./assets.ts";
import { conversationTraceArchive, TraceExportError } from "./traceExport.ts";

import "./assistant-trace.css";

type TraceRecord = {
  event?: string;
  requestId?: string;
  choiceIndex?: number;
  text?: string;
  type?: string;
  tool?: string;
  name?: string;
  timestamp?: number;
  status?: number;
  elapsedMs?: number;
  error?: string;
  payload?: { model?: string; messages?: { role: string; content?: unknown; reasoning_content?: string }[]; tools?: unknown[] };
  native?: {
    type?: string;
    subtype?: string;
    event_type?: string;
    role?: string;
    payload?: { text?: string };
    timestamp?: number;
    part?: { text?: string; tool?: string; reason?: string; state?: { status?: string } };
    item?: { type?: string; text?: string; role?: string; command?: string; aggregated_output?: string; exit_code?: number | null; status?: string; message?: string };
    message?: { role?: string; content?: { type?: string; text?: string }[] };
  };
};

const labels: Record<string, MessageKey> = {
  system: "trace.role.system", user: "trace.role.user", context: "trace.role.context",
  assistant: "trace.role.assistant", tool: "trace.role.tool", model: "trace.role.model",
  event: "trace.role.event", reasoning: "trace.role.reasoning",
};

const TraceRow = memo(function TraceRow({ kind, summary, value }: {
  kind: string; summary: string; value: unknown;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <details className="cw-trace-row" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className={`cw-trace-badge is-${kind}`}>{t(labels[kind] ?? "trace.role.event")}</span>
        <span className="cw-trace-preview">{summary.slice(0, 512)}</span>
      </summary>
      {open && <pre>{typeof value === "string" ? value : JSON.stringify(readableTraceValue(value), null, 2)}</pre>}
    </details>
  );
});

const TraceEntries = memo(function TraceEntries({ traces, rawModel }: {
  traces: readonly (TraceSnapshot | undefined)[]; rawModel: boolean;
}) {
  const t = useT();
  const entries = useMemo(() => {
    const sources = rawModel ? traces.slice(0, 1) : traces;
    const parsed = sources.flatMap((trace, sourceIndex) => {
      let timestamp = 0;
      return trace?.rows.flatMap((value, index) => {
        const line = typeof value === "string" ? value : "";
        const record = value && typeof value === "object" ? value as TraceRecord : null;
        if (!record && !line) return [];
        if (isThinkingTokenEstimate(record?.native)) return [];
        if (record?.native?.type === "assistant" && record.native.message?.content?.length === 0) return [];
        timestamp = record?.native?.timestamp ??
          (record?.timestamp === undefined ? timestamp : record.timestamp * 1000);
        return [{ line, record, timestamp, key: `${sourceIndex}:${trace.generation}:${index}` }];
      }) ?? [];
    }).sort((a, b) => a.timestamp - b.timestamp);
    const reasoning = new Map<string, typeof parsed[number]>();
    return parsed.flatMap((entry) => {
      if (entry.record?.event !== "model.reasoning") return [entry];
      const identity = `${entry.record.requestId}:${entry.record.choiceIndex ?? 0}`;
      const previous = reasoning.get(identity);
      if (previous?.record) {
        previous.record.text = (previous.record.text ?? "") + (entry.record.text ?? "");
        return [];
      }
      const merged = { ...entry, record: { ...entry.record } };
      reasoning.set(identity, merged);
      return [merged];
    });
  }, [traces, rawModel]);
  let request = 0;
  const seenInputs = new Set<string>();
  const seenReasoning = new Set<string>();
  const hasStreamedReasoning = entries.some(({ record }) => record?.event === "model.reasoning");
  let firstModelRequest = true;
  return entries.map(({ line, record, key }) => {
    const payload = record?.payload;
    if (record?.event === "model.request" && payload) {
      const titleRequest = payload.messages?.some((message) =>
        message.role === "user" && message.content === "Generate a title for this conversation:");
      if (rawModel) {
        request++;
        const label = titleRequest ? t("trace.generateTitle") :
          t("trace.modelRequest", { number: request });
        return <TraceRow key={key} kind="model" summary={`${label} · ${payload.model ?? ""}`} value={record} />;
      }
      const thoughts = (payload.messages ?? []).flatMap((message, index) => {
        const text = message.reasoning_content?.trim();
        if (!text || message.role !== "assistant") return [];
        const identity = JSON.stringify(readableTraceValue(message));
        if (seenReasoning.has(identity)) return [];
        seenReasoning.add(identity);
        if (hasStreamedReasoning || firstModelRequest || titleRequest) return [];
        return [<TraceRow key={`reasoning:${index}`} kind="reasoning" summary={text} value={text} />];
      });
      if (!titleRequest) firstModelRequest = false;
      const inputs = titleRequest ? [] : (payload.messages ?? []).flatMap((message, index) => {
        if (!["system", "developer"].includes(message.role)) return [];
        const identity = JSON.stringify(readableTraceValue(message));
        if (seenInputs.has(identity)) return [];
        seenInputs.add(identity);
        const content = typeof message.content === "string" ? message.content : identity;
        return [<TraceRow key={index} kind="system"
          summary={t("trace.systemPrompt")}
          value={content} />];
      });
      const toolsKey = payload.tools?.length ? JSON.stringify(readableTraceValue(payload.tools)) : undefined;
      if (toolsKey && !seenInputs.has(toolsKey)) {
        seenInputs.add(toolsKey);
        inputs.push(<TraceRow key="tools" kind="context"
          summary={t("trace.toolDefinitions", { count: payload.tools?.length ?? 0 })}
          value={payload.tools} />);
      }
      return <div key={key}>{thoughts}{inputs}</div>;
    }
    const type = record?.native?.event_type ?? record?.native?.type ?? record?.event ?? record?.type;
    const part = record?.native?.part;
    const codexItem = record?.native?.item;
    if (codexItem?.type === "command_execution") {
      const state = codexItem.status ?? "in_progress";
      const status = state === "in_progress" ? t("trace.running") : codexItem.exit_code === 0 ? t("trace.succeeded") : t("trace.failed");
      return <details key={key} className="cw-trace-row">
        <summary><span className="cw-trace-badge is-tool">{t("trace.role.tool")}</span>
          <span className="cw-trace-preview">{codexItem.command}</span>
          <span className="cw-trace-status">{status}</span></summary>
        <div className="cw-trace-command-detail">
          <h3>{t("trace.command")}</h3><pre>{codexItem.command}</pre>
          <h3>{t("trace.output")}</h3><pre>{codexItem.aggregated_output || t(state === "in_progress" ? "trace.waitingOutput" : "trace.noOutput")}</pre>
          {codexItem.exit_code != null && <p>{t("trace.exitCode", { code: codexItem.exit_code })}</p>}
        </div>
      </details>;
    }
    if (codexItem?.type === "error" && codexItem.message)
      return <TraceRow key={key} kind="event" summary={codexItem.message} value={codexItem.message} />;
    if (type === "model.reasoning" && record?.text) {
      return <TraceRow key={key} kind="reasoning" summary={record.text.trim()} value={record.text} />;
    }
    if (!rawModel && type?.startsWith("model.")) return null;
    if (type === "reasoning" && part?.text?.trim()) {
      if (hasStreamedReasoning) return null;
      return <TraceRow key={key} kind="reasoning" summary={part.text.trim()} value={part.text} />;
    }
    const assistantText = type === "text" || type === "reasoning" ? part?.text :
      type === "item.completed" && record?.native?.item?.type === "agent_message" ? record.native.item.text :
      type === "assistant" ? record?.native?.message?.content
        ?.filter((block) => block.type === "text").map((block) => block.text).join("\n") : undefined;
    if (assistantText?.trim()) {
      return <TraceRow key={key} kind={record?.native?.role === "user" ? "user" : "assistant"} summary={assistantText.trim()} value={assistantText} />;
    }
    if (type === "step_start" || type === "text" || type === "reasoning") return null;
    const kind = traceCategory(
      type === "item.completed" || type === "item.started" ? record?.native?.item?.type : type,
      record?.native?.message?.role ?? record?.native?.item?.role ?? record?.native?.role,
    );
    const summary = part?.text?.trim() || record?.native?.payload?.text || [
      part?.tool ?? record?.tool ?? record?.name ?? type,
      part?.state?.status ?? part?.reason ?? record?.error ?? record?.status,
      record?.elapsedMs === undefined ? undefined : `${record.elapsedMs} ms`,
    ].filter(Boolean).join(" · ") || line;
    return <TraceRow key={key} kind={kind} summary={summary} value={record ?? line} />;
  });
});

function TraceJobs({ jobs }: { jobs: TurnJob[] }) {
  const t = useT();
  return (
    <section className="cw-trace-jobs" aria-label={t("trace.jobs.title")}>
      <h2>{t("trace.jobs.title")}</h2>
      {jobs.map((job) => {
        const view = turnJobView(job, t);
        return (
          <div key={view.key} className="cw-trace-row cw-trace-job">
            <span className={`cw-trace-badge is-job-${view.status}`}>{view.statusText}</span>
            <span className="cw-trace-preview">
              <code>{job.jobId}</code>
              {[view.assetText, view.adoptedText, view.cancelText, view.errorText]
                .filter(Boolean).map((text) => ` · ${text}`).join("")}
            </span>
          </div>
        );
      })}
    </section>
  );
}

function TurnTrace({ project, turn, runtime, live }: {
  project: string; turn: string; runtime: string; live: boolean;
}) {
  const [input, setInput] = useState<string | null>(null);
  const [traces, setTraces] = useState<readonly (TraceSnapshot | undefined)[]>([]);
  const [showModel, setShowModel] = useState(false);
  const rawModel = runtime === "opencode" && showModel;
  const [status, setStatus] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(live);
  const [jobs, setJobs] = useState<TurnJob[]>([]);
  const t = useT();

  useEffect(() => {
    const controller = new AbortController();
    const [projectPath, turnPath] = [project, turn].map(encodeURIComponent);
    const sources = traceSources(runtime).map(createTraceCursor);
    setInput(null);
    const traceUrl = `/api/creation/projects/${projectPath}/assistant/traces/${turnPath}`;
    const options = { headers: { "X-OpenDirector-Request": "1" }, signal: controller.signal };
    void fetch(`${traceUrl}/input`, options).then(async (response) => {
      if (!response.ok) return;
      const message = await response.json() as { text: string };
      if (!controller.signal.aborted) setInput(message.text);
    }).catch(() => {});
    setStatus(null);
    setTraces([]);
    setJobs([]);
    let timer: number | undefined;
    let polling = live;
    async function refresh() {
      let delay = 750;
      try {
        if (polling && document.hidden) return;
        const snapshots = await Promise.all(sources.map((source) => source.read(traceUrl, options, live)
          .catch(() => null)));
        if (controller.signal.aborted) return;
        setWaiting(snapshots.some((item) => item?.follow));
        const available = snapshots.some((item) => item?.status === 200);
        if (available) setStatus(200);
        else setStatus((previous) => previous === 200 && snapshots.includes(null) ? previous
          : snapshots.every((item) => item?.status === 404) ? 404 : 0);
        setTraces((previous) => {
          const rows = snapshots.map((item, index) => item?.snapshot ?? previous[index]);
          return rows.every((body, index) => body === previous[index]) ? previous : rows;
        });
        const more = snapshots.some((item) => item?.more);
        polling = more || snapshots.some((item) => item?.follow) || (polling && snapshots.includes(null));
        if (more) {
          delay = 0;
          return;
        }
        const nextJobs = await fetch(`/api/creation/projects/${projectPath}/assistant/turns/${turnPath}/jobs`, options)
          .then(readTurnJobs, () => null);
        if (!controller.signal.aborted && nextJobs) {
          setJobs((previous) => JSON.stringify(previous) === JSON.stringify(nextJobs) ? previous : nextJobs);
        }
      } finally {
        if (polling && !controller.signal.aborted) timer = window.setTimeout(refresh, delay);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [project, turn, live, runtime]);

  return (
    <>
      {runtime === "opencode" && (
        <nav className="cw-trace-tabs" aria-label={t("trace.views")}>
          <button type="button" aria-pressed={!rawModel} onClick={() => setShowModel(false)}>
            {t("trace.title")}
          </button>
          <button type="button" aria-pressed={rawModel} onClick={() => setShowModel(true)}>
            {t("trace.rawRequests")}
          </button>
        </nav>
      )}
      {!rawModel && input !== null && <TraceRow kind="user" summary={input} value={input} />}
      {status === 200 ? (
        rawModel && !traces[0]?.rows.length ? (
          <p role="status">{t("trace.noModelRequests")}</p>
        ) : (
          <TraceEntries traces={traces} rawModel={rawModel} />
        )
      ) : (
        <p role="status">{status === null ? t("trace.loading") :
          status === 404 && waiting ? t("trace.waiting") :
          status === 404 ? t("trace.notFound") :
          t("trace.loadFailed")}</p>
      )}
      {jobs.length > 0 && <TraceJobs jobs={jobs} />}
    </>
  );
}

function ConversationTrace({ project, conversationId, target, turns }: {
  project: string; conversationId: string; target: string; turns: ConversationTurn[];
}) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const placed = useRef(false);
  const initial = initialTurn(turns, target);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportAbort = useRef<AbortController | null>(null);
  const running = turns.some((item) => item.status === "streaming");
  useEffect(() => () => exportAbort.current?.abort(), []);
  function exportMessage(error: unknown): string | null {
    if (!(error instanceof TraceExportError)) return t("trace.export.failed");
    const { turn, source, status, limit } = error.detail;
    const params = { turn: turn ?? "-", source: source ?? "-", status: status ?? "-",
      limit: limit ? Math.round(limit / 1048576) : 0 };
    switch (error.code) {
      case "aborted": return null;
      case "running": return t("trace.export.error.running", params);
      case "tooLarge": return t("trace.export.error.tooLarge", params);
      case "tooManyFiles": return t("trace.export.error.tooManyFiles", params);
      case "timeout": return t("trace.export.error.timeout", params);
      case "changed": return t("trace.export.error.changed", params);
      case "incomplete": return t("trace.export.error.incomplete", params);
      default: return t("trace.export.error.read", params);
    }
  }
  async function exportArchive() {
    if (exporting || running || !window.confirm(t("trace.export.warning"))) return;
    const controller = new AbortController();
    exportAbort.current = controller;
    setExporting(true);
    setExportError(null);
    try {
      const archive = await conversationTraceArchive(project, conversationId, { signal: controller.signal });
      downloadFile(archive, "opendirector-trace-" + conversationId + ".zip");
    } catch (error) {
      setExportError(exportMessage(error));
    } finally {
      exportAbort.current = null;
      setExporting(false);
    }
  }

  function toggle(id: string, value: boolean) {
    setOpen((previous) => {
      if (previous.has(id) === value) return previous;
      const next = new Set(previous);
      if (value) next.add(id); else next.delete(id);
      return next;
    });
    if (value) setLoaded((previous) => previous.has(id) ? previous : new Set(previous).add(id));
  }
  function reveal(id: string) {
    toggle(id, true);
    window.requestAnimationFrame(() => document.getElementById(`turn-${id}`)?.scrollIntoView({ block: "start" }));
  }
  useEffect(() => {
    if (placed.current || !initial) return;
    placed.current = true;
    reveal(initial);
  }, [initial]);

  return (
    <>
      <div className="cw-trace-export">
        <button type="button" disabled={exporting || running || turns.length === 0} onClick={() => void exportArchive()}>
          {t(exporting ? "trace.export.working" : "trace.export.button")}
        </button>
        {exporting && <button type="button" onClick={() => exportAbort.current?.abort()}>{t("trace.export.cancel")}</button>}
        {running && !exporting && <span role="status">{t("trace.export.blockedRunning")}</span>}
        {exportError && <span role="alert">{exportError}</span>}
      </div>
      <nav className="cw-trace-turnnav" aria-label={t("trace.turns.nav")}>
        {turns.map((item) => (
          <button key={item.id} type="button" aria-pressed={open.has(item.id)}
            title={item.text} onClick={() => reveal(item.id)}>{item.number}</button>
        ))}
      </nav>
      {turns.length === 0 && <p role="status">{t("trace.turns.empty")}</p>}
      {turns.map((item) => (
        <details key={item.id} id={`turn-${item.id}`} className="cw-trace-turn"
          open={open.has(item.id)} onToggle={(event) => toggle(item.id, event.currentTarget.open)}>
          <summary>
            <span className="cw-trace-turn-number">{t("trace.turn.number", { number: item.number })}</span>
            <span className="cw-trace-preview">{item.text}</span>
            <span className="cw-trace-turn-meta">
              <span>{runtimeName(item.runtime)}</span>
              <span className={`cw-trace-badge is-turn-${item.status}`}>{t(TURN_STATUS_KEYS[item.status])}</span>
              {item.status !== "streaming" && (
                <span className="cw-trace-turn-duration">{turnTiming(item, t).duration ?? t("trace.turn.duration.unavailable")}</span>
              )}
            </span>
          </summary>
          {loaded.has(item.id) && (
            <TurnTrace project={project} turn={item.id} runtime={traceRuntime(item.runtime)} live />
          )}
        </details>
      ))}
    </>
  );
}

export default function AssistantTracePage({ params }: { params: URLSearchParams }) {
  const project = params.get("traceProject") ?? "";
  const turn = params.get("turn") ?? "";
  const runtime = params.get("runtime") ?? "opencode";
  const live = params.get("live") === "1";
  const requested = params.get("conversation");
  // undefined: not resolved yet. null: no conversation could be found, show the single turn.
  const [conversation, setConversation] = useState<{ id: string; turns: ConversationTurn[] } | null | undefined>();
  const t = useT();

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const base = `/api/creation/projects/${encodeURIComponent(project)}/assistant`;
    const options = { headers: { "X-OpenDirector-Request": "1" }, signal: controller.signal };
    async function load() {
      try {
        let id = requested;
        if (!id && turn) {
          const found = await fetch(`${base}/traces/${encodeURIComponent(turn)}/conversation`, options);
          if (found.ok) id = ((await found.json()) as { conversationId: string }).conversationId;
        }
        const response = id ? await fetch(`${base}/conversations/${encodeURIComponent(id)}/trace`, options) : null;
        if (controller.signal.aborted) return;
        if (!response?.ok) return setConversation((previous) => previous === undefined ? null : previous);
        const body = await response.json() as { conversationId: string; turns: ConversationTurn[] };
        setConversation((previous) => JSON.stringify(previous) === JSON.stringify(body) ? previous : { id: body.conversationId, turns: body.turns });
        if (body.turns.some((item) => item.status === "streaming"))
          timer = window.setTimeout(load, 2000);
      } catch {
        if (!controller.signal.aborted) setConversation((previous) => previous === undefined ? null : previous);
      }
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [project, turn, requested]);

  // A link to a turn that the conversation does not list keeps the single-turn view.
  const listed = conversation?.turns.some((item) => item.id === turn) ?? false;
  const wide = conversation && (listed || !turn);
  return (
    <main className="cw-trace-page">
      <header className="cw-trace-header">
        <h1>{wide ? t("trace.conversationTitle") : t("trace.title")}</h1>
        {!wide && <p><code>{turn}</code></p>}
      </header>
      {conversation === undefined ? <p role="status">{t("trace.loading")}</p> : wide ? (
        <ConversationTrace project={project} conversationId={conversation.id} target={turn} turns={conversation.turns} />
      ) : (
        <TurnTrace key={`${project}:${turn}:${runtime}`} project={project} turn={turn} runtime={runtime} live={live} />
      )}
    </main>
  );
}
