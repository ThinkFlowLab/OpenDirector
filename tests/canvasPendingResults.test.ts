import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createNode } from "../src/canvas/model.ts";
import {
  appendPendingResult,
  fillPendingResult,
  pendingResultNode,
  removePendingResult,
  placeToolResults,
  toolResultsPlaced,
  type LinkedMediaResult,
} from "../src/canvas/linkedResults.ts";
import {
  generationActivities,
  jobActivities,
} from "../src/canvas/generationActivity.ts";
import {
  estimatedProgress,
  expectedDuration,
  recordDuration,
} from "../src/canvas/generationDurations.ts";

const image = (title: string): LinkedMediaResult => ({
  kind: "image",
  src: `data:image/png;base64,${Buffer.from(title).toString("base64")}`,
  mimeType: "image/png",
  title,
  media: { width: 2016, height: 1152 },
});

function fixture() {
  const source = createNode("image", { x: 0, y: 0 }, { src: "original" });
  const document = { ...createDocument(), nodes: [source] };
  const origin = {
    documentId: document.id,
    nodeId: source.id,
    kind: source.type,
    src: source.data.src,
  };
  return { source, document, origin };
}

test("a running tool gets an empty result node linked to the right of its source", () => {
  const { source, document, origin } = fixture();
  const pending = appendPendingResult(document, origin, "image", "扩图");
  const [id] = pending.ids;
  const node = pendingResultNode(pending.document, id!)!;
  assert.equal(node.type, "image");
  assert.equal(node.data.title, "扩图");
  assert.ok(node.position.x >= source.position.x + source.width);
  assert.deepEqual(
    pending.document.edges.map(({ source: from, target }) => [from, target]),
    [[source.id, id]],
  );
});

test("a placeholder keeps the source video envelope", () => {
  const source = createNode("video", { x: 0, y: 0 }, {
    src: "original",
    media: { width: 1080, height: 1920 },
  });
  const document = { ...createDocument(), nodes: [source] };
  const pending = appendPendingResult(
    document,
    {
      documentId: document.id,
      nodeId: source.id,
      kind: source.type,
      src: source.data.src,
    },
    "video",
    "抠像",
  );
  const node = pendingResultNode(pending.document, pending.ids[0]!)!;
  assert.deepEqual([node.width, node.height], [source.width, source.height]);
});

test("a video placeholder starts in omni-reference mode", () => {
  const { document, origin } = fixture();
  const pending = appendPendingResult(document, origin, "video", "视频");
  const node = pendingResultNode(pending.document, pending.ids[0]!)!;
  assert.equal(node.data.settings?.videoMode, "reference");
  assert.equal(node.data.settings?.modelConfigId, undefined);
});

test("a caller-supplied model is kept on the placeholder", () => {
  const { document, origin } = fixture();
  const pending = appendPendingResult(
    document,
    origin,
    "video",
    "视频",
    undefined,
    { model: "本地模型", modelConfigId: "cfg-1" },
  );
  const node = pendingResultNode(pending.document, pending.ids[0]!)!;
  assert.equal(node.data.settings?.modelConfigId, "cfg-1");
  assert.equal(node.data.settings?.model, "本地模型");
  assert.equal(node.data.settings?.videoMode, "reference");
});

test("the first output fills the pending node and further outputs join the source", () => {  const { source, document, origin } = fixture();
  const pending = appendPendingResult(document, origin, "image", "图层分解");
  const id = pending.ids[0]!;
  const filled = fillPendingResult(pending.document, origin, id, [
    image("背景"),
    image("图层 1"),
  ]);
  assert.equal(filled.error, undefined);
  assert.equal(filled.ids[0], id);
  assert.equal(filled.ids.length, 2);
  const node = filled.document.nodes.find((item) => item.id === id)!;
  assert.equal(node.data.title, "背景");
  assert.equal(node.data.assetState, "ready");
  assert.equal(pendingResultNode(filled.document, id), undefined);
  // Both results hang off the source, the filled node keeping its original edge.
  assert.equal(
    filled.document.edges.filter((edge) => edge.source === source.id).length,
    2,
  );
});

test("a failed run removes its untouched placeholder but never a node that was filled", () => {
  const { document, origin } = fixture();
  const pending = appendPendingResult(document, origin, "image", "扩图");
  const id = pending.ids[0]!;
  const removed = removePendingResult(pending.document, id);
  assert.equal(removed.nodes.length, 1);
  assert.equal(removed.edges.length, 0);
  const filled = fillPendingResult(pending.document, origin, id, [
    image("扩图"),
  ]);
  assert.equal(removePendingResult(filled.document, id), filled.document);
});

