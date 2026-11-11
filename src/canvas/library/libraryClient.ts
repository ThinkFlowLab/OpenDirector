/** Typed client for the global cross-canvas library (docs/ASSET-LIBRARY-DESIGN.md §6). */
import { useEffect, useState } from "react";
import { request, responseError, headers } from "../../backend/api.ts";
import {
  cachedRequest,
  invalidateCached,
  peekCached,
  prefetchRequest,
} from "../../backend/requestCache.ts";
import { tNow } from "../../i18n/messages.ts";
import type { Translate } from "../../i18n/I18nProvider";
import type {
  MessageDescriptor,
  MessageKey,
  MessageParams,
} from "../../i18n/types";
import type { CanvasResource } from "../model";

export type LibraryKind = "asset" | "subject";
export type LibraryState = "active" | "trashed";
export type LibraryMediaKind = "image" | "video" | "audio" | "file";

/** Module-level fallback for helpers that cannot call React hooks. */
const nowTranslate: Translate = (
  input: MessageKey | MessageDescriptor,
  params?: MessageParams,
) =>
  typeof input === "string"
    ? tNow(input, params)
    : tNow(input.key, input.params);

export type LibraryItem = {
  id: string;
  kind: LibraryKind;
  state: LibraryState;
  name: string;
  revision: number;
  createdAt: string;
  trashedAt: string | null;
  blob: string | null;
  subject: {
    description: string;
    category: string;
    main: string | null;
    auxiliaries: string[];
    voice: string | null;
  } | null;
  mediaKind: LibraryMediaKind | null;
  metadata: {
    mimeType: string;
    size: number;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
  } | null;
  preview: string | null;
  origin: {
    type: "upload" | "canvas";
    projectId: string | null;
    nodeId: string | null;
    assetId: string | null;
  };
};

/**
 * Category tabs differ per panel and must not be shared (design R3):
 * the library only stores four media kinds, while a canvas view projects
 * text/subject/timeline nodes that are not media files at all.
 */
export const ASSET_CATEGORIES = [
  { key: "image", labelKey: "library.category.image" },
  { key: "video", labelKey: "library.category.video" },
  { key: "audio", labelKey: "library.category.audio" },
  { key: "file", labelKey: "library.category.file" },
] as const satisfies readonly { key: string; labelKey: MessageKey }[];

export const CANVAS_CATEGORIES = [
  { key: "image", labelKey: "library.category.image" },
  { key: "video", labelKey: "library.category.video" },
  { key: "audio", labelKey: "library.category.audio" },
  { key: "text", labelKey: "library.category.text" },
  { key: "subject", labelKey: "library.category.subject" },
  { key: "timeline", labelKey: "library.category.timeline" },
] as const satisfies readonly { key: string; labelKey: MessageKey }[];

export function itemContentUrl(item: LibraryItem): string {
  // Direct <img src> would omit X-OpenDirector-Request and get a 403, so media is
  // fetched with headers and turned into an object URL by useItemContentUrl().
  return `/api/library/items/${item.id}/content`;
}

/**
 * Fetches library bytes with the required headers and exposes a blob: URL,
 * mirroring how canvas nodes load media (CreationClient.mediaUrl).
 */
/** Reads an item's bytes; used when copying library media into a canvas. */
export async function itemBlob(item: LibraryItem): Promise<Blob> {
  const response = await fetch(itemContentUrl(item), { headers });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

/**
 * Maps a library item onto the canvas resource model. Library media kinds are
 * image/video/audio/file; the canvas treats non-media documents as `file`.
 */
export function itemToResource(item: LibraryItem): CanvasResource {
  const kind = item.mediaKind ?? "file";
  return {
    id: item.id,
    kind,
    title: item.name,
    mimeType: item.metadata?.mimeType,
    byteSize: item.metadata?.size,
    ...(item.metadata?.width != null ? { width: item.metadata.width } : {}),
    ...(item.metadata?.height != null ? { height: item.metadata.height } : {}),
    ...(item.metadata?.durationSeconds != null
      ? { durationSeconds: item.metadata.durationSeconds }
      : {}),
  };
}

export function useItemContentUrl(
  item: LibraryItem | null,
  t: Translate = nowTranslate,
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!item) {
      setUrl(undefined);
      return;
    }
    let revoked = false;
    let objectUrl: string | undefined;
    fetch(itemContentUrl(item), { headers })
      .then((response) => {
        if (!response.ok) throw new Error(t("library.media.readFailed"));
        return response.blob();
      })
      .then((blob) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!revoked) setUrl(undefined);
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item]);
  return url;
}

const MEDIA_SUFFIXES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "text/markdown": ".md",
  "text/plain": ".txt",
};

/**
 * Canvas node titles ("图片 1") carry no extension, but the backend identifies
 * uploads by file suffix — an extensionless name is rejected as an unsupported
 * format even when the bytes are a valid PNG. Names that already have a suffix
 * are left untouched.
 */
