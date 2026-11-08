import type { CanvasDocument } from "./model.ts";

export interface StarterGuideSavePlan {
  read: () => CanvasDocument;
  /** Synchronously enter the normal editing history, only if before is current. */
  apply: (before: CanvasDocument, next: CanvasDocument) => void;
  persist: (next: CanvasDocument) => Promise<boolean>;
  changed: () => Error;
  failed: () => Error;
}

/** Publish the edit to normal canvas history BEFORE saving it. Later edits then
 * build on it and use the normal save queue. Never reinstall a captured document
 * after I/O: doing so would discard intervening edits or resurrect another project.
 * A failed save retains the visible unsaved edit, like other canvas operations. */
export async function saveStarterGuideChange(
  next: CanvasDocument,
  plan: StarterGuideSavePlan,
) {
  const before = plan.read();
  if (before.id !== next.id) throw plan.changed();
  plan.apply(before, next);
  if (plan.read() !== next) throw plan.changed();
  if (!(await plan.persist(next))) throw plan.failed();
  if (plan.read().id !== next.id) throw plan.changed();
}
