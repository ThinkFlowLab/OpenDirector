import assert from "node:assert/strict";
import test from "node:test";
import { absolutePosition } from "../src/canvas/geometry.ts";
import { createDocument, createNode } from "../src/canvas/model.ts";
import type { CanvasDocument, CanvasNode } from "../src/canvas/model.ts";
import {
  copySelection,
  edgesAttachedTo,
  deleteSelection,
  orderNodesForCanvas,
  groupDescendants,
  groupSelection,
  layoutGroup,
  pasteFragment,
  ungroupSelection,
} from "../src/canvas/operations.ts";

function positions(document: CanvasDocument) {
  return new Map(
    document.nodes.map((node) => [
      node.id,
      absolutePosition(node, document.nodes),
    ]),
  );
}

function assertPositionsRetained(
  before: CanvasDocument,
  after: CanvasDocument,
) {
  const original = positions(before);
  for (const node of after.nodes)
    if (original.has(node.id))
      assert.deepEqual(
        absolutePosition(node, after.nodes),
        original.get(node.id),
      );
}

test("group and ungroup preserve coordinates and references across existing parents", () => {
  const outer = createNode("group", { x: -200, y: 70 });
  const first = {
    ...createNode("group", { x: 40, y: 30 }),
    parentId: outer.id,
  };
  const second = {
    ...createNode("group", { x: 700, y: 100 }),
    parentId: outer.id,
  };
  const a = { ...createNode("image", { x: 25, y: 50 }), parentId: first.id };
  const b = { ...createNode("text", { x: -20, y: 100 }), parentId: second.id };
  const document = {
    ...createDocument(),
    nodes: [outer, first, a, second, b],
    edges: [{ id: "reference", source: a.id, target: b.id }],
  };
  const grouped = groupSelection(document, [a.id, b.id]);
  const group = grouped.nodes.find(
    (node) => !document.nodes.includes(node) && node.type === "group",
  )!;
  assert.equal(group.parentId, outer.id);
  assert.equal(
    grouped.nodes.find((node) => node.id === a.id)!.parentId,
    group.id,
  );
  assert.equal(
    grouped.nodes.find((node) => node.id === b.id)!.parentId,
    group.id,
  );
  assertPositionsRetained(document, grouped);
  assert.equal(grouped.edges, document.edges);
  const ungrouped = ungroupSelection(grouped, [group.id]);
  assert.equal(
    ungrouped.nodes.find((node) => node.id === a.id)!.parentId,
    outer.id,
  );
  assert.equal(
    ungrouped.nodes.find((node) => node.id === b.id)!.parentId,
    outer.id,
  );
  assertPositionsRetained(document, ungrouped);
  assert.deepEqual(ungrouped.edges, document.edges);
  assert.equal(a.parentId, first.id);
});

test("grouping ancestor and descendant together moves only independent roots and cannot form a cycle", () => {
  const group = createNode("group", { x: 100, y: 200 });
  const child = {
    ...createNode("image", { x: 20, y: 40 }),
    parentId: group.id,
  };
  const other = createNode("text", { x: 900, y: -100 });
  const document = { ...createDocument(), nodes: [group, child, other] };
  assert.equal(groupSelection(document, [group.id, child.id]), document);
  const grouped = groupSelection(document, [
    group.id,
    child.id,
    other.id,
    other.id,
  ]);
  assert.equal(grouped.nodes.length, 4);
  assert.equal(
    grouped.nodes.find((node) => node.id === child.id),
    child,
  );
  assertPositionsRetained(document, grouped);
});

test("ungrouping nested selected containers reconnects to the nearest retained ancestor", () => {
  const outer = createNode("group", { x: -300, y: 80 });
  const middle = {
    ...createNode("group", { x: 70, y: 90 }),
    parentId: outer.id,
  };
  const inner = {
    ...createNode("group", { x: -20, y: 30 }),
    parentId: middle.id,
  };
  const child = { ...createNode("text", { x: 5, y: 6 }), parentId: inner.id };
  const target = createNode("image");
  const document = {
    ...createDocument(),
    nodes: [outer, middle, inner, child, target],
    edges: [
      { id: "content", source: child.id, target: target.id },
      { id: "container", source: inner.id, target: target.id },
    ],
  };
  const result = ungroupSelection(document, [middle.id, inner.id]);
  assert.equal(
    result.nodes.find((node) => node.id === child.id)!.parentId,
    outer.id,
  );
  assert.deepEqual(result.edges, [document.edges[0]]);
  assertPositionsRetained(document, result);
  const ungrouped = ungroupSelection(result, [outer.id]);
  assert.equal(
    ungrouped.nodes.find((node) => node.id === child.id)!.parentId,
    undefined,
  );
  assertPositionsRetained(document, ungrouped);
});

