import { assetReference, displayedAssetId, objectVersion, visibleItems, type CreationClient } from "../backend/creationClient.ts";
import type { Asset, CanvasItem, ProjectSnapshot } from "../contracts/generated.ts";
import { createNode, type Point } from "./model.ts";

/** Prefer the original binding, then a visible item showing the same asset. */
export function findAssetItem(snapshot: ProjectSnapshot, assetId: string, preferredId?: string | null) {
  const resultAssets = new Map(snapshot.results.map(result => [result.id, result.asset.assetId]));
  const adopted = new Map(snapshot.generationSpecs.map(spec =>
    [spec.id, spec.currentResultId ? resultAssets.get(spec.currentResultId) : undefined]));
  const owners = snapshot.canvasItems.filter(item => displayedAssetId(item, id => adopted.get(id)) === assetId);
  const preferred = owners.find(item => item.id === preferredId);
  if (preferred || owners.length < 2) return preferred ?? owners[0];
  const visible = visibleItems(snapshot);
  return owners.find(item => visible.has(item.id)) ?? owners[0];
}

/** Restore the existing item and its hidden ancestors under their current revisions. */
export async function showExistingItem(client: CreationClient, item: CanvasItem) {
  if (visibleItems(client.snapshot).has(item.id)) return item.id;
  const versions = [objectVersion("canvas_item", item)];
  let parentId = item.parentId;
  while (parentId) {
    const parent = client.snapshot.canvasItems.find(candidate => candidate.id === parentId)!;
    versions.push(objectVersion("canvas_item", parent));
    parentId = parent.parentId;
  }
  await client.command("canvas.show", { item }, versions);
  return item.id;
}

/** Attach an unplaced timeline to the existing editor document. */
export async function showTimelineEditorItem(client: CreationClient, editorId: string, revision: number, position: Point) {
  const node = createNode("timeline", position);
  await client.command("canvas.show", { item: {
    id: node.id, projectId: client.id, kind: "timeline", title: node.data.title,
    position, width: node.width, height: node.height,
    binding: { role: "editor", objectRef: { objectType: "editor_document", kind: "timeline", id: editorId } },
  } }, [objectVersion("editor_document", { id: editorId, revision })]);
  return node.id;
}

export function newAssetItem(asset: Asset, position: Point, specId?: string | null): CanvasItem {
  const node = createNode(asset.kind, { x: position.x - 150, y: position.y - 150 }, {
    media: { width: asset.metadata.width ?? undefined, height: asset.metadata.height ?? undefined },
  });
  return {
    id: node.id, projectId: asset.projectId, revision: 1, kind: asset.kind, title: asset.name,
    position: node.position, width: node.width, height: node.height,
    zIndex: 0, locked: false, visible: true, parentId: null, tags: [], editors: [],
    binding: specId
      ? { role: "generation", objectRef: { objectType: "generation_spec", id: specId }, materialOverride: null }
      : { role: "material", objectRef: assetReference(asset) },
  } as CanvasItem;
}

export async function showNewAssetItem(
  client: CreationClient, asset: Asset, position: Point, specId?: string | null,
) {
  const item = newAssetItem(asset, position, specId);
  await client.command("canvas.show", { item }, [objectVersion("asset", asset)]);
  return item.id;
}
