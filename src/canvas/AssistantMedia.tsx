import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatAsset } from "../backend/chat";
import { assetSource } from "../backend/assetSource.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { CanvasIcon } from "./CanvasIcon";
import { useCanvasPlayback } from "./CanvasMediaPreview";
import { formatMediaTime } from "./mediaPlayback";
import { assetDisplayName } from "./assetNames";
import { useAssetMedia } from "./useAssetMedia.tsx";

function mediaKind(asset: ChatAsset) {
  if (asset.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif)$/i.test(asset.name)) return "image";
  if (asset.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(asset.name)) return "video";
  if (asset.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac)$/i.test(asset.name)) return "audio";
  return "text";
}
function useMediaSource(projectId: string, asset: ChatAsset, active: boolean) {
  const media = useAssetMedia(mediaKind(asset) === "text" ? undefined : assetSource(projectId, asset.id), active);
  const [failed, setFailed] = useState(false);
  return {src: media.src ?? "", failed: failed || media.state === "failed", setFailed};
}

function AttachmentCard({ projectId, asset }: {projectId: string; asset: ChatAsset}) {
  const t = useT();
  const root = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [duration, setDuration] = useState(0);
  const {src, failed, setFailed} = useMediaSource(projectId, asset, visible);
  const kind = mediaKind(asset);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(item => item.isIntersecting)) {setVisible(true); observer.disconnect();}
    }, {rootMargin: "80px"});
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  return <button type="button" ref={root} className="cw-chat-attachment" data-preview-asset={asset.id}
    aria-label={t("assistant.media.preview", { name: assetDisplayName(asset.name) })}>
    <span className="cw-chat-attachment-picture">
      {src && !failed && kind === "image" ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
        : src && !failed && kind === "video" ? <video src={src} muted playsInline preload="metadata"
          onLoadedMetadata={event => {const video = event.currentTarget; setDuration(Number.isFinite(video.duration) ? video.duration : 0); if (Number.isFinite(video.duration) && video.duration > 0.3) video.currentTime = Math.min(0.3, video.duration / 2);}}
          onError={() => setFailed(true)} />
        : <CanvasIcon name={kind} size={28} />}
      {kind === "video" && <span className="cw-chat-attachment-play" aria-hidden="true">▶</span>}
      {duration > 0 && <small>{formatMediaTime(duration)}</small>}
    </span>
    <span className="cw-chat-attachment-name">{assetDisplayName(asset.name)}</span>
  </button>;
}

export function AttachmentStrip({projectId, assets}: {projectId: string; assets: ChatAsset[]}) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  if (!assets.length) return null;
  return <div className="cw-chat-attachments">
    <button type="button" className="cw-chat-attachments-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? t("assistant.media.collapse") : t("assistant.media.expand", { count: assets.length })}</button>
    {expanded && <div className="cw-chat-attachment-list">{assets.map(asset => <AttachmentCard key={`${asset.id}:${asset.fingerprint}`} projectId={projectId} asset={asset} />)}</div>}
  </div>;
}

export function AttachmentHover({projectId, asset, anchor}: {projectId: string; asset: ChatAsset; anchor: DOMRect}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [dimensions, setDimensions] = useState<{width: number; height: number} | null>(null);
  const {src, failed, setFailed} = useMediaSource(projectId, asset, true);
  const kind = mediaKind(asset);
  const playback = useCanvasPlayback();
  useLayoutEffect(() => {
    const element = panel.current!;
    const source = dimensions ?? {width: 340, height: 200};
    const scale = Math.min(360 / source.width, 360 / source.height, (window.innerWidth - 24) / source.width, (window.innerHeight - 24) / source.height);
    element.style.width = `${Math.max(1, Math.round(source.width * scale))}px`;
    element.style.height = `${Math.max(1, Math.round(source.height * scale))}px`;
    element.showPopover();
    const height = element.getBoundingClientRect().height;
    element.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - element.offsetWidth - 12))}px`;
    element.style.top = `${Math.max(12, Math.min(anchor.top >= height + 20 ? anchor.top - height - 8 : anchor.bottom + 8, window.innerHeight - height - 12))}px`;
  }, [anchor, dimensions]);
  useEffect(() => {
    const media = video.current;
    if (!src || !media || playback.blocked) return;
    const timer = setTimeout(() => {playback.claim(media); void media.play().catch(() => {});}, 150);
    return () => {clearTimeout(timer); media.pause();};
  }, [src, playback]);
  return <div ref={panel} popover="manual" className="cw-chat-media-preview" role="tooltip">
    <div className="cw-chat-media-preview-heading"><strong>{assetDisplayName(asset.name)}</strong>{duration > 0 && <span>{duration.toFixed(1)}s</span>}</div>
    {failed ? <p>{t("assistant.media.unavailable")}</p> : !src && kind !== "text" ? <p role="status">{t("assistant.media.loading")}</p>
      : kind === "image" ? <img src={src} alt={assetDisplayName(asset.name)} onLoad={event => {const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setDimensions({width: image.naturalWidth, height: image.naturalHeight});}} onError={() => setFailed(true)} />
      : kind === "video" ? <video ref={video} src={src} muted playsInline preload="auto" onLoadedMetadata={event => {const media = event.currentTarget; if (media.videoWidth && media.videoHeight) setDimensions({width: media.videoWidth, height: media.videoHeight}); const duration = media.duration; setDuration(Number.isFinite(duration) ? duration : 0);}} onError={() => setFailed(true)} />
      : <p>{kind === "audio" ? t("assistant.media.audio") : t("assistant.media.file")} · {Math.ceil(asset.size / 1024)} KB</p>}
  </div>;
}
