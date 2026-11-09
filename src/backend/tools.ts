import { useCallback, useEffect, useState } from "react";
import type { GenerationJob } from "../canvas/generationHistory.ts";
import type { LinkedMediaResult } from "../canvas/linkedResults.ts";
import type {
  CanvasToolId,
  ToolCapabilities,
  ToolField,
  ToolParameters,
} from "../canvas/toolCatalog.ts";
import { CANVAS_TOOLS } from "../canvas/toolCatalog.ts";
import { ApiError, errorMessage, json, request } from "./api.ts";
import { creationClient } from "./creationClient.ts";
import {
  toolTaskError,
  toolTaskPhase,
  type ToolTaskFailure,
} from "../canvas/toolTaskText.ts";
import { toolReasonText } from "../canvas/toolReasonText.ts";
import { tNow } from "../i18n/messages.ts";
import {
  EXTENSIONS,
  fileName,
  fingerprint,
  type BackendAsset,
} from "./generation.ts";
import { openBackendProject } from "./projects.ts";
import {
  readDelay,
  resilientRead,
  transientReadFailure,
  type ReadOptions,
} from "./resilientRead.ts";
import { deliverTool } from "./toolDeliveries.ts";

/** Canvas AI tools run by the local API. The service maps each tool to model
 * capabilities, so the canvas never names a model or protocol here. */

export interface ToolCatalogEntry {
  id: CanvasToolId;
  available: boolean;
  reason?: string;
  note: string;
  parametersConfirmed: boolean;
  fields: ToolField[];
  requires: { capability: string; label: string }[];
  models: Record<string, { id: string; label: string }[]>;
}

