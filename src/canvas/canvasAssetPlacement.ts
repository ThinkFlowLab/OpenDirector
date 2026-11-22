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

export async function showNewAssetItem(
  client: CreationClient, asset: Asset, position: Point, specId?: string | null,
) {
  const node = createNode(asset.kind, { x: position.x - 150, y: position.y - 150 }, {
    media: { width: asset.metadata.width ?? undefined, height: asset.metadata.height ?? undefined },
  });
  const item = {
    id: node.id, projectId: client.id, revision: 1, kind: asset.kind, title: asset.name,
    position: node.position, width: node.width, height: node.height,
    zIndex: 0, locked: false, visible: true, parentId: null, tags: [], editors: [],
    binding: specId
      ? { role: "generation", objectRef: { objectType: "generation_spec", id: specId }, materialOverride: null }
      : { role: "material", objectRef: assetReference(asset) },
  } as CanvasItem;
  await client.command("canvas.show", { item }, [objectVersion("asset", asset)]);
  return item.id;
}
