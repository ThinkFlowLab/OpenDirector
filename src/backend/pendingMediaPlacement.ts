import type { Asset, AssetRef, CanvasItem } from "../contracts/generated.ts";

function placementKey(projectId: string, ref: Pick<AssetRef, "assetId" | "revision" | "fingerprint">) {
  return `opendirector.editor.placement:${projectId}:${ref.assetId}:${ref.revision}:${ref.fingerprint}`;
}

/** Index an unresolved delivery by its immutable asset before it has a canvas identity. */
export function rememberPendingPlacement(item: CanvasItem | undefined, delivery: string, pending: boolean) {
  if (item?.binding.role !== "material") return;
  const key = placementKey(item.projectId, item.binding.objectRef);
  if (pending) sessionStorage.setItem(key, JSON.stringify({ item, delivery }));
  else if (JSON.parse(sessionStorage.getItem(key) ?? "null")?.item?.id === item.id)
    sessionStorage.removeItem(key);
}

export function pendingPlacement(asset: Asset): CanvasItem | undefined {
  try {
    const key = placementKey(asset.projectId, { assetId: asset.id, revision: asset.revision, fingerprint: asset.fingerprint });
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
    const item: CanvasItem | undefined = saved?.item;
    if (item?.binding.role === "material" && item.kind === asset.kind && item.projectId === asset.projectId
      && item.binding.objectRef.assetId === asset.id && item.binding.objectRef.revision === asset.revision
      && item.binding.objectRef.fingerprint === asset.fingerprint && sessionStorage.getItem(saved.delivery)) return item;
  } catch {
    // Session storage is optional. A live editor still owns its pending delivery.
  }
}
