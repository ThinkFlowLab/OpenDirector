/** Exact-byte, user-triggered archive of per-turn raw trace files. No normalization or redaction. */
import { traceRuntime, traceSources, type ConversationTurn } from "./traceTurns.ts";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 512;
const SOURCES = new Set(["opencode", "model", "codex", "claude", "jiuwenswarm", "deepseek"]);
const encoder = new TextEncoder();

type ZipEntry = { name: string; data: Uint8Array };
type SourceEntry = { source: string; file?: string; status: "included" | "missing" | "unsupported" };
type JobEntry = { jobId: string; status: string; adopted: boolean };
type ManifestTurn = {
  id: string; number: number; runtime: string; status: string;
  sources: SourceEntry[]; jobs: JobEntry[] | null;
};

/** Read bytes, not text; fail closed on oversized or unsuccessful source reads. */
async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > limit) throw new Error("Trace archive size limit exceeded");
  if (!response.body) {
    const value = new Uint8Array(await response.arrayBuffer());
    if (value.byteLength > limit) throw new Error("Trace archive size limit exceeded");
    return value;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Trace archive size limit exceeded");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    // The browser's source stream is released on success; cancel a failed/oversized read.
    if (size > limit) await response.body?.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.byteLength; }
  return result;
}

async function linkedJobs(fetcher: typeof fetch, base: string, id: string): Promise<JobEntry[] | null> {
  try {
    const response = await fetcher(base + "/turns/" + encodeURIComponent(id) + "/jobs",
      { headers: { "X-OpenDirector-Request": "1" } });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return null;
    return payload.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const value = entry as Record<string, unknown>;
      if (typeof value.jobId !== "string") return [];
      return [{ jobId: value.jobId, status: typeof value.status === "string" ? value.status : "unknown",
        adopted: value.adopted === true }];
    });
  } catch { return null; }
}

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

/** ZIP32 with uncompressed STORE entries: original JSONL bytes stay byte-for-byte identical. */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_FILES + 1) throw new Error("Too many trace archive files");
  const prepared = entries.map(({ name, data }) => ({
    name: encoder.encode(name), data, crc: crc32(data),
  }));
  let localSize = 0, centralSize = 0;
  for (const item of prepared) {
    if (item.name.length > 65535) throw new Error("Trace filename is too long");
    localSize += 30 + item.name.length + item.data.length;
    centralSize += 46 + item.name.length;
  }
  if (localSize + centralSize + 22 > MAX_ARCHIVE_BYTES + 65536)
    throw new Error("Trace archive size limit exceeded");
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(bytes.buffer);
  let pos = 0;
  const u16 = (value: number) => { view.setUint16(pos, value, true); pos += 2; };
  const u32 = (value: number) => { view.setUint32(pos, value, true); pos += 4; };
  const put = (value: Uint8Array) => { bytes.set(value, pos); pos += value.length; };
  const offsets: number[] = [];
  for (const item of prepared) {
    offsets.push(pos);
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(0); u16(0);
    u32(item.crc); u32(item.data.length); u32(item.data.length);
    u16(item.name.length); u16(0); put(item.name); put(item.data);
  }
  const centralOffset = pos;
  prepared.forEach((item, index) => {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(0); u16(0);
    u32(item.crc); u32(item.data.length); u32(item.data.length);
    u16(item.name.length); u16(0); u16(0); u16(0); u16(0); u32(0);
    u32(offsets[index]); put(item.name);
  });
  u32(0x06054b50); u16(0); u16(0); u16(prepared.length); u16(prepared.length);
  u32(pos - centralOffset); u32(centralOffset); u16(0);
  return bytes;
}

/**
 * Fetch each source as-is. Missing (404) logs appear in the manifest; other errors abort.
 * All turns are included, regardless of which UI panels are expanded.
 */
export async function conversationTraceArchive(project: string, conversationId: string,
  turns: ConversationTurn[], fetcher: typeof fetch = fetch,
  generatedAt = new Date().toISOString()): Promise<Uint8Array> {
  const base = "/api/creation/projects/" + encodeURIComponent(project) + "/assistant";
  const files: ZipEntry[] = [];
  const manifestTurns: ManifestTurn[] = [];
  let total = 0;
  for (const [index, turn] of turns.entries()) {
    const sources: SourceEntry[] = [];
    const names = traceSources(traceRuntime(turn.runtime));
    const directory = "turn-" + String(index + 1).padStart(4, "0") + "/";
    for (const source of names) {
      if (!SOURCES.has(source)) { sources.push({ source, status: "unsupported" }); continue; }
      const response = await fetcher(base + "/traces/" + encodeURIComponent(turn.id) + "/" +
        encodeURIComponent(source), { headers: { "X-OpenDirector-Request": "1" } });
      if (response.status === 404) { sources.push({ source, status: "missing" }); continue; }
      if (!response.ok) throw new Error("Could not read original trace: " + source);
      const bytes = await readBytes(response, Math.min(MAX_SOURCE_BYTES, MAX_ARCHIVE_BYTES - total));
      const name = directory + source + ".jsonl";
      files.push({ name, data: bytes });
      total += bytes.byteLength;
      if (files.length > MAX_FILES) throw new Error("Too many trace archive files");
      sources.push({ source, file: name, status: "included" });
    }
    manifestTurns.push({ id: turn.id, number: turn.number, runtime: turn.runtime,
      status: turn.status, sources, jobs: await linkedJobs(fetcher, base, turn.id) });
  }
  const manifest = encoder.encode(JSON.stringify({
    format: "opendirector-original-trace-archive", version: 1,
    projectId: project, conversationId, exportedAt: generatedAt,
    warning: "Original trace data may include credentials, prompts, tool inputs/outputs and private paths. Review before sharing.",
    turns: manifestTurns,
  }, null, 2) + "\n");
  if (total + manifest.length > MAX_ARCHIVE_BYTES) throw new Error("Trace archive size limit exceeded");
  files.unshift({ name: "manifest.json", data: manifest });
  return zipStore(files);
}
