import type { CanvasResource, TimelineData } from "./model.ts";
import { timelineError, timelineImportedAssets } from "./dataBoundary.ts";
import {
  timelineDuration,
  timelineSegments,
  timelineHasTextResources,
} from "./timeline.ts";
import { tNow } from "../i18n/messages.ts";

export interface TimelineExportAsset {
  resource: CanvasResource;
  path: string;
  ref: string;
}
const keyOf = (asset: CanvasResource) =>
  `${asset.kind}:${asset.src ?? asset.id}`;
const xml = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
/** FCPXML rational seconds, rounded to microseconds rather than rounded once per frame. */
export function fcpxmlTime(seconds: number): string {
  const numerator = Math.round(seconds * 1_000_000);
  if (!Number.isSafeInteger(numerator) || numerator < 0)
    throw new Error(tNow("errors.export.range"));
  let a = numerator,
    b = 1_000_000;
  while (b) {
    const r = a % b;
    a = b;
    b = r;
  }
  return numerator % 1_000_000 === 0
    ? `${numerator / 1_000_000}s`
    : `${numerator / a}/${1_000_000 / a}s`;
}
function extension(asset: CanvasResource): string {
  const mime =
    asset.mimeType?.split(";")[0]?.toLowerCase() ||
    asset.src?.match(/^data:([^;,]+)/)?.[1]?.toLowerCase();
  const types: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/webm": "webm",
  };
  return (
    (mime && types[mime]) ||
    asset.title.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase() ||
    "bin"
  );
}
export function timelineExportAssets(
  timeline: TimelineData,
): TimelineExportAsset[] {
  const error = timelineError(timeline);
  if (error) throw new Error(error);
  const assets = new Map<string, CanvasResource>();
  for (const asset of [
    ...timelineImportedAssets(timeline),
    ...timelineSegments(timeline).map(({ clip }) => clip.resource),
  ]) {
    if (!asset.src)
      throw new Error(
        tNow("errors.export.missingMedia", { title: asset.title }),
      );
    assets.set(keyOf(asset), asset);
  }
  return [...assets.values()].map((resource, index) => {
    const stem =
      Array.from(
        resource.title
          .replace(/\.[^.]+$/, "")
          .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
          .replace(/[. ]+$/g, ""),
      )
        .slice(0, 64)
        .join("") || "media";
    return {
      resource,
      ref: `a${index + 1}`,
      path: `media/${String(index + 1).padStart(3, "0")}-${stem}.${extension(resource)}`,
    };
  });
}

/** Apple FCPXML 1.10. Relative media URLs are portable with the accompanying ZIP.
 * https://developer.apple.com/documentation/professional-video-applications/document-type-definition
 * https://developer.apple.com/documentation/professional-video-applications/timemap
 * A primary gap anchors video and audio lanes without inventing source track metadata.
 */
