import type { ChatMessage } from "../backend/chat.ts";
import type { Asset, AssetRef, CanvasItem, ProjectSnapshot } from "../contracts/generated.ts";
import { pendingPlacement } from "../backend/pendingMediaPlacement.ts";
import { currentAsset, type CreationClient } from "../backend/creationClient.ts";
import { findAssetItem, newAssetItem, showExistingItem, showTimelineEditorItem } from "./canvasAssetPlacement.ts";
import { indexNodes, isNodeLocked } from "./hierarchy.ts";
import type { Point } from "./model.ts";
import { tNow } from "../i18n/messages.ts";

export interface ProjectTimelineTarget {
  kind: "timeline";
  projectId: string;
  itemId: string | null;
  editorId: string;
  revision: number;
}
export type ProjectEditorTarget = ProjectTimelineTarget | {
  kind: "media";
  asset: Asset;
  itemId: string | null;
};

export type DeliveredTimeline = NonNullable<ChatMessage["publishedTimelines"]>["timelines"][number];

/** A turn can finish before its project notification reaches the browser. */
export function deliveredTimelineState(
  result: DeliveredTimeline, projectId: string, eventCursor: number | undefined, snapshot?: ProjectSnapshot,
) {
  if (snapshot?.project.id !== projectId || (eventCursor !== undefined && snapshot.eventCursor < eventCursor))
    return { status: "pending", title: result.title } as const;
  const editor = snapshot.editorDocuments.find(doc => doc.id === result.editorId && doc.kind === "timeline");
  const item = snapshot.canvasItems.find(candidate => candidate.id === result.itemId);
  if (!editor || (result.itemId && (item?.kind !== "timeline" || item.binding.objectRef.id !== editor.id)))
    return { status: "missing", title: result.title } as const;
  return { status: "available", title: item?.title || result.title, revision: editor.revision } as const;
}

export function timelinesForResultAssets(snapshot: ProjectSnapshot | undefined) {
  const byAsset = new Map<string, (ProjectTimelineTarget & { itemId: string; title: string })[]>();
  if (!snapshot) return byAsset;
  const documents = new Map(snapshot.editorDocuments.map(doc => [doc.id, doc]));
  const assets = new Map(snapshot.assets.map(asset => [asset.id, asset]));
  const renders = new Map<string, Asset[]>();
  for (const asset of snapshot.assets) {
    const { source, editorDocumentId } = asset.provenance;
    if (source !== "rendered" || !editorDocumentId) continue;
    const group = renders.get(editorDocumentId);
    if (group) group.push(asset);
    else renders.set(editorDocumentId, [asset]);
  }
  for (const item of snapshot.canvasItems) {
    if (item.kind !== "timeline" || item.binding.role !== "editor") continue;
    const doc = documents.get(item.binding.objectRef.id);
    if (doc?.kind !== "timeline") continue;
    const ids = new Set<string>();
    const include = (ref?: AssetRef | null) => {
      if (ref && assets.get(ref.assetId)?.fingerprint === ref.fingerprint) ids.add(ref.assetId);
    };
    for (const track of doc.data.tracks)
      for (const clip of track.clips) include(clip.resource.asset);
    for (const connection of doc.inputConnections) include(connection.asset);
    for (const resource of doc.data.importedAssets) include(resource.asset);
    for (const overlay of doc.data.overlays ?? []) include(overlay.sourceAsset);
    for (const asset of renders.get(doc.id) ?? []) {
      if (!asset.provenance.sourceItemId || asset.provenance.sourceItemId === item.id) ids.add(asset.id);
    }
    const target = {
      kind: "timeline" as const, projectId: snapshot.project.id,
      itemId: item.id, editorId: doc.id, revision: doc.revision, title: item.title,
    };
    for (const id of ids) {
      const targets = byAsset.get(id);
      if (targets) targets.push(target);
      else byAsset.set(id, [target]);
    }
  }
  return byAsset;
}

function boundProjectEditorItem(snapshot: ProjectSnapshot, target: ProjectEditorTarget) {
  if (target.kind === "timeline") {
    const item = target.itemId ? snapshot.canvasItems.find(candidate => candidate.id === target.itemId)
      : snapshot.canvasItems.find(candidate => candidate.kind === "timeline" && candidate.binding.objectRef.id === target.editorId);
    const editor = snapshot.editorDocuments.find(candidate => candidate.id === target.editorId);
    if (snapshot.project.id !== target.projectId || editor?.kind !== "timeline"
      || (target.itemId && (item?.kind !== "timeline" || item.binding.objectRef.id !== target.editorId)))
      throw new Error(tNow("errors.backend.timelineSourceMissing"));
    if (editor.revision !== target.revision) throw new Error(tNow("assistant.result.timelineChanged"));
    return item;
  }
  const { asset, itemId } = target;
  const saved = snapshot.assets.find(candidate => candidate.id === asset.id);
  if (snapshot.project.id !== asset.projectId || !saved) throw new Error(tNow("canvas.workspace.error.assetMissing"));
  if (saved.revision !== asset.revision || saved.fingerprint !== asset.fingerprint)
    throw new Error(tNow("canvasNodes.assets.versionChanged"));
  if (!itemId) return findAssetItem(snapshot, asset.id);
  const item = snapshot.canvasItems.find(candidate => candidate.id === itemId);
  if (!item || currentAsset(snapshot, item)?.id !== asset.id)
    throw new Error(tNow("canvasNodes.assets.versionChanged"));
  return item;
}

/** Hidden ancestors participate in the same lock checks as visible parents. */
export function resolveProjectEditorItem(snapshot: ProjectSnapshot, target: ProjectEditorTarget, provisionalId?: string) {
  const bound = boundProjectEditorItem(snapshot, target);
  if (provisionalId && bound) throw new Error(tNow("assistant.result.editorChanged"));
  // A lost reply can leave the already-edited output at the provisional ID.
  // It still participates in lock and revision checks while the fixed command is resolved.
  const item = provisionalId ? snapshot.canvasItems.find(candidate => candidate.id === provisionalId) : bound;
  if (item && isNodeLocked(item, indexNodes(snapshot.canvasItems)))
    throw new Error(tNow("canvas.workspace.toast.unlockFirst"));
  return item;
}

export async function prepareProjectEditorItem(
  client: CreationClient, target: ProjectEditorTarget, center: () => Point,
): Promise<{ itemId: string; unplaced?: CanvasItem }> {
  const item = resolveProjectEditorItem(client.snapshot, target);
  if (target.kind === "media") {
    if (item) return { itemId: item.id };
    // No project object is needed to inspect or cancel an unplaced candidate.
    const unplaced = pendingPlacement(target.asset) ?? newAssetItem(target.asset, center());
    return { itemId: unplaced.id, unplaced };
  }
  const itemId = item ? await showExistingItem(client, item)
    : await showTimelineEditorItem(client, target.editorId, target.revision, center());
  return { itemId };
}
