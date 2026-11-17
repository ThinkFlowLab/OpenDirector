import type { ProjectSnapshot } from "../contracts/generated.ts";
import type { ReferenceAsset } from "./chatReferenceContent.ts";

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
        id: asset.id,
        name: asset.name,
        nodeTitle: source?.title,
        logicalNodeId: source?.id,
        referenceId: ref.id,
        binding: "asset" as const,
        kind: asset.kind,
        type: asset.metadata.mimeType,
        size: asset.metadata.size,
        fingerprint: asset.fingerprint,
      },
    ];
  });
}
