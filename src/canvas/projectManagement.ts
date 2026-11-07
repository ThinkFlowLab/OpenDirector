import type { ProjectSnapshot } from "../contracts/generated.ts";
import type { WorkspaceProject } from "../backend/workspace.ts";
import type { CanvasDocument } from "./model.ts";

/** Flush until the saved snapshot is the one still on screen; async generated
 * results may arrive while a project is saving for a switch. */
export async function persistCurrentDocument(
  read: () => CanvasDocument,
  persist: (snapshot: CanvasDocument) => Promise<boolean>,
): Promise<boolean> {
  for (;;) {
    const snapshot = read();
    if (!(await persist(snapshot))) return false;
    if (read() === snapshot) return true;
  }
}

export interface DeleteOpenProjectPlan {
  /** Authoritative snapshot of the open project, already in memory. */
  snapshot: ProjectSnapshot;
  /** Rejects or resolves after flushing pending edits; must not resolve when
   * the flush failed, because a failed flush must never delete the project. */
  flush: () => Promise<void>;
  list: () => Promise<{ projects: WorkspaceProject[] }>;
  trash: (project: WorkspaceProject, snapshot: ProjectSnapshot) => Promise<void>;
  /** Loads and installs the replacement canvas; runs in the background. */
  openNext: (
    next: WorkspaceProject | undefined,
    taken: Set<string>,
  ) => Promise<void>;
  fail: (error: unknown) => void;
  settle: () => void;
}

/** Delete the open project and move the workspace to another canvas.
 *
 * Resolves as soon as the store accepts the removal: the confirmation dialog
 * must not stay busy while the replacement canvas loads. Callers show the
 * switching overlay until `settle` runs. */
export async function deleteOpenProject(
  project: WorkspaceProject,
  plan: DeleteOpenProjectPlan,
): Promise<void> {
  await plan.flush();
  const { projects } = await plan.list();
  const next = projects.find((item) => item.id !== project.id);
  const taken = new Set(projects.map((item) => item.name.toLocaleLowerCase()));
  await plan.trash(project, plan.snapshot);
  void plan.openNext(next, taken).catch(plan.fail).finally(plan.settle);
}
