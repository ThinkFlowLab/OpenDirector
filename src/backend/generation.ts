import type { ReferenceContent } from "../canvas/chatReferenceContent.ts";
import { generationFailureMessage } from "../canvas/generationFailureText.ts";
import { creationClient } from "./creationClient.ts";
import type { BackendVideoMode, ModelConfig } from "./rules.ts";
import { tNow } from "../i18n/messages.ts";

/** Shared media metadata and generation request values. Executions and control use project commands. */

export interface BackendAsset {
  id: string;
  kind: "text" | "image" | "video" | "audio" | "other";
  name: string;
  type: string;
  fingerprint: string;
  fingerprintAliases?: string[];
  size?: number;
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
  protocol?: string | null;
  externalTaskId?: string | null;
  recovery?: string | null;
  resumeAllowed?: boolean;
  assetId: string | null;
  error: string | null;
  title?: string;
  createdAt?: string;
}

export interface ReferenceInput {
  kind: "image" | "video" | "audio" | "text";
  title: string;
  nodeId?: string;
  sourceRole?: string;
  contextOnly?: boolean;
  binding?: "asset";
  assetId?: string;
  fingerprint?: string | null;
  referenceId?: string;
  src?: string;
  text?: string;
}

export interface GenerationRequest {
  documentId: string;
  documentTitle: string;
  nodeId?: string;
  promptContent?: ReferenceContent;
  batchId?: string;
  executionSlot?: number;
  config: ModelConfig;
  kind: "text" | "image" | "video" | "audio";
  thinking?: "auto" | "low" | "medium" | "high";
  maxTokens?: number;
  prompt: string;
  title: string;
  videoMode: BackendVideoMode;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  voice?: string;
  references: readonly ReferenceInput[];
}

export interface BackendResult {
  assetId?: string;
  kind: "image" | "video" | "audio";
  file: File;
  media: { width?: number; height?: number; durationSeconds?: number };
}

export const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
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

export function fileName(title: string, extension: string) {
  let base =
    title
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .trim()
      .slice(0, 80) || tNow("errors.backend.mediaFallback");
  const suffix = `.${extension}`;
  while (base.toLowerCase().endsWith(suffix.toLowerCase()))
    base = base.slice(0, -suffix.length);
  return `${base || tNow("errors.backend.mediaFallback")}${suffix}`;
}

export async function fingerprint(blob: Blob) {
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

export async function cancelGeneration(projectId: string, taskId: string) {
  await creationClient(projectId).control(taskId, "cancel");
  return;
}

/** Resume the saved task; this endpoint never creates a new generation ID. */
export async function recoverGeneration(projectId: string, taskId: string) {
  const client = creationClient(projectId);
  await client.control(taskId, "recover");
  const job = client.snapshot.jobs.find((job) => job.id === taskId)!;
  return {
    id: job.id,
    nodeId: job.originItemId ?? job.inputSnapshot.spec.id,
    kind: job.inputSnapshot.spec.kind,
    status: job.status,
    assetId: job.asset?.assetId ?? null,
    error: job.errorDetails
      ? generationFailureMessage(job.errorDetails)
      : null,
  } as BackendTask;
}
