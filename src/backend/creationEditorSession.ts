import type { CanvasDocument, CanvasNodeData } from "../canvas/model.ts";
import { applyCommand } from "../canvas/model.ts";
import { updateStack } from "../canvas/operations.ts";
import {
  CreationClient,
  CreationCommandError,
  objectVersion,
} from "./creationClient.ts";
import { CreationProjection } from "./creationProjection.ts";
import { tNow } from "../i18n/messages.ts";

/** A modal owns a draft and its original version basis, never a second project.
 * Keep the prepared command across an unknown reply, including imported assets
 * and newly allocated editor IDs. Changing the draft cannot replace that command.
 */
export class CreationEditorSession {
  readonly projection: CreationProjection;
  private pending?: {
    key: string;
    data: Partial<CanvasNodeData>;
    document: CanvasDocument;
    plan: Awaited<ReturnType<CreationProjection["prepare"]>>;
    id: string;
  };
  private active = false;
  readonly itemId: string;
  constructor(
    client: CreationClient,
    document: CanvasDocument,
    itemId: string,
  ) {
    this.itemId = itemId;
    this.projection = new CreationProjection(client);
    this.projection.baseline = document;
    this.projection.basis = client.snapshot;
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(this.storageKey()) ?? "null",
      );
      if (saved?.id && saved.plan && saved.data)
        this.pending = {
          ...saved,
          document: this.draft(saved.data),
        };
    } catch {
      /* Storage is optional; the open session retains the operation. */
    }
  }
  private draft(data: Partial<CanvasNodeData>) {
    return data.stack
      ? updateStack(this.projection.baseline, this.itemId, data.stack)
      : applyCommand(this.projection.baseline, {
          type: "update-node",
          id: this.itemId,
          patch: { data },
        });
  }
  private storageKey() {
    return `opendirector.editor.delivery:${this.projection.client.id}:${this.itemId}`;
  }
  private storePending() {
    try {
      if (this.pending) {
        const { document: _, ...delivery } = this.pending;
        sessionStorage.setItem(this.storageKey(), JSON.stringify(delivery));
      } else sessionStorage.removeItem(this.storageKey());
    } catch {
      /* Do not invalidate a business operation on preference failure. */
    }
  }
  async apply(data: Partial<CanvasNodeData>) {
    if (this.active) throw new Error(tNow("errors.backend.editSaving"));
    const key = JSON.stringify(data);
    let resolvingPrevious = !!this.pending && this.pending.key !== key;
    this.active = true;
    try {
      // A page can reload after the server committed the previous edit but
      // before this session forgot it. When the server has already settled
      // that command, it is no longer unknown: drop it instead of replaying it
      // and turning the user's new edit away. The fresh plan below still uses
      // the current version basis, so nothing newer is overwritten.
      if (resolvingPrevious && this.pending) {
        const settled = await this.projection.client.receipt(this.pending.id);
        if (settled) {
          await this.projection.client.refresh();
          if (settled.status === "applied")
            this.projection.baseline = this.pending.document;
          this.projection.basis = this.projection.client.snapshot;
          this.pending = undefined;
          this.storePending();
          resolvingPrevious = false;
        }
      }
      if (!this.pending) {
        const document = this.draft(data);
        const plan = await this.projection.prepare(document);
        // Even an unchanged draft needs a server-side version/lock check before
        // it can be used as the acknowledged input of a new render.
        const item = this.projection.basis.canvasItems.find(
          (item) => item.id === this.itemId,
        )!;
        const editorIds = new Set([
          ...(item.binding.role === "editor"
            ? [item.binding.objectRef.id]
            : []),
          ...("editors" in item ? item.editors.map((ref) => ref.id) : []),
        ]);
        for (const version of [
          objectVersion("canvas_item", item),
          ...this.projection.basis.editorDocuments
            .filter((doc) => editorIds.has(doc.id))
            .map((doc) => objectVersion("editor_document", doc)),
        ]) {
          if (
            !plan.versions.some(
              (v) => v.objectType === version.objectType && v.id === version.id,
            )
          )
            plan.versions.push(version);
        }
        if (!plan.operations.length) {
          plan.operations.push({
            type: "canvas.update",
            payload: { itemId: this.itemId },
          });
          const timeline = this.projection.basis.editorDocuments.find(
            (doc) => editorIds.has(doc.id) && doc.kind === "timeline",
          );
          if (timeline)
            plan.operations.push({
              type: "editor.save",
              payload: { document: timeline },
            });
        }
        this.pending = { key, data, document, plan, id: crypto.randomUUID() };
        this.storePending();
      }
      const { document, plan, id } = this.pending;
      const receipt = await this.projection.client.command(
        "creation.batch",
        { operations: plan.operations },
        plan.versions,
        undefined,
        id,
      );
      const committed = new Map(
        plan.versions.map((v) => [`${v.objectType}:${v.id}`, v.revision]),
      );
      for (const v of receipt.changed ?? [])
        committed.set(`${v.objectType}:${v.id}`, v.revision);
      const current = this.projection.client.snapshot;
      const superseded = [
        ...current.canvasItems,
        ...current.editorDocuments,
      ].some((obj) => {
        const type = "binding" in obj ? "canvas_item" : "editor_document";
        const revision = committed.get(`${type}:${obj.id}`);
        return revision !== undefined && obj.revision !== revision;
      });
      if (superseded) {
        this.pending = undefined;
        this.storePending();
        throw new Error(
          tNow("errors.backend.editChangedAfterSave"),
        );
      }
      this.projection.baseline = document;
      this.projection.basis = this.projection.client.snapshot;
      this.pending = undefined;
      this.storePending();
      if (resolvingPrevious)
        throw new Error(
          tNow("errors.backend.priorEditSaved"),
        );
    } catch (error) {
      // Only a definitive rejection releases the operation. Its version basis
      // remains unchanged: retrying must not silently overwrite a newer edit.
      if (error instanceof CreationCommandError) {
        this.pending = undefined;
        this.storePending();
      }
      throw error;
    } finally {
      this.active = false;
    }
  }
}