test("progress grows with elapsed time but never completes before the result", () => {
  assert.equal(estimatedProgress(0, 20_000), 0);
  const atExpected = estimatedProgress(20_000, 20_000);
  assert.ok(atExpected > 0.85 && atExpected < 0.92);
  assert.ok(estimatedProgress(10_000, 20_000) < atExpected);
  assert.ok(estimatedProgress(600_000, 20_000) <= 0.97);
  const [activity] = generationActivities(
    [
      {
        documentId: "d",
        nodeId: "n",
        phase: "generating",
        startedAt: 2000,
        expectedMs: 10_000,
      },
      {
        documentId: "d",
        nodeId: "n",
        phase: "queued",
        startedAt: 1000,
        expectedMs: 30_000,
      },
    ],
    "d",
  ).values();
  assert.deepEqual(activity, {
    count: 2,
    phase: "generating",
    startedAt: 1000,
    expectedMs: 30_000,
  });
});

test("stable identities make repeated and partially saved placeholder fills idempotent", () => {
  const { document, origin } = fixture();
  const pending = appendPendingResult(document, origin, "image", "Layers");
  const ids = [pending.ids[0]!, crypto.randomUUID()];
  const outputs = [image("First"), image("Second")];
  const target = { id: ids[0]!, title: "Layers", kind: "image" };
  const partial = placeToolResults(
    pending.document,
    origin,
    outputs.slice(0, 1),
    undefined,
    ids.slice(0, 1),
    target,
  );
  const completed = placeToolResults(
    partial.document,
    origin,
    outputs,
    undefined,
    ids,
    target,
  );
  assert.equal(completed.error, undefined);
  assert.equal(completed.document.nodes.length, 3);
  const replay = placeToolResults(
    completed.document,
    origin,
    outputs,
    undefined,
    ids,
    target,
  );
  assert.equal(replay.document, completed.document);
  assert.deepEqual(replay.ids, []);
  assert.ok(toolResultsPlaced(replay.document, outputs, ids));
});

for (const change of [
  "source-deleted",
  "source-replaced",
  "source-locked",
  "target-locked",
  "target-deleted",
  "target-uploaded",
  "target-prompt",
  "target-parameters",
  "target-renamed",
]) {
  test(`pending output respects ${change}`, () => {
    const f = fixture();
    const pending = appendPendingResult(
      f.document,
      f.origin,
      "image",
      "Pending",
    );
    const id = pending.ids[0]!;
    const document = {
      ...pending.document,
      nodes: pending.document.nodes.flatMap((node) => {
        if (node.id === f.source.id) {
          if (change === "source-deleted") return [];
          if (change === "source-replaced")
            return [{ ...node, data: { ...node.data, src: "replacement" } }];
          if (change === "source-locked") return [{ ...node, locked: true }];
        }
        if (node.id === id) {
          if (change === "target-deleted") return [];
          if (change === "target-locked") return [{ ...node, locked: true }];
          if (change === "target-uploaded")
            return [{ ...node, data: { ...node.data, src: "manual" } }];
          if (change === "target-prompt")
            return [
              { ...node, data: { ...node.data, prompt: "My own prompt" } },
            ];
          if (change === "target-parameters")
            return [
              {
                ...node,
                data: {
                  ...node.data,
                  settings: { ...node.data.settings!, aspectRatio: "16:9" },
                },
              },
            ];
          if (change === "target-renamed")
            return [{ ...node, data: { ...node.data, title: "My result" } }];
        }
        return [node];
      }),
    };
    const result = placeToolResults(
      document,
      f.origin,
      [image("Generated")],
      undefined,
      [id],
      { id, title: "Pending", kind: "image" },
    );
    assert.ok(result.error, change);
    assert.equal(result.document, document);
    if (change.startsWith("target-") && change !== "target-deleted")
      assert.equal(
        removePendingResult(document, id, "Pending", "image"),
        document,
      );
  });
}