export function exportTimelineFcpxml(
  timeline: TimelineData,
  title: string,
): string {
  if (timelineHasTextResources(timeline))
    throw new Error(tNow("errors.export.textUnsupported"));
  const assets = timelineExportAssets(timeline),
    duration = timelineDuration(timeline);
  if (!duration) throw new Error(tNow("errors.export.emptyTimeline"));
  if (timeline.fps > 0xffffffff)
    throw new Error(tNow("errors.export.fpsRange"));
  const frameTime = (frames: number) => {
    if (!Number.isSafeInteger(frames) || frames < 0)
      throw new Error(tNow("errors.export.frameRange"));
    return frames % timeline.fps === 0
      ? `${frames / timeline.fps}s`
      : `${frames}/${timeline.fps}s`;
  };
  const durationTime = frameTime(Math.round(duration * timeline.fps));
  const refs = new Map(assets.map((asset) => [keyOf(asset.resource), asset]));
  const segments = timelineSegments(timeline);
  const resourceXml = assets
    .map(({ resource, ref, path }) => {
      const dimensions =
        resource.kind !== "audio" && resource.width && resource.height;
      const format = dimensions ? `${ref}-format` : undefined;
      const formatXml = format
        ? `<format id="${format}" width="${Math.round(resource.width!)}" height="${Math.round(resource.height!)}"/>`
        : "";
      // Unknown source audio channels/rate/fps are deliberately left for the importing app to probe.
      const flags =
        resource.kind === "image"
          ? ' hasVideo="1" hasAudio="0"'
          : resource.kind === "audio"
            ? ' hasVideo="0" hasAudio="1"'
            : ' hasVideo="1"';
      const mediaDuration =
        resource.kind === "image"
          ? "0s"
          : resource.durationSeconds
            ? fcpxmlTime(resource.durationSeconds)
            : undefined;
      return `${formatXml}<asset id="${ref}" name="${xml(resource.title)}" start="0s"${mediaDuration ? ` duration="${mediaDuration}"` : ""}${flags}${format ? ` format="${format}"` : ""}><media-rep kind="original-media" src="./${xml(path.split("/").map(encodeURIComponent).join("/"))}"/></asset>`;
    })
    .join("\n");
  const clips = segments
    .map(({ clip, track, start, end }) => {
      const source = refs.get(keyOf(clip.resource))!;
      const audio = track.kind === "audio",
        muted = track.muted || clip.muted || clip.volume === 0;
      const lane = audio
        ? -(
            timeline.tracks
              .filter((item) => item.kind === "audio")
              .findIndex((item) => item.id === track.id) + 1
          )
        : 1;
      const speed = clip.speed,
        retimed = clip.resource.kind !== "image" && speed !== 1;
      const mappedStart = retimed ? clip.inPoint / speed : clip.inPoint;
      const sourceEnd = Math.max(
        clip.outPoint,
        clip.resource.durationSeconds ?? 0,
      );
      const startFrame = Math.round(start * timeline.fps),
        endFrame = Math.round(end * timeline.fps);
      if (endFrame <= startFrame)
        throw new Error(
          tNow("errors.export.clipShort", { title: clip.resource.title }),
        );
      const timeMap = retimed
        ? `<timeMap preservesPitch="0" frameSampling="floor"><timept time="0s" value="0s" interp="linear"/><timept time="${fcpxmlTime(sourceEnd / speed)}" value="${fcpxmlTime(sourceEnd)}" interp="linear"/></timeMap>`
        : "";
      const volume =
        audio || clip.resource.kind === "video"
          ? `<adjust-volume amount="${muted ? "-96" : (20 * Math.log10(clip.volume)).toFixed(6)}dB"/>`
          : "";
      const conform = !audio ? '<adjust-conform type="fit"/>' : "";
      // Disabling audio-only clips is exact silence; visual clips keep their picture via srcEnable.
      return `<asset-clip ref="${source.ref}" name="${xml(clip.resource.title)}" lane="${lane}" offset="${frameTime(startFrame)}" start="${fcpxmlTime(mappedStart)}" duration="${frameTime(endFrame - startFrame)}"${audio && muted ? ' enabled="0"' : ""} srcEnable="${audio ? "audio" : muted || clip.resource.kind === "image" ? "video" : "all"}"${audio ? ` audioRole="music.track-${-lane}"` : ""}>${timeMap}${conform}${volume}</asset-clip>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources><format id="sequence-format" frameDuration="1/${timeline.fps}s" width="${timeline.width}" height="${timeline.height}"/>\n${resourceXml}</resources><library><event name="OpenDirector"><project name="${xml(title || "Timeline")}"><sequence format="sequence-format" duration="${durationTime}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine><gap name="Timeline" offset="0s" start="0s" duration="${durationTime}">\n${clips}\n</gap></spine></sequence></project></event></library></fcpxml>\n`;
}

export interface ZipEntry {
  path: string;
  content: Blob;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
async function crc32(blob: Blob, signal: AbortSignal): Promise<number> {
  const reader = blob.stream().getReader();
  const cancel = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  let crc = 0xffffffff;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      for (const byte of part.value)
        crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
/** ZIP method 0 preserves original bytes. ZIP32's actual format limits are checked before writing. */
export async function createTimelineZip(
  entries: ZipEntry[],
  signal: AbortSignal,
): Promise<Blob> {
  if (entries.length > 65535) throw new Error(tNow("errors.export.zipEntries"));
  const parts: BlobPart[] = [],
    central: Uint8Array[] = [],
    names = new Set<string>();
  let offset = 0,
    centralSize = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    if (
      !entry.path ||
      /(^\/|\\|(^|\/)\.\.?($|\/))/.test(entry.path) ||
      names.has(entry.path)
    )
      throw new Error(tNow("errors.export.zipName"));
    names.add(entry.path);
    const name = new TextEncoder().encode(entry.path),
      size = entry.content.size;
    if (
      name.length > 65535 ||
      size > 0xffffffff ||
      offset + 30 + name.length + size > 0xffffffff
    )
      throw new Error(tNow("errors.export.zipSize"));
    const crc = await crc32(entry.content, signal);
    const header = new Uint8Array(30 + name.length),
      view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(12, 33, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, name.length, true);
    header.set(name, 30);
    const directory = new Uint8Array(46 + name.length),
      dv = new DataView(directory.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(14, 33, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, size, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    directory.set(name, 46);
    parts.push(header, entry.content);
    central.push(directory);
    centralSize += directory.length;
    offset += header.length + size;
  }
  if (offset + centralSize > 0xffffffff)
    throw new Error(tNow("errors.export.zipDirectory"));
  const tail = new Uint8Array(22),
    view = new DataView(tail.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  signal.throwIfAborted();
  return new Blob([...parts, ...central, tail], { type: "application/zip" });
}

async function readLocalResource(
  resource: CanvasResource,
  signal: AbortSignal,
): Promise<Blob> {
  if (!resource.src)
    throw new Error(
      tNow("errors.export.missingFile", { title: resource.title }),
    );
  const base =
    typeof location === "undefined" ? "http://localhost/" : location.href;
  const url = new URL(resource.src, base);
  if (
    !(
      url.protocol === "data:" ||
      (typeof location !== "undefined" &&
        url.origin === location.origin &&
        ["http:", "https:", "blob:"].includes(url.protocol))
    )
  )
    throw new Error(tNow("errors.export.notLocal", { title: resource.title }));
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(
      tNow("errors.export.readFailed", {
        title: resource.title,
        status: response.status,
      }),
    );
  return response.blob();
}
export async function exportTimelinePackage(
  timeline: TimelineData,
  title: string,
  signal: AbortSignal,
  progress: (value: number) => void = () => {},
  read: (
    resource: CanvasResource,
    signal: AbortSignal,
  ) => Promise<Blob> = readLocalResource,
): Promise<Blob> {
  const fcpxml = exportTimelineFcpxml(timeline, title);
  const assets = timelineExportAssets(timeline);
  const entries: ZipEntry[] = [
    {
      path: "project.fcpxml",
      content: new Blob([fcpxml], { type: "application/xml" }),
    },
  ];
  for (const [index, asset] of assets.entries()) {
    signal.throwIfAborted();
    const content = await read(asset.resource, signal);
    signal.throwIfAborted();
    if (!content.size)
      throw new Error(
        tNow("errors.export.emptyFile", { title: asset.resource.title }),
      );
    entries.push({ path: asset.path, content });
    progress((index + 1) / (assets.length + 1));
  }
  entries.push({
    path: "README.txt",
    content: new Blob([tNow("errors.export.readme")]),
  });
  const zip = await createTimelineZip(entries, signal);
  progress(1);
  return zip;
}
