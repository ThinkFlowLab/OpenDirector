import type { VoiceRecord } from "../backend/voices.ts";

/** Favorites are UI preferences, scoped to the backend's opaque service identity. */
const key = (connectionId: string) =>
  `opendirector.voiceFavorites.v1:${connectionId}`;
export function readVoiceFavorites(connectionId: string): Set<string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(key(connectionId)) ?? "[]",
    );
    return new Set(
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}
export function saveVoiceFavorites(
  connectionId: string,
  favorites: Set<string>,
) {
  try {
    localStorage.setItem(key(connectionId), JSON.stringify([...favorites]));
  } catch {
    /* Still usable for this session if browser preference storage is unavailable. */
  }
}

const recordsKey = (connectionId: string, modelConfigId: string) =>
  `opendirector.voiceFavoriteRecords.v1:${JSON.stringify([connectionId, modelConfigId])}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isLocalVoicePreview(
  value: string,
  voiceId: string,
  connectionId: string,
  modelConfigId: string,
) {
  if (!value.startsWith("/api/voices/")) return false;
  try {
    const url = new URL(value, "http://localhost");
    const path = /^\/api\/voices\/([^/]+)\/preview$/.exec(url.pathname);
    return Boolean(
      path &&
      decodeURIComponent(path[1]) === voiceId &&
      !url.hash &&
      url.searchParams.size === 2 &&
      url.searchParams.get("connectionId") === connectionId &&
      url.searchParams.get("modelConfigId") === modelConfigId,
    );
  } catch {
    return false;
  }
}

function parseFavoriteRecord(
  value: unknown,
  connectionId: string,
  modelConfigId: string,
): VoiceRecord | null {
  if (!isRecord(value) || value.connectionId !== connectionId) return null;
  const {
    voiceId,
    name,
    source,
    hasReferenceAudio,
    embeddingDim,
    refText,
    previewUrl,
    metadata,
    compatible,
    incompatibility,
    canDelete,
  } = value;
  if (
    typeof voiceId !== "string" ||
    !voiceId ||
    typeof name !== "string" ||
    !name ||
    (source !== "builtin" && source !== "uploaded") ||
    typeof hasReferenceAudio !== "boolean" ||
    (embeddingDim !== null &&
      (typeof embeddingDim !== "number" ||
        !Number.isInteger(embeddingDim) ||
        embeddingDim <= 0 ||
        embeddingDim > 65_536)) ||
    (refText !== null && typeof refText !== "string") ||
    (previewUrl !== null &&
      (typeof previewUrl !== "string" ||
        !isLocalVoicePreview(
          previewUrl,
          voiceId,
          connectionId,
          modelConfigId,
        ))) ||
    !isStringRecord(metadata) ||
    typeof compatible !== "boolean" ||
    (incompatibility !== null && typeof incompatibility !== "string") ||
    typeof canDelete !== "boolean"
  )
    return null;
  return {
    connectionId,
    voiceId,
    name,
    source,
    hasReferenceAudio,
    embeddingDim,
    refText,
    previewUrl,
    metadata,
    compatible,
    incompatibility,
    canDelete,
  };
}

export function readVoiceFavoriteRecords(
  connectionId: string,
  modelConfigId: string,
): Map<string, VoiceRecord> {
  const records = new Map<string, VoiceRecord>();
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(recordsKey(connectionId, modelConfigId)) ?? "[]",
    );
    if (Array.isArray(value)) {
      for (const row of value) {
        const record = parseFavoriteRecord(row, connectionId, modelConfigId);
        if (record) records.set(record.voiceId, record);
      }
    }
  } catch {
    /* Corrupt or unavailable storage just leaves the favorite IDs to resolve. */
  }
  return records;
}

export function saveVoiceFavoriteRecords(
  connectionId: string,
  modelConfigId: string,
  records: ReadonlyMap<string, VoiceRecord>,
): void {
  try {
    const value = [...records].flatMap(([identity, row]) => {
      const record = parseFavoriteRecord(row, connectionId, modelConfigId);
      return record?.voiceId === identity ? [record] : [];
    });
    const storageKey = recordsKey(connectionId, modelConfigId);
    if (value.length) localStorage.setItem(storageKey, JSON.stringify(value));
    else localStorage.removeItem(storageKey);
  } catch {
    /* Still usable for this session if browser preference storage is unavailable. */
  }
}
