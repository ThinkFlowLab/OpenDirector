import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createNode } from "../src/canvas/model.ts";
import { createHistory, recordChange, undo } from "../src/canvas/history.ts";
import { serializeDocument, parseDocument } from "../src/canvas/storage.ts";
import { absolutePosition } from "../src/canvas/geometry.ts";
import { createLocalStage } from "../src/canvas/stageDocument.ts";
import {
  toolProvenanceEdges,
  type GenerationJob,
} from "../src/canvas/generationHistory.ts";
import {
  appendLinkedMediaResults,
  captureEditorSource,
  type LinkedMediaResult,
} from "../src/canvas/linkedResults.ts";

const outputs: LinkedMediaResult[] = [
  {
    kind: "image",
    src: "data:image/png;base64,YQ==",
    mimeType: "image/png",
    title: "裁剪结果",
    media: { width: 1024, height: 512 },
  },
  {
    kind: "audio",
    src: "data:audio/wav;base64,YQ==",
    mimeType: "audio/wav",
    title: "提取音轨",
    media: { durationSeconds: 4 },
  },
];

test("recovered tool output identities prevent duplicate and partially repeated placement", () => {
  const source = createNode("image", { x: 0, y: 0 }, { src: "source" });
  const document = { ...createDocument(), nodes: [source] };
  const origin = {
    documentId: document.id,
    nodeId: source.id,
    kind: source.type,
    src: source.data.src,
  };
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const first = appendLinkedMediaResults(
    document,
    origin,
    outputs.slice(0, 1),
    undefined,
    ids.slice(0, 1),
  );
  const recovered = appendLinkedMediaResults(
    first.document,
    origin,
    outputs,
    undefined,
    ids,
  );
  assert.deepEqual(recovered.ids, [ids[1]]);
  const again = appendLinkedMediaResults(
    recovered.document,
    origin,
    outputs,
    undefined,
    ids,
  );
  assert.deepEqual(again.ids, []);
  assert.equal(again.document, recovered.document);
  assert.deepEqual(
    recovered.document.nodes.map((node) => node.id),
    [source.id, ...ids],
  );
  assert.deepEqual(
    recovered.document.edges.map((edge) => edge.target),
    ids,
  );
  assert.ok(
    appendLinkedMediaResults(document, origin, outputs, undefined, [ids[0]!])
      .error,
  );
});

test("tool provenance is projected from history without duplicating saved edges or revealing hidden results", () => {
  const source = createNode("image", { x: 0, y: 0 });
  const result = createNode("image", { x: 400, y: 0 });
  const document = { ...createDocument(), nodes: [source, result] };
  const job: GenerationJob = {
    id: "tool-task",
    taskId: "tool-task",
    nodeId: source.id,
    title: "outpaint",
    time: "",
    status: "succeeded",
    toolTask: { placement: "placed", outputIds: [result.id] },
  };
  const edges = toolProvenanceEdges([job], document);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.intent, "post_edit_result");
  assert.deepEqual(toolProvenanceEdges([job], { ...document, edges }), []);
  assert.deepEqual(
    toolProvenanceEdges([job], { ...document, nodes: [source] }),
    [],
  );
  for (const status of ["failed", "cancelled", "interrupted"] as const) {
    const failed = {
      ...job,
      status,
      targetNodeId: result.id,
      toolTask: { placement: "unplaced" as const, outputIds: [] },
    };
    assert.deepEqual(toolProvenanceEdges([failed, failed], document), edges);
    const replaced = { ...result, data: { ...result.data, src: "another-image.png" } };
    assert.deepEqual(toolProvenanceEdges([failed], { ...document, nodes: [source, replaced] }), []);
  }
  const submitting: GenerationJob = {
    ...job,
    status: "running",
    toolTask: undefined,
    targetNodeId: result.id,
    tool: { version: 1, tool: "outpaint", sourceNodeIds: [source.id], parameters: {} },
  };
  assert.deepEqual(toolProvenanceEdges([submitting], document), edges);
});

test("mask composite history links each input to its pending and published result", () => {
  const depth = createNode("video");
  const mask = createNode("video");
  const result = createNode("video");
  const document = { ...createDocument(), nodes: [depth, mask, result] };
  const running: GenerationJob = {
    id: "composite",
    nodeId: depth.id,
    title: "Mask composite",
    time: "",
    status: "running",
    targetNodeId: result.id,
    tool: {
      version: 1,
      tool: "video-mask-composite",
      sourceNodeIds: [depth.id, mask.id],
      parameters: { stretch: true },
    },
  };
  const edges = toolProvenanceEdges([running], document);
  assert.deepEqual(edges.map((edge) => [edge.source, edge.target]), [
    [depth.id, result.id], [mask.id, result.id],
  ]);
  const saved = { ...document, edges: [edges[0]!] };
  assert.deepEqual(toolProvenanceEdges([running], saved), [edges[1]]);

  const output: LinkedMediaResult = {
    kind: "video", title: "Composite", src: "blob:composite", mimeType: "video/mp4",
  };
  const completed: GenerationJob = {
    ...running,
    status: "succeeded",
    outputs: [output],
    toolTask: { placement: "placed", outputIds: [result.id] },
  };
  const published = { ...result, data: { ...result.data, src: output.src } };
  assert.deepEqual(
    toolProvenanceEdges([completed], { ...saved, nodes: [depth, mask, published] }),
    [edges[1]],
  );
  assert.deepEqual(toolProvenanceEdges([completed], saved), []);
});

