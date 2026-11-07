/** Decode inline data locally; this function never fetches a remote resource. */
import { tNow } from "../i18n/messages.ts";

export function dataUrlToBlob(value: string): Blob {
  const comma = value.indexOf(",");
  if (!/^data:/i.test(value) || comma < 0)
    throw new Error(tNow("errors.download.invalidUrl"));
  let mediaType = value.slice(5, comma);
  const base64 = /;base64$/i.test(mediaType);
  if (base64) mediaType = mediaType.slice(0, -7);
  if (!mediaType) mediaType = "text/plain;charset=US-ASCII";
  else if (mediaType.startsWith(";")) mediaType = `text/plain${mediaType}`;
  const payload = value.slice(comma + 1);
  try {
    if (base64) {
      // Only a percent escape needs decoding; a plain payload is used as is, so
      // exporting media does not copy the whole string through a URI decoder.
      const decoded = atob(
        payload.includes("%") ? decodeURIComponent(payload) : payload,
      );
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index++)
        bytes[index] = decoded.charCodeAt(index);
      return new Blob([bytes], { type: mediaType });
    }
    // Percent escapes represent bytes, including bytes that are not valid UTF-8.
    const encoded = new TextEncoder().encode(payload);
    const bytes = new Uint8Array(encoded.length);
    let length = 0;
    for (let index = 0; index < encoded.length; index++) {
      const hex = String.fromCharCode(encoded[index + 1] ?? 0, encoded[index + 2] ?? 0);
      if (encoded[index] === 37 && /^[\da-f]{2}$/i.test(hex)) {
        bytes[length++] = Number.parseInt(hex, 16);
        index += 2;
      } else bytes[length++] = encoded[index]!;
    }
    return new Blob([bytes.subarray(0, length)], { type: mediaType });
  } catch {
    throw new Error(tNow("errors.download.corrupt"));
  }
}

const mediaExtensions: Record<string, readonly string[]> = {
  "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"],
  "image/svg+xml": ["svg"], "image/webp": ["webp"],
  "image/gif": ["gif"], "image/avif": ["avif"],
  "image/bmp": ["bmp"], "image/tiff": ["tiff", "tif"],
  "video/webm": ["webm"], "video/mp4": ["mp4", "m4v"],
  "video/quicktime": ["mov"], "video/ogg": ["ogv", "ogg"],
  "audio/wav": ["wav"], "audio/wave": ["wav"], "audio/x-wav": ["wav"],
  "audio/vnd.wave": ["wav"], "audio/webm": ["webm"],
  "audio/mpeg": ["mp3"], "audio/mp4": ["m4a", "mp4"],
  "audio/ogg": ["ogg", "oga", "opus"], "audio/aac": ["aac"],
  "audio/flac": ["flac"], "audio/x-flac": ["flac"],
  "text/plain": ["txt"], "application/json": ["json"],
};
const knownExtensions = new Set(Object.values(mediaExtensions).flat());

export function downloadFilename(title: string, mimeType?: string): string {
  const name = title.trim() || tNow("errors.download.fallbackName");
  const extensions = mediaExtensions[mimeType?.split(";")[0]?.trim().toLowerCase() ?? ""];
  if (!extensions) return name;
  const suffix = /\.([a-z0-9]+)$/i.exec(name);
  const existing = suffix?.[1]?.toLowerCase();
  if (existing && extensions.includes(existing)) return name;
  const stem = existing && knownExtensions.has(existing) ? name.slice(0, -suffix![0].length) : name;
  return `${stem}.${extensions[0]}`;
}
