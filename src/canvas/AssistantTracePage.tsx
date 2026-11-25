import { useT } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";
import { useEffect, useMemo, useRef, useState } from "react";

import { traceCategory, isThinkingTokenEstimate, readableTraceValue } from "./traceCategory.ts";

import { initialTurn, normalizeTrace, runtimeName, traceRuntime, traceSources, type ConversationTurn } from "./traceTurns.ts";

import { readTurnJobs, turnJobView, type TurnJob } from "./traceJobs.ts";
import { conversationTraceArchive } from "./traceExport.ts";

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

function TraceRow({ kind, summary, value }: {
  kind: string; summary: string; value: unknown;
}) {
  const t = useT();
  return (
    <details className="cw-trace-row">
      <summary>
        <span className={`cw-trace-badge is-${kind}`}>{t(labels[kind] ?? "trace.role.event")}</span>
        <span className="cw-trace-preview">{summary}</span>
      </summary>
      <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function TraceEntries({ traces, rawModel }: { traces: string[]; rawModel: boolean }) {
  const t = useT();
  const entries = useMemo(() => {
    const parsed = traces.flatMap((trace, sourceIndex) => {
    let timestamp = 0;
    return trace.split("\n").flatMap((line, index) => {
      if (!line.trim()) return [];
      let record: TraceRecord | null;
      try {
        record = readableTraceValue(JSON.parse(line)) as TraceRecord | null;
      } catch {
        record = null;
      }
      if (isThinkingTokenEstimate(record?.native)) return [];
      if (record?.native?.type === "assistant" && record.native.message?.content?.length === 0) return [];
      timestamp = record?.native?.timestamp ??
        (record?.timestamp === undefined ? timestamp : record.timestamp * 1000);
      return [{ line, record, timestamp, key: `${sourceIndex}:${index}` }];
    });
  }).sort((a, b) => a.timestamp - b.timestamp);
    const reasoning = new Map<string, typeof parsed[number]>();
    return parsed.filter((entry) => {
      if (entry.record?.event !== "model.reasoning") return true;
      const identity = `${entry.record.requestId}:${entry.record.choiceIndex ?? 0}`;
      const previous = reasoning.get(identity);
      if (previous?.record) {
        previous.record.text = (previous.record.text ?? "") + (entry.record.text ?? "");
        return false;
      }
      reasoning.set(identity, entry);
      return true;
    });
  }, [traces]);
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
        const identity = JSON.stringify(message);
        if (seenReasoning.has(identity)) return [];
        seenReasoning.add(identity);
        if (hasStreamedReasoning || firstModelRequest || titleRequest) return [];
        return [<TraceRow key={`reasoning:${index}`} kind="reasoning" summary={text} value={text} />];
      });
      if (!titleRequest) firstModelRequest = false;
      const inputs = titleRequest ? [] : (payload.messages ?? []).flatMap((message, index) => {
        if (!["system", "developer"].includes(message.role)) return [];
        const identity = JSON.stringify(message);
        if (seenInputs.has(identity)) return [];
        seenInputs.add(identity);
        const content = typeof message.content === "string" ? message.content : identity;
        return [<TraceRow key={index} kind="system"
          summary={t("trace.systemPrompt")}
          value={content} />];
      });
      const toolsKey = payload.tools?.length ? JSON.stringify(payload.tools) : undefined;
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
}

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
  const [traces, setTraces] = useState<string[]>([]);
  const [showModel, setShowModel] = useState(false);
  const rawModel = runtime === "opencode" && showModel;
  const [status, setStatus] = useState<number | null>(null);
  const [jobs, setJobs] = useState<TurnJob[]>([]);
  const t = useT();

  useEffect(() => {
    const controller = new AbortController();
    const [projectPath, turnPath] = [project, turn].map(encodeURIComponent);
    const sources = traceSources(runtime);
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
    async function refresh() {
      try {
        if (live && document.hidden) return;
        const jobsRequest = fetch(`/api/creation/projects/${projectPath}/assistant/turns/${turnPath}/jobs`, options)
          .then(readTurnJobs, () => [] as TurnJob[]);
        const snapshots = await Promise.all(sources.map(async (name) => {
          const response = await fetch(`${traceUrl}/${encodeURIComponent(name)}`, options);
          const body = response.ok ? await response.text() : "";
          return { status: response.status, body: normalizeTrace(name, body) };
        }));
        const nextJobs = await jobsRequest;
        const status = snapshots.some((item) => item.status === 200) ? 200 : snapshots[0].status;
        if (controller.signal.aborted) return;
        setStatus(status);
        setJobs((previous) => JSON.stringify(previous) === JSON.stringify(nextJobs) ? previous : nextJobs);
        const bodies = snapshots.map((item) => item.body);
        setTraces((previous) => bodies.every((body, index) => body === previous[index]) ? previous : bodies);
      } catch {
        if (!controller.signal.aborted) setStatus(0);
      } finally {
        if (live && !controller.signal.aborted) timer = window.setTimeout(refresh, 750);
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
        rawModel && !traces[0]?.trim() ? (
          <p role="status">{t("trace.noModelRequests")}</p>
        ) : (
          <TraceEntries traces={rawModel ? traces.slice(0, 1) : traces} rawModel={rawModel} />
        )
      ) : (
        <p role="status">{status === null ? t("trace.loading") :
          status === 404 && live ? t("trace.waiting") :
          status === 404 ? t("trace.notFound") :
          t("trace.loadFailed")}</p>
      )}
      {jobs.length > 0 && <TraceJobs jobs={jobs} />}
    </>
  );
}

const STATUS_KEYS: Record<ConversationTurn["status"], MessageKey> = {
  streaming: "trace.turn.status.streaming", complete: "trace.turn.status.complete",
  stopped: "trace.turn.status.stopped", interrupted: "trace.turn.status.interrupted",
};

function ConversationTrace({ project, conversationId, target, turns }: {
  project: string; conversationId: string; target: string; turns: ConversationTurn[];
}) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const placed = useRef(false);
  const initial = initialTurn(turns, target);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  async function exportArchive() {
    if (exporting || !window.confirm(t("trace.export.warning"))) return;
    setExporting(true);
    setExportError(false);
    try {
      const archive = await conversationTraceArchive(project, conversationId, turns);
      const url = URL.createObjectURL(new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "opendirector-trace-" + conversationId + ".zip";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportError(true);
    } finally {
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
        <button type="button" disabled={exporting || turns.length === 0} onClick={() => void exportArchive()}>
          {t(exporting ? "trace.export.working" : "trace.export.button")}
        </button>
        {exportError && <span role="alert">{t("trace.export.failed")}</span>}
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
              <span className={`cw-trace-badge is-turn-${item.status}`}>{t(STATUS_KEYS[item.status])}</span>
            </span>
          </summary>
          {loaded.has(item.id) && (
            <TurnTrace project={project} turn={item.id} runtime={traceRuntime(item.runtime)}
              live={item.status === "streaming"} />
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
        <TurnTrace project={project} turn={turn} runtime={runtime} live={live} />
      )}
    </main>
  );
}