export interface ToolTaskOutput {
  id: string;
  canvasItemId: string;
  kind: "image" | "video" | "audio";
  name: string;
  type: string;
  title: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

export interface ToolTask {
  id: string;
  tool: CanvasToolId;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  phase: string | null;
  error: string | null;
  errorDetails?: ToolTaskFailure;
  outputs: ToolTaskOutput[];
  createdAt?: string;
  finishedAt?: string | null;
  canvas?: ToolCanvasOrigin | null;
  sourceFingerprint?: string;
  sourceKind?: "image" | "video" | "audio";
  placement?: "pending" | "placed" | "unplaced";
  parameters?: ToolParameters;
  cancelRequested?: boolean;
  cancelRequestedAt?: string;
  localState?: "active" | "stopping" | "stopped";
  remoteCancellation?:
    | "not_applicable"
    | "not_required"
    | "not_requested"
    | "requested"
    | "confirmed"
    | "unsupported"
    | "unknown";
  modelCalls?: {
    externalTaskId?: string | null;
    state:
      | "submitting"
      | "running"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "unknown";
  }[];
}

/** Stopping the local execution does not confirm a provider cancellation. */
export function toolTaskMessage(task: ToolTask): string | undefined {
  if (task.cancelRequested && task.localState !== "stopped")
    return tNow("errors.tools.taskMessage.stopping");
  if (task.cancelRequested) {
    const detail =
      task.remoteCancellation === "not_applicable"
        ? tNow("errors.tools.taskMessage.notApplicable")
        : task.remoteCancellation === "not_required"
          ? tNow("errors.tools.taskMessage.notRequired")
          : task.remoteCancellation === "not_requested"
            ? tNow("errors.tools.taskMessage.notRequested")
            : task.remoteCancellation === "requested"
              ? tNow("errors.tools.taskMessage.requested")
              : task.remoteCancellation === "confirmed"
                ? tNow("errors.tools.taskMessage.confirmed")
                : task.remoteCancellation === "unsupported"
                  ? tNow("errors.tools.taskMessage.unsupported")
                  : tNow("errors.tools.taskMessage.unknown");
    return tNow("errors.tools.taskMessage.stopped", { detail });
  }
  if (task.status === "cancelled")
    return tNow("errors.tools.taskMessage.cancelledHistory");
  if (task.status === "interrupted" && task.modelCalls?.length) {
    const states = new Set(task.modelCalls.map((call) => call.state));
    const detail =
      states.has("unknown") || states.has("submitting")
        ? tNow("errors.tools.taskMessage.interruptedUnknown")
        : states.has("running")
          ? tNow("errors.tools.taskMessage.interruptedRunning")
          : tNow("errors.tools.taskMessage.interruptedEnded");
    return tNow("errors.tools.taskMessage.interrupted", { detail });
  }
  return toolTaskError(task.error, undefined, task.errorDetails);
}

export interface ToolCanvasOrigin {
  nodeId: string;
  sourceNodeIds: string[];
  targetNodeId?: string;
  targetKind?: "image" | "video" | "audio";
  targetTitle?: string;
}

export interface ToolSourceInput {
  kind: "image" | "video" | "audio";
  title: string;
  src: string;
}

export interface ToolRequest {
  id: string;
  canvas: ToolCanvasOrigin;
  documentId: string;
  documentTitle: string;
  tool: CanvasToolId;
  sources: readonly ToolSourceInput[];
  parameters: ToolParameters;
  maskDataUrl?: string;
  annotatedDataUrl?: string;
  modelConfigIds?: Record<string, string>;
  boxes?: readonly { x: number; y: number; width: number; height: number }[];
}

/** Availability and service-supplied options for every tool, refreshed with the model list. */
export function useToolCatalog(connected: boolean, revision: unknown) {
  const [tools, setTools] = useState<ToolCatalogEntry[]>([]);
  const [error, setError] = useState("");
  const [selectionPreview, setSelectionPreview] = useState<{
    available: boolean;
    reason?: string;
  }>({ available: false });
  const refresh = useCallback(async () => {
    try {
      const value = await request<{
        tools: ToolCatalogEntry[];
        selectionPreview?: { available: boolean; reason?: string };
      }>("/tools");
      setTools(
        value.tools.map((entry) => ({
          ...entry,
          reason: toolReasonText(entry.reason),
        })),
      );
      setSelectionPreview({
        ...(value.selectionPreview ?? { available: false }),
        reason: toolReasonText(value.selectionPreview?.reason),
      });
      setError("");
    } catch (failure) {
      setTools([]);
      setSelectionPreview({ available: false });
      setError(errorMessage(failure));
    }
  }, []);
  useEffect(() => {
    if (connected) void refresh();
    else {
      setTools([]);
      setSelectionPreview({ available: false });
    }
  }, [connected, revision, refresh]);
  const capabilities: ToolCapabilities = Object.fromEntries(
    tools.map((entry) => [
      entry.id,
      {
        available: entry.available,
        reason: entry.reason,
        fields: entry.fields,
        models: entry.models,
        parametersConfirmed: entry.parametersConfirmed,
      },
    ]),
  );
  return { tools, capabilities, selectionPreview, error, refresh };
}

/** Sources and masks become project assets once; identical files are reused. */
export async function uploadAsset(
  projectId: string,
  blob: Blob,
  title: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const print = await fingerprint(blob);
  signal.throwIfAborted();
  {
    const client = creationClient(projectId);
    const existing = client.snapshot.assets.find(
      (asset) => asset.fingerprint === print,
    );
    return (
      existing?.id ??
      (
        await client.importBlob(
          blob,
          fileName(title, EXTENSIONS[blob.type] ?? "png"),
          blob.type.startsWith("video/")
            ? "video"
            : blob.type.startsWith("audio/")
              ? "audio"
              : "image",
        )
      ).assetId
    );
  }
}

export class ToolSubmissionError extends Error {
  uncertain: boolean;
  constructor(message: string, uncertain: boolean) {
    super(message);
    this.uncertain = uncertain;
  }
}

export async function submitToolTask(value: ToolRequest, signal: AbortSignal) {
  let attempted = false;
  try {
    const projectId = await openBackendProject(
      value.documentId,
      value.documentTitle,
    );
    const client = creationClient(projectId);
    const owner = client?.snapshot.canvasItems.find(
      (item) => item.id === value.canvas?.nodeId,
    );
    const editorRef =
      owner && "editors" in owner
        ? owner.editors.find((ref) => ref.kind === "media_edit")
        : undefined;
    const editor =
      editorRef &&
      client?.snapshot.editorDocuments.find((doc) => doc.id === editorRef.id);
    if (client && (!owner || !editor || editor.kind !== "media_edit"))
      throw new Error(tNow("errors.tools.saveBeforeSubmit"));
    const draft =
      owner && editor
        ? {
            itemId: owner.id,
            itemRevision: owner.revision,
            editorId: editor.id,
            editorRevision: editor.revision,
          }
        : undefined;
    const sourceAssetIds: string[] =
      editor?.kind === "media_edit"
        ? editor.data.sources.map((ref) => ref.assetId)
        : [];
    const maskAssetId =
      editor?.kind === "media_edit"
        ? editor.data.selection?.mask?.assetId
        : value.maskDataUrl
          ? await uploadAsset(
              projectId,
              await (await fetch(value.maskDataUrl, { signal })).blob(),
              tNow("errors.tools.selectionAsset"),
              signal,
            )
          : undefined;
    const annotationAssetId = value.annotatedDataUrl
      ? await uploadAsset(
          projectId,
          await (await fetch(value.annotatedDataUrl, { signal })).blob(),
          tNow("errors.tools.annotationAsset"),
          signal,
        )
      : undefined;
    signal.throwIfAborted();
    attempted = true;
    const body = {
      id: value.id,
      ...(draft ? { draft } : {}),
      canvas: value.canvas,
      tool: value.tool,
      sourceAssetIds,
      ...(maskAssetId ? { maskAssetId } : {}),
      ...(annotationAssetId ? { annotationAssetId } : {}),
      ...(value.modelConfigIds ? { modelConfigIds: value.modelConfigIds } : {}),
      boxes: value.boxes ?? [],
      parameters: value.parameters,
    };
    const task = await deliverTool<ToolTask>(projectId, owner!.id, body);
    if (signal.aborted) {
      // Acceptance may race a click on Cancel. Once the identity is known,
      // cancel the accepted task too; aborting a browser request is not enough.
      await cancelToolTask(projectId, task.id);
      attempted = false; // Cancellation was confirmed by the service.
      signal.throwIfAborted();
    }
    return { projectId, taskId: task.id };
  } catch (failure) {
    const rejected =
      failure instanceof ApiError &&
      failure.status !== null &&
      failure.status >= 400 &&
      failure.status < 500;
    throw new ToolSubmissionError(
      errorMessage(failure),
      attempted && !rejected,
    );
  }
}

export const toolTaskPath = (projectId: string) =>
  `/creation/projects/${projectId}/tool-tasks`;

export const getToolTask = (
  projectId: string,
  taskId: string,
  signal?: AbortSignal,
) => request<ToolTask>(`${toolTaskPath(projectId)}/${taskId}`, { signal });

export const acknowledgeToolPlacement = (
  projectId: string,
  taskId: string,
  state: "placed" | "unplaced",
  policy: "if_current" | "explicit" = "if_current",
) =>
  request<ToolTask>(
    `${toolTaskPath(projectId)}/${taskId}/placement`,
    json("POST", { state, policy }),
  );

export function cancelToolTask(projectId: string, taskId: string) {
  return request<ToolTask>(`${toolTaskPath(projectId)}/${taskId}/cancel`, {
    method: "POST",
  });
}

export interface ToolReadOptions {
  signal?: AbortSignal;
  timeouts?: { status: number; download: number };
  retryDelayMs?: number;
}

const TIMEOUTS = { status: 15_000, download: 120_000 };
const downloadOptions = (options: ToolReadOptions): ReadOptions => ({
  signal: options.signal,
  timeoutMs: (options.timeouts ?? TIMEOUTS).download,
  attempts: 3,
  retryDelayMs: options.retryDelayMs,
});

/** Polls until the task ends; resolves with downloadable result files. */
export async function waitForToolTask(
  projectId: string,
  taskId: string,
  signal: AbortSignal,
  onProgress?: (task: ToolTask) => void,
  timeouts = TIMEOUTS,
) {
  for (;;) {
    const task = await resilientRead(
      (attempt) => getToolTask(projectId, taskId, attempt),
      { signal, timeoutMs: timeouts.status },
    );
    onProgress?.(task);
    if (task.status === "succeeded")
      return Promise.all(
        task.outputs.map(async (output) => ({
          output,
          file: new File(
            [
              await toolBlob(
                projectId,
                output.id,
                downloadOptions({ signal, timeouts }),
              ),
            ],
            output.name,
            { type: output.type },
          ),
        })),
      );
    if (!["queued", "running"].includes(task.status))
      throw new Error(
        toolTaskMessage(task) ??
          (task.status === "cancelled"
            ? tNow("errors.tools.taskCancelled")
            : tNow("errors.tools.taskIncomplete")),
      );
    await readDelay(2000, signal);
  }
}

function toolBlob(projectId: string, assetId: string, options: ReadOptions) {
  return creationClient(projectId).blob(assetId, options);
}

async function toolOutput(
  projectId: string,
  output: ToolTaskOutput,
  options: ToolReadOptions,
) {
  options.signal?.throwIfAborted();
  return {
    kind: output.kind,
    title: output.title,
    src: await creationClient(projectId).mediaUrl(
      output.id,
      downloadOptions(options),
    ),
    mimeType: output.type,
    media: {
      width: output.width ?? undefined,
      height: output.height ?? undefined,
      durationSeconds: output.durationMs ? output.durationMs / 1000 : undefined,
    },
  };
}

/** Tool execution lives on the service. Browser job
 * records are used only to recover ownership of tasks from older clients. */
export async function toolHistoryJobs(
  projectId: string,
  previous: readonly GenerationJob[] = [],
  options: ToolReadOptions = {},
) {
  const { tasks } = await resilientRead(
    (signal) =>
      request<{ tasks: ToolTask[] }>(toolTaskPath(projectId), { signal }),
    {
      signal: options.signal,
      timeoutMs: (options.timeouts ?? TIMEOUTS).status,
      retryDelayMs: options.retryDelayMs,
    },
  );
  return Promise.all(
    tasks.map(async (task) => {
      const old = previous.find((job) => job.tool && job.taskId === task.id);
      const canvas: ToolCanvasOrigin | undefined =
        task.canvas ??
        (old?.tool
          ? { nodeId: old.nodeId, sourceNodeIds: old.tool.sourceNodeIds }
          : undefined);
      const definition = CANVAS_TOOLS.find((tool) => tool.id === task.tool);
      let outputs: LinkedMediaResult[] = [];
      let unavailable = false;
      let outputFailure: unknown;
      try {
        outputs = await Promise.all(
          task.outputs.map((output) => toolOutput(projectId, output, options)),
        );
      } catch (failure) {
        if (options.signal?.aborted) throw failure;
        unavailable = true;
        outputFailure = failure;
      }
      const job = {
        id: task.id,
        taskId: task.id,
        nodeId: canvas?.nodeId ?? task.id,
        targetNodeId: canvas?.targetNodeId,
        targetKind: canvas?.targetKind,
        targetTitle: canvas?.targetTitle,
        title: definition?.title ?? task.tool,
        time: "",
        createdAt: task.createdAt ? Date.parse(task.createdAt) : old?.createdAt,
        finishedAt: task.finishedAt ? Date.parse(task.finishedAt) : undefined,
        durationKey: `tool:${task.tool}`,
        status: task.status === "queued" ? "running" : task.status,
        message:
          toolTaskMessage(task) ??
          (unavailable
            ? transientReadFailure(outputFailure)
              ? tNow("errors.tools.resultRetry")
              : outputFailure instanceof ApiError &&
                  [404, 410].includes(outputFailure.status ?? 0)
                ? tNow("errors.tools.resultMissing")
                : tNow("errors.tools.resultReadFailed", {
                    error: errorMessage(outputFailure),
                  })
            : (toolTaskPhase(task.phase) ??
              (task.placement === "placed"
                ? tNow("errors.tools.addedToCanvas")
                : task.placement === "unplaced"
                  ? tNow("errors.tools.sourceChanged")
                  : tNow("errors.tools.waitingForCanvas")))),
        outputs,
        tool: {
          version: 1,
          tool: task.tool,
          parameters: task.parameters ?? old?.tool?.parameters ?? {},
          sourceNodeIds: canvas?.sourceNodeIds ?? [],
        },
        resultSource: canvas
          ? {
              documentId: projectId,
              nodeId: canvas.nodeId,
              kind:
                task.sourceKind ??
                old?.resultSource?.kind ??
                definition?.sources[0] ??
                "image",
            }
          : undefined,
        toolTask: {
          canCancel:
            !task.cancelRequested &&
            (["queued", "running"].includes(task.status) ||
              !!task.modelCalls?.some(
                (call) =>
                  call.externalTaskId &&
                  ["running", "unknown"].includes(call.state),
              )),
          cancelRequested: task.cancelRequested,
          localState: task.localState,
          remoteCancellation: task.remoteCancellation,
          placement: task.placement ?? "pending",
          sourceFingerprint: task.sourceFingerprint,
          outputIds: task.outputs.map((output) => output.canvasItemId),
          unavailable,
        },
      } satisfies GenerationJob;
      // Preserve stable rows between polls, including their media URLs. Idle
      // history queries should not invalidate canvas memoization during drags.
      return old?.toolTask &&
        old.targetNodeId === job.targetNodeId &&
        old.targetKind === job.targetKind &&
        old.targetTitle === job.targetTitle &&
        old.createdAt === job.createdAt &&
        old.finishedAt === job.finishedAt &&
        old.status === job.status &&
        old.message === job.message &&
        old.toolTask.placement === job.toolTask.placement &&
        old.toolTask.canCancel === job.toolTask.canCancel &&
        old.toolTask.cancelRequested === job.toolTask.cancelRequested &&
        old.toolTask.localState === job.toolTask.localState &&
        old.toolTask.remoteCancellation === job.toolTask.remoteCancellation &&
        old.toolTask.sourceFingerprint === job.toolTask.sourceFingerprint &&
        old.toolTask.unavailable === job.toolTask.unavailable &&
        old.toolTask.outputIds.join() === job.toolTask.outputIds.join() &&
        old.outputs?.length === outputs.length &&
        old.outputs.every(
          (output, index) =>
            output.kind !== "text" && output.src === outputs[index]?.src,
        )
        ? old
        : job;
    }),
  );
}
