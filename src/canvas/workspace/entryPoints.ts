import type { SubjectMediaSlot } from "../subjectMedia.ts";

/** Why a file picker must not open. The workspace maps these to existing toasts. */
export type UploadBlockReason = "locked" | "generation-output" | "generating";

export type UploadPickerPlan =
  | { blocked: "locked" }
  | { blocked: "generation-output" }
  | { blocked: "generating" }
  | { blocked: null; multiple: boolean; accept: string };

/**
 * Upload entry: locked nodes, generation outputs, and in-flight runs refuse a picker.
 * A subject slot narrows the accept filter; a fresh drop accepts any file.
 */
export function uploadPickerPlan(input: {
  hasTarget: boolean;
  locked: boolean;
  generating: boolean;
  nodeType?: string;
  hasSrc?: boolean;
  mediaRole?: string;
  subjectSlot?: SubjectMediaSlot;
}): UploadPickerPlan {
  if (input.hasTarget && input.locked) return { blocked: "locked" };
  if (
    input.hasSrc &&
    input.mediaRole === "generation" &&
    input.nodeType !== "text"
  )
    return { blocked: "generation-output" };
  if (input.hasTarget && input.generating) return { blocked: "generating" };
  const accept =
    input.nodeType === "text"
      ? ".txt,.md,.markdown"
      : input.nodeType === "subject"
        ? input.subjectSlot === "auxiliary"
          ? "image/*"
          : input.subjectSlot === "voice"
            ? "audio/*"
            : "image/*,video/*"
        : input.nodeType && ["image", "video", "audio"].includes(input.nodeType)
          ? `${input.nodeType}/*`
          : "";
  return { blocked: null, multiple: !input.hasTarget, accept };
}

/** Nodes selected after an import: the replaced node, else the reference target, else the created ids. */
export function importedNodeIds(input: {
  targetId: string | null;
  referenceTargetId: string | null;
  createdIds: readonly string[];
}): string[] {
  if (input.targetId) return [input.targetId];
  if (input.referenceTargetId) return [input.referenceTargetId];
  return [...input.createdIds];
}

/** Silent gates in front of a generation submit. Missing and locked look the same to the caller. */
export type GenerationPrepareBlock = "missing" | "locked" | "running";

export function generationPrepareBlock(input: {
  nodeFound: boolean;
  locked: boolean;
  alreadyRunning: boolean;
}): GenerationPrepareBlock | null {
  if (!input.nodeFound) return "missing";
  if (input.locked) return "locked";
  if (input.alreadyRunning) return "running";
  return null;
}