test("locked nodes and nodes within locked groups are not implicitly reparented", () => {
  const lockedGroup = { ...createNode("group"), locked: true };
  const child = { ...createNode("text"), parentId: lockedGroup.id };
  const locked = { ...createNode("image"), locked: true };
  const free = createNode("image", { x: 900, y: 20 });
  const document = {
    ...createDocument(),
    nodes: [lockedGroup, child, locked, free],
  };
  assert.equal(
    groupSelection(
      document,
      document.nodes.map((node) => node.id),
    ),
    document,
  );
  assert.equal(ungroupSelection(document, [lockedGroup.id]), document);

  const parent = createNode("group", { x: 400, y: 200 });
  const lockedChild = { ...locked, parentId: parent.id };
  const containingLocked = {
    ...createDocument(),
    nodes: [parent, lockedChild, free],
  };
  assert.equal(
    ungroupSelection(containingLocked, [parent.id]),
    containingLocked,
  );
  const grouped = groupSelection(containingLocked, [parent.id, free.id]);
  assert.equal(
    grouped.nodes.find((node) => node.id === lockedChild.id),
    lockedChild,
  );
  assertPositionsRetained(containingLocked, grouped);
});

test("copy includes group descendants and internal references, detaches omitted parents, and clones data", () => {
  const outer = createNode("group", { x: -100, y: 300 });
  const inner = {
    ...createNode("group", { x: 30, y: 70 }),
    parentId: outer.id,
  };
  const child = {
    ...createNode(
      "image",
      { x: 10, y: 20 },
      { custom: { tags: ["original"] } },
    ),
    parentId: inner.id,
  };
  const other = createNode("text");
  const document = {
    ...createDocument(),
    nodes: [outer, inner, child, other],
    edges: [
      {
        id: "inside",
        source: inner.id,
        target: child.id,
        targetHandle: "reference",
      },
      { id: "outside", source: child.id, target: other.id },
    ],
  };
  const copied = copySelection(document, [inner.id]);
  assert.deepEqual(
    copied.nodes.map((node) => node.id),
    [inner.id, child.id],
  );
  assert.equal(copied.nodes[0]!.parentId, undefined);
  assert.deepEqual(copied.nodes[0]!.position, { x: -70, y: 370 });
  assert.equal(copied.nodes[1]!.parentId, inner.id);
  assert.deepEqual(copied.edges, [document.edges[0]]);
  (copied.nodes[1]!.data.custom as { tags: string[] }).tags.push("copy");
  assert.deepEqual(child.data.custom, { tags: ["original"] });
  const childOnly = copySelection(document, [child.id]);
  assert.deepEqual(childOnly.nodes[0]!.position, { x: -60, y: 390 });
  assert.equal(childOnly.nodes[0]!.parentId, undefined);
  assert.deepEqual(childOnly.edges, []);
});

