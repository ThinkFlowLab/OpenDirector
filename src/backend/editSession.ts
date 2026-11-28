import { request, rotateSession } from "./api.ts";

export type EditingState = { mode: "edit" | "preview" };

export function parseEditingState(value: unknown): EditingState {
  if (typeof value === "object" && value !== null && "mode" in value &&
      (value.mode === "edit" || value.mode === "preview"))
    return { mode: value.mode };
  throw new TypeError("Invalid editing session response");
}

let current: { projectId: string; state: EditingState } | undefined;
const listeners = new Set<() => void>();

export function subscribeEditingState(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getEditingState(projectId: string) {
  return current?.projectId === projectId ? current.state : undefined;
}

export function installEditingState(projectId: string, state: EditingState) {
  const previous = getEditingState(projectId);
  if (previous?.mode === state.mode) return;
  current = { projectId, state };
  for (const listener of listeners) listener();
}

export async function readEditingState(projectId: string, init?: RequestInit) {
  return parseEditingState(await request<unknown>(`/creation/projects/${projectId}/edit-session`, init));
}

export async function takeEditingOwnership(projectId: string) {
  // Each takeover uses a fresh write identity, even when returning to the same tab.
  await rotateSession();
  return readEditingState(projectId, { method: "POST", signal: AbortSignal.timeout(10000) });
}
