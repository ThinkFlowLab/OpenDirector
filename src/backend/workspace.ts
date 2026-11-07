import { type CanvasDocument } from "../canvas/model.ts";
import type {
  CommandReceipt,
  ProjectSnapshot,
} from "../contracts/generated.ts";
import { ApiError, json, request } from "./api.ts";
import {
  CreationCommandError,
  creationClient,
  creationPath,
  objectVersion,
  visibleItems,
} from "./creationClient.ts";
import { tNow } from "../i18n/messages.ts";
import { CreationProjection } from "./creationProjection.ts";
import {
  activeBackendProjectId,
  openBackendProject,
  openBackendProjectCanvas,
  releaseBackendProject,
} from "./projects.ts";
import {
  cachedRequest,
  invalidateCached,
  peekCached,
  prefetchRequest,
} from "./requestCache.ts";

const projections = new Map<string, CreationProjection>();
export function workspaceProjection(id: string) {
  let projection = projections.get(id);
  if (!projection) {
    projection = new CreationProjection(creationClient(id));
    projections.set(id, projection);
  }
  return projection;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  path: string;
}
export interface UnreadableWorkspaceProject {
  id: string | null;
  name: string;
  path: string;
  reason: string;
}
export interface WorkspaceProjectList {
  projects: WorkspaceProject[];
  unreadable: UnreadableWorkspaceProject[];
  warnings: string[];
}
export interface WorkspaceCleanupResult {
  removed: string[];
  failed: { name: string; message: string }[];
}
const lastKey = "opendirector.lastUnifiedFilesystemProject";
/** The project selector opens and closes often; the list is cheap to reuse. */
const PROJECTS_KEY = "workspace:projects";

export const listWorkspaceProjects = (read: { fresh?: boolean } = {}) =>
  cachedRequest<WorkspaceProjectList>(
    PROJECTS_KEY,
    () => request<WorkspaceProjectList>("/creation/projects"),
    read,
  );

/** Rows already fetched for this page, for a selector that opens instantly. */
export const peekWorkspaceProjects = () =>
  peekCached<WorkspaceProjectList>(PROJECTS_KEY);

export function prefetchWorkspaceProjects() {
  prefetchRequest(PROJECTS_KEY, () =>
    request<WorkspaceProjectList>("/creation/projects"),
  );
}

export const cleanupUnreadableWorkspaceProjects = () =>
  request<WorkspaceCleanupResult>("/creation/projects/cleanup", {
    method: "POST",
  });

/** Whether removing a project lands in the operating system recycle bin. */
export const projectDeleteMode = () =>
  request<{ projectDelete: "recycle_bin" | "permanent" }>("/creation/storage");

export async function readWorkspaceDocument(project: WorkspaceProject) {
  return workspaceProjection(project.id).open();
}

export async function openWorkspaceProject(project: WorkspaceProject) {
  // Read first: invalid content cannot take the lease away from the old project.
  // The read itself acquires the session lease, so no second open is needed.
  const document = await openBackendProjectCanvas(project.id, () =>
    readWorkspaceDocument(project),
  );
  try {
    localStorage.setItem(lastKey, project.id);
  } catch {
    /* UI hint only. */
  }
  return document;
}

export async function saveWorkspaceDocument(
  document: CanvasDocument,
  options: { saveView?: boolean } = {},
) {
  const changed = await workspaceProjection(document.id).save(
    document,
    options,
  );
  if (changed)
    creationClient(document.id).install(creationClient(document.id).snapshot);
  return;
}

export async function createWorkspaceProject(name: string, id: string) {
  // Unified creation does not acquire a lease; projection.open does that.
  await creationClient(id).command("project.create", { name });
  invalidateCached(PROJECTS_KEY);
  return (await listWorkspaceProjects()).projects.find(
    (project) => project.id === id,
  )!;
}

async function populateWorkspaceProject(
  project: WorkspaceProject,
  document: CanvasDocument,
) {
  await openWorkspaceProject(project);
  const imported = { ...document, id: project.id, title: project.name };
  await saveWorkspaceDocument(imported);
  return imported;
}

/** JSON imports become independent filesystem projects. */
export async function importWorkspaceDocument(document: CanvasDocument) {
  const { projects } = await listWorkspaceProjects();
  const occupied = new Set(
    projects.map((project) => project.name.toLocaleLowerCase()),
  );
  const base =
    document.title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .trim()
      .replace(/[. ]+$/, "")
      .slice(0, 80) || tNow("errors.backend.importCanvas");
  let name = base,
    suffix = 2;
  while (occupied.has(name.toLocaleLowerCase())) name = `${base} (${suffix++})`;
  const project = await createWorkspaceProject(name, crypto.randomUUID());
  return populateWorkspaceProject(project, document);
}

const exampleOpenings = new Map<string, Promise<CanvasDocument>>();

