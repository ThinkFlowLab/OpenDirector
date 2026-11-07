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
