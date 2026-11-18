export type WorkspaceMode = "agent" | "canvas";

export const WORKSPACE_MODE_KEY = "opendirector.workspaceMode.v1";

/** A browser preference: never part of project content or undo history. */
export function readWorkspaceMode(
  storage?: Pick<Storage, "getItem">,
): WorkspaceMode {
  try {
    return (storage ?? window.localStorage).getItem(WORKSPACE_MODE_KEY) === "agent"
      ? "agent"
      : "canvas";
  } catch {
    return "canvas";
  }
}

/** Report preference failures separately from successful in-memory switching. */
export function saveWorkspaceMode(
  mode: WorkspaceMode,
  storage?: Pick<Storage, "setItem">,
): boolean {
  try {
    (storage ?? window.localStorage).setItem(WORKSPACE_MODE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}
