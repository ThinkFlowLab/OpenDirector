import {
  ApiError,
  errorMessage,
  json,
  request,
  sessionId,
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

function keepAlive() {
  if (heartbeat !== undefined) return;
  heartbeat = window.setInterval(() => {
    if (active && !opening) {
      const projectId = active;
      // A pending renewal must finish before an explicit close or project switch.
      void serializeSessionChange(() =>
        storageRequest(
          `/creation/sessions/${sessionId}`,
          json("PUT", { projectId }),
        ),
      ).catch(() => {});
    }
  }, 15000);
  window.addEventListener("pagehide", () => {
    if (!active) return;
    void closeProjectSession(true).catch(() => {});
  });
}

function closeProjectSession(keepalive = false) {
  return request(`/creation/sessions/${sessionId}`, {
    method: "DELETE",
    keepalive,
  });
}

function serializeSessionChange<T>(operation: () => Promise<T>): Promise<T> {
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
    if (active !== id)
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
    const switching = previous && previous !== id;
    if (switching) {
      await closeProjectSession();
      active = null;
    }
    let value: T;
    try {
      value = await activate();
    } catch (failure) {
      if (switching) {
        try {
          await request(`/creation/projects/${previous}/open`, {
            method: "POST",
          });
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

/** Opening again renews a lease that lapsed while the page was suspended. */
export function openBackendProject(documentId: string, _title: string) {
  const id = backendProjectId(documentId);
  return activateBackendProject(id, async () => {
    await request(`/creation/projects/${id}/open`, { method: "POST" });
    return id;
  });
}

/** Longest canvas read that can rely on the lease it acquired at the start.
 *
 * The server grants a 60 s lease, and heartbeat renewal is suppressed while a
 * read owns the session-change queue. A media-heavy read can stream for longer
 * than that (one asset read is bounded at 120 s per attempt), so a read that
 * outlived this window renews the lease before adoption. */
const LEASE_RECONFIRM_MS = 30_000;

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
    const startedAt = Date.now();
    let value: T;
    try {
      value = await read();
      if (Date.now() - startedAt >= LEASE_RECONFIRM_MS)
        // Hydration kept the normal heartbeat from running. Renewing here keeps
        // the lease alive when it outlived the 60 s grant; if another window has
        // taken over the expired lease the server rejects this renewal and the
        // open fails instead of adopting a session we no longer own.
        await request(`/creation/sessions/${sessionId}`, json("PUT", { projectId: id }));
    } catch (failure) {
      // read() moves this window's session before it finishes the view. A
      // failure after that acceptance would leave the lease on `id` while
      // `active` is still `previous`, so the old canvas's next save is
      // rejected until a heartbeat. Move the session back, as a failed switch
      // does. A renewal rejected because another window took `id` restores
      // `previous` without taking `id` back.
      if (previous && previous !== id) {
        try {
          await request(`/creation/projects/${previous}/open`, {
            method: "POST",
          });
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
