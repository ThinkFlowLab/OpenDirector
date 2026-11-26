import type { Asset, ProjectSnapshot } from "../contracts/generated.ts";
import type { ReferenceAsset } from "./chatReferenceContent.ts";

export function pinnedReferenceAsset(asset: Asset): ReferenceAsset {
  return {
    id: asset.id,
    name: asset.name,
    binding: "asset",
    kind: asset.kind,
    type: asset.metadata.mimeType,
    size: asset.metadata.size,
    fingerprint: asset.fingerprint,
  };
}

/** Presentation metadata only: the reference continues to bind its fixed asset. */
export function pinnedReferenceAssets(
  snapshot: ProjectSnapshot,
  specId: string,
): ReferenceAsset[] {
  return snapshot.references.flatMap((ref) => {
    if (
      ref.binding !== "pinned" ||
      ref.targetSpecId !== specId ||
      !ref.active
    )
      return [];
    const asset = snapshot.assets.find(
      (asset) => asset.id === ref.source.assetId,
    );
    if (!asset) return [];
    const source = snapshot.canvasItems.find(
      (item) => item.id === ref.sourceVersion?.id,
    );
    return [
      {
        ...pinnedReferenceAsset(asset),
        nodeTitle: source?.title,
        logicalNodeId: source?.id,
        referenceId: ref.id,
      },
    ];
  });
}
