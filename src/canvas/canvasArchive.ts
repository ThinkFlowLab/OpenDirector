import { dataUrlToBlob, downloadFilename } from "./downloadAssets.ts";
import type { CanvasDocument, TimelineTextSourceView } from "./model.ts";
import {
  TIMELINE_TEXT_CAPABILITY,
  timelineHasTextResources,
} from "./timeline.ts";
import { parseDocument } from "./storage.ts";
import { createZip, readZip, type ZipEntry } from "./zipArchive.ts";
import { tNow } from "../i18n/messages.ts";

/** A `.canvas` file is a ZIP archive: `manifest.json` describes the export,
 * `canvas.json` is the document and `assets/` holds the media bytes. Keeps the
 * document readable and stops embedded base64 from bloating a single file. */
export const CANVAS_ARCHIVE_MAGIC = "opendirector-canvas";
/** v3 protects timeline text and its bundled font/source resources.
 * v2 records generation provenance; v1/v2 remain readable for older documents. */
export const CANVAS_ARCHIVE_VERSION = 3;
export const CANVAS_DOCUMENT_ENTRY = "canvas.json";
export const CANVAS_ASSET_DIRECTORY = "assets";

const UNSAFE_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
/** Field names that hold media: node sources, palettes and adopted outputs. */
export const MEDIA_FIELDS = new Set(["src", "sourceImageUri", "output"]);

function textResources(document: CanvasDocument) {
  return [...document.nodes, ...(document.hiddenNodes ?? [])].flatMap(
    (node) => {
      const timeline = node.data.timeline;
      return [
        ...(timeline?.fonts ?? []).map((view) => ({
          view: view as TimelineTextSourceView,
          identity: `font:${node.id}:${view.id}`,
        })),
        ...(timeline?.overlays ?? []).flatMap((overlay) =>
          overlay.source
            ? [
                {
                  view: overlay.source,
                  identity: `source:${node.id}:${overlay.id}`,
                },
              ]
            : [],
        ),
      ];
    },
  );
}

function hasText(document: CanvasDocument): boolean {
  return [...document.nodes, ...(document.hiddenNodes ?? [])].some(
    (node) =>
      node.data.timeline && timelineHasTextResources(node.data.timeline),
  );
}

export interface CanvasArchive {
  blob: Blob;
  filename: string;
  /** Archive-relative paths, in the order they were written. */
  assets: readonly string[];
}

export interface CanvasArchiveOptions {
  /** Reads media bytes. Injectable so exports can be verified off-browser. */
  read?: (src: string) => Promise<Blob>;
  now?: Date;
}

async function readMedia(src: string): Promise<Blob> {
  if (/^data:/i.test(src)) return dataUrlToBlob(src);
  const response = await fetch(src);
  if (!response.ok) throw new Error(tNow("errors.archive.readMedia"));
  return response.blob();
}

