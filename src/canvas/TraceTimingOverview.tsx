import { memo, useEffect, useMemo, useRef } from "react";
import { useT } from "../i18n/I18nProvider";
import { barPercent, buildTimingOverview, statusBadgeClass, type OverviewRow } from "./traceTimingOverview.ts";
import { formatTurnDuration, TURN_STATUS_KEYS } from "./turnTiming.ts";
import type { ConversationTurn } from "./traceTurns.ts";

const OverviewItem = memo(function OverviewItem({ row, selected, onSelect }: {
  row: OverviewRow; selected: boolean; onSelect: (id: string) => void;
}) {
  const t = useT();
  const status = row.status ? t(TURN_STATUS_KEYS[row.status]) : t("trace.turn.duration.unavailable");
  // A running turn has only its status badge: no bar and no duration text.
  const duration = row.kind === "running" ? ""
    : formatTurnDuration(row.durationMs) ?? t("trace.turn.duration.unavailable");
  const label = [t("trace.overview.select", { number: row.number }), status,
    row.kind === "timed" ? duration : row.kind === "unavailable" ? t("trace.turn.duration.unavailable") : "",
    row.slowest ? t("trace.overview.slowest") : "", row.zero ? t("trace.overview.zero") : ""]
    .filter(Boolean).join(", ");
  return (
    <li>
      <button type="button" data-turn-id={row.id} className={`cw-trace-overview-row${row.slowest ? " is-slowest" : ""}`}
        aria-pressed={selected} aria-label={label} onClick={() => onSelect(row.id)}>
        <span className="cw-trace-overview-number">{row.number}</span>
        <span className={`cw-trace-badge ${statusBadgeClass(row.status)}`} aria-hidden="true">{status}</span>
        <span className="cw-trace-overview-track" aria-hidden="true">
          {row.fraction !== null && !row.zero && (
            <span className="cw-trace-overview-bar" style={{ width: `${barPercent(row.fraction)}%` }} />
          )}
          {row.zero && <span className="cw-trace-overview-zero" />}
        </span>
        <span className="cw-trace-overview-value" aria-hidden="true">
          {duration}{row.slowest && <span className="cw-trace-overview-flag"> ▲</span>}
        </span>
      </button>
    </li>
  );
});

export default function TraceTimingOverview({ turns, selected, onSelect }: {
  turns: ConversationTurn[]; selected: string | null; onSelect: (id: string) => void;
}) {
  const t = useT();
  const overview = useMemo(() => buildTimingOverview(turns), [turns]);
  const list = useRef<HTMLOListElement>(null);
  // Keep the selected row visible by moving only the list's own scrollTop, never the page.
  useEffect(() => {
    const box = list.current;
    if (!box || selected === null) return;
    const row = Array.from(box.querySelectorAll<HTMLElement>("[data-turn-id]")).find((el) => el.dataset.turnId === selected);
    if (!row) return;
    const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const bottom = row.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom;
    if (top < 0) box.scrollTop += top;
    else if (bottom > 0) box.scrollTop += bottom;
  }, [selected, overview]);
  if (overview.rows.length === 0) return null;
  return (
    <section className="cw-trace-overview" aria-label={t("trace.overview.title")}>
      <h2>{t("trace.overview.title")}</h2>
      {!overview.hasTiming && <p role="status">{t("trace.overview.noData")}</p>}
      <ol ref={list} className="cw-trace-overview-list">
        {overview.rows.map((row) => (
          <OverviewItem key={row.id} row={row} selected={row.id === selected} onSelect={onSelect} />
        ))}
      </ol>
    </section>
  );
}
