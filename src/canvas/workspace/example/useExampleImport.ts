/**
 * Import orchestration for one example canvas: download, hand the bytes to the
 * existing import path, and report progress. The bytes never outlive the call,
 * so there is no archive copy left behind once the import finishes.
 */
import { useCallback, useRef, useState } from "react";
import {
  ExampleError,
  fetchExampleCanvas,
  type ExampleDownload,
  type ExampleErrorCode,
} from "./exampleDownload.ts";
import type { ExampleEntry } from "./exampleCatalog.ts";

export type ExamplePhase = "idle" | "downloading" | "importing" | "done" | "failed";

export interface ExampleStatus {
  phase: ExamplePhase;
  /** Present when `phase` is `failed`. */
  code?: ExampleErrorCode | "unknown";
  /** HTTP status for `http` failures. */
  httpStatus?: number;
  /** The imported title, when `phase` is `done`. */
  title?: string;
  /** The original message, for failures the codes cannot describe. */
  message?: string;
  /** Bytes received while `phase` is `downloading`. */
  received?: number;
  /** Declared download size, when the server sent a `content-length`. */
  total?: number | null;
}

export interface ExampleImportDeps {
  fetchCanvas?: typeof fetchExampleCanvas;
  /** Receives the unwrapped `.canvas` archive; must not retain it. */
  importCanvas: (archive: Blob) => Promise<void>;
}

function failure(error: unknown): ExampleStatus {
  if (error instanceof ExampleError)
    return { phase: "failed", code: error.code, httpStatus: error.status };
  // Archive validation (version too new, damaged manifest) arrives as a plain
  // localized Error; keep its wording instead of flattening it to "unknown".
  return {
    phase: "failed",
    code: "unknown",
    message: error instanceof Error ? error.message : undefined,
  };
}

export interface ExampleImportResult {
  kind: ExampleDownload["kind"];
  innerEntry?: string;
  outerBytes: number;
}

/**
 * Runs one import, reports every phase transition, and always releases the
 * downloaded buffers afterwards.
 *
 * Throws after reporting `failed`, so a caller can decide whether to surface a
 * toast in addition to the inline status.
 */
export async function runExampleImport(
  entry: ExampleEntry,
  deps: ExampleImportDeps,
  signal: AbortSignal,
  report: (status: ExampleStatus) => void,
): Promise<ExampleImportResult> {
  report({ phase: "downloading" });
  let download: ExampleDownload;
  try {
    download = await (deps.fetchCanvas ?? fetchExampleCanvas)(entry, {
      signal,
      onProgress: (received, total) =>
        report({ phase: "downloading", received, total }),
    });
  } catch (error) {
    report(failure(error));
    throw error;
  }
  try {
    if (signal.aborted) throw new ExampleError("aborted");
    report({ phase: "importing" });
    await deps.importCanvas(
      new Blob([download.bytes as unknown as BlobPart], {
        type: "application/octet-stream",
      }),
    );
    report({ phase: "done", title: entry.title["zh-CN"] });
    return {
      kind: download.kind,
      innerEntry: download.innerEntry,
      outerBytes: download.outerBytes,
    };
  } catch (error) {
    report(failure(error));
    throw error;
  } finally {
    // No download survives the call: this is the cache release the feature needs.
    download.release();
  }
}

/** Per-entry status plus the controls the dialog needs. */
export function useExampleImport(deps: ExampleImportDeps) {
  const [statuses, setStatuses] = useState<Record<string, ExampleStatus>>({});
  const controllers = useRef(new Map<string, AbortController>());
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const update = useCallback((id: string, status: ExampleStatus | null) => {
    setStatuses((current) => {
      const next = { ...current };
      if (status) next[id] = status;
      else delete next[id];
      return next;
    });
  }, []);

  const start = useCallback(
    async (entry: ExampleEntry) => {
      if (controllers.current.has(entry.id)) return;
      const controller = new AbortController();
      controllers.current.set(entry.id, controller);
      try {
        await runExampleImport(entry, depsRef.current, controller.signal, (status) => {
          // A cancelled download returns to idle instead of showing an error.
          if (status.code === "aborted") update(entry.id, null);
          else update(entry.id, status);
        });
      } catch {
        /* The inline status already explains the failure. */
      } finally {
        controllers.current.delete(entry.id);
      }
    },
    [update],
  );

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
  }, []);

  const reset = useCallback((id: string) => update(id, null), [update]);

  return {
    statuses,
    start,
    cancel,
    reset,
    isRunning: (id: string) =>
      statuses[id]?.phase === "downloading" || statuses[id]?.phase === "importing",
  };
}
