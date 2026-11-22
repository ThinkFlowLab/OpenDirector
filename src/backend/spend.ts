import { json, request } from "./api.ts";
import { creationPath } from "./creationClient.ts";
import type { SpendPolicy, SpendQuote, SpendRequest } from "../contracts/generated.ts";

export interface QuoteView {
  quote: SpendQuote;
  fingerprint: string;
  currency: SpendPolicy["currency"];
  amount: string | null;
  projectAfter: string | null;
  subtotals: Record<string, string>;
}

export interface PendingSpend {
  request: SpendRequest;
  fingerprint: string;
  reason: "ready" | "stale" | "upstream_confirmation" | "confirmation" | "unknown_confirmation" | "unpriced" | "prior_unknown" | "over_cap";
  amount: string | null;
  shortfall: string | null;
  subtotals: Record<string, string>;
}

export interface SpendStatus {
  policy: SpendPolicy;
  held: string;
  settled: string;
  available: string | null;
  unknown: number;
  legacy: number;
  since: string | null;
  projectRevision: number;
  pending: PendingSpend[];
  workflows: { id: string; items: string[]; state: "waiting" | "running" | "cancelled" | "completed" | "incomplete"; completed: number; failed: number; skipped: number; total: number }[];
  turn?: { callCount: number; settled: string; held: string; unknown: number };
}

export function spendQuery<T>(projectId: string, type: "spend.status" | "generation.quote" | "generation.groupQuote", fields = {}, signal?: AbortSignal) {
  return request<T>(creationPath(projectId) + "/queries", {
    ...json("POST", { type, projectId, queryId: crypto.randomUUID(), ...fields }), signal,
  });
}