test("paste remaps nested identity and references, offsets roots once, and supports independent repetitions", () => {
  const group = createNode("group", { x: -50, y: 20 });
  const child = {
    ...createNode("image", { x: 10, y: 30 }),
    parentId: group.id,
  };
  const text = {
    ...createNode("text", { x: 350, y: 30 }, { text: "copy" }),
    parentId: group.id,
  };
  const source = {
    ...createDocument(),
    nodes: [group, child, text],
    edges: [
      {
        id: "reference",
        source: child.id,
        target: text.id,
        sourceHandle: "output",
        targetHandle: "reference",
      },
    ],
  };
  const fragment = copySelection(source, [group.id]);
  const first = pasteFragment(source, fragment);
  const pasted = first.document.nodes.slice(source.nodes.length);
  assert.equal(
    new Set([...source.nodes, ...pasted].map((node) => node.id)).size,
    6,
  );
  assert.equal(pasted[1]!.parentId, pasted[0]!.id);
  assert.deepEqual(pasted[0]!.position, { x: -10, y: 60 });
  assert.deepEqual(pasted[1]!.position, child.position);
  assert.deepEqual(absolutePosition(pasted[1]!, pasted), { x: 0, y: 90 });
  const edge = first.document.edges[1]!;
  assert.notEqual(edge.id, source.edges[0]!.id);
  assert.equal(edge.source, pasted[1]!.id);
  assert.equal(edge.target, pasted[2]!.id);
  assert.equal(edge.targetHandle, "reference");
  assert.deepEqual(
    first.ids,
    pasted.map((node) => node.id),
  );
  pasted[2]!.data.text = "edited";
  assert.equal(fragment.nodes[2]!.data.text, "copy");
  const second = pasteFragment(first.document, fragment, { x: 80, y: -20 });
  assert.deepEqual(second.document.nodes[6]!.position, { x: 30, y: 0 });
  assert.equal(
    second.ids.some((id) => first.ids.includes(id)),
    false,
  );
  assert.equal(source.nodes.length, 3);
});

test("duplicate retains incoming, internal and outgoing connections with fresh identities", () => {
  const image = (x: number) => createNode("image", { x, y: 0 }, {
    src: "data:image/png;base64,AA==",
  });
  const [upstream, first, second] = [image(0), image(300), image(600)];
  const downstream = createNode("video", { x: 900, y: 0 }, {
    settings: { videoMode: "reference" },
  });
  const edges = [
    { id: "in", source: upstream.id, target: second.id, targetHandle: "in" },
    { id: "internal", source: first.id, target: second.id },
    { id: "out", source: second.id, target: downstream.id },
  ];
  const document = { ...createDocument(), nodes: [upstream, first, second, downstream], edges };
  const fragment = copySelection(document, [first.id, second.id]);
  const pasted = pasteFragment(document, fragment);
  assert.equal(pasted.document.edges.length, 4);

  const duplicate = pasteFragment(document, fragment, undefined, "duplicate");
  const [firstCopy, secondCopy] = duplicate.ids;
  assert.deepEqual(duplicate.document.edges.slice(0, 3), edges);
  const added = duplicate.document.edges.slice(3);
  assert.deepEqual(added.map(({ source, target }) => [source, target]), [
    [upstream.id, secondCopy],
    [firstCopy, secondCopy],
    [secondCopy, downstream.id],
  ]);
  assert.equal(added[0]?.targetHandle, "in");
  assert.equal(new Set(duplicate.document.edges.map(({ id }) => id)).size, 6);
});

test("paste orders parents first and rejects incomplete or cyclic fragments without mutating the destination", () => {
  const document = createDocument();
  const parent = createNode("group");
  const child: CanvasNode = { ...createNode("text"), parentId: parent.id };
  const result = pasteFragment(document, { nodes: [child, parent], edges: [] });
  assert.equal(result.document.nodes[0]!.type, "group");
  assert.equal(
    result.document.nodes[1]!.parentId,
    result.document.nodes[0]!.id,
  );
  assert.throws(
    () => pasteFragment(document, { nodes: [child], edges: [] }),
    /父节点/,
  );
  assert.throws(
    () =>
      pasteFragment(document, {
        nodes: [{ ...parent, parentId: child.id }, child],
        edges: [],
      }),
    /循环/,
  );
  assert.throws(
    () =>
      pasteFragment(document, {
        nodes: [parent],
        edges: [{ id: "dangling", source: parent.id, target: "missing" }],
      }),
    /两端/,
  );
  assert.throws(
    () =>
      pasteFragment(document, { nodes: [], edges: [] }, { x: Infinity, y: 0 }),
    /有限/,
  );
  assert.equal(document.nodes.length, 0);
  assert.equal(
    pasteFragment(document, { nodes: [], edges: [] }).document,
    document,
  );
});

test("rendering orders parents before children without losing layer values or mutating document order", () => {
  const group = { ...createNode("group"), zIndex: 4 };
  const child = { ...createNode("image"), parentId: group.id, zIndex: 2 };
  const nested = { ...createNode("text"), parentId: child.id, zIndex: 3 };
  const input = [nested, child, group];
  const result = orderNodesForCanvas(input);
  assert.deepEqual(
    result.map((n) => n.id),
    [group.id, child.id, nested.id],
  );
  assert.deepEqual(
    result.map((n) => n.zIndex),
    [4, 2, 3],
  );
  assert.equal(input[0], nested);
});

