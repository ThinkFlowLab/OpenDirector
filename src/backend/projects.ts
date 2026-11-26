import { getEditingState, installEditingState } from "./editSession.ts";
import {
  ApiError,
  errorMessage,
  json,
  request,
  sessionId,
  setLeaseRecovery,
  storageRequest,
} from "./api.ts";
import { creationClient } from "./creationClient.ts";
import { tNow } from "../i18n/messages.ts";

/** Canvas documents use the stable identity of an existing filesystem project. */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function backendProjectId(documentId: string) {
  if (UUID.test(documentId)) return documentId.toLowerCase();
  throw new ApiError(tNow("errors.backend.projectRequired"), 409, "invalid_project");
}

let active: string | null = null;
let opening: Promise<unknown> | null = null;
let heartbeat: number | undefined;

/** A renewal that has not answered by then is abandoned. Renewals run one at a
 * time in the session-change queue, so a request stuck on a dropped connection
 * would otherwise hold back every later renewal until the 60 s lease lapsed. */
export const RENEWAL_TIMEOUT_MS = 10_000;

function renewLease(projectId: string) {
  return storageRequest(`/creation/sessions/${sessionId}`, {
    ...json("PUT", { projectId }),
    signal: AbortSignal.timeout(RENEWAL_TIMEOUT_MS),
  });
}

// A write rejected for a lapsed lease renews the visible project's lease and is
// resent once. Only the active project is renewed: a stale editor must never
// move the lease back to a project this page has left. The renewal runs in the
// session-change queue, like the heartbeat, so it cannot land after a queued
// close or switch has released the project. Writes rejected together share one
// renewal. No queued operation issues a lease-checked write, so this cannot
// wait on itself.
let recovering: { projectId: string; renewed: Promise<boolean> } | null = null;
setLeaseRecovery((projectId) => {
  if (recovering?.projectId === projectId) return recovering.renewed;
  const renewed = serializeSessionChange(async () => {
    if (active !== projectId || getEditingState(projectId) !== undefined) return false;
    await renewLease(projectId);
    return active === projectId;
  });
  const current = { projectId, renewed };
  recovering = current;
  void renewed
    .finally(() => {
      if (recovering === current) recovering = null;
    })
    .catch(() => {});
  return renewed;
});

function keepAlive() {
  if (heartbeat !== undefined) return;
  heartbeat = window.setInterval(() => {
    if (active && !opening && getEditingState(active) === undefined) {
      const projectId = active;
      // A pending renewal must finish before an explicit close or project switch.
      void serializeSessionChange(async () => {
        if (active !== projectId || getEditingState(projectId) !== undefined) return;
        await renewLease(projectId);
      }).catch(() => {});
    }
  }, 15000);
}

function closeProjectSession() {
  return request(`/creation/sessions/${sessionId}`, { method: "DELETE" });
}

export function serializeSessionChange<T>(operation: () => Promise<T>): Promise<T> {
  const task = (opening ?? Promise.resolve()).catch(() => {}).then(operation);
  opening = task;
  return task.finally(() => {
    if (opening === task) opening = null;
  });
}

/** Previews use the visible project's lease; they must never reactivate an old
 * editor's project after a queued navigation or cancellation. */
export function requireActiveBackendProject(
  documentId: string,
  signal: AbortSignal,
) {
  const id = backendProjectId(documentId);
  return serializeSessionChange(async () => {
    signal.throwIfAborted();
    if (active !== id || getEditingState(id)?.mode === "preview")
      throw new DOMException(tNow("errors.backend.selectionAborted"), "AbortError");
    return id;
  });
}

/** Both creating and opening a project move the server's single session lease. */
function activateBackendProject<T>(
  documentId: string,
  activate: () => Promise<T>,
) {
  const id = backendProjectId(documentId);
  return serializeSessionChange(async () => {
    const previous = active;
    const previousMode = previous ? getEditingState(previous) : undefined;
    const switching = previous && previous !== id;
    if (switching) {
      await closeProjectSession();
      active = null;
    }
    let value: T;
    try {
      value = await activate();
    } catch (failure) {
      if (switching && previousMode?.mode === "preview") active = previous;
      if (switching && previousMode?.mode !== "preview") {
        try {
          await openEditingProject(previous);
          active = previous;
        } catch (restoreFailure) {
          throw new Error(
            tNow("errors.backend.openFailed", {
              error: errorMessage(failure),
              restore: errorMessage(restoreFailure),
            }),
          );
        }
      }
      throw failure;
    }
    active = id;
    if (previous && previous !== id) creationClient(previous).close();
    keepAlive();
    return value;
  });
}

function openEditingProject(projectId: string) {
  return request(`/creation/projects/${projectId}/open`, {
    method: "POST",
    headers: { "X-OpenDirector-Persistent": "true" },
  });
}

export function openBackendProject(documentId: string, _title: string) {
  const id = backendProjectId(documentId);
  return activateBackendProject(id, async () => {
    await openEditingProject(id);
    installEditingState(id, { mode: "edit" });
    return id;
  });
}

/** Read a canvas and adopt the session lease that read acquires.
 *
 * `CreationClient.open()` reads through POST /open-canvas, which moves this
 * window's single session lease to the project. Releasing the session and
 * opening it again would transfer and validate the same snapshot a second time
 * for no lease benefit. The read runs inside the session-change queue so a
 * pending heartbeat renewal cannot move the lease back while a large canvas is
 * still loading. Callers that have not read a snapshot must keep using
 * openBackendProject. */
export function openBackendProjectCanvas<T>(
  documentId: string,
  read: () => Promise<T>,
) {
  const id = backendProjectId(documentId);
  return serializeSessionChange(async () => {
    const previous = active;
    const previousMode = previous ? getEditingState(previous) : undefined;
    let value: T;
    try {
      value = await read();
    } catch (failure) {
      // read() moves this window's session before it finishes the view. A
      // failure after that acceptance would leave the lease on `id` while
      // `active` is still `previous`, so the old canvas's next save is
      // rejected until a heartbeat. Move the session back, as a failed switch
      // does. A renewal rejected because another window took `id` restores
      // `previous` without taking `id` back.
      if (previous && previous !== id && previousMode?.mode === "preview") {
        await closeProjectSession();
        installEditingState(previous, previousMode);
      } else if (previous && previous !== id) {
        try {
          await openEditingProject(previous);
        } catch (restoreFailure) {
          throw new Error(
            tNow("errors.backend.openFailed", {
              error: errorMessage(failure),
              restore: errorMessage(restoreFailure),
            }),
          );
        }
      }
      throw failure;
    }
    // The successful read already holds the lease for `id`.
    active = id;
    if (previous && previous !== id) creationClient(previous).close();
    keepAlive();
    return value;
  });
}

/** Pause lease renewal while the current project directory is renamed. */
export function releaseBackendProject() {
  return serializeSessionChange(async () => {
    await closeProjectSession();
    active = null;
  });
}

/** The project this window currently leases, if any. */
export function activeBackendProjectId() {
  return active;
}
