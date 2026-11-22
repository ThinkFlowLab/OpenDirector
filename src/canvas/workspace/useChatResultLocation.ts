import { useEffect, useRef, useState } from "react";
import type { Asset } from "../../contracts/generated.ts";
import { creationClient, currentAsset, visibleItems } from "../../backend/creationClient.ts";
import { findAssetItem, showExistingItem, showNewAssetItem } from "../canvasAssetPlacement.ts";
import type { WorkspaceRuntime } from "./runtimeTypes.ts";

export function useChatResultLocation(rt: WorkspaceRuntime) {
  const [destination, setDestination] = useState<{ projectId: string; itemId: string; assetId: string } | null>(null);
  const queue = useRef(Promise.resolve());
  const { doc, canvasVisible, workspaceMode } = rt;

  // The ordinary mode switch preserves the viewport. Apply explicit focus only
  // after the canvas and the acknowledged display item have both been rendered.
  useEffect(() => {
    if (!destination) return;
    if (doc.id !== destination.projectId || !canvasVisible) {
      setDestination(null);
      return;
    }
    const snapshot = creationClient(doc.id).snapshot;
    const item = snapshot.canvasItems.find(candidate => candidate.id === destination.itemId);
    if (!item || currentAsset(snapshot, item)?.id !== destination.assetId || !visibleItems(snapshot).has(item.id)) {
      rt.notify(rt.t("canvasNodes.assets.versionChanged"));
      setDestination(null);
      return;
    }
    const node = doc.nodes.find(candidate => candidate.id === item.id);
    if (!node) return;
    rt.selectAndFocus(node);
    rt.root.current?.focus({ preventScroll: true });
    setDestination(null);
  }, [rt, destination, doc, canvasVisible]);

  const locate = async (asset: Asset, preferredId?: string | null) => {
    const active = () => rt.mounted.current && !rt.switchPending.current &&
      rt.doc.id === asset.projectId && rt.workspaceMode === workspaceMode;
    if (!active()) return;
    const client = creationClient(asset.projectId);
    await rt.saveQueue.current?.wait();
    if (!active()) return;
    const snapshot = await client.refresh();
    if (!active()) return;
    const saved = snapshot.assets.find(candidate => candidate.id === asset.id);
    if (!saved) throw new Error(rt.t("canvas.workspace.error.assetMissing"));
    if (saved.revision !== asset.revision || saved.fingerprint !== asset.fingerprint)
      throw new Error(rt.t("canvasNodes.assets.versionChanged"));

    const item = findAssetItem(snapshot, saved.id, preferredId);
    // Showing an unadopted candidate creates a material binding to this version.
    const itemId = item ? await showExistingItem(client, item)
      : await showNewAssetItem(client, saved, rt.center());
    if (!active()) return;
    rt.setPanel(null);
    rt.changeWorkspaceMode("canvas");
    if (rt.assistantLayout.mobile) rt.setAssistantOpen(false);
    setDestination({ projectId: saved.projectId, assetId: saved.id, itemId });
  };

  return (asset: Asset, preferredId?: string | null) => {
    const next = queue.current.then(() => locate(asset, preferredId));
    queue.current = next.catch(() => {});
    return next;
  };
}
