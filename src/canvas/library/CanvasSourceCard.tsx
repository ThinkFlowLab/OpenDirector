import { useEffect, useState } from "react";
import { headers, responseError } from "../../backend/api";
import {
  canvasSourceMedia,
  type CanvasSource,
} from "../../backend/canvasSources";
import { CanvasIcon } from "../CanvasIcon";
import { MediaCard } from "./MediaCard";
import { useAssetMedia } from "../useAssetMedia.tsx";

export function CanvasSourceCard({
  item,
  projectId,
  selected,
  disabled,
  onSelect,
  preview = true,
}: {
  item: CanvasSource;
  projectId: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  /** Off for the open canvas: its media is already on screen. */
  preview?: boolean;
}) {
  const inline = useAssetMedia(
    item.main.kind === "image" ? item.main.src : undefined,
  );
  const [thumbnail, setThumbnail] = useState<string>();
  const src = thumbnail ?? inline.src;
  useEffect(() => {
    if (!preview) return;
    // Videos get a rendered first frame too: the original can be tens of MB.
    if (item.main.kind !== "image" && item.main.kind !== "video") return;
    let active = true,
      url: string | undefined;
    fetch(canvasSourceMedia(projectId, item, "main", "thumb"), { headers })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response);
        const blob = await response.blob();
        url = URL.createObjectURL(blob);
        if (active) setThumbnail(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => {});
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item, projectId, preview]);
  return (
    <MediaCard
      title={item.title}
      src={src}
      icon={
        item.kind === "subject"
          ? "subject"
          : item.main.kind === "audio"
            ? "audio"
            : item.main.kind === "video"
              ? "video"
              : item.main.kind === "text"
                ? "text"
                : item.main.kind === "file"
                  ? "file"
                  : "image"
      }
      action={
        // The preview is a still frame, so keep the play marker it replaced.
        item.main.kind === "video" && src ? (
          <span className="cw-lib-badge" aria-hidden>
            <CanvasIcon name="video" size={16} />
          </span>
        ) : undefined
      }
      selected={selected}
      disabled={disabled}
      onSelect={onSelect}
    />
  );
}
