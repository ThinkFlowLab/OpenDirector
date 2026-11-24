import { workflowRequest } from "./workspace/workflowMembers.ts";
import { generationOutput, money, uniformOutputPrice } from "./spendPresentation.ts";
import { TooltipButton } from "./TooltipButton.tsx";
import { CANVAS_TOOLS } from "./toolCatalog.ts";
import { translateToolText } from "./toolText.ts";
import type { CanvasDocument, GenerationSettings } from "./model.ts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { errorMessage, json, request } from "../backend/api.ts";
import { creationClient, objectVersion } from "../backend/creationClient.ts";
import type { ModelConfig } from "../backend/rules.ts";
import { spendQuery, type PendingSpend, type QuoteView, type SpendStatus } from "../backend/spend.ts";
import type { ConnectionPrice, SpendPolicy, SpendQuote } from "../contracts/generated.ts";
import { useI18n, useT } from "../i18n/I18nProvider";
import { CanvasIcon } from "./CanvasIcon";
import { SpendDialog } from "./SpendDialog";
import "./project-spend.css";

function useSnapshot(projectId: string) {
  const client = creationClient(projectId);
  const subscribe = useCallback((notify: () => void) => client.listen(notify), [client]);
  return useSyncExternalStore(subscribe, () => client.snapshot);
}

function QuoteLines({ quote }: { quote: SpendQuote }) {
  const { t, locale } = useI18n();
  return <ul className="cw-spend-lines">{quote.lines.map((line, index) => <li key={index}>
    <span>{t(`spend.operation.${line.operation}` as "spend.operation.image")} · {line.modelId}</span>
    <span>{line.price && line.amount != null
      ? quote.count > 1 ? t("spend.batchLine", {amount: money(line.amount, line.price.currency, locale), count: quote.count})
        : money(line.amount, line.price.currency, locale)
      : t("spend.unknown")}</span>
    {line.price == null && <small>{t("spend.noRate")}</small>}
    {line.price && line.amount == null && <small>{t("spend.missingUnits")}</small>}
    {line.price && <small>{t(`spend.source.${line.source}`)} · {line.quantityBasis === "maximum" && "≤ "}{line.quantity ?? "?"} × {line.price.rate} {line.price.currency} / {t(`spend.unit.${line.price.unit}`)}{line.sourceUrl && <> · <a href={line.sourceUrl} target="_blank" rel="noreferrer">{line.sourceVersion}</a></>}</small>}
  </li>)}</ul>;
}

function Subtotals({ values }: { values: Record<string, string> }) {
  const { t, locale } = useI18n();
  return <>{Object.entries(values).map(([currency, amount]) => <p key={currency}>{t("spend.knownSubtotal", { amount: money(amount, currency, locale) })}</p>)}</>;
}

export function TurnSpend({ projectId, turnId }: { projectId: string; turnId: string }) {
  const { t, locale } = useI18n();
  const snapshot = useSnapshot(projectId);
  const hasJobs = snapshot?.jobs.some(job => job.agentRunId === turnId);
  const [status, setStatus] = useState<SpendStatus>();
  useEffect(() => {
    if (!hasJobs) return;
    const abort = new AbortController();
    void spendQuery<SpendStatus>(projectId, "spend.status", {agentRunId: turnId}, abort.signal)
      .then(value => { if (!abort.signal.aborted) setStatus(value); }).catch(() => {});
    return () => abort.abort();
  }, [hasJobs, projectId, turnId, snapshot?.eventCursor]);
  if (!hasJobs || !status?.turn?.callCount) return null;
  const { settled, held, unknown } = status.turn;
  return <details className="cw-spend-estimate"><summary>{t("spend.turn")}</summary>
    {t("spend.summary", { settled: money(settled, status.policy.currency, locale), held: money(held, status.policy.currency, locale) })}
    {unknown > 0 && <p>{t("spend.coverage", { count: unknown })}</p>}
  </details>;
}

