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

/**
 * Runs one import and reports every phase transition.
 *
 * Throws after reporting `failed`, so a caller can decide whether to surface a
 * toast in addition to the inline status.
 */
export async function runExampleImport(
  entry: ExampleEntry,
  deps: ExampleImportDeps,
  signal: AbortSignal,
  report: (status: ExampleStatus) => void,
): Promise<ExampleDownload> {
  report({ phase: "downloading" });
  let download: ExampleDownload;
  try {
    download = await (deps.fetchCanvas ?? fetchExampleCanvas)(entry, { signal });
  } catch (error) {
    const status = failure(error);
    report(status);
    throw error;
  }
  if (signal.aborted) {
    const aborted = new ExampleError("aborted");
    report({ phase: "failed", code: "aborted" });
    throw aborted;
  }
  report({ phase: "importing" });
  try {
    await deps.importCanvas(
      new Blob([download.bytes as unknown as BlobPart], {
        type: "application/octet-stream",
      }),
    );
  } catch (error) {
    const status = failure(error);
    report(status);
    throw error;
  }
  report({ phase: "done", title: entry.title["zh-CN"] });
  return download;
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
