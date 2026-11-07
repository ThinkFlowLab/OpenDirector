import { request } from "./api.ts";
import type { VoiceLibraryCapabilities } from "./rules.ts";

export type VoiceSource = "builtin" | "uploaded" | "custom";

export interface Voice {
  id: string;
  name: string;
  provider: "moss" | "vllm-omni";
  source: VoiceSource;
  createdAt?: number | null;
  deletable: boolean;
  hasReference: boolean;
  description?: string | null;
  metadata?: Record<string, string>;
}

export interface VoicePage {
  voices: Voice[];
  hasMore: boolean;
  nextCursor?: string | null;
  capabilities: VoiceLibraryCapabilities;
}

export interface VoiceCreateInput {
  file: File;
  name: string;
  consent?: string;
  refText?: string;
  speakerDescription?: string;
}

export function listVoices(
  configId: string,
  options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
) {
  const query = new URLSearchParams();
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.limit) query.set("limit", String(options.limit));
  const suffix = query.toString();
  return request<VoicePage>(
    `/model-configs/${encodeURIComponent(configId)}/voices${suffix ? `?${suffix}` : ""}`,
    { signal: options.signal },
  );
}

export function createVoice(configId: string, value: VoiceCreateInput) {
  const form = new FormData();
  form.set("audio_sample", value.file, value.file.name);
  if (value.name.trim()) form.set("name", value.name.trim());
  if (value.consent?.trim()) form.set("consent", value.consent.trim());
  if (value.refText?.trim()) form.set("ref_text", value.refText.trim());
  if (value.speakerDescription?.trim())
    form.set("speaker_description", value.speakerDescription.trim());
  return request<Voice>(
    `/model-configs/${encodeURIComponent(configId)}/voices`,
    { method: "POST", body: form },
  );
}

export function deleteVoice(configId: string, voiceId: string) {
  return request<void>(
    `/model-configs/${encodeURIComponent(configId)}/voices/${encodeURIComponent(voiceId)}`,
    { method: "DELETE" },
  );
}