export function GenerationEstimate({ projectId, itemId, count, modelId, prompt, priceRevision, draft }: {
  projectId: string; itemId: string; count: number; modelId: string; prompt: string; priceRevision: string; draft: GenerationSettings;
}) {
  const { t, locale } = useI18n();
  const snapshot = useSnapshot(projectId);
  const [result, setResult] = useState<{ key: string; value: QuoteView | null }>();
  const item = snapshot?.canvasItems.find(i => i.id === itemId);
  const specId = item?.binding.role === "generation" ? item.binding.objectRef.id :
    item && "draftSpec" in item.binding ? item.binding.draftSpec?.id : undefined;
  const spec = snapshot?.generationSpecs.find(s => s.id === specId);
  const key = JSON.stringify([projectId, itemId, specId, snapshot?.eventCursor, count, modelId, prompt, priceRevision]);
  const matches = spec?.modelConfigId === modelId && spec.prompt === prompt &&
    (spec.kind !== "audio" || (spec.parameters.creationType ?? "audio") === (draft.audioCreationType ?? "audio")) &&
    (spec.kind !== "audio" || spec.parameters.creationType !== "music" ||
      ((draft.durationSeconds == null || spec.parameters.durationSeconds === draft.durationSeconds) &&
       (spec.parameters.durationFromReference ?? true) === (draft.durationFromReference ?? true))) &&
    (spec.kind !== "video" || draft.durationSeconds == null || spec.parameters.durationSeconds === draft.durationSeconds);
  useEffect(() => {
    if (!specId || !matches) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void spendQuery<QuoteView>(projectId, "generation.quote", { specId, originItemId: itemId, count }, abort.signal)
        .then(value => { if (!abort.signal.aborted) setResult({ key, value }); })
        .catch(() => { if (!abort.signal.aborted) setResult({ key, value: null }); });
    }, 180);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [projectId, itemId, specId, count, matches, key]);
  if (!matches) return null;
  if (result?.key !== key) return <span aria-busy="true">{t("spend.estimating")}</span>;
  if (!result.value) return <span>{t("spend.estimateUnavailable")}</span>;
  const { amount, currency, projectAfter, quote } = result.value;
  return <details className="cw-spend-estimate">
    <summary>{t("spend.estimate", { action: t(`spend.action.${generationOutput(quote)}`, {count}), amount: amount == null ? t("spend.unknown") : money(amount, currency, locale) })}
      {projectAfter != null && <> · {t("spend.after", { amount: money(projectAfter, currency, locale) })}</>}
    </summary>{amount == null && <Subtotals values={result.value.subtotals} />}<QuoteLines quote={quote} />
  </details>;
}

export function GroupEstimate({ document, groupId, models }: {
  document: CanvasDocument; groupId: string; models: readonly ModelConfig[];
}) {
  const { t, locale } = useI18n();
  const snapshot = useSnapshot(document.id);
  const workflow = snapshot && workflowRequest(document, groupId, snapshot, models);
  const members = workflow && JSON.stringify(workflow.members);
  const key = JSON.stringify([document.id, members, snapshot?.eventCursor, models.map(model => model.price)]);
  const [result, setResult] = useState<{ key: string; value: QuoteView }>();
  useEffect(() => {
    if (!members) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void spendQuery<QuoteView>(document.id, "generation.groupQuote", {workflow: {members: JSON.parse(members)}}, abort.signal)
        .then(value => { if (!abort.signal.aborted) setResult({ key, value }); }).catch(() => {});
    }, 180);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [document.id, members, key]);
  if (!result || result.key !== key) return null;
  const { quote, currency, amount, subtotals } = result.value;
  return <details className="cw-spend-estimate cw-group-estimate">
    <summary>{t("spend.estimate", {action: t(`spend.action.${generationOutput(quote)}`, {count: quote.candidates ?? quote.count}), amount: amount == null ? t("spend.unknown") : money(amount, currency, locale)})}
      {!!quote.deferred?.length && <> · {t("spend.awaitingInputs", {count: quote.deferred.length})}</>}
      {!!quote.skipped?.length && <> · {t("spend.skippedSteps", {count: quote.skipped.length})}</>}
    </summary>{amount == null && <Subtotals values={subtotals} />}<QuoteLines quote={quote} />
  </details>;
}

