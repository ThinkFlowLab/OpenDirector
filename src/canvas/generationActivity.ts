import type { BackendTask } from "../backend/generation.ts";
import type { GenerationJob } from "./generationHistory.ts";
import type { CanvasNode } from "./model.ts";
import { expectedDuration } from "./generationDurations.ts";

/** Display ownership may differ from the source retained by task/history APIs. */
export function jobActivities(
  jobs: readonly GenerationJob[],
  documentId: string,
  nodes: readonly CanvasNode[] = [],
): ActiveGeneration[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return jobs.flatMap((job) => {
    // A node keeps its old media, or shows an empty frame, until the new result
    // has loaded; stay busy until then. Locally edited text has content but no
    // backend asset, and is not waiting for anything.
    const node = byId.get(job.nodeId);
    const shown = node?.data.backendAssetId;
    const empty = Boolean(node && !node.data.src && !node.data.text);
    const delivering = Boolean(
      job.status === "succeeded" &&
      job.deliveredAssetId &&
      (shown ? shown !== job.deliveredAssetId : empty),
    );
    const finishing = delivering || Boolean(
      job.toolTask &&
      job.status === "succeeded" &&
      job.toolTask.placement === "pending",
    );
    if (job.status !== "running" && !finishing) return [];
    const kind =
      job.targetKind ??
      job.outputKind ??
      job.resultSource?.kind ??
      job.request?.kind ??
      "image";
    return [
      {
        documentId,
        nodeId: job.targetNodeId ?? job.nodeId,
        startedAt: job.createdAt,
        expectedMs: expectedDuration(
          job.durationKey ?? `tool:${job.tool?.tool}`,
          kind,
        ),
        phase: finishing
          ? ("finishing" as const)
          : (job.activityPhase ??
            (job.taskId ? ("generating" as const) : ("preparing" as const))),
      },
    ];
  });
}

/** Transient task activity, never part of the saved canvas or undo history. */
export type GenerationPhase =
  | "preparing"
  | "submitting"
  | "queued"
  | "generating"
  | "finishing";

import type { MessageKey } from "../i18n/types.ts";

export const GENERATION_LABELS: Record<GenerationPhase, MessageKey> = {
  preparing: "generation.activity.preparing",
  submitting: "generation.activity.submitting",
  queued: "generation.activity.queued",
  generating: "generation.activity.generating",
  finishing: "generation.activity.finishing",
};

export interface ActiveGeneration {
  documentId: string;
  nodeId: string;
  phase: GenerationPhase;
  /** Wall-clock start and expected duration, for the estimated progress ring. */
  startedAt?: number;
  expectedMs?: number;
}

export interface NodeGenerationActivity {
  phase: GenerationPhase;
  count: number;
  startedAt?: number;
  expectedMs?: number;
}

export function generationPhase(
  task: Pick<BackendTask, "status" | "phase">,
): GenerationPhase | null {
  if (task.status === "queued") return "queued";
  if (task.status !== "running") return null;
  switch (task.phase) {
    case "queued":
      return "queued";
    case "prepare":
      return "preparing";
    case "submit":
      return "submitting";
    case "download":
    case "check":
    case "save":
    case "adopt":
      return "finishing";
    default:
      return "generating";
  }
}

const PRIORITY: Record<GenerationPhase, number> = {
  queued: 0,
  finishing: 1,
  preparing: 2,
  submitting: 3,
  generating: 4,
};

/** One batch may have tasks in different phases. Show active work until every
 * task finishes; a queued sibling must not turn a running node back into a queue. */
export function generationActivities(
  runs: readonly ActiveGeneration[],
  documentId: string,
): ReadonlyMap<string, NodeGenerationActivity> {
  const nodes = new Map<string, NodeGenerationActivity>();
  for (const run of runs) {
    if (run.documentId !== documentId) continue;
    const previous = nodes.get(run.nodeId);
    // Several runs on one node finish together: the earliest start, the longest expectation.
    const startedAt = [previous?.startedAt, run.startedAt].filter(
      (value): value is number => value !== undefined,
    );
    const expectedMs = [previous?.expectedMs, run.expectedMs].filter(
      (value): value is number => value !== undefined,
    );
    nodes.set(run.nodeId, {
      count: (previous?.count ?? 0) + 1,
      phase:
        previous && PRIORITY[previous.phase] > PRIORITY[run.phase]
          ? previous.phase
          : run.phase,
      ...(startedAt.length && expectedMs.length
        ? {
            startedAt: Math.min(...startedAt),
            expectedMs: Math.max(...expectedMs),
          }
        : {}),
    });
  }
  return nodes;
}
