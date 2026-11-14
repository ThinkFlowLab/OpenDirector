import { isGenerationSettings } from "./dataBoundary.ts";
import {
  appendServiceResults,
  applyGenerationResults,
  type GenerationResultMode,
  type ResultSource,
  type ServiceResult,
} from "./linkedResults.ts";
import { tNow } from "../i18n/messages.ts";
import type {
  CanvasDocument,
  CanvasEdge,
  GenerationSettings,
} from "./model.ts";
import { applyTextGenerationResult } from "./textGeneration.ts";
import type { CanvasToolTask } from "./toolCatalog.ts";

export interface GenerationJob {
  id: string;
  /** Authoritative execution revision, when supplied by the service ledger. */
  revision?: number;
  nodeId: string;
  title: string;
  status:
    | "draft"
    | "imported"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  time: string;
  createdAt?: number;
  finishedAt?: number;
  durationKey?: string;
  outputKind?: "text" | "image" | "video" | "audio";
  activityPhase?: import("./generationActivity.ts").GenerationPhase;
  message?: string;
  /** Service-reported reason for a failed or interrupted execution. */
  failure?: string;
  taskId?: string;
  serviceTask?: {
    protocol?: string | null;
    externalTaskId?: string | null;
    recovery?: string | null;
    resumeAllowed?: boolean;
    cancelRequested?: boolean;
    remoteCancellation?:
      | "not_requested"
      | "requested"
      | "confirmed"
      | "unknown";
  };
  /** Frozen placement owner, retained so a reopened canvas fills the same node. */
  resultSource?: ResultSource;
  resultMode?: GenerationResultMode;
  request?: {
    kind: "image" | "video" | "audio";
    title: string;
    prompt: string;
    settings: GenerationSettings;
  };
  outputs?: ServiceResult[];
  /** Rebuildable unified history preview; independent of execution status. */
  preview?: { assetId: string; state: "pending" | "ready" | "unavailable" };
  /** The AI tool request behind a tool task, so a reopened canvas can follow it. */
  tool?: CanvasToolTask;
  /** The pending result node a tool task fills, linked from its source. */
  targetNodeId?: string;
  targetKind?: "image" | "video" | "audio";
  targetTitle?: string;
  /** Execution and placement facts read from the independent tool ledger. */
  toolTask?: {
    canCancel?: boolean;
    cancelRequested?: boolean;
    localState?: "active" | "stopping" | "stopped";
    remoteCancellation?: string;
    placement: "pending" | "placed" | "unplaced";
    sourceFingerprint?: string;
    outputIds: string[];
    unavailable?: boolean;
  };
}

/** Project tool progress and older results from execution records. Saved
 * provenance takes precedence, and hidden/missing endpoints stay hidden. */
export function toolProvenanceEdges(
  jobs: readonly GenerationJob[],
  document: CanvasDocument,
): CanvasEdge[] {
  const visible = new Map(document.nodes.map((node) => [node.id, node]));
  const projected = new Set<string>();
  const edges: CanvasEdge[] = [];
  for (const job of jobs) {
    if (!(job.toolTask || job.tool) || !visible.has(job.nodeId)) continue;
    const targets = job.status === "succeeded" ? (job.toolTask?.outputIds ?? []) : [];
    const target = job.targetNodeId && visible.get(job.targetNodeId);
    if (
      target &&
      (job.status === "running" ||
        (job.toolTask &&
          ["failed", "interrupted", "cancelled"].includes(job.status) &&
          !target.data.src))
    )
      targets.push(target.id);
    for (const id of targets) {
      if (
        !visible.has(id) ||
        projected.has(id) ||
        document.edges.some((edge) => edge.source === job.nodeId && edge.target === id)
      ) continue;
      projected.add(id);
      edges.push({
        id: `tool-${id}`,
        source: job.nodeId,
        target: id,
        intent: "post_edit_result",
      });
    }
  }
  return edges;
}