/** Reopen the user's example edits; generate the initial media only once. */
export function openExampleWorkspaceProject(
  name: string,
  createExample: () => Promise<CanvasDocument>,
): Promise<CanvasDocument> {
  const opening = exampleOpenings.get(name);
  if (opening) return opening;
  const pending = (async () => {
    const key = `opendirector.exampleWorkspaceProject:${name}`;
    let preferred: string | undefined;
    try {
      preferred = localStorage.getItem(key) ?? undefined;
    } catch {
      /* Optional navigation hint; project contents stay on the server. */
    }
    const { projects, unreadable } = await listWorkspaceProjects({
      fresh: true,
    });
    const existing =
      projects.find((project) => project.id === preferred) ??
      projects.find((project) => project.name === name);
    const remember = (document: CanvasDocument) => {
      try {
        localStorage.setItem(key, document.id);
      } catch {
        /* Reopening by the original name still works without local storage. */
      }
      return document;
    };
    if (existing) {
      const saved = await request<ProjectSnapshot>(creationPath(existing.id));
      if (visibleItems(saved).size === 0) {
        return remember(await importWorkspaceDocument(await createExample()));
      }
      return remember(await openWorkspaceProject(existing));
    }
    const blocked = unreadable.find((project) => project.id === preferred);
    if (blocked) throw new Error(blocked.reason);
    const example = await createExample();
    let project: WorkspaceProject;
    try {
      project = await createWorkspaceProject(name, crypto.randomUUID());
    } catch (error) {
      // Another window may have created it after the list read. Only a
      // definite create conflict can be resolved by opening that project.
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      const raced = (
        await listWorkspaceProjects({ fresh: true })
      ).projects.find((project) => project.name === name);
      if (!raced) throw error;
      return remember(await openWorkspaceProject(raced));
    }
    return remember(await populateWorkspaceProject(project, example));
  })().finally(() => exampleOpenings.delete(name));
  exampleOpenings.set(name, pending);
  return pending;
}

let initialization: Promise<CanvasDocument> | undefined;
export function initializeWorkspace() {
  // StrictMode's concurrent mount effects share in-flight work. A later mount
  // must reread the current project, not reinstall the first empty document.
  initialization ??= (async () => {
    let { projects } = await listWorkspaceProjects();
    let selected: string | undefined =
      window.location.pathname.split("/ai-canvas/")[1];
    if (selected) {
      selected = decodeURIComponent(selected);
      if (!projects.some((project) => project.id === selected)) {
        // Ask the authoritative store for the precise missing/unsupported-format error.
        await request(creationPath(selected));
        throw new Error(tNow("errors.backend.projectNotOpen"));
      }
    } else
      try {
        selected = localStorage.getItem(lastKey) ?? undefined;
      } catch {
        /* Optional hint. */
      }
    if (!projects.length) {
      const id = crypto.randomUUID();
      try {
        projects = [await createWorkspaceProject(tNow("errors.backend.untitled"), id)];
      } catch (error) {
        // Another window may have created the default directory concurrently.
        if (!(error instanceof ApiError && error.status === 409)) throw error;
        projects = (await listWorkspaceProjects()).projects;
        if (!projects.length) {
          // Preserve occupied directories, including unsupported old projects.
          for (let suffix = 2; suffix <= 100 && !projects.length; suffix++) {
            try {
              projects = [
                await createWorkspaceProject(
                  tNow("errors.backend.untitledSuffix", { suffix }),
                  id,
                ),
              ];
            } catch (conflict) {
              if (!(conflict instanceof ApiError && conflict.status === 409))
                throw conflict;
            }
          }
          if (!projects.length) throw error;
        }
      }
    }
    const document = await openWorkspaceProject(
      projects.find((project) => project.id === selected) ?? projects[0]!,
    );
    await saveWorkspaceDocument(document);
    return document;
  })().finally(() => {
    initialization = undefined;
  });
  return initialization;
}

export async function renameWorkspaceProject(
  project: WorkspaceProject,
  name: string,
) {
  // Reading the project is enough to check its version; only the project this
  // window holds needs its editing lease paused for the rename.
  const snapshot = await request<ProjectSnapshot>(creationPath(project.id));
  const current = activeBackendProjectId() === project.id;
  if (current) await releaseBackendProject();
  try {
    await creationClient(project.id).command("project.rename", { name }, [
      objectVersion("project", snapshot.project),
    ]);
  } finally {
    if (current) await openBackendProject(project.id, name).catch(() => {});
  }
  invalidateCached(PROJECTS_KEY);
  return (await listWorkspaceProjects()).projects.find(
    (item) => item.id === project.id,
  )!;
}

/** Removes a closed project from the list; the directory goes to the operating
 * system recycle bin when the platform supports it and is deleted otherwise.
 * The open canvas passes its authoritative snapshot so deleting it does not
 * read the same project again only to name the current revision. */
export async function trashWorkspaceProject(
  project: WorkspaceProject,
  known?: ProjectSnapshot,
) {
  let snapshot =
    known ?? (await request<ProjectSnapshot>(creationPath(project.id)));
  const current = activeBackendProjectId() === project.id;
  if (current) await releaseBackendProject();
  const trash = async () => {
    const receipt = await request<CommandReceipt>(
      `${creationPath(project.id)}/commands`,
      json("POST", {
        commandId: crypto.randomUUID(),
        projectId: project.id,
        type: "project.trash",
        payload: {},
        expectedVersions: [objectVersion("project", snapshot.project)],
      }),
    );
    // A definite rejection is a 200 receipt; it must not look like a deletion.
    if (receipt.status === "rejected") throw new CreationCommandError(receipt);
    return receipt;
  };
  try {
    try {
      await trash();
    } catch (error) {
      // An agent or another window may have advanced the project while the page
      // held it; reread the authoritative revision once and retry only that
      // definite conflict.
      if (
        !known ||
        !(error instanceof CreationCommandError) ||
        !error.receipt.issues.some((issue) => issue.code === "revision_conflict")
      )
        throw error;
      snapshot = await request<ProjectSnapshot>(creationPath(project.id));
      await trash();
    }
  } catch (error) {
    if (current)
      await openBackendProject(project.id, project.name).catch(() => {});
    // A lost response must not report a project that is already gone as an error.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  creationClient(project.id).close();
  projections.delete(project.id);
  invalidateCached(PROJECTS_KEY);
}
