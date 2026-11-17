/**
 * Remote example canvases: catalog parsing, validation and the fallback order.
 *
 * The catalog is data, never code: a remote copy may be updated without an app
 * release, an in-app copy keeps first launch working offline, and a compiled-in
 * list keeps the entry usable when both files are missing.
 */
export interface ExampleText {
  "zh-CN": string;
  "en-US": string;
}

/** What the downloader is expected to find behind `url`. Content wins over this hint. */
export type ExampleContentKind = "auto" | "canvas" | "zip-wrapper";

/** Observed metadata for a `.canvas` entry wrapped inside an outer ZIP. */
export interface ExampleInner {
  entry: string;
  sha256?: string;
  bytes?: number;
  archiveVersion?: number;
  assets?: number;
  nodes?: number;
}

export interface ExampleManualDownload {
  shareUrl?: string;
  code?: string;
}

export interface ExampleEntry {
  id: string;
  title: ExampleText;
  summary?: ExampleText;
  url: string;
  filename?: string;
  sha256?: string;
  bytes?: number;
  contentKind?: ExampleContentKind;
  archiveVersion?: number;
  minAppVersion?: string;
  manual?: ExampleManualDownload;
  inner?: ExampleInner;
}

export interface ExampleCatalog {
  schemaVersion: number;
  updatedAt?: string;
  items: ExampleEntry[];
}

export type CatalogSource = "remote" | "builtin" | "code";

export interface RejectedEntry {
  /** The offending id when it parsed well enough to be reported. */
  id?: string;
  reason: string;
}

export interface ExampleCatalogResult {
  catalog: ExampleCatalog;
  source: CatalogSource;
  rejected: RejectedEntry[];
}

export const EXAMPLE_CATALOG_SCHEMA_VERSION = 1;

/** Served by the app itself; the build copies `public/` to the site root. */
export const EXAMPLE_CATALOG_BUILTIN_PATH = "/example-canvases.json";

/**
 * Hosts a catalog may download from. Suffix entries match their subdomains, so
 * one object-storage line covers every regional bucket endpoint.
 */
export const EXAMPLE_ALLOWED_HOSTS: readonly string[] = [
  "lz.qaiu.top",
  "webgetstore.com",
  "aliyuncs.com",
  "myqcloud.com",
  "volces.com",
  "qiniucdn.com",
  "qbox.me",
];

/**
 * Compiled-in fallback. Kept in step with `public/example-canvases.json`; the
 * sizes and digests here were measured on 2026-11-17 (see the development doc).
 */
export const BUILTIN_EXAMPLE_CATALOG: ExampleCatalog = {
  schemaVersion: EXAMPLE_CATALOG_SCHEMA_VERSION,
  updatedAt: "2026-11-17T06:40:00Z",
  items: [
    {
      id: "image-canvas",
      title: {
        "zh-CN": "图像创作示例画布",
        "en-US": "Image creation example canvas",
      },
      summary: {
        "zh-CN": "图片生成、主体替换与参考素材的入门示例",
        "en-US": "Image generation, subject replacement and references",
      },
      url: "https://lz.qaiu.top/parser?url=https://wwbks.lanzouv.com/i1BWT4ga8c6h&pwd=4b6t",
      filename: "图像创作示例画布.zip",
      sha256:
        "12566c858dab7a4ccbefa757a0d69965b526b9c253b472034137445f1c93b0cb",
      bytes: 27582888,
      contentKind: "zip-wrapper",
      inner: {
        entry: "图像创作示例画布.canvas",
        sha256:
          "60f40d2aaa54b65724081efab1b58b0e41f0dd78d6793dcf95ea9ee3dd97f911",
        bytes: 27689522,
        archiveVersion: 2,
        assets: 5,
        nodes: 12,
      },
    },
    {
      id: "video-canvas",
      title: {
        "zh-CN": "视频创作示例画布",
        "en-US": "Video creation example canvas",
      },
      summary: {
        "zh-CN": "时间线、文生视频与图生视频的组合示例",
        "en-US": "Timeline with text-to-video and image-to-video",
      },
      url: "https://lz.qaiu.top/parser?url=https://wwbks.lanzouv.com/iUPML4ga8bch&pwd=905a",
      filename: "视频创作示例画布.zip",
      sha256:
        "9c1662d6eec2ee1f9765ca53473cd1a93ab0ceeb841e8c0db895cd522a0bb13e",
      bytes: 26086524,
      contentKind: "zip-wrapper",
      inner: {
        entry: "视频创作示例画布.canvas",
        sha256:
          "76b10a86f0900816095c2b03c7533514db7fbe4ee968fe8338da55905e1cd8e5",
        bytes: 26128975,
        archiveVersion: 2,
        assets: 9,
        nodes: 17,
      },
    },
  ],
};

