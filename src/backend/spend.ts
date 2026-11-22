import { json, request } from "./api.ts";
import { creationPath } from "./creationClient.ts";
import type { SpendPolicy, SpendQuote, SpendRequest } from "../contracts/generated.ts";

export interface QuoteView {
  quote: SpendQuote;
  fingerprint: string;
  currency: SpendPolicy["currency"];
  amount: string | null;
  projectAfter: string | null;
}

export interface PendingSpend {
  request: SpendRequest;
  fingerprint: string;
  reason: "ready" | "confirmation" | "unknown_confirmation" | "unpriced" | "over_cap";
  amount: string | null;
  shortfall: string | null;
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
}

export function spendQuery<T>(projectId: string, type: "spend.status" | "generation.quote", fields = {}, signal?: AbortSignal) {
  return request<T>(creationPath(projectId) + "/queries", {
    ...json("POST", { type, projectId, queryId: crypto.randomUUID(), ...fields }), signal,
  });
}
