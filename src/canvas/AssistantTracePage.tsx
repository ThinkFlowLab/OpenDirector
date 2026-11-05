import { useEffect, useMemo, useState } from "react";

import { traceCategory } from "./traceCategory.ts";
import { useT } from "../i18n/I18nProvider";

import { normalizeDeepseekTrace } from "./deepseekTrace.ts";

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
    event_type?: string;
    role?: string;
    payload?: { text?: string };
    timestamp?: number;
    part?: { text?: string; tool?: string; reason?: string; state?: { status?: string } };
    item?: { type?: string; text?: string; role?: string };
    message?: { role?: string; content?: { type?: string; text?: string }[] };
  };
};

const labels = {
  system: "assistant.trace.kind.system", user: "assistant.trace.kind.user",
  context: "assistant.trace.kind.context", assistant: "assistant.trace.kind.assistant",
  tool: "assistant.trace.kind.tool", model: "assistant.trace.kind.model",
  event: "assistant.trace.kind.event", reasoning: "assistant.trace.kind.reasoning",
} as const;

function TraceRow({ kind, summary, value }: {
  kind: keyof typeof labels; summary: string; value: unknown;
}) {
  const t = useT();
  return (
    <details className="cw-trace-row">
      <summary>
        <span className={`cw-trace-badge is-${kind}`}>{t(labels[kind])}</span>
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
        record = JSON.parse(line) as TraceRecord | null;
      } catch {
        record = null;
      }
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
        const label = titleRequest ? t("assistant.trace.titleRequest") :
          t("assistant.trace.modelRequest", { count: request });
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
          summary={t("assistant.trace.systemPrompt")}
          value={content} />];
      });
      const toolsKey = payload.tools?.length ? JSON.stringify(payload.tools) : undefined;
      if (toolsKey && !seenInputs.has(toolsKey)) {
        seenInputs.add(toolsKey);
        inputs.push(<TraceRow key="tools" kind="context"
          summary={t("assistant.trace.toolDefinitions", { count: payload.tools?.length ?? 0 })}
          value={payload.tools} />);
      }
      return <div key={key}>{thoughts}{inputs}</div>;
    }
    const type = record?.native?.event_type ?? record?.native?.type ?? record?.event ?? record?.type;
    const part = record?.native?.part;
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
      return <TraceRow key={key} kind="assistant" summary={assistantText.trim()} value={assistantText} />;
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

export default function AssistantTracePage({ params }: { params: URLSearchParams }) {
  const project = params.get("traceProject") ?? "";
  const turn = params.get("turn") ?? "";
  const runtime = params.get("runtime") ?? "opencode";
  const live = params.get("live") === "1";
  const [input, setInput] = useState<string | null>(null);
  const [traces, setTraces] = useState<string[]>([]);
  const [showModel, setShowModel] = useState(false);
  const rawModel = runtime === "opencode" && showModel;
  const [status, setStatus] = useState<number | null>(null);
  const t = useT();

  useEffect(() => {
    const controller = new AbortController();
    const [projectPath, turnPath] = [project, turn].map(encodeURIComponent);
    const sources = runtime === "opencode" ? ["model", runtime] : [runtime];
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
    let timer: number | undefined;
    async function refresh() {
      try {
        if (live && document.hidden) return;
        const snapshots = await Promise.all(sources.map(async (name) => {
          const response = await fetch(`${traceUrl}/${encodeURIComponent(name)}`, options);
          const body = response.ok ? await response.text() : "";
          return { status: response.status, body: name === "deepseek" ? normalizeDeepseekTrace(body) : body };
        }));
        const status = snapshots.some((item) => item.status === 200) ? 200 : snapshots[0].status;
        if (controller.signal.aborted) return;
        setStatus(status);
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
    <main className="cw-trace-page">
      <header className="cw-trace-header">
      <h1>{t("assistant.trace.title")}</h1>
      <p><code>{turn}</code></p>
      {runtime === "opencode" && (
        <nav className="cw-trace-tabs" aria-label={t("assistant.trace.views")}>
          <button type="button" aria-pressed={!rawModel} onClick={() => setShowModel(false)}>
            {t("assistant.trace.title")}
          </button>
          <button type="button" aria-pressed={rawModel} onClick={() => setShowModel(true)}>
            {t("assistant.trace.rawRequests")}
          </button>
        </nav>
      )}
      </header>
      {!rawModel && input !== null && <TraceRow kind="user" summary={input} value={input} />}
      {status === 200 ? (
        rawModel && !traces[0]?.trim() ? (
          <p role="status">{t("assistant.trace.noModelRequests")}</p>
        ) : (
          <TraceEntries traces={rawModel ? traces.slice(0, 1) : traces} rawModel={rawModel} />
        )
      ) : (
        <p role="status">{status === null ? t("assistant.trace.loading") :
          status === 404 && live ? t("assistant.trace.waiting") :
          status === 404 ? t("assistant.trace.missing") :
          t("assistant.trace.failed")}</p>
      )}
    </main>
  );
}
