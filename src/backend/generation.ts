import { assetBlob, json, request } from "./api.ts";
import { openBackendProject } from "./projects.ts";
import type { BackendVideoMode, ModelConfig } from "./rules.ts";

/** Generation through the local API: references become current project
 * assets, each submission gets its own generation node, and results are
 * read back as files. Earlier results therefore stay valid continuation
 * sources for the H3 service. */

export interface BackendAsset {
  id: string;
  kind: "text" | "image" | "video" | "audio" | "other";
  name: string;
  type: string;
  fingerprint: string;
  fingerprintAliases?: string[];
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  agentRunId?: string | null;
  generationTaskId?: string | null;
}

export interface BackendTask {
  id: string;
  nodeId: string;
  kind: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  phase?: string | null;
  assetId: string | null;
  error: string | null;
  title?: string;
  createdAt?: string;
  productionPlanId?: string | null;
}

interface CanvasSnapshot {
  assets: BackendAsset[];
  tasks: BackendTask[];
}

export interface ReferenceInput {
  kind: "image" | "video" | "audio" | "text";
  title: string;
  src?: string;
  text?: string;
}

export interface GenerationRequest {
  documentId: string;
  documentTitle: string;
  config: ModelConfig;
  kind: "image" | "video" | "audio";
  prompt: string;
  title: string;
  videoMode: BackendVideoMode;
  durationSeconds?: number;
  aspectRatio?: string;
  voice?: string;
  references: readonly ReferenceInput[];
}

export interface BackendResult {
  kind: "image" | "video" | "audio";
  file: File;
  media: { width?: number; height?: number; durationSeconds?: number };
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

function fileName(title: string, extension: string) {
  const base =
    title
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .trim()
      .slice(0, 80) || "素材";
  return `${base}.${extension}`;
}

async function fingerprint(blob: Blob) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return (
    "sha256:" +
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function placeOnCanvas(
  projectId: string,
  kind: string,
  assetId: string,
  signal: AbortSignal,
) {
  await request(`/projects/${projectId}/canvas/nodes`, {
    ...json("POST", { id: crypto.randomUUID(), kind, assetId }),
    signal,
  });
}

/** Reuse an identical current asset (such as an earlier H3 result), else upload one. */
export async function uploadReferences(
  projectId: string,
  references: readonly ReferenceInput[],
  signal: AbortSignal,
) {
  if (!references.length) return [];
  const current = await request<BackendAsset[]>(
    `/projects/${projectId}/assets?current_only=true`,
    { signal },
  );
  const ids: string[] = [];
  for (const reference of references) {
    signal.throwIfAborted();
    if (reference.kind === "text") {
      const asset = await request<BackendAsset>(
        `/projects/${projectId}/assets/text`,
        {
          ...json("POST", {
            id: crypto.randomUUID(),
            name: fileName(reference.title, "md"),
            text: reference.text ?? "",
          }),
          signal,
        },
      );
      await placeOnCanvas(projectId, "text", asset.id, signal);
      ids.push(asset.id);
      continue;
    }
    const response = await fetch(reference.src!, { signal });
    if (!response.ok)
      throw new Error(
        `无法读取参考素材：${reference.title}（${response.status}）`,
      );
    const blob = await response.blob();
    const print = await fingerprint(blob);
    const existing = current.find(
      (asset) =>
        asset.kind === reference.kind &&
        (asset.fingerprint === print ||
          asset.fingerprintAliases?.includes(print)),
    );
    if (existing) {
      if (!ids.includes(existing.id)) ids.push(existing.id);
      continue;
    }
    const type = blob.type.split(";")[0] ?? "";
    const asset = await request<BackendAsset>(
      `/projects/${projectId}/assets/${crypto.randomUUID()}`,
      {
        method: "PUT",
        signal,
        headers: {
          "X-Asset-Name": encodeURIComponent(
            fileName(
              reference.title,
              EXTENSIONS[type] ?? type.split("/")[1] ?? "bin",
            ),
          ),
          "Content-Type": "application/octet-stream",
        },
        body: blob,
      },
    );
    await placeOnCanvas(projectId, reference.kind, asset.id, signal);
    current.push(asset);
    ids.push(asset.id);
  }
  return ids;
}

export async function submitGeneration(
  value: GenerationRequest,
  signal: AbortSignal,
) {
  const projectId = await openBackendProject(
    value.documentId,
    value.documentTitle,
  );
  const referenceIds = await uploadReferences(
    projectId,
    value.references,
    signal,
  );
  signal.throwIfAborted();
  const node = await request<{ id: string; revision: number }>(
    `/projects/${projectId}/canvas/nodes`,
    json("POST", { id: crypto.randomUUID(), kind: value.kind }),
  );
  const task = await request<BackendTask>(
    `/projects/${projectId}/canvas/nodes/${node.id}/generate`,
    json("POST", {
      id: crypto.randomUUID(),
      modelConfigId: value.config.id,
      expectedRevision: node.revision,
      inputs: {
        prompt: value.prompt,
        title: value.title.slice(0, 255),
        referenceIds,
        videoMode: value.videoMode,
        ...(value.kind === "video"
          ? {
              durationSeconds: value.durationSeconds,
              aspectRatio: value.aspectRatio,
            }
          : {}),
        ...(value.kind === "audio" && value.voice
          ? { voice: value.voice }
          : {}),
      },
    }),
  );
  return { projectId, taskId: task.id };
}

export async function cancelGeneration(projectId: string, taskId: string) {
  await request(`/projects/${projectId}/tasks/${taskId}/cancel`, {
    method: "POST",
  });
}

export function projectSnapshot(projectId: string, signal?: AbortSignal) {
  return request<CanvasSnapshot>(`/projects/${projectId}/canvas`, { signal });
}

export async function downloadAsset(
  projectId: string,
  asset: BackendAsset,
  signal?: AbortSignal,
): Promise<BackendResult | null> {
  if (!["image", "video", "audio"].includes(asset.kind)) return null;
  const blob = await assetBlob(projectId, asset.id, signal);
  return {
    kind: asset.kind as BackendResult["kind"],
    file: new File([blob], asset.name, { type: asset.type || blob.type }),
    media: {
      ...(asset.width ? { width: asset.width } : {}),
      ...(asset.height ? { height: asset.height } : {}),
      ...(asset.durationMs ? { durationSeconds: asset.durationMs / 1000 } : {}),
    },
  };
}

/** Resolves after the delay; the abort listener never outlives the wait. */
export const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancel);
  });

const FAILED = new Set(["failed", "cancelled", "interrupted"]);

export async function waitForResult(
  projectId: string,
  taskId: string,
  signal: AbortSignal,
  onProgress?: (task: BackendTask) => void,
): Promise<BackendResult> {
  for (;;) {
    const snapshot = await projectSnapshot(projectId, signal);
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("生成任务不存在，可能已被项目外的操作移除。");
    if (task.status === "succeeded" && task.assetId) {
      onProgress?.(task);
      const asset = snapshot.assets.find((item) => item.id === task.assetId);
      const result = asset && (await downloadAsset(projectId, asset, signal));
      if (!result) throw new Error("生成结果不是图片、视频或音频文件。");
      return result;
    }
    if (FAILED.has(task.status))
      throw new Error(
        task.error ??
          (task.status === "cancelled" ? "任务已取消。" : "生成未完成。"),
      );
    onProgress?.(task);
    await wait(3000, signal);
  }
}
