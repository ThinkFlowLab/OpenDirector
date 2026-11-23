/** Display fields for the Jobs a Turn submitted, shown on the Trace page. */
import type { AssetRef, GenerationFailure } from "../contracts/generated.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import { generationFailureMessage } from "./generationFailureText.ts";

export type TurnJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

/** One item of GET /assistant/turns/{turn}/jobs. */
export type TurnJob = {
  jobId: string;
  callId: string;
  commandId: string;
  status: TurnJobStatus;
  phase?: string | null;
  recovery?: string | null;
  resumeAllowed?: boolean;
  cancelRequested?: boolean;
  remoteCancellation?: string | null;
  errorDetails: GenerationFailure | null;
  asset: AssetRef | null;
  adopted: boolean;
};

const STATUS_KEYS: Record<TurnJobStatus, MessageKey> = {
  queued: "trace.jobs.status.queued",
  running: "trace.jobs.status.running",
  succeeded: "trace.jobs.status.succeeded",
  failed: "trace.jobs.status.failed",
  cancelled: "trace.jobs.status.cancelled",
  interrupted: "trace.jobs.status.interrupted",
};

export type TurnJobView = {
  key: string;
  status: TurnJobStatus;
  statusText: string;
  assetText: string | null;
  errorText: string | null;
  adoptedText: string | null;
  cancelText: string | null;
};

export function turnJobView(job: TurnJob, t: Translate): TurnJobView {
  const status = job.status in STATUS_KEYS ? job.status : "failed";
  return {
    key: job.jobId,
    status,
    statusText: t(STATUS_KEYS[status]),
    assetText: job.asset
      ? t("trace.jobs.asset", { kind: job.asset.kind, assetId: job.asset.assetId, revision: job.asset.revision })
      : null,
    errorText: job.errorDetails ? generationFailureMessage(job.errorDetails, t) : null,
    adoptedText: job.asset ? t(job.adopted ? "trace.jobs.adopted" : "trace.jobs.notAdopted") : null,
    cancelText: job.cancelRequested && status !== "cancelled" ? t("trace.jobs.cancelRequested") : null,
  };
}

/** Parse a jobs response; any failure yields no jobs so the trace is unaffected. */
export async function readTurnJobs(response: Pick<Response, "ok" | "json">): Promise<TurnJob[]> {
  if (!response.ok) return [];
  try {
    const body: unknown = await response.json();
    return Array.isArray(body) ? body.filter((job) => job && typeof job.jobId === "string") : [];
  } catch {
    return [];
  }
}
