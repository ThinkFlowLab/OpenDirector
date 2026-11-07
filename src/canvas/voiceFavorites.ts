type VoiceProvider = "moss" | "vllm-omni";

const KEY = "opendirector.voiceFavorites.v1";

export type VoiceFavorite = {
  connectionId: string;
  provider: VoiceProvider;
  voiceId: string;
};

function identity(value: VoiceFavorite) {
  return `${value.connectionId}\u0000${value.provider}\u0000${value.voiceId}`;
}

export function readVoiceFavorites(storage?: Pick<Storage, "getItem">): VoiceFavorite[] {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(KEY);
    if (!raw) return [];
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("connectionId" in value) ||
        !("provider" in value) ||
        !("voiceId" in value) ||
        typeof value.connectionId !== "string" ||
        !value.connectionId ||
        (value.provider !== "moss" && value.provider !== "vllm-omni") ||
        typeof value.voiceId !== "string" ||
        !value.voiceId
      )
        return [];
      return [
        {
          connectionId: value.connectionId,
          provider: value.provider,
          voiceId: value.voiceId,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function writeVoiceFavorites(
  values: VoiceFavorite[],
  storage?: Pick<Storage, "setItem">,
) {
  const unique = new Map(values.map((value) => [identity(value), value]));
  (storage ?? globalThis.localStorage).setItem(
    KEY,
    JSON.stringify([...unique.values()]),
  );
}

export function isVoiceFavorite(
  value: VoiceFavorite,
  values: readonly VoiceFavorite[],
) {
  return values.some((item) => identity(item) === identity(value));
}

export function toggleVoiceFavorite(
  value: VoiceFavorite,
  values: readonly VoiceFavorite[],
) {
  const current = identity(value);
  return values.some((item) => identity(item) === current)
    ? values.filter((item) => identity(item) !== current)
    : [...values, value];
}