export function withMediaSuffix(name: string, mimeType?: string): string {
  if (/\.[A-Za-z0-9]{1,5}$/.test(name)) return name;
  const suffix = MEDIA_SUFFIXES[(mimeType ?? "").toLowerCase()];
  return suffix ? `${name}${suffix}` : name;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

export type LibraryQuery = {
  kind?: LibraryKind;
  state?: LibraryState;
  query?: string;
  mediaKind?: LibraryMediaKind;
};

const itemsPath = (options: LibraryQuery) =>
  `/library/items${query({
    kind: options.kind,
    state: options.state,
    query: options.query,
    mediaKind: options.mediaKind,
  })}`;
const itemsKey = (options: LibraryQuery) => `library:items${itemsPath(options)}`;

export async function listItems(
  options: LibraryQuery = {},
  read: { fresh?: boolean } = {},
): Promise<LibraryItem[]> {
  return cachedRequest<LibraryItem[]>(
    itemsKey(options),
    () => request<LibraryItem[]>(itemsPath(options)),
    read,
  );
}

/** Rows already fetched for this session, so a reopened tab paints instantly. */
export const peekItems = (options: LibraryQuery = {}) =>
  peekCached<LibraryItem[]>(itemsKey(options));

/**
 * A refreshed list usually holds the same rows. Keeping the previous array in
 * that case leaves card props untouched, so media is not downloaded again.
 */
export function sameLibraryItems(
  previous: LibraryItem[],
  next: LibraryItem[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every(
      (item, index) =>
        item.id === next[index]?.id && item.revision === next[index]?.revision,
    )
  );
}

export function prefetchItems(options: LibraryQuery = {}) {
  prefetchRequest(itemsKey(options), () =>
    request<LibraryItem[]>(itemsPath(options)),
  );
}

/** A write makes every cached library list eligible to change. */
function changed<T>(value: T): T {
  invalidateCached("library:");
  return value;
}

export async function uploadItem(file: File): Promise<LibraryItem> {
  const response = await fetch(
    `/api/library/items/upload${query({ name: file.name })}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    },
  );
  if (!response.ok) throw await responseError(response);
  return changed((await response.json()) as LibraryItem);
}

export async function addFromCanvas(
  projectId: string,
  assetId: string,
  name?: string,
): Promise<LibraryItem> {
  return changed(
    await request<LibraryItem>("/library/items/from-canvas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, assetId, ...(name ? { name } : {}) }),
    }),
  );
}

/**
 * Backs up canvas media that is embedded in the document (a `data:` URL)
 * rather than stored as a backend asset. The bytes already exist in the
 * browser, so they are posted directly and stored as a library blob (L1).
 */
export async function addInlineFromCanvas(
  src: string,
  name: string,
  options: { projectId?: string; assetId?: string; mimeType?: string } = {},
  t: Translate = nowTranslate,
): Promise<LibraryItem> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(t("library.media.inlineReadFailed"));
  const blob = await response.blob();
  const mime =
    options.mimeType || blob.type || "application/octet-stream";
  const search = new URLSearchParams({ name });
  if (options.projectId) search.set("project_id", options.projectId);
  if (options.assetId) search.set("asset_id", options.assetId);
  const upload = await fetch(
    `/api/library/items/from-canvas-inline?${search.toString()}`,
    { method: "POST", headers: { ...headers, "content-type": mime }, body: blob },
  );
  if (!upload.ok) throw await responseError(upload);
  return changed((await upload.json()) as LibraryItem);
}

export async function addSubject(
  payload: {
    projectId: string;
    nodeId: string;
    name: string;
    description?: string;
    category?: string;
    main?: string | null;
    auxiliaries?: string[];
    voice?: string | null;
    preview?: string | null;
  },
): Promise<LibraryItem> {
  return changed(
    await request<LibraryItem>("/library/items/from-subject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function renameItem(id: string, name: string): Promise<LibraryItem> {
  return changed(
    await request<LibraryItem>(`/library/items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
}

export async function trashItems(itemIds: string[]): Promise<LibraryItem[]> {
  return changed(
    await request<LibraryItem[]>("/library/items/trash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemIds }),
    }),
  );
}

export async function restoreItems(itemIds: string[]): Promise<LibraryItem[]> {
  return changed(
    await request<LibraryItem[]>("/library/trash/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemIds }),
    }),
  );
}

export async function purgeAll(): Promise<{
  purged: string[];
  blobsRemoved: string[];
}> {
  return changed(await request("/library/trash", { method: "DELETE" }));
}

export async function purgeOne(
  id: string,
): Promise<{ purged: string[]; blobsRemoved: string[] }> {
  return changed(await request(`/library/trash/${id}`, { method: "DELETE" }));
}
