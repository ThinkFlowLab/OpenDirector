/**
 * Downloads an example canvas and normalizes whatever arrived into a `.canvas`
 * archive. The served file is frequently a ZIP that wraps a single `.canvas`,
 * so the bytes — not the file name — decide what was downloaded.
 */
import { readZip } from "../../zipArchive.ts";
import { exampleUrlAllowed, type ExampleEntry } from "./exampleCatalog.ts";

export type ExampleErrorCode =
  | "invalidUrl"
  | "aborted"
  | "network"
  | "http"
  | "tooLarge"
  | "html"
  | "notArchive"
  | "ambiguous"
  | "notCanvas"
  | "integrity";

/** A classified failure; the UI owns the wording for each code. */
export class ExampleError extends Error {
  readonly code: ExampleErrorCode;
  readonly status?: number;

  constructor(code: ExampleErrorCode, message?: string, status?: number) {
    super(message ?? code);
    this.name = "ExampleError";
    this.code = code;
    this.status = status;
  }
}

/** Upper bound for one download; the shipped samples are ~26 MB. */
export const EXAMPLE_MAX_BYTES = 256 * 1024 * 1024;

/** Whole-request deadline, including the streaming body read. */
export const EXAMPLE_TIMEOUT_MS = 120_000;

export interface ExampleDownloadOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface NormalizedCanvas {
  /** Bytes of the `.canvas` archive itself, ready for `readCanvasArchive`. */
  bytes: Uint8Array;
  kind: "canvas" | "zip-wrapper";
  /** Outer entry that was unwrapped, when `kind` is `zip-wrapper`. */
  innerEntry?: string;
}

export interface ExampleDownload extends NormalizedCanvas {
  /** Size of the response body before unwrapping. */
  outerBytes: number;
  /**
   * Zeroes the downloaded buffers and drops this object's claim on them.
   * Idempotent, so a failure path and a success path can both call it.
   */
  release: () => void;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const HTML_MARKERS = new Set([0x3c /* < */, 0x7b /* { */]);
const CANVAS_ENTRY = /\.canvas$/i;

function isZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((value, index) => bytes[index] === value);
}

/** Login pages and JSON error bodies are the usual "download" of a blocked link. */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  for (const byte of bytes.subarray(0, 512)) {
    // Skip a UTF-8 BOM and leading whitespace before judging the first byte.
    if (byte === 0xef || byte === 0xbb || byte === 0xbf) continue;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return HTML_MARKERS.has(byte);
  }
  return false;
}

async function sha256Hex(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Links the caller's signal with the deadline, without leaking a listener. */
function withDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const aborter = new AbortController();
  const forward = () => aborter.abort();
  if (signal) {
    if (signal.aborted) aborter.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }
  const timer = setTimeout(() => aborter.abort(), timeoutMs);
  return {
    signal: aborter.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

function abortedError(cause: unknown): ExampleError {
  if (cause instanceof ExampleError) return cause;
  return new ExampleError("aborted", "the download was cancelled");
}

/** Distinguishes a cancelled request from a transport failure. */
function transportError(cause: unknown, cancelled: boolean): ExampleError {
  if (cause instanceof ExampleError) return cause;
  if (cancelled) return abortedError(cause);
  return new ExampleError(
    "network",
    cause instanceof Error ? cause.message : undefined,
  );
}

/** Reads the body under a byte budget so a huge file cannot fill memory first. */
async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new ExampleError("tooLarge");
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ExampleError("tooLarge");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetches the entry's URL and returns the raw response bytes. */
export async function fetchExampleBytes(
  entry: ExampleEntry,
  options: ExampleDownloadOptions = {},
): Promise<Uint8Array> {
  if (!exampleUrlAllowed(entry.url))
    throw new ExampleError("invalidUrl", entry.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? EXAMPLE_MAX_BYTES;
  const deadline = withDeadline(options.signal, options.timeoutMs ?? EXAMPLE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(entry.url, {
        method: "GET",
        mode: "cors",
        // Never send cookies to a third-party origin; the hosted copy is public.
        credentials: "omit",
        redirect: "follow",
        // The link resolves to a short-lived CDN path; a cached body would rot.
        cache: "no-store",
        signal: deadline.signal,
      });
    } catch (cause) {
      throw transportError(cause, deadline.signal.aborted);
    }
    if (!response.ok)
      throw new ExampleError("http", `status ${response.status}`, response.status);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new ExampleError("tooLarge");
    let bytes: Uint8Array;
    try {
      bytes = await readLimited(response, maxBytes);
    } catch (cause) {
      throw transportError(cause, deadline.signal.aborted);
    }
    if (bytes.byteLength === 0) throw new ExampleError("notArchive");
    if (entry.sha256) {
      const digest = await sha256Hex(bytes);
      if (digest && digest !== entry.sha256) throw new ExampleError("integrity");
    }
    return bytes;
  } finally {
    deadline.dispose();
  }
}

/**
 * Turns the downloaded bytes into the `.canvas` archive to import.
 *
 * - a plain archive (its manifest sits at the ZIP root) is returned untouched
 * - a ZIP holding exactly one `.canvas` entry is unwrapped one level
 * - anything else is reported, never guessed
 */
export async function normalizeToCanvas(
  bytes: Uint8Array,
): Promise<NormalizedCanvas> {
  if (!bytes.byteLength) throw new ExampleError("notArchive");
  if (looksLikeMarkup(bytes)) throw new ExampleError("html");
  if (!isZip(bytes)) throw new ExampleError("notArchive");
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(bytes);
  } catch {
    // A truncated or damaged container is a download problem, not a canvas one.
    throw new ExampleError("notArchive");
  }
  if (files.has("manifest.json")) return { bytes, kind: "canvas" };
  const canvases = [...files.keys()].filter(
    (name) => !name.endsWith("/") && CANVAS_ENTRY.test(name),
  );
  if (canvases.length !== 1) throw new ExampleError("ambiguous");
  const innerEntry = canvases[0]!;
  const inner = files.get(innerEntry)!;
  if (!inner.byteLength) throw new ExampleError("notArchive");
  return { bytes: inner, kind: "zip-wrapper", innerEntry };
}

/** Download plus normalization, with the optional inner digest checked. */
export async function fetchExampleCanvas(
  entry: ExampleEntry,
  options: ExampleDownloadOptions = {},
): Promise<ExampleDownload> {
  const outer = await fetchExampleBytes(entry, options);
  const normalized = await normalizeToCanvas(outer);
  if (entry.inner?.sha256) {
    const digest = await sha256Hex(normalized.bytes);
    if (digest && digest !== entry.inner.sha256)
      throw new ExampleError("integrity");
  }
  // Both buffers are ours: the wrapper's bytes and, when unwrapped, the inner
  // entry copy. Zeroing them is the only copy this module ever creates.
  const buffers = [outer, normalized.bytes];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const buffer of buffers) buffer.fill(0);
  };
  return { ...normalized, outerBytes: outer.byteLength, release };
}
