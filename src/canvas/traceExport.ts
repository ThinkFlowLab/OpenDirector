/** Exact-byte, user-triggered archive of per-turn raw trace files. No normalization or redaction.
 * Sources are read one at a time, so the archive is not an atomic snapshot: it is only produced
 * when no turn is running before and after the reads, and any inconsistency fails the export. */
import { createZip, type ZipEntry } from "./zipArchive.ts";
import { traceRuntime, traceSources, type ConversationTurn } from "./traceTurns.ts";

/** Total budget for raw bytes plus ZIP headers, central directory and manifest. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 512;
const REQUEST_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 10 * 60_000;
const SOURCES = new Set(["opencode", "model", "codex", "claude", "jiuwenswarm", "deepseek"]);
const encoder = new TextEncoder();

export type TraceExportErrorCode =
  | "running" | "tooLarge" | "tooManyFiles" | "read" | "incomplete" | "changed" | "timeout" | "aborted";

/** Failure with enough structure for the UI to name the turn and source involved. */
export type TraceExportDetail = {
  turn?: number; source?: string; status?: number; limit?: number; cause?: unknown };

export class TraceExportError extends Error {
  readonly code: TraceExportErrorCode;
  readonly detail: TraceExportDetail;
  constructor(code: TraceExportErrorCode, detail: TraceExportDetail = {}) {
    super("Trace export failed: " + code
      + (detail.turn ? " turn " + detail.turn : "") + (detail.source ? " " + detail.source : "")
      + (detail.status ? " HTTP " + detail.status : ""));
    this.name = "TraceExportError";
    this.code = code;
    this.detail = detail;
  }
}

export type TraceExportOptions = {
  fetcher?: typeof fetch;
  generatedAt?: string;
  signal?: AbortSignal;
  /** Bound for one request including its body. */
  requestTimeoutMs?: number;
  /** Bound for the whole export. */
  totalTimeoutMs?: number;
  /** Raw data and archive overhead cap. */
  maxArchiveBytes?: number;
};

type SourceEntry = { source: string; file?: string; bytes?: number; status: "included" | "missing" | "unsupported" };
type JobEntry = { jobId: string; status: string; adopted: boolean };
type ManifestTurn = {
  id: string; number: number; runtime: string; status: string;
  sources: SourceEntry[]; jobs: JobEntry[] | null; jobsStatus: "ok" | "unavailable";
};

const HEADERS = { "X-OpenDirector-Request": "1" };

