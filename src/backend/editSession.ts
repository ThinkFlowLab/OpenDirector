import { json, request } from "./api.ts";

export type EditingState =
  | { mode: "edit"; requester: string | null }
  | { mode: "preview"; handoff: "available" | "occupied" | "requested" | "busy" };

export function parseEditingState(value: unknown): EditingState {
  if (typeof value === "object" && value !== null && "mode" in value) {
    if (value.mode === "edit" && "requester" in value &&
        (value.requester === null || typeof value.requester === "string"))
      return { mode: value.mode, requester: value.requester };
    if (value.mode === "preview" && "handoff" in value &&
        (value.handoff === "available" || value.handoff === "occupied" ||
         value.handoff === "requested" || value.handoff === "busy"))
      return { mode: value.mode, handoff: value.handoff };
  }
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
  if (previous?.mode === "edit" && state.mode === "edit" && previous.requester === state.requester ||
      previous?.mode === "preview" && state.mode === "preview" && previous.handoff === state.handoff)
    return;
  current = { projectId, state };
  for (const listener of listeners) listener();
}

export async function readEditingState(projectId: string, init?: RequestInit) {
  return parseEditingState(await request<unknown>(`/creation/projects/${projectId}/edit-session`, init));
}

export const requestEditing = (projectId: string) => readEditingState(projectId, { method: "POST" });
export const resolveEditing = (projectId: string, requester: string, accept: boolean) =>
  readEditingState(projectId, json("PUT", { requester, accept }));