for (const kind of ["timeline", "external"] as const) {
  test(`${kind} renders can join the canvas without an original media URL`, () => {
    const source = createNode(kind);
    if (kind === "external") source.data.localStage = createLocalStage();
    const document = { ...createDocument(), nodes: [source] };
    const origin = captureEditorSource(document.id, source);
    const result = appendLinkedMediaResults(document, origin, [outputs[0]!]);
    assert.equal(result.error, undefined);
    assert.equal(result.ids.length, 1);
    assert.equal(result.document.nodes[0], source);
    assert.equal(result.document.edges[0]?.source, source.id);
    assert.equal(result.document.edges[0]?.intent, "post_edit_result");
    assert.deepEqual(
      undo(recordChange(createHistory(document), result.document)).present,
      document,
    );
    const changed = structuredClone(document);
    if (kind === "timeline") changed.nodes[0]!.data.timeline!.width += 32;
    else changed.nodes[0]!.data.localStage!.background = "#123456";
    for (const invalid of [
      changed,
      { ...document, id: "another-project" },
      { ...document, nodes: [] },
      { ...document, nodes: [{ ...source, locked: true }] },
      {
        ...document,
        nodes: [
          {
            ...source,
            data: { ...source.data, assetState: "missing" as const },
          },
        ],
      },
    ]) {
      const refused = appendLinkedMediaResults(invalid, origin, [outputs[0]!]);
      assert.equal(refused.document, invalid);
      assert.deepEqual(refused.ids, []);
      assert.ok(refused.error);
    }
    // Moving or renaming the composition does not change its rendered content.
    assert.equal(
      appendLinkedMediaResults(
        {
          ...document,
          nodes: [{ ...source, data: { ...source.data, title: "renamed" } }],
        },
        origin,
        [outputs[0]!],
      ).error,
      undefined,
    );
  });
}

test("repeated results avoid existing grouped media and other new outputs without moving sources", () => {
  const source = createNode("video", { x: 0, y: 0 }, { src: "original" });
  const group = createNode("group", { x: source.width + 100, y: 0 });
  const obstacle = {
    ...createNode("image", { x: 0, y: 0 }),
    parentId: group.id,
  };
  const original = { ...createDocument(), nodes: [source, group, obstacle] };
  const origin = {
    documentId: original.id,
    nodeId: source.id,
    kind: source.type,
    src: source.data.src,
  };
  const first = appendLinkedMediaResults(original, origin, outputs);
  const second = appendLinkedMediaResults(first.document, origin, outputs);
  assert.deepEqual(second.document.nodes.slice(0, 3), original.nodes);
  const media = second.document.nodes.filter((node) => node.type !== "group");
  for (let i = 0; i < media.length; i++) {
    for (const other of media.slice(i + 1)) {
      const node = media[i]!;
      const a = absolutePosition(node, second.document.nodes);
      const b = absolutePosition(other, second.document.nodes);
      assert.ok(
        a.x + node.width <= b.x ||
          b.x + other.width <= a.x ||
          a.y + node.height <= b.y ||
          b.y + other.height <= a.y,
      );
    }
  }
});

test("local results retain provenance and pixel metadata through save/restore, and undo as one operation", () => {
  const group = createNode("group", { x: 500, y: 300 });
  const source = {
    ...createNode(
      "video",
      { x: 30, y: 40 },
      { src: "data:video/mp4;base64,YQ==", title: "原素材" },
    ),
    parentId: group.id,
  };
  const document = { ...createDocument(), nodes: [group, source] };
  const result = appendLinkedMediaResults(
    document,
    {
      documentId: document.id,
      nodeId: source.id,
      kind: source.type,
      src: source.data.src,
    },
    outputs,
  );
  assert.equal(result.error, undefined);
  assert.equal(result.ids.length, 2);
  assert.equal(result.document.nodes[1], source);
  assert.equal(result.document.nodes[2]!.parentId, undefined);
  assert.deepEqual(result.document.nodes[2]!.position, {
    x: 530 + source.width + 100,
    y: 340,
  });
  assert.deepEqual(
    result.document.edges.map((edge) => edge.source),
    [source.id, source.id],
  );
  assert.deepEqual(
    result.document.edges.map((edge) => edge.target),
    result.ids,
  );
  const saved = serializeDocument(result.document);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  const restored = parseDocument(saved.value);
  assert.equal(restored.ok, true);
  if (restored.ok) {
    assert.deepEqual(restored.value.nodes[2]!.data.media, {
      width: 1024,
      height: 512,
    });
    assert.deepEqual(restored.value.nodes[3]!.data.media, {
      durationSeconds: 4,
    });
  }
  assert.deepEqual(
    undo(recordChange(createHistory(document), result.document)).present,
    document,
  );
  assert.equal(document.nodes.length, 2);
});

test("late result imports do not enter another project, deleted source, or replaced media", () => {
  const source = createNode(
    "image",
    { x: 0, y: 0 },
    { src: "data:image/png;base64,b2xk" },
  );
  const document = { ...createDocument(), nodes: [source] };
  const origin = {
    documentId: document.id,
    nodeId: source.id,
    kind: source.type,
    src: source.data.src,
  };
  for (const changed of [
    { ...document, id: "another-project" },
    { ...document, nodes: [] },
    {
      ...document,
      nodes: [
        { ...createNode("video"), id: source.id, data: { ...source.data } },
      ],
    },
    {
      ...document,
      nodes: [
        {
          ...source,
          data: { ...source.data, src: "data:image/png;base64,bmV3" },
        },
      ],
    },
  ]) {
    const result = appendLinkedMediaResults(changed, origin, outputs);
    assert.equal(result.document, changed);
    assert.equal(result.ids.length, 0);
    assert.ok(result.error);
  }
  assert.equal(
    appendLinkedMediaResults(document, origin, []).document,
    document,
  );
});