const KINDS = new Set<ExampleContentKind>(["auto", "canvas", "zip-wrapper"]);
const HOST_LOCATOR = /^[a-z0-9.-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+(?:\.\d+)*$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is ExampleText {
  return (
    record(value) &&
    typeof value["zh-CN"] === "string" &&
    !!value["zh-CN"].trim() &&
    typeof value["en-US"] === "string" &&
    !!value["en-US"].trim()
  );
}

function optionalText(value: unknown): ExampleText | undefined {
  if (value === undefined) return undefined;
  return text(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && !!value.trim() ? value : undefined;
}

function optionalDigest(value: unknown): string | undefined {
  return typeof value === "string" && SHA256.test(value) ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Exact host, or a suffix entry such as `aliyuncs.com` covering its subdomains. */
export function exampleHostAllowed(host: string): boolean {
  const name = host.toLowerCase();
  return EXAMPLE_ALLOWED_HOSTS.some(
    (allowed) => name === allowed || name.endsWith(`.${allowed}`),
  );
}

/** HTTPS only, and only to a host the catalog is allowed to reach. */
export function exampleUrlAllowed(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    !!parsed.hostname &&
    HOST_LOCATOR.test(parsed.hostname) &&
    exampleHostAllowed(parsed.hostname)
  );
}

function parseInner(value: unknown): ExampleInner | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) return undefined;
  const entry = optionalString(value.entry);
  if (!entry) return undefined;
  return {
    entry,
    sha256: optionalDigest(value.sha256),
    bytes: optionalCount(value.bytes),
    archiveVersion: optionalCount(value.archiveVersion),
    assets: optionalCount(value.assets),
    nodes: optionalCount(value.nodes),
  };
}

function parseManual(value: unknown): ExampleManualDownload | undefined {
  if (!record(value)) return undefined;
  const shareUrl = optionalString(value.shareUrl);
  const code = optionalString(value.code);
  if (!shareUrl && !code) return undefined;
  return { shareUrl, code };
}

/** Returns the entry, or the reason it cannot be used. */
export function parseExampleEntry(
  value: unknown,
): { entry: ExampleEntry } | { id?: string; reason: string } {
  if (!record(value)) return { reason: "entry is not an object" };
  const id = optionalString(value.id);
  if (!id) return { reason: "missing id" };
  if (!text(value.title)) return { id, reason: "title must fill zh-CN and en-US" };
  const url = optionalString(value.url);
  if (!url) return { id, reason: "missing url" };
  if (!exampleUrlAllowed(url)) return { id, reason: "url must be https on an allowed host" };
  const sha256 = optionalDigest(value.sha256);
  if (value.sha256 !== undefined && !sha256)
    return { id, reason: "sha256 must be 64 lowercase hex characters" };
  const bytes = optionalCount(value.bytes);
  if (value.bytes !== undefined && bytes === undefined)
    return { id, reason: "bytes must be a non-negative integer" };
  const contentKind =
    typeof value.contentKind === "string" && KINDS.has(value.contentKind as ExampleContentKind)
      ? (value.contentKind as ExampleContentKind)
      : "auto";
  const minAppVersion = optionalString(value.minAppVersion);
  if (minAppVersion && !VERSION.test(minAppVersion))
    return { id, reason: "minAppVersion must be dotted digits" };
  return {
    entry: {
      id,
      title: value.title,
      summary: optionalText(value.summary),
      url,
      filename: optionalString(value.filename),
      sha256,
      bytes,
      contentKind,
      archiveVersion: optionalCount(value.archiveVersion),
      minAppVersion,
      manual: parseManual(value.manual),
      inner: parseInner(value.inner),
    },
  };
}