export function ToolEstimate({ projectId, itemId, tool, priceRevision }: {
  projectId: string; itemId: string; tool: string; priceRevision: string;
}) {
  const snapshot = useSnapshot(projectId);
  const { t, locale } = useI18n();
  const item = snapshot?.canvasItems.find(i => i.id === itemId);
  const ref = item && "editors" in item ? item.editors.find(e => e.kind === "media_edit") : undefined;
  const editor = snapshot?.editorDocuments.find(e => e.id === ref?.id);
  const key = JSON.stringify([projectId, itemId, item?.revision, editor?.id, editor?.revision, tool, priceRevision, snapshot?.project.revision]);
  const [saved, setSaved] = useState<{ key: string; value: QuoteView }>();
  useEffect(() => {
    if (!item || editor?.kind !== "media_edit" || editor.data.tool !== tool || !editor.data.sources.length) return;
    const { sources, parameters, selection } = editor.data;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void request<QuoteView>(`/creation/projects/${projectId}/tool-tasks/quote`, {
        ...json("POST", { id: crypto.randomUUID(), tool, parameters, sourceAssetIds: sources.map(s => s.assetId),
          boxes: selection?.boxes ?? [], maskAssetId: selection?.mask?.assetId,
          modelConfigIds: typeof parameters.imageModelConfigId === "string" && parameters.imageModelConfigId ? {"image.edit": parameters.imageModelConfigId} : {},
          draft: { itemId, itemRevision: item.revision, editorId: editor.id, editorRevision: editor.revision } }),
        signal: abort.signal,
      }).then(value => { if (!abort.signal.aborted) setSaved({key, value}); }).catch(() => {});
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [key]);
  if (saved?.key !== key || !saved.value.quote.lines.length) return null;
  const { amount, currency, quote, subtotals } = saved.value;
  return <details className="cw-spend-estimate"><summary>{t("spend.toolQuote", { amount: amount == null ? t("spend.unknown") : money(amount, currency, locale) })}</summary>
    {amount == null && <Subtotals values={subtotals} />}<QuoteLines quote={quote} /></details>;
}

function SpendBalances({ status }: { status: SpendStatus }) {
  const { t, locale } = useI18n();
  const { currency, cap } = status.policy;
  const spent = money(status.settled, currency, locale);
  const held = money(status.held, currency, locale);
  const batch = status.settledBatch;
  const spentHelp = batch && (batch.kind === "image" || batch.kind === "video")
    ? t(`spend.spentHelp.${batch.kind}`, {count: batch.count, amount: spent})
    : t("spend.spentHelp");
  const heldHelp = status.unknown ? t("spend.heldHelp.unknown") : Number(status.held) === 0
    ? t("spend.heldHelp.zero") : t("spend.heldHelp.active", {amount: held});
  return <div className="cw-spend-balances">
    <div className="cw-spend-metric"><span>{t("spend.cap")}</span><strong>{cap == null ? t("spend.off") : money(cap, currency, locale)}</strong></div>
    {([["spend.spent", spent, spentHelp], ["spend.held", held, heldHelp]] as const).map(([label, amount, help]) =>
      <TooltipButton key={label} label={help} aria-label={`${t(label)} ${amount}`} className="cw-spend-metric" showOnClick>
        <span>{t(label)} <span aria-hidden="true">ⓘ</span></span><strong>{amount}</strong>
      </TooltipButton>)}
  </div>;
}

function ReviewCard({ projectId, entry, status, onSettings, onChange, onBusyChange }: {
  projectId: string; entry: PendingSpend; status: SpendStatus; onSettings?: () => void; onChange: (decision?: "approve" | "cancel") => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { request: batch, reason } = entry;
  const currency = status.policy.currency;
  const { quote } = batch;
  const output = generationOutput(quote);
  const count = quote.candidates ?? quote.count;
  const tool = batch.toolTask?.tool;
  const toolName = CANVAS_TOOLS.find(item => item.id === tool)?.title;
  const title = batch.toolTask
    ? toolName ? translateToolText(locale, toolName) : t(tool === "selection-preview" ? "spend.selectionPreview" : "spend.mediaTool")
    : t(`spend.action.${output}`, {count});
  const unit = uniformOutputPrice(quote);
  const unitPrice = unit && !batch.toolTask && output !== "tasks"
    ? t(`spend.each.${output}`, {amount: money(unit.amount, unit.currency, locale), model: unit.model}) : undefined;
  const runsSteps = Boolean(batch.toolTask || quote.deferred?.length);
  const cap = entry.suggestedCap == null ? null : money(entry.suggestedCap, currency, locale);
  let approvalLabel;
  switch (reason) {
    case "stale": case "stale_inputs": case "prior_unknown": case "unpriced": break;
    case "over_cap":
      if (cap != null) approvalLabel = t(runsSteps ? "spend.raiseRun" : "spend.raiseGenerate", {amount: cap});
      break;
    case "unknown_confirmation": approvalLabel = t("spend.allowUnknown"); break;
    default:
      approvalLabel = t(quote.deferred?.length ? "spend.runUpstream" : runsSteps ? "spend.approve" : "spend.generate");
  }
  const decide = async (decision: "approve" | "cancel") => {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const raising = decision === "approve" && reason === "over_cap";
      const versions = [...(decision === "approve" ? batch.versions : []), objectVersion("spend_request", batch)];
      if (raising) versions.push({ objectType: "project", id: projectId, revision: status.projectRevision });
      await creationClient(projectId).command("spend.review", {
        requestId: batch.id, fingerprint: entry.fingerprint, decision,
        acceptUnknown: decision === "approve" && reason === "unknown_confirmation",
        ...(raising ? { newCap: entry.suggestedCap } : {}),
      }, versions);
      onChange(decision);
    } catch (failure) { setError(errorMessage(failure)); onChange(); }
    finally { setBusy(false); onBusyChange(false); }
  };
  return <article className="cw-spend-card" data-spend-request={batch.id}>
    <div className="cw-spend-offer">
      <div><h4 className="cw-spend-title">{title}</h4>{unitPrice && <div className="cw-spend-unit">{unitPrice}</div>}</div>
      <div><span className="cw-spend-quote-label">{t("spend.batchEstimate")}</span>
        <strong className="cw-spend-amount">{entry.amount == null ? t("spend.unknown") : money(entry.amount, currency, locale)}</strong>
      </div>
    </div>
    {entry.amount == null && <Subtotals values={entry.subtotals} />}
    {quote.lines.length > 0 && <details className="cw-spend-price-details" open={!unitPrice}>
      <summary>{t("spend.priceDetails")}</summary><QuoteLines quote={quote} />
    </details>}
    {!!batch.quote.deferred?.length && <p>{t("spend.deferred", { count: batch.quote.deferred.length })}</p>}
    {!!batch.quote.skipped?.length && <p>{t("spend.skippedSteps", {count: batch.quote.skipped.length})}</p>}
    {reason === "over_cap" && <p className="cw-spend-reason">{t("spend.shortfall", {available: money(status.available!, currency, locale), missing: money(entry.shortfall!, currency, locale)})}
      {cap == null && <> {t("spend.capOutOfRange")}</>}</p>}
    {reason === "unpriced" && <p>{t("spend.needPrice")}</p>}
    {reason === "prior_unknown" && <p>{t("spend.priorUnknown")}</p>}
    {reason === "stale" && <p>{t("spend.stale")}</p>}
    {reason === "stale_inputs" && <p>{t("spend.staleInputs")}</p>}
    <SpendBalances status={status} />
    <div className="cw-spend-actions">
      {reason === "unpriced" && onSettings && <button onClick={onSettings}>{t("spend.connections")}</button>}
      {approvalLabel && <button className="cw-spend-confirm" disabled={busy} onClick={() => void decide("approve")}>
          {approvalLabel}
        </button>}
      <button className="cw-spend-cancel" disabled={busy} onClick={() => void decide("cancel")}>{t(runsSteps ? "spend.cancel" : "spend.cancelGeneration")}</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </article>;
}

function PolicyForm({ projectId, status }: { projectId: string; status: SpendStatus }) {
  const t = useT();
  const [currency, setCurrency] = useState(status.policy.currency);
  const [threshold, setThreshold] = useState(status.policy.threshold ?? "");
  const [cap, setCap] = useState(status.policy.cap ?? "");
  const [error, setError] = useState("");
  return <form className="cw-spend-form" onSubmit={async e => {
    e.preventDefault();
    try {
      await creationClient(projectId).command("spend.policy", { currency, threshold: threshold || null, cap: cap || null },
        [{ objectType: "project", id: projectId, revision: status.projectRevision }]);
      setError("");
    } catch (failure) { setError(errorMessage(failure)); }
  }}>
    <label>{t("spend.currency")} <select value={currency} onChange={e => setCurrency(e.target.value as SpendPolicy["currency"])}><option>USD</option><option>CNY</option></select></label>
    <label>{t("spend.threshold")} <input type="number" min="0" step="any" placeholder={t("spend.off")} value={threshold} onChange={e => setThreshold(e.target.value)} /></label>
    <label>{t("spend.cap")} <input type="number" min="0" step="any" placeholder={t("spend.off")} value={cap} onChange={e => setCap(e.target.value)} /></label>
    <button>{t("spend.save")}</button>{error && <p role="alert">{error}</p>}
  </form>;
}

export function ProjectSpend({ projectId, onSettings, onNotify }: {
  projectId: string; onSettings?: () => void; onNotify: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const snapshot = useSnapshot(projectId);
  const pendingIds = new Set(snapshot?.spendRequests?.filter(r => r.status === "pending").map(r => r.id));
  const pendingCount = pendingIds.size;
  const pendingKey = [...pendingIds].join(",");
  const [view, setView] = useState<string | null>(() => {
    const reviewId = new URLSearchParams(window.location.search).get("spendReview");
    return reviewId && pendingIds.has(reviewId) ? reviewId : null;
  });
  const seen = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SpendStatus>();
  const [error, setError] = useState("");
  const [revision, reload] = useState(0);
  const dismiss = () => {
    pendingIds.forEach(id => seen.current.add(id));
    setView(null);
  };
  useEffect(() => {
    const reveal = (event: Event) => {
      if ((event as CustomEvent).detail === projectId && pendingCount) setView([...pendingIds][0]);
    };
    window.addEventListener("opendirector:spend-review", reveal);
    return () => window.removeEventListener("opendirector:spend-review", reveal);
  }, [projectId, pendingKey]);
  // Both canvas and Agent requests arrive through the project snapshot. Show each
  // new request once; closing the dialog keeps it pending without reopening it.
  useEffect(() => {
    if (view && pendingIds.has(view)) { seen.current.add(view); return; }
    const next = [...pendingIds].find(id => !seen.current.has(id));
    if (next) { seen.current.add(next); setView(next); }
    else if (view !== "overview") setView(null);
  }, [pendingKey, view]);
  const shown = view != null;
  useEffect(() => {
    if (!shown || !snapshot) return;
    const abort = new AbortController();
    void spendQuery<SpendStatus>(projectId, "spend.status", {}, abort.signal).then(value => {
      if (!abort.signal.aborted) { setStatus(value); setError(""); }
    }).catch(failure => { if (!abort.signal.aborted) setError(errorMessage(failure)); });
    return () => abort.abort();
  }, [shown, projectId, snapshot, revision]);
  const reviewed = (decision?: "approve" | "cancel") => {
    reload(r => r + 1);
    if (!decision) return;
    onNotify(t(decision === "approve" ? "spend.reviewSubmitted" : "spend.reviewCancelled"));
  };
  const review = status?.pending.find(entry => entry.request.id === view && pendingIds.has(view));
  return <div className="cw-spend cw-settings-control">
    <TooltipButton className="cw-icon-button cw-spend-toggle" aria-expanded={shown} aria-haspopup="dialog"
      label={pendingCount ? t("spend.pendingHint", {count: pendingCount}) : t("spend.title")}
      onClick={() => setView(pendingCount ? [...pendingIds][0] : "overview")}>
      <CanvasIcon name="wallet" size={18} />
      {pendingCount > 0 && <span className="cw-spend-dot" aria-hidden="true" />}
    </TooltipButton>
    {shown && <SpendDialog title={t(view === "overview" ? "spend.title" : "spend.confirmTitle")}
      focusKey={view} busy={busy} onClose={dismiss}>
      {error && <p role="alert">{error}</p>}
      {(!status || (view !== "overview" && !review)) && !error && <p role="status">{t("spend.estimating")}</p>}
      {status && <>
        {(status.legacy > 0 || status.unknown > 0) && <p>{t("spend.coverage", { count: status.legacy + status.unknown })}</p>}
        {review && <ReviewCard key={review.request.id} projectId={projectId} status={status} entry={review}
          onSettings={onSettings && (() => { dismiss(); onSettings(); })} onChange={reviewed} onBusyChange={setBusy} />}
        {view === "overview" ? <>
          <SpendBalances status={status} />
          {pendingCount > 0 && <div className="cw-spend-actions"><button onClick={() => setView([...pendingIds][0])}>
            {t("spend.pending", {count: pendingCount})}</button></div>}
          <details><summary>{t("spend.controls")}</summary><PolicyForm key={JSON.stringify(status.policy)} projectId={projectId} status={status} /></details>
          <details><summary>{t("spend.log")}</summary>
            {(status.workflows ?? []).map(run => <p key={run.id}>{t("spend.workflowProgress", {
              completed: run.completed, total: run.total, state: t(`spend.workflowState.${run.state}`),
            })}{run.skipped > 0 && <> · {t("spend.skippedSteps", {count: run.skipped})}</>}</p>)}
            {status.since && <small>{t("spend.since", { date: new Date(status.since).toLocaleString(locale) })}</small>}
            <ul className="cw-spend-lines">{[...(snapshot?.spendCalls ?? [])].reverse().map(call => <li key={call.id}>
              <span>{t(`spend.operation.${call.line.operation}` as "spend.operation.image")} · {call.line.modelId} · {t(`spend.state.${call.state}`)}</span>
              <small>{t("spend.estimateAmount")} {call.line.amount ?? t("spend.unknown")} {call.line.price?.currency}
                {call.calculated != null && <> · {t("spend.calculated")} {call.calculated}</>}
                {call.usage != null && call.usageSource && call.line.price && <> · {t(`spend.usage.${call.usageSource}`)} {call.usage} {t(`spend.unit.${call.line.price.unit}`)}</>}
                {call.reported != null && <> · {t("spend.reported")} {call.reported}</>}
              </small>
            </li>)}</ul>
          </details>
        </> : <button type="button" className="cw-spend-overview" disabled={busy} onClick={() => {
          pendingIds.forEach(id => seen.current.add(id)); setView("overview");
        }}>{t("spend.overview")}</button>}
      </>}
    </SpendDialog>}
  </div>;
}

export function ModelPriceEditor({ model, refresh }: { model: ModelConfig; refresh: () => Promise<unknown> }) {
  const t = useT();
  const [unit, setUnit] = useState<ConnectionPrice["unit"]>(model.price?.unit ?? "request");
  const [currency, setCurrency] = useState<ConnectionPrice["currency"]>(model.price?.currency ?? "USD");
  const [rate, setRate] = useState(model.price?.rate ?? "");
  const [message, setMessage] = useState("");
  return <form className="cw-spend-form" onSubmit={async event => {
    event.preventDefault();
    try {
      await request(`/model-configs/${model.id}/price`, json("PUT", rate ? { currency, unit, rate } : null));
      await refresh(); setMessage(t("spend.saved"));
    } catch (failure) { setMessage(errorMessage(failure)); }
  }}>
    <strong>{model.modelId}</strong>
    <label>{t("spend.price")} <input type="number" min="0" step="any" placeholder={t("spend.automatic")} value={rate} onChange={e => setRate(e.target.value)} /></label>
    <label>{t("spend.currency")} <select value={currency} onChange={e => setCurrency(e.target.value as ConnectionPrice["currency"])}><option>USD</option><option>CNY</option></select></label>
    <label>{t("spend.unit")} <select value={unit} onChange={e => setUnit(e.target.value as ConnectionPrice["unit"])}>
      {(["request", "input_character", "input_second", "requested_second", "output_second"] as const).map(key =>
        <option key={key} value={key}>{t(`spend.unit.${key}`)}</option>)}
    </select></label>
    <button>{t("spend.save")}</button>{message && <small role="status">{message}</small>}
  </form>;
}
