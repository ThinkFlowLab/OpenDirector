/** Pure data for the Trace timing overview. Reads persisted durationMs only, never startedAt/finishedAt. */
import type { TurnStatus } from "./turnTiming.ts";

export type OverviewRowKind = "timed" | "running" | "unavailable";

export type OverviewRow = {
  /** Stable turn id; the only link to the detail element and to selection. */
  id: string;
  number: number;
  status: TurnStatus | null;
  kind: OverviewRowKind;
  /** Valid persisted duration, or null. */
  durationMs: number | null;
  /** 0..1 against the longest valid non-running turn. null when no bar is drawn. */
  fraction: number | null;
  zero: boolean;
  slowest: boolean;
};

export type TimingOverview = { rows: OverviewRow[]; hasTiming: boolean; maxMs: number | null };

/** Badge modifier for a status; unrecognised values get a neutral "unknown" class instead of a status colour. */
export const statusBadgeClass = (status: TurnStatus | null): string => `is-turn-${status ?? "unknown"}`;

/** Smallest bar width, in percent of the track, for any nonzero duration. Used by the CSS and the component. */
export const MIN_BAR_PERCENT = 2;

const STATUSES: readonly string[] = ["streaming", "complete", "stopped", "interrupted"];

const validMs = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Visible bar width in percent: linear, with a floor for nonzero durations. */
export function barPercent(fraction: number): number {
  return fraction <= 0 ? 0 : Math.max(MIN_BAR_PERCENT, fraction * 100);
}

/** Rows ordered by turn number (stable on ties). Never throws on malformed input. */
export function buildTimingOverview(turns: unknown): TimingOverview {
  const list: unknown[] = Array.isArray(turns) ? turns : [];
  const items: { id: string; number: number; status: TurnStatus | null; ms: number | null; order: number }[] = [];
  list.forEach((raw, order) => {
    if (raw === null || typeof raw !== "object") return;
    const turn = raw as Record<string, unknown>;
    if (typeof turn.id !== "string" || turn.id === "") return;
    const status = typeof turn.status === "string" && STATUSES.includes(turn.status) ? turn.status as TurnStatus : null;
    const number = typeof turn.number === "number" && Number.isFinite(turn.number) ? turn.number : Number.POSITIVE_INFINITY;
    items.push({ id: turn.id, number, status, ms: status === "streaming" ? null : validMs(turn.durationMs), order });
  });
  items.sort((a, b) => a.number === b.number ? a.order - b.order : a.number < b.number ? -1 : 1);

  const timed = items.filter((item) => item.ms !== null);
  const maxMs = timed.length ? Math.max(...timed.map((item) => item.ms as number)) : null;
  const markSlowest = timed.length >= 2 && (maxMs ?? 0) > 0;
  const rows = items.map((item): OverviewRow => {
    const base = { id: item.id, number: Number.isFinite(item.number) ? item.number : 0, status: item.status };
    if (item.status === "streaming")
      return { ...base, kind: "running", durationMs: null, fraction: null, zero: false, slowest: false };
    if (item.ms === null || maxMs === null)
      return { ...base, kind: "unavailable", durationMs: null, fraction: null, zero: false, slowest: false };
    return {
      ...base, kind: "timed", durationMs: item.ms,
      fraction: maxMs > 0 ? item.ms / maxMs : 0,
      zero: item.ms === 0,
      slowest: markSlowest && item.ms === maxMs,
    };
  });
  return { rows, hasTiming: timed.length > 0, maxMs };
}
