import type { ChatAsset } from "../backend/chat";
import { assetDisplayName } from "./assetNames.ts";
import { CanvasIcon } from "./CanvasIcon";

function kindOf(asset: ChatAsset) {
  return asset.type.startsWith("image/")
    ? "image"
    : asset.type.startsWith("video/")
      ? "video"
      : asset.type.startsWith("audio/")
        ? "audio"
        : "text";
}

/** Reference chip in a sent user bubble. Matches the composer chip's truncation. */
export function ChatReferenceChip({
  name,
  assetId,
  asset,
  previewSrc,
  ariaLabel,
}: {
  name: string;
  assetId: string;
  asset?: ChatAsset;
  previewSrc?: string;
  ariaLabel?: string;
}) {
  const displayName = assetDisplayName(name);
  return (
    <span
      className="cw-chat-reference"
      data-preview-asset={assetId}
      aria-label={ariaLabel}
      title={displayName || undefined}
    >
      {previewSrc ? (
        <img src={previewSrc} alt="" />
      ) : (
        <CanvasIcon
          name={kindOf(asset ?? ({ type: "text/plain" } as ChatAsset))}
          size={18}
        />
      )}
      {displayName ? (
        <span className="cw-chat-reference-label">{displayName}</span>
      ) : null}
    </span>
  );
}