/**
 * Validates a catalog document. Unusable entries are reported and dropped
 * rather than failing the whole list, so one bad row cannot hide the others.
 */
export function parseExampleCatalog(value: unknown): {
  catalog: ExampleCatalog;
  rejected: RejectedEntry[];
} {
  if (!record(value)) throw new Error("catalog is not an object");
  if (value.schemaVersion !== EXAMPLE_CATALOG_SCHEMA_VERSION)
    throw new Error("unsupported catalog schemaVersion");
  if (!Array.isArray(value.items)) throw new Error("catalog items must be an array");
  const items: ExampleEntry[] = [];
  const rejected: RejectedEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value.items) {
    const parsed = parseExampleEntry(raw);
    if (!("entry" in parsed)) {
      rejected.push({ id: "id" in parsed ? parsed.id : undefined, reason: parsed.reason });
      continue;
    }
    if (seen.has(parsed.entry.id)) {
      rejected.push({ id: parsed.entry.id, reason: "duplicate id" });
      continue;
    }
    seen.add(parsed.entry.id);
    items.push(parsed.entry);
  }
  return {
    catalog: { schemaVersion: EXAMPLE_CATALOG_SCHEMA_VERSION, updatedAt: optionalString(value.updatedAt), items },
    rejected,
  };
}

/** Dotted numeric comparison; unparsable input sorts below any real version. */
export function compareAppVersions(left: string, right: string): number {
  const a = VERSION.test(left) ? left.split(".").map(Number) : [];
  const b = VERSION.test(right) ? right.split(".").map(Number) : [];
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Entries this build can import. `minAppVersion` keeps newer samples out of
 * older apps; when the running version is unknown the gate is skipped rather
 * than hiding every sample.
 */
export function availableExamples(
  catalog: ExampleCatalog,
  appVersion?: string,
): ExampleEntry[] {
  return catalog.items.filter(
    (item) =>
      !item.minAppVersion ||
      !appVersion ||
      compareAppVersions(appVersion, item.minAppVersion) >= 0,
  );
}

async function readCatalogFile(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<ExampleCatalog> {
  const response = await fetchImpl(url, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`catalog responded ${response.status}`);
  const parsed: unknown = await response.json();
  return parseExampleCatalog(parsed).catalog;
}

/**
 * Loads the catalog without ever failing: remote, then app copy, then the
 * compiled-in list. `rejected` reports rows dropped while validating.
 */
export async function loadExampleCatalog(
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    remoteUrl?: string;
    builtinUrl?: string;
    appVersion?: string;
  } = {},
): Promise<ExampleCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const builtinUrl = options.builtinUrl ?? EXAMPLE_CATALOG_BUILTIN_PATH;
  const rejected: RejectedEntry[] = [];
  for (const [source, url] of [
    ["remote", options.remoteUrl],
    ["builtin", builtinUrl],
  ] as const) {
    if (!url) continue;
    try {
      const parsed: unknown = await (async () => {
        const response = await fetchImpl(url, {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          signal: options.signal,
        });
        if (!response.ok) throw new Error(`catalog responded ${response.status}`);
        return response.json();
      })();
      const validated = parseExampleCatalog(parsed);
      rejected.push(...validated.rejected);
      return { catalog: validated.catalog, source, rejected };
    } catch {
      /* A missing or malformed copy falls through to the next source. */
    }
  }
  const fallback = parseExampleCatalog(BUILTIN_EXAMPLE_CATALOG);
  rejected.push(...fallback.rejected);
  return { catalog: fallback.catalog, source: "code", rejected };
}

/** One entry by id, for reopening a sample the user already imported. */
export function exampleById(
  catalog: ExampleCatalog,
  id: string,
): ExampleEntry | undefined {
  return catalog.items.find((item) => item.id === id);
}

export { readCatalogFile };
