import assert from "node:assert/strict";
import test from "node:test";
import { ExampleError } from "../src/canvas/workspace/example/exampleDownload.ts";
import type { ExampleEntry } from "../src/canvas/workspace/example/exampleCatalog.ts";
import {
  runExampleImport,
  type ExampleStatus,
} from "../src/canvas/workspace/example/useExampleImport.ts";

const entry: ExampleEntry = {
  id: "image-canvas",
  title: { "zh-CN": "图像创作示例画布", "en-US": "Image creation example canvas" },
  url: "https://lz.qaiu.top/parser?url=x",
  bytes: 2048,
};

const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

function recorder(): { phases: string[]; statuses: ExampleStatus[] } {
  const statuses: ExampleStatus[] = [];
  return { statuses, phases: [] as string[] };
}

test("a successful import reports every phase and hands over the archive", async () => {
  const statuses: ExampleStatus[] = [];
  let received: Blob | undefined;
  let released = false;
  const result = await runExampleImport(
    entry,
    {
      fetchCanvas: async () => ({
        bytes: archive,
        kind: "zip-wrapper",
        outerBytes: 9,
        release: () => {
          released = true;
        },
      }),
      importCanvas: async (blob) => {
        received = blob;
      },
    },
    new AbortController().signal,
    (status) => statuses.push(status),
  );
  assert.deepEqual(
    statuses.map((status) => status.phase),
    ["downloading", "importing", "done"],
  );
  assert.equal(statuses[2]?.title, entry.title["zh-CN"]);
  assert.equal(result.kind, "zip-wrapper");
  assert.equal(result.outerBytes, 9);
  assert.ok(received instanceof Blob);
  assert.deepEqual(new Uint8Array(await received!.arrayBuffer()), archive);
  // The download is released once the import settles.
  assert.equal(released, true);
});

test("a download failure is classified and rethrown", async () => {
  const statuses: ExampleStatus[] = [];
  await assert.rejects(
    runExampleImport(
      entry,
      {
        fetchCanvas: async () => {
          throw new ExampleError("html");
        },
        importCanvas: async () => {},
      },
      new AbortController().signal,
      (status) => statuses.push(status),
    ),
    (error: unknown) => error instanceof ExampleError && error.code === "html",
  );
  assert.deepEqual(
    statuses.map((status) => status.phase),
    ["downloading", "failed"],
  );
  assert.deepEqual(statuses.at(-1), { phase: "failed", code: "html", httpStatus: undefined });
});

test("an HTTP failure keeps its status for the message", async () => {
  const statuses: ExampleStatus[] = [];
  await assert.rejects(
    runExampleImport(
      entry,
      {
        fetchCanvas: async () => {
          throw new ExampleError("http", "status 403", 403);
        },
        importCanvas: async () => {},
      },
      new AbortController().signal,
      (status) => statuses.push(status),
    ),
  );
  assert.equal(statuses.at(-1)?.code, "http");
  assert.equal(statuses.at(-1)?.httpStatus, 403);
});

test("an unexpected import failure is reported as unknown", async () => {
  const statuses: ExampleStatus[] = [];
  await assert.rejects(
    runExampleImport(
      entry,
      {
        fetchCanvas: async () => ({
          bytes: archive,
          kind: "canvas",
          outerBytes: 7,
          release: () => {},
        }),
        importCanvas: async () => {
          throw new Error("switch failed");
        },
      },
      new AbortController().signal,
      (status) => statuses.push(status),
    ),
    /switch failed/,
  );
  assert.deepEqual(
    statuses.map((status) => status.phase),
    ["downloading", "importing", "failed"],
  );
  assert.equal(statuses.at(-1)?.code, "unknown");
});

test("download progress reaches the status before the import starts", async () => {
  const statuses: ExampleStatus[] = [];
  await runExampleImport(
    entry,
    {
      fetchCanvas: async (_entry, options) => {
        options?.onProgress?.(64, 256);
        options?.onProgress?.(256, 256);
        return {
          bytes: archive,
          kind: "canvas",
          outerBytes: 256,
          release: () => {},
        };
      },
      importCanvas: async () => {},
    },
    new AbortController().signal,
    (status) => statuses.push(status),
  );
  const downloading = statuses.filter((status) => status.phase === "downloading");
  assert.deepEqual(
    downloading.map((status) => [status.received, status.total]),
    [
      [undefined, undefined],
      [64, 256],
      [256, 256],
    ],
  );
});

test("a failed import still releases the download", async () => {
  let released = false;
  await assert.rejects(
    runExampleImport(
      entry,
      {
        fetchCanvas: async () => ({
          bytes: archive,
          kind: "canvas",
          outerBytes: 7,
          release: () => {
            released = true;
          },
        }),
        importCanvas: async () => {
          throw new Error("boom");
        },
      },
      new AbortController().signal,
      () => {},
    ),
  );
  assert.equal(released, true);
});

test("cancelling after the download skips the import entirely", async () => {
  const controller = new AbortController();
  const statuses: ExampleStatus[] = [];
  let imported = false;
  await assert.rejects(
    runExampleImport(
      entry,
      {
        fetchCanvas: async () => {
          controller.abort();
          return {
            bytes: archive,
            kind: "canvas",
            outerBytes: 7,
            release: () => {},
          };
        },
        importCanvas: async () => {
          imported = true;
        },
      },
      controller.signal,
      (status) => statuses.push(status),
    ),
    (error: unknown) => error instanceof ExampleError && error.code === "aborted",
  );
  assert.equal(imported, false);
  assert.equal(statuses.at(-1)?.code, "aborted");
});