function fileName(value: string, fallback: string): string {
  const cleaned = value
    .replace(UNSAFE_FILE_NAME, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return cleaned.slice(0, 80) || fallback;
}

function uniquePath(
  title: string,
  mimeType: string,
  taken: Set<string>,
): string {
  const name = fileName(
    downloadFilename(title, mimeType),
    tNow("errors.archive.mediaFallback"),
  );
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; ; index++) {
    const candidate = `${stem}-${index}${extension}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

async function sha256(data: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface Asset {
  path: string;
  data: Uint8Array;
  mimeType: string;
  byteSize: number;
  sha256?: string;
  /** Where the bytes came from. A generation node's picture must keep its
   * provenance across export/import, or the importer cannot restore the
   * generation binding the backend insists on. */
  provenance?: ArchiveProvenance;
}

/** Provenance the archive carries so imported generation nodes stay valid.
 * `jobId` and `inputFingerprint` are the original execution identity; the
 * importer records them as an imported generation rather than a live job. */
export interface ArchiveProvenance {
  source: "generated" | "edited" | "rendered" | "upload" | "manual";
  jobId?: string;
  inputFingerprint?: string;
  editorDocumentId?: string;
  editorRevision?: number;
}

/** Narrows an untrusted node field into archive provenance, if it fits. */
function asProvenance(value: unknown): ArchiveProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (
    source !== "generated" &&
    source !== "edited" &&
    source !== "rendered" &&
    source !== "upload" &&
    source !== "manual"
  )
    return undefined;
  const provenance: ArchiveProvenance = { source };
  if (typeof record.jobId === "string") provenance.jobId = record.jobId;
  if (typeof record.inputFingerprint === "string")
    provenance.inputFingerprint = record.inputFingerprint;
  if (typeof record.editorDocumentId === "string")
    provenance.editorDocumentId = record.editorDocumentId;
  if (typeof record.editorRevision === "number")
    provenance.editorRevision = record.editorRevision;
  return provenance;
}

/** Media lives in `assets/`; the document keeps a relative reference to it. */
export async function buildCanvasArchive(
  document: CanvasDocument,
  options: CanvasArchiveOptions = {},
): Promise<CanvasArchive> {
  const read = options.read ?? readMedia;
  const copy = structuredClone(document);
  const paths = new Map<string, Promise<string>>();
  const byDigest = new Map<string, string>();
  const taken = new Set<string>();
  const assets: Asset[] = [];

  const register = async (
    src: string,
    title: string,
    mimeType: string,
    provenance?: ArchiveProvenance,
  ): Promise<string> => {
    const known = paths.get(src);
    if (known) return known;
    const pending = (async () => {
      const blob = await read(src);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const type = blob.type || mimeType;
      const digest = await sha256(bytes);
      const shared = digest ? byDigest.get(digest) : undefined;
      if (shared) return shared;
      const path = `${CANVAS_ASSET_DIRECTORY}/${uniquePath(title, type, taken)}`;
      assets.push({
        path,
        data: bytes,
        mimeType: type,
        byteSize: bytes.length,
        sha256: digest,
        provenance,
      });
      if (digest) byDigest.set(digest, path);
      return path;
    })();
    paths.set(src, pending);
    return pending;
  };

  const visit = async (
    value: unknown,
    title: string,
    mimeType: string,
    provenance?: ArchiveProvenance,
  ): Promise<void> => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const ownTitle = typeof record.title === "string" ? record.title : title;
    const ownType =
      typeof record.mimeType === "string" ? record.mimeType : mimeType;
    // A node states where its own picture came from; descendants inherit it.
    const ownProvenance =
      asProvenance(record.generationProvenance) ?? provenance;
    for (const [key, entry] of Object.entries(record)) {
      if (
        MEDIA_FIELDS.has(key) &&
        typeof entry === "string" &&
        /^(data|blob):/i.test(entry)
      )
        record[key] = await register(entry, ownTitle, ownType, ownProvenance);
      else if (typeof entry === "object")
        await visit(entry, ownTitle, ownType, ownProvenance);
    }
  };

  // Timeline Views may expose project media URLs as well as data/blob URLs.
  // Every font and original text source is required for a portable archive.
  for (const { view } of textResources(copy)) {
    if (!view.src)
      throw new Error(
        tNow("errors.archive.textResourceMissing", { title: view.title }),
      );
    view.src = await register(view.src, view.title, view.mimeType);
  }
  await visit(copy, document.title, "");

  const canvasJson = `${JSON.stringify(copy, null, 2)}\n`;
  if (/:\s*"blob:/i.test(canvasJson))
    throw new Error(tNow("errors.archive.transientMedia"));

  const manifest = {
    magic: CANVAS_ARCHIVE_MAGIC,
    formatVersion: hasText(copy) ? CANVAS_ARCHIVE_VERSION : 2,
    ...(hasText(copy)
      ? { requiredCapabilities: [TIMELINE_TEXT_CAPABILITY] }
      : {}),
    name: document.title,
    exportedAt: (options.now ?? new Date()).toISOString(),
    document: CANVAS_DOCUMENT_ENTRY,
    assets: assets.map((asset) => ({
      path: asset.path,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
      ...(asset.provenance ? { provenance: asset.provenance } : {}),
    })),
  };
  const entries: ZipEntry[] = [
    {
      path: "manifest.json",
      data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
      compress: true,
    },
    {
      path: CANVAS_DOCUMENT_ENTRY,
      data: new TextEncoder().encode(canvasJson),
      compress: true,
    },
    ...assets.map((asset) => ({ path: asset.path, data: asset.data })),
  ];
  return {
    blob: await createZip(entries, options.now ?? new Date()),
    filename: `${fileName(document.title, tNow("errors.archive.canvasFallback"))}.canvas`,
    assets: assets.map((asset) => asset.path),
  };
}

export interface CanvasArchiveContents {
  document: CanvasDocument;
  /** Number of media files restored from `assets/`. */
  assets: number;
  /** Provenance per inline media data URL, for v2 archives. The importer uses
   * this to restore generation bindings instead of inventing one. */
  provenance: Map<string, ArchiveProvenance>;
}

interface ArchiveManifest {
  magic?: unknown;
  formatVersion?: unknown;
  document?: unknown;
  requiredCapabilities?: unknown;
  assets?: {
    path?: unknown;
    mimeType?: unknown;
    provenance?: unknown;
    byteSize?: unknown;
    sha256?: unknown;
  }[];
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Character codes of the alphabet, read as bytes when encoding. */
const BASE64_CODES = new Uint8Array(64);
for (let code = 0; code < 64; code++)
  BASE64_CODES[code] = BASE64_ALPHABET.charCodeAt(code);
/** `=` pads the final group when the byte count is not a multiple of three. */
const BASE64_PAD = 61;

/** Standard base64 with padding, the same text `btoa` returns for the
 * equivalent binary string. Writes four ASCII bytes per three input bytes into
 * a buffer and decodes once: an import re-encodes the whole media payload, and
 * one multi-megabyte intermediate string per asset cost more than reading and
 * decompressing the archive itself. */
function base64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let to = 0;
  let from = 0;
  for (; from + 2 < bytes.length; from += 3) {
    const triple =
      (bytes[from]! << 16) | (bytes[from + 1]! << 8) | bytes[from + 2]!;
    out[to++] = BASE64_CODES[(triple >>> 18) & 63]!;
    out[to++] = BASE64_CODES[(triple >>> 12) & 63]!;
    out[to++] = BASE64_CODES[(triple >>> 6) & 63]!;
    out[to++] = BASE64_CODES[triple & 63]!;
  }
  const rest = bytes.length - from;
  if (rest > 0) {
    const triple =
      (bytes[from]! << 16) | (rest === 2 ? bytes[from + 1]! << 8 : 0);
    out[to++] = BASE64_CODES[(triple >>> 18) & 63]!;
    out[to++] = BASE64_CODES[(triple >>> 12) & 63]!;
    out[to++] = rest === 2 ? BASE64_CODES[(triple >>> 6) & 63]! : BASE64_PAD;
    out[to++] = BASE64_PAD;
  }
  // Every encoded byte is ASCII, so a latin1 decode copies it as one string.
  return new TextDecoder("latin1").decode(out.subarray(0, to));
}

/** Reads a `.canvas` archive back into a document whose media is inline again.
 * The exporter stores relative paths, so importing needs no project history. */
export async function readCanvasArchive(
  file: Blob,
): Promise<CanvasArchiveContents> {
  const files = await readZip(file);
  const manifestEntry = files.get("manifest.json");
  if (!manifestEntry) throw new Error(tNow("errors.archive.noManifest"));
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry));
  } catch {
    throw new Error(tNow("errors.archive.manifestInvalid"));
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.magic !== CANVAS_ARCHIVE_MAGIC
  )
    throw new Error(tNow("errors.archive.notCanvas"));
  const version = manifest.formatVersion;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw new Error(tNow("errors.archive.versionInvalid"));
  if (version > CANVAS_ARCHIVE_VERSION)
    throw new Error(tNow("errors.archive.versionNewer", { version }));
  const capabilities =
    manifest.requiredCapabilities === undefined
      ? []
      : manifest.requiredCapabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.some(
      (capability) => capability !== TIMELINE_TEXT_CAPABILITY,
    ) ||
    (version === 3 && !capabilities.includes(TIMELINE_TEXT_CAPABILITY))
  )
    throw new Error(tNow("errors.timeline.capabilityUnsupported"));
  const documentPath =
    typeof manifest.document === "string" && manifest.document
      ? manifest.document
      : CANVAS_DOCUMENT_ENTRY;
  const documentEntry = files.get(documentPath);
  if (!documentEntry)
    throw new Error(
      tNow("errors.archive.missingDocument", { path: documentPath }),
    );
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(documentEntry));
  } catch {
    throw new Error(tNow("errors.archive.documentInvalid"));
  }
  const parsed = parseDocument(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const document = parsed.value;
  if (hasText(document) && version < 3)
    throw new Error(tNow("errors.archive.versionInvalid"));
  const mimeTypes = new Map<string, string>();
  const provenances = new Map<string, ArchiveProvenance>();
  if (manifest.assets !== undefined && !Array.isArray(manifest.assets))
    throw new Error(tNow("errors.archive.manifestInvalid"));
  for (const asset of manifest.assets ?? [])
    if (typeof asset?.path === "string" && typeof asset.mimeType === "string") {
      const bytes = files.get(asset.path);
      if (!bytes)
        throw new Error(
          tNow("errors.archive.missingMedia", { entry: asset.path }),
        );
      if (
        (asset.byteSize !== undefined && asset.byteSize !== bytes.length) ||
        (asset.sha256 !== undefined &&
          (typeof asset.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(asset.sha256) ||
            (await sha256(bytes)) !== asset.sha256))
      )
        throw new Error(tNow("errors.archive.integrity"));
      mimeTypes.set(asset.path, asset.mimeType);
      const provenance = asProvenance(asset.provenance);
      if (provenance) provenances.set(asset.path, provenance);
    }
  const restored = new Set<string>();
  // Keyed by the inline data URL the document ends up holding.
  const provenance = new Map<string, ArchiveProvenance>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (typeof entry === "object") {
        visit(entry);
        continue;
      }
      if (!MEDIA_FIELDS.has(key) || typeof entry !== "string") continue;
      if (/^data:/i.test(entry)) continue;
      if (/^blob:/i.test(entry))
        throw new Error(tNow("errors.archive.transientReference"));
      const bytes = files.get(entry);
      if (!bytes)
        throw new Error(tNow("errors.archive.missingMedia", { entry }));
      const type = mimeTypes.get(entry) || "application/octet-stream";
      const url = `data:${type};base64,${base64(bytes)}`;
      record[key] = url;
      restored.add(entry);
      const known = provenances.get(entry);
      if (known) provenance.set(url, known);
    }
  };
  const bundledViews = textResources(document).filter(
    ({ view }) =>
      view.src?.startsWith(`${CANVAS_ASSET_DIRECTORY}/`) && files.has(view.src),
  );
  visit(document);
  for (const { view, identity } of bundledViews) {
    const original = view.asset;
    view.importIdentity = original
      ? `asset:${original.kind}:${original.assetId}:${original.revision}:${original.fingerprint}`
      : (view.importIdentity ?? identity);
    delete view.asset;
  }
  return { document, assets: restored.size, provenance };
}
