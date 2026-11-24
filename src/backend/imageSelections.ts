import { readDelay } from "./resilientRead.ts";
import { creationClient } from "./creationClient.ts";
import { json, request } from "./api.ts";
import type { BackendAsset } from "./generation.ts";
import { requireActiveBackendProject } from "./projects.ts";
import { uploadAsset, type ToolSourceInput } from "./tools.ts";
import { tNow } from "../i18n/messages.ts";

export interface ImageSelectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageSelectionPreview {
  sourceAssetId: string;
  width: number;
  height: number;
  instances: {
    id: string;
    label: string;
    score: number;
    box: ImageSelectionBox;
    /** Source-sized white paint on transparency, directly usable as an editor mask. */
    maskDataUrl: string;
  }[];
}

export interface ImageSelectionQuery {
  documentId: string;
  documentTitle: string;
  source: ToolSourceInput & { kind: "image" };
  /** Reuse the prior preview's asset while the source image is unchanged. */
  sourceAssetId?: string;
  prompt?: string;
  boxes?: readonly ImageSelectionBox[];
}

/** The preview never creates output assets or canvas nodes. Abort when the editor
 * closes or a newer request supersedes it; the API closes its upstream request. */
export async function previewImageSelection(
  value: ImageSelectionQuery,
  signal: AbortSignal,
): Promise<ImageSelectionPreview> {
  signal.throwIfAborted();
  const projectId = await requireActiveBackendProject(value.documentId, signal);
  signal.throwIfAborted();
  let sourceAssetId = value.sourceAssetId;
  if (!sourceAssetId) {
    const response = await fetch(value.source.src, { signal });
    if (!response.ok)
      throw new Error(tNow("errors.backend.imageRead"));
    sourceAssetId = await uploadAsset(
      projectId,
      await response.blob(),
      value.source.title,
      signal,
    );
  }
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const path = `/creation/projects/${projectId}/image-selections`;
  let result = await request<ImageSelectionPreview | { status: string }>(
    path,
    {
      ...json("POST", {
        id, sourceAssetId,
        prompt: value.prompt ?? "",
        boxes: value.boxes ?? [],
      }),
      signal,
    },
  );
  if ('status' in result) {
    await creationClient(projectId).refresh();
    window.dispatchEvent(new CustomEvent('opendirector:spend-review', { detail: projectId }));
  }
  while ('status' in result) {
    if (['cancelled', 'interrupted', 'expired'].includes(result.status)) throw new Error(tNow('spend.previewStopped'));
    await readDelay(750, signal);
    result = await request<ImageSelectionPreview | { status: string }>(`${path}/${id}`, {signal});
  }
  return result;
}
