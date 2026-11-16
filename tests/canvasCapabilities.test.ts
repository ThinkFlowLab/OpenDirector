import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  canAddReference,
  createDocument,
  createNode,
  type CanvasDocument,
  type CanvasEdge,
} from "../src/canvas/model.ts";
import {
  nodePorts,
  referenceIssue,
  connectedCreationKinds,
} from "../src/canvas/connectionPolicy.ts";
import {
  copySelection,
  pasteFragment,
  stackSelection,
  updateStack,
  unstackSelection,
} from "../src/canvas/operations.ts";
import { projectCanvasStacks } from "../src/canvas/stackProjection.ts";
import { parseDocument, serializeDocument } from "../src/canvas/storage.ts";
import {
  createHistory,
  recordChange,
  undo,
  redo,
} from "../src/canvas/history.ts";

test("interactive reference policy enforces ports and source capabilities while allowing cycles", () => {
  const kinds = [
    "image",
    "video",
    "text",
    "stack",
    "timeline",
    "tool",
    "external",
  ] as const;
  const nodes = kinds.map((kind) =>
    createNode(kind, undefined, {
      src: `data:${kind}/fixture`,
      text: kind === "text" ? "saved text" : undefined,
    }),
  );
  const [image, video, text, stack, timeline, tool, external] = nodes;
  let doc: CanvasDocument = { ...createDocument(), nodes };
  assert.deepEqual(nodePorts("timeline"), { source: false, target: true });
  assert.deepEqual(nodePorts("subject"), { source: true, target: true });
  assert.deepEqual(nodePorts("tool"), { source: true, target: false });
  assert.deepEqual(nodePorts("stack"), { source: false, target: false });
  assert.deepEqual(nodePorts("external"), { source: false, target: false });
  for (const [a, b] of [
    [image, stack],
    [stack, image],
    [timeline, video],
    [image, tool],
    [external, image],
    [video, image],
  ]) {
    const next = applyCommand(doc, {
      type: "add-edge",
      edge: { id: crypto.randomUUID(), source: a!.id, target: b!.id },
    });
    assert.equal(next, doc);
  }
  doc = applyCommand(doc, {
    type: "add-edge",
    edge: { id: "ab", source: image!.id, target: text!.id },
  });
  assert.equal(doc.edges.length, 1);
  assert.equal(referenceIssue(doc, text!.id, image!.id), null);
  assert.equal(canAddReference(doc, image!.id, video!.id), true);
});

test("reference capacity counts inputs but never charges provenance against the target", () => {
  const sources = Array.from({ length: 8 }, () =>
      createNode("image", undefined, { src: "data:image/fixture" }),
    ),
    target = createNode("audio");
  let doc: CanvasDocument = {
    ...createDocument(),
    nodes: [...sources, target],
  };
  for (const source of sources.slice(0, 7))
    doc = applyCommand(doc, {
      type: "add-edge",
      edge: { id: crypto.randomUUID(), source: source.id, target: target.id },
    });
  assert.equal(doc.edges.length, 7);
  assert.equal(
    referenceIssue(doc, sources[7]!.id, target.id),
    "capacity_exceeded",
  );
  doc = {
    ...doc,
    edges: doc.edges.map((edge) => ({ ...edge, intent: "post_edit_result" })),
  };
  assert.equal(canAddReference(doc, sources[7]!.id, target.id), true);
});

test("connected creation menu and frame disconnection consume only generation-input relationships", () => {
  const image = createNode("image"),
    video = createNode("video"),
    audio = createNode("audio");
  let doc: CanvasDocument = {
    ...createDocument(),
    nodes: [image, video, audio],
  };
  assert.deepEqual(
    connectedCreationKinds(doc, audio.id, "target", [
      "image",
      "text",
      "tool",
      "video",
    ]),
    [], // Creating an empty upstream node cannot manufacture a usable reference.
  );
  video.data.settings = {
    ...doc.settings,
    mode: "video",
    firstFrameNodeId: image.id,
  };
  doc = {
    ...doc,
    edges: [
      { id: "input", source: image.id, target: video.id },
      {
        id: "result",
        source: image.id,
        target: video.id,
        intent: "post_edit_result",
      },
    ],
  };
  const disconnected = applyCommand(doc, {
    type: "remove-edges",
    ids: ["input"],
  });
  assert.equal(
    disconnected.nodes[1]!.data.settings!.firstFrameNodeId,
    undefined,
  );
  assert.equal(disconnected.edges[0]!.id, "result");
  const removedResult = applyCommand(doc, {
    type: "remove-edges",
    ids: ["result"],
  });
  assert.equal(
    removedResult.nodes[1]!.data.settings!.firstFrameNodeId,
    image.id,
  );
  assert.equal(parseDocument({ ...doc, edges: [doc.edges[1]] }).ok, false);
});

