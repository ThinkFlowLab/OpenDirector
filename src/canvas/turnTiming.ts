/** One duration format and status label for an assistant turn, shared by Chat and the Trace page. */
import type { Translate } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";

export type TurnStatus = "streaming" | "complete" | "stopped" | "interrupted";

export const TURN_STATUS_KEYS: Record<TurnStatus, MessageKey> = {
  streaming: "trace.turn.status.streaming", complete: "trace.turn.status.complete",
  stopped: "trace.turn.status.stopped", interrupted: "trace.turn.status.interrupted",
};

/** 820 -> "820 ms", 12400 -> "12.4 s", 125000 -> "2m 5s", 3725000 -> "1h 2m". Unknown or invalid -> null. */
export function formatTurnDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole} ms`;
  const tenths = Math.round(whole / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(whole / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

/** Status word and duration of a finished turn; duration is null when it was not recorded. */
export function turnTiming(
  turn: { status: TurnStatus; durationMs?: number | null },
  t: Translate,
): { status: string; duration: string | null } {
  return {
    status: t(TURN_STATUS_KEYS[turn.status]),
    duration: turn.status === "streaming" ? null : formatTurnDuration(turn.durationMs),
  };
}

/** "Completed · 12.4 s", or null when there is nothing honest to show (running, or no recorded duration). */
export function turnTimingLabel(
  turn: { status: TurnStatus; durationMs?: number | null },
  t: Translate,
): string | null {
  const { status, duration } = turnTiming(turn, t);
  return duration === null ? null : `${status} · ${duration}`;
}

/**
 * Chat line under a reply. AssistantPanel already prints "Reply stopped" / "Reply interrupted" for those
 * statuses, so only a completed reply gets the status word; the other two show the bare duration.
 */
export function chatTurnTiming(
  turn: { status: TurnStatus; durationMs?: number | null },
  t: Translate,
): string | null {
  return turn.status === "complete" ? turnTimingLabel(turn, t) : turnTiming(turn, t).duration;
}