export function parseGenerationJob(value: unknown): GenerationJob {
  if (!value || typeof value !== "object")
    throw new Error(tNow("errors.history.invalidFormat"));
  const raw = value as GenerationJob;
  if (
    ![raw.id, raw.nodeId, raw.title, raw.time].every(
      (v) => typeof v === "string",
    ) ||
    ![
      "draft",
      "imported",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(raw.status) ||
    (raw.createdAt !== undefined && !Number.isFinite(raw.createdAt)) ||
    [raw.message, raw.taskId, raw.targetNodeId].some(
      (v) => v !== undefined && typeof v !== "string",
    )
  )
    throw new Error(tNow("errors.history.invalidField"));
  if (
    raw.serviceTask !== undefined &&
    (!raw.serviceTask ||
      typeof raw.serviceTask !== "object" ||
      [
        raw.serviceTask.protocol,
        raw.serviceTask.externalTaskId,
        raw.serviceTask.recovery,
      ].some((v) => v != null && typeof v !== "string") ||
      (raw.serviceTask.resumeAllowed !== undefined &&
        typeof raw.serviceTask.resumeAllowed !== "boolean"))
  )
    throw new Error(tNow("errors.history.invalidResume"));
  if (
    (raw.resultMode !== undefined &&
      !["replace", "additional"].includes(raw.resultMode)) ||
    (raw.resultSource !== undefined &&
      (!raw.resultSource ||
        typeof raw.resultSource.documentId !== "string" ||
        raw.resultSource.nodeId !== raw.nodeId ||
        !["text", "image", "video", "audio"].includes(raw.resultSource.kind) ||
        (raw.resultSource.src !== undefined &&
          typeof raw.resultSource.src !== "string") ||
        (raw.resultSource.text !== undefined &&
          typeof raw.resultSource.text !== "string") ||
        (raw.resultSource.referenceInputs !== undefined &&
          (!raw.resultSource.referenceInputs ||
            typeof raw.resultSource.referenceInputs !== "object" ||
            Array.isArray(raw.resultSource.referenceInputs) ||
            !Object.entries(raw.resultSource.referenceInputs).every(
              ([id, value]) => id.length > 0 && typeof value === "string",
            )))))
  )
    throw new Error(tNow("errors.history.invalidOwner"));
  if (
    raw.request &&
    (!isGenerationSettings(raw.request.settings) ||
      !["image", "video", "audio"].includes(raw.request.kind) ||
      typeof raw.request.title !== "string" ||
      typeof raw.request.prompt !== "string")
  )
    throw new Error(tNow("errors.history.invalidRequest"));
  if (
    raw.outputs &&
    (!Array.isArray(raw.outputs) ||
      raw.outputs.some(
        (item) =>
          !item ||
          typeof item.title !== "string" ||
          (item.kind === "text"
            ? typeof item.text !== "string"
            : !["image", "video", "audio"].includes(item.kind) ||
              typeof item.src !== "string" ||
              item.src.startsWith("blob:")),
      ))
  )
    throw new Error(tNow("errors.history.noMedia"));
  return structuredClone(raw);
}

/** A persisted interrupted run is reconciled without creating jobs for unrelated server tasks. */
export function reconcileGenerationJobs(
  jobs: GenerationJob[],
  tasks: ({
    id: string;
    status: string;
    error: string | null;
  } & GenerationJob["serviceTask"])[],
): GenerationJob[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return jobs.map((job) => {
    const task = job.taskId ? byId.get(job.taskId) : undefined;
    if (!task) return job;
    const serviceTask = {
      protocol: task.protocol,
      externalTaskId: task.externalTaskId,
      recovery: task.recovery,
      resumeAllowed: task.resumeAllowed,
    };
    const updated =
      JSON.stringify(job.serviceTask) === JSON.stringify(serviceTask)
        ? job
        : { ...job, serviceTask };
    if (
      ["queued", "running"].includes(task.status) &&
      !job.outputs?.length &&
      job.status !== "succeeded"
    ) {
      const message =
        task.status === "queued"
          ? tNow("errors.history.waiting")
          : tNow("errors.history.querying");
      return { ...updated, status: "running", message };
    }
    if (!["failed", "cancelled", "interrupted"].includes(task.status))
      return updated;
    const status = task.status as "failed" | "cancelled" | "interrupted";
    const message =
      task.error ||
      (status === "cancelled"
        ? tNow("errors.history.cancelled")
        : status === "interrupted"
          ? tNow("errors.history.interrupted")
          : tNow("errors.history.failed"));
    return job.status === status && job.message === message
      ? updated
      : { ...updated, status, message };
  });
}

/** These actions continue or stop existing jobs; they never repeat submission. */
export function generationTaskActions(job: GenerationJob) {
  if (job.tool)
    return {
      recover: false,
      cancel:
        !!job.taskId &&
        (job.toolTask?.canCancel ?? job.status === "running") &&
        !job.toolTask?.cancelRequested,
    };
  const remote =
    !!job.taskId &&
    ["interrupted", "failed"].includes(job.status) &&
    job.serviceTask?.protocol === "vllm_omni" &&
    !!job.serviceTask.externalTaskId;
  return {
    recover:
      remote &&
      job.serviceTask?.resumeAllowed === true &&
      ["remote", "download", "local"].includes(job.serviceTask.recovery ?? ""),
    cancel: remote && job.serviceTask?.recovery === "remote",
  };
}

/** Current in-memory changes win over a persisted snapshot read earlier. */
export function mergeGenerationJobs(
  saved: readonly GenerationJob[],
  current: readonly GenerationJob[],
): GenerationJob[] {
  return [
    ...new Map([...saved, ...current].map((job) => [job.id, job])).values(),
  ].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Live completion and recovery share the same ownership and replacement policy. */
export function applyRecoveredGenerationResults(
  document: CanvasDocument,
  outputs: readonly { taskId: string; output: ServiceResult }[],
  jobs: readonly GenerationJob[],
) {
  const byTask = new Map(
    jobs.filter((job) => job.taskId).map((job) => [job.taskId!, job]),
  );
  let next = document;
  const placements = outputs.map(({ taskId, output }) => {
    const job = byTask.get(taskId);
    const result: { document: CanvasDocument; ids: string[]; error?: string } =
      job?.resultSource
        ? output.kind === "text"
          ? applyTextGenerationResult(next, job.resultSource, output)
          : applyGenerationResults(
              next,
              job.resultSource,
              [output],
              job.resultMode,
            )
        : appendServiceResults(next, [output]);
    next = result.document;
    return {
      taskId,
      output,
      ids: result.ids,
      error: result.error,
    };
  });
  return {
    document: next,
    placements,
    ids: placements.flatMap((entry) => entry.ids),
  };
}