test("hidden completed outputs remain hidden while unfinished hidden placeholders are not resurrected", () => {
  const { document, origin } = fixture();
  const pending = appendPendingResult(document, origin, "image", "Pending");
  const id = pending.ids[0]!;
  const outputs = [image("Generated")];
  const hidden = {
    ...pending.document,
    nodes: pending.document.nodes.filter((node) => node.id !== id),
    edges: [],
  };
  const unfilled = placeToolResults(hidden, origin, outputs, undefined, [id], {
    id,
  });
  assert.ok(unfilled.error);
  const placed = placeToolResults(
    hidden,
    origin,
    outputs,
    undefined,
    [id],
    { id },
    new Set([id]),
  );
  assert.equal(placed.document, hidden);
  assert.deepEqual(placed.ids, []);
});

test("a different output kind removes only an untouched prediction and preserves stable extra IDs", () => {
  const { document, origin } = fixture();
  const pending = appendPendingResult(document, origin, "image", "Pending");
  const output = {
    ...image("Motion"),
    kind: "video" as const,
    mimeType: "video/mp4",
  };
  const outputId = crypto.randomUUID();
  const placed = placeToolResults(
    pending.document,
    origin,
    [output],
    undefined,
    [outputId],
    { id: pending.ids[0]!, title: "Pending", kind: "image" },
  );
  assert.equal(placed.error, undefined);
  assert.equal(
    placed.document.nodes.some((node) => node.id === pending.ids[0]),
    false,
  );
  assert.equal(
    placed.document.nodes.find((node) => node.id === outputId)?.type,
    "video",
  );
});

test("server task activity belongs to the result, including the final download phase", () => {
  const base = {
    id: "job",
    nodeId: "source",
    title: "Tool",
    time: "",
    targetNodeId: "result",
    targetKind: "video" as const,
    createdAt: 1000,
    durationKey: "tool:test",
    toolTask: { placement: "pending" as const, outputIds: ["result"] },
  };
  const running = jobActivities(
    [{ ...base, status: "running", taskId: "task" }],
    "project",
  );
  assert.equal(running[0]!.nodeId, "result");
  assert.equal(running[0]!.startedAt, 1000);
  assert.equal(running[0]!.expectedMs, 180000);
  const finishing = jobActivities(
    [{ ...base, status: "succeeded" }],
    "project",
  );
  assert.equal(finishing[0]!.phase, "finishing");
  assert.deepEqual(
    jobActivities(
      [
        {
          ...base,
          status: "succeeded",
          toolTask: { placement: "placed", outputIds: ["result"] },
        },
      ],
      "project",
    ),
    [],
  );
});

test("history polling and reloads learn each successful duration sample only once", () => {
  const storage = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
  });
  try {
    const key = `tool:${crypto.randomUUID()}`;
    recordDuration(key, 1000, "first");
    recordDuration(key, 9000, "first");
    assert.equal(expectedDuration(key, "image"), 1000);
    recordDuration(key, 3000, "second");
    assert.equal(expectedDuration(key, "image"), 1800);
    storage.set(
      "opendirector.generation-durations.v1.samples",
      JSON.stringify([`${key}:reloaded`]),
    );
    recordDuration(key, 20000, "reloaded");
    assert.equal(expectedDuration(key, "image"), 1800);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a regenerated node stays busy until its delivered result is displayed", () => {
  const node = createNode("image");
  node.data.backendAssetId = "old-asset";
  const job = {
    id: "job",
    nodeId: node.id,
    title: "regenerate",
    status: "succeeded" as const,
    time: "",
    outputKind: "image" as const,
    deliveredAssetId: "new-asset",
  };
  const [activity] = jobActivities([job], "doc", [node]);
  assert.equal(activity?.phase, "finishing");
  assert.equal(activity?.nodeId, node.id);
  // Once the canvas shows the new asset, or the node is gone, nothing is pending.
  const shown = { ...node, data: { ...node.data, backendAssetId: "new-asset" } };
  assert.deepEqual(jobActivities([job], "doc", [shown]), []);
  assert.deepEqual(jobActivities([job], "doc", []), []);
  // Local text edits clear the backend asset; such a node is not waiting.
  const edited = { ...node, data: { ...node.data, backendAssetId: undefined, text: "draft" } };
  assert.deepEqual(jobActivities([job], "doc", [edited]), []);
  // A first generation into an empty node waits instead of flashing an empty frame.
  const fresh = { ...node, data: { ...node.data, backendAssetId: undefined, src: undefined, text: undefined } };
  assert.equal(jobActivities([job], "doc", [fresh])[0]?.phase, "finishing");
  // A succeeded job whose result is not the node's current content stays idle.
  assert.deepEqual(jobActivities([{ ...job, deliveredAssetId: undefined }], "doc", [node]), []);
});
