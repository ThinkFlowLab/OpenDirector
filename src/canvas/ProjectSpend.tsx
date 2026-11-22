import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { errorMessage, json, request } from "../backend/api.ts";
import { creationClient, objectVersion } from "../backend/creationClient.ts";
import type { ModelConfig } from "../backend/rules.ts";
import { spendQuery, type PendingSpend, type QuoteView, type SpendStatus } from "../backend/spend.ts";
import type { ConnectionPrice, SpendPolicy, SpendQuote } from "../contracts/generated.ts";
import { useI18n, useT } from "../i18n/I18nProvider";
import "./project-spend.css";

function useSnapshot(projectId: string) {
  const client = creationClient(projectId);
  const subscribe = useCallback((notify: () => void) => client.listen(notify), [client]);
  return useSyncExternalStore(subscribe, () => client.snapshot);
}

function money(value: string, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "code", maximumFractionDigits: 12 }).format(Number(value));
}

function QuoteLines({ quote }: { quote: SpendQuote }) {
  const { t, locale } = useI18n();
  return <ul className="cw-spend-lines">{quote.lines.map((line, index) => <li key={index}>
    <span>{t(`spend.operation.${line.operation}` as "spend.operation.image")} · {line.modelId}</span>
    <span>{line.price && line.amount != null ? money(line.amount, line.price.currency, locale) : t("spend.unknown")}</span>
    {line.price && <small>{t(`spend.source.${line.source}`)} · {line.quantity ?? "?"} × {line.price.rate} {line.price.currency} / {t(`spend.unit.${line.price.unit}`)}</small>}
  </li>)}</ul>;
}

export function GenerationEstimate({ projectId, itemId, count, modelId, prompt, priceRevision }: {
  projectId: string; itemId: string; count: number; modelId: string; prompt: string; priceRevision: string;
}) {
  const { t, locale } = useI18n();
  const snapshot = useSnapshot(projectId);
  const [result, setResult] = useState<{ key: string; value: QuoteView }>();
  const item = snapshot?.canvasItems.find(i => i.id === itemId);
  const specId = item?.binding.role === "generation" ? item.binding.objectRef.id :
    item && "draftSpec" in item.binding ? item.binding.draftSpec?.id : undefined;
  const spec = snapshot?.generationSpecs.find(s => s.id === specId);
  const key = JSON.stringify([projectId, itemId, specId, snapshot?.eventCursor, count, modelId, prompt, priceRevision]);
  const matches = spec?.modelConfigId === modelId && spec.prompt === prompt;
  useEffect(() => {
    if (!specId || !matches) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void spendQuery<QuoteView>(projectId, "generation.quote", { specId, originItemId: itemId, count }, abort.signal)
        .then(value => { if (!abort.signal.aborted) setResult({ key, value }); })
        .catch(() => { if (!abort.signal.aborted) setResult(undefined); });
    }, 180);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [projectId, itemId, specId, count, matches, key]);
  if (!matches || result?.key !== key) return null;
  const { amount, currency, projectAfter, quote } = result.value;
  return <details className="cw-spend-estimate">
    <summary>{t("spend.estimate", { count, amount: amount == null ? t("spend.unknown") : money(amount, currency, locale) })}
      {projectAfter != null && <> · {t("spend.after", { amount: money(projectAfter, currency, locale) })}</>}
    </summary><QuoteLines quote={quote} />
  </details>;
}