/** Reject as soon as the signal aborts, even if the underlying fetcher ignores it. */
function guard<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Per-request signal that aborts on timeout (request or remaining total) or the caller's signal. */
function requestScope(outer: AbortSignal, timeoutMs: number, turn?: number, source?: string) {
  const controller = new AbortController();
  const forward = () => controller.abort(outer.reason);
  if (outer.aborted) forward(); else outer.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new TraceExportError("timeout", { turn, source })), timeoutMs);
  return {
    signal: controller.signal,
    done() { clearTimeout(timer); outer.removeEventListener("abort", forward); },
  };
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Read bytes, not text; cancel the stream on any failure so no response is left open. */
async function readBytes(response: Response, limit: number, cap: number, signal: AbortSignal,
  turn: number, source: string): Promise<Uint8Array> {
  const tooLarge = () => new TraceExportError("tooLarge", { turn, source, limit: cap });
  const header = response.headers.get("content-length");
  const declared = header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
  if (declared !== undefined && declared > limit) { await discard(response); throw tooLarge(); }
  if (!response.body) {
    const value = new Uint8Array(await guard(response.arrayBuffer(), signal));
    if (value.byteLength > limit) throw tooLarge();
    if (declared !== undefined && value.byteLength !== declared)
      throw new TraceExportError("incomplete", { turn, source });
    return value;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await guard(reader.read(), signal);
      if (done) { finished = true; break; }
      size += value.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
    if (declared !== undefined && size !== declared) throw new TraceExportError("incomplete", { turn, source });
  } catch (error) {
    if (error instanceof TraceExportError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new TraceExportError("incomplete", { turn, source, cause: error });
  } finally {
    if (!finished) await Promise.resolve(reader.cancel()).catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.byteLength; }
  return result;
}

async function fetchTurns(fetcher: typeof fetch, base: string, id: string,
  signal: AbortSignal): Promise<ConversationTurn[]> {
  const response = await guard(fetcher(base + "/conversations/" + encodeURIComponent(id) + "/trace",
    { headers: HEADERS, signal }), signal);
  if (!response.ok) {
    await discard(response);
    throw new TraceExportError("read", { source: "trace index", status: response.status });
  }
  const body = await guard(response.json(), signal) as { turns?: unknown };
  if (!Array.isArray(body.turns)) throw new TraceExportError("read", { source: "trace index" });
  return body.turns as ConversationTurn[];
}

/** An unavailable Jobs lookup is recorded as `jobs: null`; a lookup with no Jobs is `[]`. */
async function linkedJobs(fetcher: typeof fetch, base: string, id: string,
  signal: AbortSignal): Promise<JobEntry[] | null> {
  try {
    const response = await guard(fetcher(base + "/turns/" + encodeURIComponent(id) + "/jobs",
      { headers: HEADERS, signal }), signal);
    if (!response.ok) { await discard(response); return null; }
    const payload: unknown = await guard(response.json(), signal);
    if (!Array.isArray(payload)) return null;
    return payload.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const value = entry as Record<string, unknown>;
      if (typeof value.jobId !== "string") return [];
      return [{ jobId: value.jobId, status: typeof value.status === "string" ? value.status : "unknown",
        adopted: value.adopted === true }];
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return null;
  }
}

const archiveOverhead = (path: string) => 30 + 46 + 2 * encoder.encode(path).length;
const END_RECORD = 22;

function assertIdle(turns: ConversationTurn[]): void {
  const running = turns.find((turn) => turn.status === "streaming");
  if (running) throw new TraceExportError("running", { turn: running.number });
}

/**
 * Re-checks turn status, then reads every source as-is. Missing (404) logs appear in the
 * manifest; any other failure, size overrun, timeout or cancellation aborts the whole export
 * and no archive is returned. All turns are included, regardless of which UI panels are expanded.
 */
export async function conversationTraceArchive(project: string, conversationId: string,
  options: TraceExportOptions = {}): Promise<Blob> {
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const limit = options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const base = "/api/creation/projects/" + encodeURIComponent(project) + "/assistant";
  const started = Date.now();
  const total = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const outer = options.signal ?? new AbortController().signal;
  const mapAbort = (error: unknown) => {
    if (error instanceof TraceExportError) return error;
    return outer.aborted ? new TraceExportError("aborted") : error;
  };
  const scoped = async <T>(turn: number | undefined, source: string | undefined,
    work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const remaining = total - (Date.now() - started);
    if (remaining <= 0) throw new TraceExportError("timeout", { turn, source });
    const scope = requestScope(outer, Math.min(requestTimeout, remaining), turn, source);
    try { return await work(scope.signal); } catch (error) { throw mapAbort(error); } finally { scope.done(); }
  };

  const turns = await scoped(undefined, "trace index", (signal) => fetchTurns(fetcher, base, conversationId, signal));
  assertIdle(turns);
  const files: ZipEntry[] = [];
  const manifestTurns: ManifestTurn[] = [];
  let used = END_RECORD + archiveOverhead("manifest.json");
  for (const [index, turn] of turns.entries()) {
    const sources: SourceEntry[] = [];
    const directory = "turn-" + String(index + 1).padStart(4, "0") + "/";
    for (const source of traceSources(traceRuntime(turn.runtime))) {
      if (!SOURCES.has(source)) { sources.push({ source, status: "unsupported" }); continue; }
      const path = directory + source + ".jsonl";
      if (files.length >= MAX_FILES) throw new TraceExportError("tooManyFiles", { turn: turn.number, source });
      const bytes = await scoped(turn.number, source, async (signal) => {
        let response: Response;
        try {
          response = await guard(fetcher(base + "/traces/" + encodeURIComponent(turn.id) + "/" +
            encodeURIComponent(source), { headers: HEADERS, signal }), signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          throw new TraceExportError("read", { turn: turn.number, source, cause: error });
        }
        if (response.status === 404) { await discard(response); return undefined; }
        if (!response.ok) {
          await discard(response);
          throw new TraceExportError("read", { turn: turn.number, source, status: response.status });
        }
        return readBytes(response, limit - used - archiveOverhead(path), limit, signal, turn.number, source);
      });
      if (!bytes) { sources.push({ source, status: "missing" }); continue; }
      files.push({ path, data: bytes, compress: false });
      used += bytes.byteLength + archiveOverhead(path);
      sources.push({ source, file: path, bytes: bytes.byteLength, status: "included" });
    }
    const jobs = await scoped(turn.number, "jobs", (signal) => linkedJobs(fetcher, base, turn.id, signal));
    manifestTurns.push({ id: turn.id, number: turn.number, runtime: turn.runtime, status: turn.status,
      sources, jobs, jobsStatus: jobs === null ? "unavailable" : "ok" });
  }

  // Sources were read one by one: refuse an archive if the turns changed or started running meanwhile.
  const after = await scoped(undefined, "trace index", (signal) => fetchTurns(fetcher, base, conversationId, signal));
  assertIdle(after);
  const key = (list: ConversationTurn[]) => JSON.stringify(list.map((turn) => [turn.id, turn.status]));
  if (key(after) !== key(turns)) throw new TraceExportError("changed");

  const manifest = encoder.encode(JSON.stringify({
    format: "opendirector-original-trace-archive", version: 1,
    projectId: project, conversationId, exportedAt: generatedAt,
    snapshot: "Each source file was read separately after confirming no turn was running, and turn status was re-checked afterwards. This is not an atomic snapshot across files.",
    warning: "Original trace data may include credentials, prompts, tool inputs/outputs and private paths. Review before sharing.",
    turns: manifestTurns,
  }, null, 2) + "\n");
  if (used + manifest.length > limit)
    throw new TraceExportError("tooLarge", { source: "manifest.json", limit });
  return createZip([{ path: "manifest.json", data: manifest, compress: false }, ...files], new Date(generatedAt));
}
