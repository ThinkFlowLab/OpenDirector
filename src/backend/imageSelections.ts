import { json, request } from "./api.ts";
import type { BackendAsset } from "./generation.ts";
import { requireActiveBackendProject } from "./projects.ts";
import { uploadAsset, type ToolSourceInput } from "./tools.ts";
import { tNow } from "../i18n/messages.ts";
import { fetchMediaSource } from "./creationClient.ts";

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
    const response = await fetchMediaSource(value.source.src, { signal });
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
  return request<ImageSelectionPreview>(
    `/creation/projects/${projectId}/image-selections`,
    {
      ...json("POST", {
        sourceAssetId,
        prompt: value.prompt ?? "",
        boxes: value.boxes ?? [],
      }),
      signal,
    },
  );
}
