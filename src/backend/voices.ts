import { request } from "./api.ts";

import type {
  VoiceLibraryCapabilities,
  VoiceSelection,
} from "../contracts/generated.ts";
export type { VoiceSelection } from "../contracts/generated.ts";
export type VoiceCapabilities = VoiceLibraryCapabilities;

export interface VoiceRecord extends VoiceSelection {
  source: "builtin" | "uploaded";
  previewUrl: string | null;
  metadata: Record<string, string>;
  compatible: boolean;
  incompatibility: string | null;
  canDelete: boolean;
}
export interface VoiceLibraryData {
  connectionId: string;
  capabilities: VoiceCapabilities;
  voices: VoiceRecord[];
  nextCursor?: string | null;
}
export const voiceSelection = (voice: VoiceRecord): VoiceSelection => ({
  connectionId: voice.connectionId,
  voiceId: voice.voiceId,
  name: voice.name,
  source: voice.source,
  hasReferenceAudio: voice.hasReferenceAudio,
  embeddingDim: voice.embeddingDim,
  refText: voice.refText,
});
export function voiceIssue(
  selection: VoiceSelection | undefined,
  capabilities: VoiceCapabilities | null | undefined,
) {
  if (selection && selection.connectionId !== capabilities?.connectionId)
    return "voiceLibrary.connectionChanged";
  if (
    capabilities?.supportsUploadedVoices === false &&
    selection?.source === "uploaded"
  )
    return "voiceLibrary.modelUnsupported";
  const matchingEmbedding =
    selection?.source === "uploaded" &&
    capabilities?.referenceEmbeddingDimension != null &&
    selection.embeddingDim === capabilities.referenceEmbeddingDimension;
  if (selection?.source === "uploaded" && !selection.hasReferenceAudio && !matchingEmbedding && !capabilities?.requiresReferenceAudio)
    return "voiceLibrary.modelUnsupported";
  if (
    capabilities?.requiresReferenceAudio &&
    !selection?.hasReferenceAudio &&
    !matchingEmbedding
  )
    return "voiceLibrary.referenceRequired";
  if (
    capabilities?.requiresTranscript &&
    selection?.source === "uploaded" &&
    !selection.refText?.trim()
  )
    return "voiceLibrary.transcriptRequired";
  return null;
}
export function listVoices(
  modelConfigId: string,
  signal?: AbortSignal,
  page?: { connectionId: string; after?: string },
) {
  const query = new URLSearchParams({ modelConfigId });
  if (page) {
    query.set("pageSize", "150");
    query.set("connectionId", page.connectionId);
    if (page.after) query.set("after", page.after);
  }
  return request<VoiceLibraryData>(`/voices?${query}`, { signal });
}
export function createVoice(
  modelConfigId: string,
  file: File,
  fields: {
    connectionId: string;
    name: string;
    consent: string;
    refText: string;
    speakerDescription: string;
  },
) {
  const body = new FormData();
  body.set("audio_sample", file);
  body.set("name", fields.name);
  body.set("connectionId", fields.connectionId);
  if (fields.consent) body.set("consent", fields.consent);
  if (fields.refText) body.set("refText", fields.refText);
  if (fields.speakerDescription) body.set("speakerDescription", fields.speakerDescription);
  return request<VoiceRecord>(`/voices?${new URLSearchParams({ modelConfigId })}`, {
    method: "POST",
    body,
  });
}
export const deleteVoice = (modelConfigId: string, voice: VoiceRecord) =>
  request<void>(
    `/voices/${encodeURIComponent(voice.voiceId)}?${new URLSearchParams({ modelConfigId, connectionId: voice.connectionId })}`,
    { method: "DELETE" },
  );
