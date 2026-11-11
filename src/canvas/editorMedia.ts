import type { Translate } from "../i18n/I18nProvider.tsx";
import { defaultTranslate } from "./assistantTranslate.ts";
import type { CanvasResource } from "./model";

const aborted = (t: Translate) =>
  new DOMException(t("editors.media.error.aborted"), "AbortError");

const mediaExtensions: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
};

/** Missing/generic browser MIME may fall back to the filename; explicit types win.
 * This classifies an import, not its validity: the media decoder still validates it.
 */
export function classifyImportFile(file: Pick<File, "name" | "type">): {
  kind: CanvasResource["kind"];
  mimeType: string;
} {
  const reported = file.type.trim().toLowerCase();
  const extension = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const mimeType =
    !reported || reported === "application/octet-stream"
      ? (mediaExtensions[extension] ?? reported)
      : reported;
  const kind = mimeType.startsWith("image/")
    ? "image"
    : mimeType.startsWith("video/")
      ? "video"
      : mimeType.startsWith("audio/")
        ? "audio"
        : mimeType.startsWith("text/") &&
            ["txt", "md", "markdown"].includes(extension)
          ? "text"
          : "file";
  return { kind, mimeType };
}

export async function readEditorResource(
  file: File,
  signal?: AbortSignal,
  t: Translate = defaultTranslate,
): Promise<CanvasResource> {
  const { kind, mimeType } = classifyImportFile(file);
  if (kind === "text") {
    if (file.size > 1024 * 1024)
      throw new Error(t("editors.media.error.textTooLarge"));
    const bytes = await file.arrayBuffer();
    signal?.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text))
      throw new Error(t("editors.media.error.textBinary"));
    return {
      id: crypto.randomUUID(),
      kind,
      title: file.name,
      text,
      byteSize: file.size,
      mimeType,
    };
  }
  const src = await new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted(t));
      return;
    }
    const reader = new FileReader();
    const cleanup = () => {
      signal?.removeEventListener("abort", cancel);
      reader.onload = reader.onerror = reader.onabort = null;
    };
    const cancel = () => {
      cleanup();
      reader.abort();
      reject(aborted(t));
    };
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error(t("editors.media.error.readFile", { name: file.name })));
    };
    reader.onabort = () => {
      cleanup();
      reject(aborted(t));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    reader.readAsDataURL(
      file.type === mimeType ? file : file.slice(0, file.size, mimeType),
    );
  });
  return withMediaDuration(
    {
      id: crypto.randomUUID(),
      kind,
      title: file.name,
      src,
      mimeType,
      byteSize: file.size,
    },
    signal,
    t,
  );
}

/** Resolves actual pixels/duration once, and releases the loader when its dialog closes. */
export async function withMediaDuration(
  resource: CanvasResource,
  signal?: AbortSignal,
  t: Translate = defaultTranslate,
): Promise<CanvasResource> {
  if (signal?.aborted) throw aborted(t);
  if (resource.kind === "file" || resource.kind === "text") return resource;
  if (resource.kind === "image" && resource.width && resource.height)
    return resource;
  const hasDuration =
    typeof resource.durationSeconds === "number" &&
    Number.isFinite(resource.durationSeconds) &&
    resource.durationSeconds > 0;
  if (resource.kind === "audio" && hasDuration) return resource;
  if (
    resource.kind === "video" &&
    hasDuration &&
    resource.width &&
    resource.height
  )
    return resource;
  if (!resource.src)
    throw new Error(t("editors.media.error.missingSource"));
  return new Promise<CanvasResource>((resolve, reject) => {
    const element =
      resource.kind === "image"
        ? new Image()
        : document.createElement(resource.kind === "video" ? "video" : "audio");
    let finished = false;
    let metadataLoaded = false,
      probingEnd = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      const width =
        element instanceof HTMLImageElement
          ? element.naturalWidth
          : element instanceof HTMLVideoElement
            ? element.videoWidth
            : undefined;
      const height =
        element instanceof HTMLImageElement
          ? element.naturalHeight
          : element instanceof HTMLVideoElement
            ? element.videoHeight
            : undefined;
      const durationSeconds =
        element instanceof HTMLMediaElement ? element.duration : undefined;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      element.onload = null;
      element.onerror = null;
      if (element instanceof HTMLMediaElement) {
        element.onloadedmetadata = null;
        element.ondurationchange = null;
        element.onseeked = null;
        element.pause();
        element.removeAttribute("src");
        element.load();
      } else element.removeAttribute("src");
      if (error) {
        reject(error);
        return;
      }
      if (
        durationSeconds !== undefined &&
        (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
      ) {
        reject(new Error(t("editors.media.error.invalidDuration")));
        return;
      }
      if (resource.kind !== "audio" && (!width || !height)) {
        reject(new Error(t("editors.media.error.invalidSize")));
        return;
      }
      resolve({
        ...resource,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(width && height ? { width, height } : {}),
      });
    };
    const cancel = () => finish(aborted(t));
    const timer = setTimeout(
      () => finish(new Error(t("editors.media.error.timeout"))),
      20000,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (element instanceof HTMLMediaElement) {
      element.preload = "metadata";
      element.muted = true;
      const durationChanged = () => {
        if (!metadataLoaded || finished) return;
        if (Number.isFinite(element.duration) && element.duration > 0) {
          finish();
          return;
        }
        // MediaRecorder WebM often lacks a container duration. Seeking past the
        // end lets the browser demux the local file and report its real duration.
        // The seek target/currentTime is never treated as a duration estimate.
        if (element.duration === Infinity && !probingEnd) {
          probingEnd = true;
          element.preload = "auto";
          try {
            element.currentTime = Number.MAX_SAFE_INTEGER;
          } catch {
            finish(new Error(t("editors.media.error.seekEnd")));
          }
        }
      };
      element.ondurationchange = durationChanged;
      element.onseeked = durationChanged;
      element.onloadedmetadata = () => {
        metadataLoaded = true;
        durationChanged();
      };
    } else element.onload = () => finish();
    element.onerror = () =>
      finish(
        new Error(
          t("editors.media.error.metadata", { title: resource.title }),
        ),
      );
    element.src = resource.src!;
  });
}