test("deleting nodes lists its attached references while other edges stay", () => {
  const source = createNode("image", undefined, { title: "A" });
  const other = createNode("image", undefined, { title: "B" });
  const target = createNode("video", undefined, { title: "C" });
  const document = {
    ...createDocument(),
    nodes: [source, other, target],
    edges: [
      { id: "e-source", source: source.id, target: target.id },
      { id: "e-other", source: other.id, target: target.id },
    ],
  };
  assert.deepEqual(edgesAttachedTo(document, [source.id]), ["e-source"]);
  assert.deepEqual(
    edgesAttachedTo(document, [source.id, other.id]).sort(),
    ["e-other", "e-source"],
  );
  // The target's incoming references belong to it as well.
  assert.deepEqual(edgesAttachedTo(document, [target.id]).sort(), [
    "e-other",
    "e-source",
  ]);
  assert.deepEqual(edgesAttachedTo(document, []), []);
  const group = createNode("group");
  const grouped = {
    ...document,
    nodes: [group, { ...source, parentId: group.id }, { ...other, locked: true }, target],
  };
  const deleted = deleteSelection(grouped, [group.id, other.id], []);
  assert.deepEqual(deleted.nodes.map((node) => node.id), [other.id, target.id]);
  assert.deepEqual(deleted.edges.map((edge) => edge.id), ["e-other"]);
});

test("layoutGroup arranges direct members and fits the group around them", () => {
  const group = { ...createNode("group", { x: 100, y: 100 }), width: 900, height: 900 };
  const member = (x: number, y: number, width: number, height: number) => ({
    ...createNode("image", { x, y }),
    width,
    height,
    parentId: group.id,
  });
  const a = member(300, 30, 200, 100);
  const b = member(24, 400, 100, 150);
  const c = member(24, 40, 120, 80);
  const outside = createNode("text", { x: 0, y: 0 });
  const document: CanvasDocument = {
    ...createDocument(),
    nodes: [group, a, b, c, outside],
  };
  const at = (doc: CanvasDocument, id: string) =>
    doc.nodes.find((node) => node.id === id)!;

  const row = layoutGroup(document, group.id, "row");
  // Left-to-right order: c, b (x 24, lower), a.
  assert.deepEqual(at(row, c.id).position, { x: 24, y: 40 });
  assert.deepEqual(at(row, b.id).position, { x: 184, y: 40 });
  assert.deepEqual(at(row, a.id).position, { x: 324, y: 40 });
  assert.equal(at(row, group.id).width, 324 + 200 + 24);
  assert.equal(at(row, group.id).height, 40 + 150 + 24);
  assert.deepEqual(at(row, group.id).position, group.position);
  assert.equal(at(row, outside.id), outside);

  const column = layoutGroup(document, group.id, "column");
  // Top-to-bottom order: a (y 30), c, b.
  assert.deepEqual(
    [a, c, b].map((node) => at(column, node.id).position),
    [
      { x: 24, y: 40 },
      { x: 24, y: 180 },
      { x: 24, y: 300 },
    ],
  );
  assert.equal(at(column, group.id).width, 24 + 200 + 24);

  const grid = layoutGroup(document, group.id, "grid");
  assert.deepEqual(at(grid, b.id).position, { x: 24, y: 40 + 100 + 40 });
  assert.equal(layoutGroup(document, outside.id, "grid"), document);
});

test("groupDescendants returns members at every depth", () => {
  const outer = createNode("group", { x: 0, y: 0 });
  const inner = { ...createNode("group", { x: 10, y: 10 }), parentId: outer.id };
  const leaf = { ...createNode("image", { x: 5, y: 5 }), parentId: inner.id };
  const direct = { ...createNode("text", { x: 50, y: 5 }), parentId: outer.id };
  const other = createNode("image", { x: 500, y: 500 });
  const nodes = [leaf, other, direct, inner, outer];
  assert.deepEqual(
    new Set(groupDescendants(nodes, outer.id).map((node) => node.id)),
    new Set([inner.id, leaf.id, direct.id]),
  );
  assert.deepEqual(groupDescendants(nodes, inner.id).map((node) => node.id), [leaf.id]);
});