function ReviewCard({ projectId, entry, status, onSettings, onChange }: {
  projectId: string; entry: PendingSpend; status: SpendStatus; onSettings?: () => void; onChange: () => void;
}) {
  const { t, locale } = useI18n();
  const [newCap, setNewCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { request: batch, reason } = entry;
  const currency = status.policy.currency;
  const decide = async (decision: "approve" | "cancel") => {
    setBusy(true);
    setError("");
    try {
      const raising = decision === "approve" && reason === "over_cap";
      const versions = [...(decision === "approve" ? batch.versions : []), objectVersion("spend_request", batch)];
      if (raising) versions.push({ objectType: "project", id: projectId, revision: status.projectRevision });
      await creationClient(projectId).command("spend.review", {
        requestId: batch.id, fingerprint: entry.fingerprint, decision,
        acceptUnknown: decision === "approve" && reason === "unknown_confirmation",
        ...(raising ? { newCap } : {}),
      }, versions);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); onChange(); }
  };
  return <article className="cw-spend-card" data-spend-request={batch.id}>
    <strong>{t("spend.estimate", { count: batch.quote.count, amount: entry.amount == null ? t("spend.unknown") : money(entry.amount, currency, locale) })}</strong>
    <QuoteLines quote={batch.quote} />
    {reason === "over_cap" && <>
      <p>{t("spend.shortfall", { cap: money(status.policy.cap!, currency, locale), available: money(status.available!, currency, locale), missing: money(entry.shortfall!, currency, locale) })}</p>
      <label>{t("spend.newCap")} <input type="number" step="any" min="0" value={newCap} onChange={e => setNewCap(e.target.value)} /></label>
    </>}
    {reason === "unpriced" && <p>{t("spend.needPrice")}</p>}
    <div className="cw-spend-actions">
      {reason === "unpriced" ? onSettings && <button onClick={onSettings}>{t("spend.connections")}</button> :
        <button disabled={busy || (reason === "over_cap" && !newCap)} onClick={() => void decide("approve")}>
          {t(reason === "over_cap" ? "spend.raiseRun" : reason === "unknown_confirmation" ? "spend.allowUnknown" : "spend.approve")}
        </button>}
      <button disabled={busy} onClick={() => void decide("cancel")}>{t("spend.cancel")}</button>
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

export function ProjectSpend({ projectId, placement, onSettings }: {
  projectId: string; placement: "canvas" | "chat"; onSettings?: () => void;
}) {
  const { t, locale } = useI18n();
  const snapshot = useSnapshot(projectId);
  const pendingCount = snapshot?.spendRequests?.filter(r => r.status === "pending").length ?? 0;
  const [open, setOpen] = useState(() => placement === "canvas" && new URLSearchParams(window.location.search).has("spendReview"));
  const [status, setStatus] = useState<SpendStatus>();
  const [error, setError] = useState("");
  const [revision, reload] = useState(0);
  const shown = open || (placement === "chat" && pendingCount > 0);
  useEffect(() => {
    if (!shown || !snapshot) return;
    const abort = new AbortController();
    void spendQuery<SpendStatus>(projectId, "spend.status", {}, abort.signal).then(value => {
      if (!abort.signal.aborted) { setStatus(value); setError(""); }
    }).catch(failure => { if (!abort.signal.aborted) setError(errorMessage(failure)); });
    return () => abort.abort();
  }, [shown, projectId, snapshot, revision]);
  if (placement === "chat" && !pendingCount) return null;
  return <div className={`cw-spend cw-spend-${placement}`}>
    {placement === "canvas" && <button className="cw-spend-toggle" aria-expanded={shown} onClick={() => setOpen(!open)}>
      {pendingCount ? t("spend.pending", { count: pendingCount }) : t("spend.title")}
    </button>}
    {shown && <section aria-label={t("spend.title")} className="cw-spend-panel">
      <h3>{t("spend.title")}</h3>
      {error && <p role="alert">{error}</p>}
      {status && <>
        <p>{t("spend.summary", { settled: money(status.settled, status.policy.currency, locale), held: money(status.held, status.policy.currency, locale) })}</p>
        {(status.legacy > 0 || status.unknown > 0) && <p>{t("spend.coverage", { count: status.legacy + status.unknown })}</p>}
        {status.pending.map(entry => <ReviewCard key={entry.request.id} projectId={projectId} status={status} entry={entry}
          onSettings={onSettings} onChange={() => reload(r => r + 1)} />)}
        {placement !== "chat" && <>
          <details><summary>{t("spend.controls")}</summary><PolicyForm key={JSON.stringify(status.policy)} projectId={projectId} status={status} /></details>
          <details><summary>{t("spend.log")}</summary>
            {status.since && <small>{t("spend.since", { date: new Date(status.since).toLocaleString(locale) })}</small>}
            <ul className="cw-spend-lines">{[...(snapshot?.spendCalls ?? [])].reverse().map(call => <li key={call.id}>
              <span>{call.line.modelId} · {t(`spend.state.${call.state}`)}</span>
              <small>{t("spend.estimateAmount")} {call.line.amount ?? t("spend.unknown")} {call.line.price?.currency}
                {call.calculated != null && <> · {t("spend.calculated")} {call.calculated}</>}
                {call.reported != null && <> · {t("spend.reported")} {call.reported}</>}
              </small>
            </li>)}</ul>
          </details>
        </>}
      </>}
    </section>}
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