test("result provenance supports external and cross-media origins, survives JSON, and stays distinct from references", () => {
  const external = createNode("external"),
    audio = createNode("audio"),
    image = createNode("image");
  let doc: CanvasDocument = {
    ...createDocument(),
    nodes: [external, audio, image],
  };
  for (const origin of [external, audio])
    doc = applyCommand(doc, {
      type: "add-edge",
      edge: {
        id: crypto.randomUUID(),
        source: origin.id,
        target: image.id,
        intent: "post_edit_result",
      },
    });
  assert.equal(doc.edges.length, 2);
  assert.equal(canAddReference(doc, external.id, image.id), false);
  const encoded = serializeDocument(doc);
  assert.equal(encoded.ok, true);
  if (encoded.ok) {
    const parsed = parseDocument(encoded.value);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.value.edges, doc.edges);
  }
  assert.equal(
    parseDocument({ ...doc, edges: [{ ...doc.edges[0], intent: "invented" }] })
      .ok,
    false,
  );
});

function stackedFixture() {
  const a = createNode("image", { x: 0, y: 0 }),
    b = createNode("image", { x: 400, y: 0 }),
    c = createNode("video", { x: 900, y: 0 });
  const edges: CanvasEdge[] = [
    { id: "inside", source: a.id, target: b.id },
    { id: "outside", source: b.id, target: c.id },
    {
      id: "provenance",
      source: c.id,
      target: a.id,
      intent: "post_edit_result",
    },
  ];
  const original = { ...createDocument(), nodes: [a, b, c], edges };
  const doc = stackSelection(original, [a.id, b.id]);
  return { a, b, c, doc, stack: doc.nodes.at(-1)! };
}

test("stack projection hides members/internal edges and redirects external edges without touching durable identity", () => {
  const { a, b, c, doc, stack } = stackedFixture();
  const snapshot = structuredClone(doc),
    projected = projectCanvasStacks(doc.nodes, doc.edges);
  assert.deepEqual(doc, snapshot);
  for (const id of [a.id, b.id]) {
    const n = projected.nodes.find((n) => n.id === id)!;
    assert.equal("hidden" in n && n.hidden, true);
    assert.equal("selectable" in n && n.selectable, false);
  }
  assert.equal(projected.edges[0]!.hidden, true);
  assert.equal(projected.edges[1]!.source, stack.id);
  assert.equal(projected.edges[1]!.target, c.id);
  assert.equal(projected.edges[2]!.target, stack.id);
  assert.equal(projected.edges[2]!.intent, "post_edit_result");
  assert.equal(projected.ownerByNodeId.get(a.id), stack.id);
  const hidden = projectCanvasStacks(
    doc.nodes,
    doc.edges.map((e) => ({ ...e, hidden: true })),
  );
  assert.ok(hidden.edges.every((e) => e.hidden));
});

test("removing one of two stack members dissolves only wrapper and preserves content/links with undo", () => {
  const { a, b, doc, stack } = stackedFixture();
  stack.position = { x: 1800, y: 1200 };
  const released = updateStack(doc, stack.id, {
    nodeIds: [b.id],
    activeIndex: 0,
  });
  assert.equal(
    released.nodes.some((n) => n.id === stack.id),
    false,
  );
  assert.equal(released.nodes.find((n) => n.id === a.id)!.data, a.data);
  assert.deepEqual(released.edges, doc.edges);
  assert.equal(released.nodes.find((n) => n.id === a.id)!.position.x, 1800);
  assert.equal(
    projectCanvasStacks(released.nodes, released.edges).ownerByNodeId.size,
    0,
  );
  const history = recordChange(createHistory(doc), released);
  assert.deepEqual(undo(history).present, doc);
});

test("unstack preserves locked member coordinates and copy remaps membership and provenance", () => {
  const { a, b, doc, stack } = stackedFixture();
  a.locked = true;
  const released = unstackSelection(doc, [stack.id]);
  assert.equal(
    released.nodes.find((n) => n.id === a.id),
    a,
  );
  const pasted = pasteFragment(doc, copySelection(doc, [stack.id]));
  const newStack = pasted.document.nodes.find(
    (n) => pasted.ids.includes(n.id) && n.type === "stack",
  )!;
  assert.ok(
    newStack.data.stack!.nodeIds.every(
      (id) => pasted.ids.includes(id) && id !== a.id && id !== b.id,
    ),
  );
  assert.equal(
    projectCanvasStacks(pasted.document.nodes, pasted.document.edges)
      .ownerByNodeId.size,
    4,
  );
});
