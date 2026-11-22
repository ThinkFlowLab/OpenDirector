import { createCanvasToolTask } from "../src/canvas/toolCatalog.ts";
import { createLayerDocument } from "../src/canvas/layerDocument.ts";
import { parseDocument } from "../src/canvas/storage.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCommand,
  createDocument,
  createNode,
  canAddReference,
} from "../src/canvas/model.ts";
import { sameCanvasContent } from "../src/canvas/history.ts";
import {
  absolutePosition,
  arrangeNodes,
  boundsOfNodes,
  fitViewport,
} from "../src/canvas/geometry.ts";

test("resizing a group keeps locked and nested children in world space", () => {
  const group = createNode("group", { x: 100, y: 200 });
  const child = {
    ...createNode("group", { x: 20, y: 30 }),
    parentId: group.id,
    locked: true,
  };
  const leaf = { ...createNode("image", { x: 10, y: 10 }), parentId: child.id };
  const before = { ...createDocument(), nodes: [group, child, leaf] };
  const after = applyCommand(before, {
    type: "resize-node",
    id: group.id,
    position: { x: 40, y: 150 },
    width: group.width + 60,
    height: group.height + 50,
  });
  for (let i = 1; i < before.nodes.length; i++)
    assert.deepEqual(
      absolutePosition(after.nodes[i]!, after.nodes),
      absolutePosition(before.nodes[i]!, before.nodes),
    );
  assert.equal(after.nodes[1]!.locked, true);
  assert.equal(after.nodes[1]!.data, child.data);
  assert.equal(after.nodes[2], leaf);
  assert.equal(
    applyCommand(before, {
      type: "resize-node",
      id: child.id,
      width: 500,
      height: 500,
    }),
    before,
  );
  assert.throws(
    () =>
      applyCommand(before, {
        type: "resize-node",
        id: group.id,
        width: NaN,
        height: 500,
      }),
    /尺寸/,
  );
});

test("group and child multiselection translates once; deletion removes attached edges", () => {
  const group = createNode("group", { x: -100, y: 40 });
  const image = {
    ...createNode("image", { x: 20, y: 30 }),
    parentId: group.id,
  };
  const text = createNode("text", { x: 900, y: 200 });
  const document = {
    ...createDocument(),
    nodes: [group, image, text],
    edges: [{ id: "edge", source: image.id, target: text.id }],
  };
  const moved = applyCommand(document, {
    type: "move-nodes",
    ids: [group.id, image.id],
    delta: { x: 50, y: -10 },
  });
  assert.deepEqual(moved.nodes[1]!.position, image.position);
  assert.deepEqual(absolutePosition(moved.nodes[1]!, moved.nodes), {
    x: -30,
    y: 60,
  });
  assert.deepEqual(document.nodes[0]!.position, { x: -100, y: 40 });
  const removed = applyCommand(moved, {
    type: "remove-nodes",
    ids: [group.id],
  });
  assert.deepEqual(
    removed.nodes.map((node) => node.id),
    [text.id],
  );
  assert.deepEqual(removed.edges, []);
});

test("locked nodes reject edits and deletion; unlock remains an explicit operation", () => {
  const node = { ...createNode("text"), locked: true };
  const document = { ...createDocument(), nodes: [node] };
  assert.equal(
    applyCommand(document, {
      type: "move-nodes",
      ids: [node.id],
      delta: { x: 10, y: 20 },
    }),
    document,
  );
  assert.equal(
    applyCommand(document, {
      type: "update-node",
      id: node.id,
      patch: { data: { text: "edit" } },
    }),
    document,
  );
  assert.equal(
    applyCommand(document, { type: "remove-nodes", ids: [node.id] }),
    document,
  );
  const unlocked = applyCommand(document, {
    type: "update-node",
    id: node.id,
    patch: { locked: false },
  });
  assert.equal(unlocked.nodes[0]!.locked, false);
  assert.equal(node.locked, true);
});

test("deleting a group containing a locked descendant preserves the group and descendant", () => {
  const group = createNode("group");
  const child = { ...createNode("image"), parentId: group.id, locked: true };
  const document = { ...createDocument(), nodes: [group, child] };
  assert.equal(
    applyCommand(document, { type: "remove-nodes", ids: [group.id] }),
    document,
  );
});

test("document commands preserve unique node identity and reject dangling edge endpoints", () => {
  const image = createNode("image");
  const document = { ...createDocument(), nodes: [image] };
  assert.throws(
    () => applyCommand(document, { type: "add-nodes", nodes: [image] }),
    /重复/,
  );
  assert.throws(
    () =>
      applyCommand(document, {
        type: "add-edge",
        edge: { id: "edge", source: image.id, target: "missing" },
      }),
    /两端/,
  );
});

test("layer commands keep multi-selection order and move by one visible step", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => ({
    ...createNode("image"),
    id,
  }));
  const document = { ...createDocument(), nodes };
  const forward = applyCommand(document, {
    type: "reorder-nodes",
    ids: ["a", "b"],
    direction: "forward",
  });
  assert.deepEqual(
    forward.nodes.map((node) => node.id),
    ["c", "a", "b", "d"],
  );
  const back = applyCommand(forward, {
    type: "reorder-nodes",
    ids: ["d"],
    direction: "back",
  });
  assert.deepEqual(
    back.nodes.map((node) => node.id),
    ["d", "c", "a", "b"],
  );
  assert.deepEqual(
    document.nodes.map((node) => node.id),
    ["a", "b", "c", "d"],
  );
});

test("bounds and fit cover negative coordinates and nested children within zoom bounds", () => {
  const parent = createNode("group", { x: -200, y: -100 });
  const child = {
    ...createNode("image", { x: 20, y: 10 }),
    parentId: parent.id,
    width: 100,
    height: 50,
  };
  const bounds = boundsOfNodes([child], [parent, child]);
  assert.deepEqual(bounds, { x: -180, y: -90, width: 100, height: 50 });
  assert.deepEqual(fitViewport(bounds, { width: 300, height: 200 }, 50), {
    x: 410,
    y: 230,
    zoom: 2,
  });
  assert.equal(
    fitViewport(
      { x: 0, y: 0, width: 1000000, height: 1000000 },
      { width: 300, height: 200 },
    ).zoom,
    0.08,
  );
  assert.equal(
    fitViewport(
      { x: 0, y: 0, width: 1, height: 1 },
      { width: 1000, height: 1000 },
    ).zoom,
    8,
  );
  assert.equal(boundsOfNodes([]), null);
});

test("arrangement honors variable heights, locks, and existing group coordinates", () => {
  const a = { ...createNode("image", { x: 0, y: 0 }), width: 100, height: 50 };
  const b = {
    ...createNode("image", { x: 500, y: 10 }),
    width: 200,
    height: 100,
  };
  const c = {
    ...createNode("image", { x: 900, y: 20 }),
    width: 100,
    height: 50,
  };
  const locked = { ...createNode("image", { x: 1200, y: 200 }), locked: true };
  const arranged = arrangeNodes(
    [a, b, c, locked],
    [a.id, b.id, c.id, locked.id],
    { columns: 2, gap: 20 },
  );
  assert.deepEqual(
    arranged.map((node) => node.position),
    [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 0, y: 120 }, locked.position],
  );
  assert.equal(arranged[3], locked);
});

test("reference commands allow self references and keep duplicate relationships unchanged", () => {
  const a = createNode("image", undefined, { src: "data:image/fixture" }),
    b = createNode("video");
  const doc = { ...createDocument(), nodes: [a, b] };
  const connected = applyCommand(doc, {
    type: "add-edge",
    edge: { id: "first", source: a.id, target: b.id },
  });
  assert.equal(
    applyCommand(connected, {
      type: "add-edge",
      edge: {
        id: "second",
        source: a.id,
        target: b.id,
        sourceHandle: "out",
        targetHandle: "in",
      },
    }),
    connected,
  );
  assert.equal(canAddReference(connected, a.id, a.id), true);
  const self = applyCommand(connected, {
    type: "add-edge",
    edge: { id: "self", source: a.id, target: a.id },
  });
  assert.deepEqual(self.edges, [
    ...connected.edges,
    { id: "self", source: a.id, target: a.id },
  ]);
  assert.equal(
    applyCommand(self, {
      type: "add-edge",
      edge: { id: "self-again", source: a.id, target: a.id },
    }),
    self,
  );
  assert.equal(canAddReference(doc, a.id, a.id, "post_edit_result"), false);
});

test("reference commands and port previews allow direct and transitive cycles", () => {
  const [a, b, c, d] = Array.from({ length: 4 }, () =>
    createNode("image", undefined, { src: "data:image/fixture" }),
  );
  const initial = { ...createDocument(), nodes: [a!, b!, c!, d!] };
  const chain = applyCommand(initial, {
    type: "batch",
    commands: [
      { type: "add-edge", edge: { id: "ab", source: a!.id, target: b!.id } },
      { type: "add-edge", edge: { id: "bc", source: b!.id, target: c!.id } },
    ],
  });
  for (const [source, target] of [
    [b!.id, a!.id],
    [c!.id, a!.id],
  ]) {
    assert.equal(canAddReference(chain, source, target), true);
    const edge = { id: "cycle", source: source!, target: target! };
    const connected = applyCommand(chain, { type: "add-edge", edge });
    assert.deepEqual(connected.edges, [...chain.edges, edge]);
    const parsed = parseDocument(connected);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.value.edges, connected.edges);
  }
  assert.equal(canAddReference(chain, a!.id, c!.id), true);
  assert.equal(canAddReference(chain, d!.id, b!.id), true);
  assert.equal(canAddReference(chain, a!.id, "absent"), false);
});

test("cyclic documents accept further references without deleting retained edges", () => {
  const [a, b, c] = Array.from({ length: 3 }, () =>
    createNode("image", undefined, { src: "data:image/fixture" }),
  );
  const old = {
    ...createDocument(),
    nodes: [a!, b!, c!],
    edges: [
      { id: "ab", source: a!.id, target: b!.id },
      { id: "ba", source: b!.id, target: a!.id },
    ],
  };
  assert.equal(canAddReference(old, c!.id, a!.id), true);
  const added = applyCommand(old, {
    type: "add-edge",
    edge: { id: "ca", source: c!.id, target: a!.id },
  });
  assert.deepEqual(added.edges.slice(0, 2), old.edges);
  assert.equal(canAddReference(added, b!.id, c!.id), true);
});

test("locking a group protects nested nodes and their live references until the group is unlocked", () => {
  const group = { ...createNode("group"), locked: true };
  const inner = { ...createNode("group"), parentId: group.id };
  const image = { ...createNode("image"), parentId: inner.id };
  const source = createNode("image");
  const document = {
    ...createDocument(),
    nodes: [
      group,
      inner,
      {
        ...image,
        data: {
          ...image.data,
          settings: {
            ...createDocument().settings,
            firstFrameNodeId: source.id,
          },
        },
      },
      source,
    ],
    edges: [{ id: "frame", source: source.id, target: image.id }],
  };
  const commands: import("../src/canvas/model.ts").CanvasCommand[] = [
    { type: "move-nodes", ids: [image.id], delta: { x: 20, y: 30 } },
    {
      type: "update-node",
      id: image.id,
      patch: { data: { title: "changed" } },
    },
    {
      type: "update-node",
      id: image.id,
      patch: { locked: false, position: { x: 20, y: 30 } },
    },
    { type: "resize-node", id: image.id, width: 500, height: 500 },
    { type: "remove-nodes", ids: [image.id, inner.id, source.id] },
    { type: "reorder-nodes", ids: [image.id], direction: "front" },
    { type: "remove-edges", ids: ["frame"] },
  ];
  for (const command of commands)
    assert.equal(applyCommand(document, command), document, command.type);
  const unlocked = applyCommand(document, {
    type: "update-node",
    id: group.id,
    patch: { locked: false },
  });
  assert.equal(unlocked.nodes[2]!.locked, false);
  const moved = applyCommand(unlocked, commands[0]!);
  assert.deepEqual(moved.nodes[2]!.position, {
    x: image.position.x + 20,
    y: image.position.y + 30,
  });
  assert.equal(moved.nodes[0]!.locked, false);
});

test("replacing media drops old pixel edits and metadata but allows atomic layer output", () => {
  const oldSrc = "data:image/svg+xml,old",
    newSrc = "data:image/svg+xml,new";
  const layers = createLayerDocument(oldSrc, 100, 100);
  const image = createNode(
    "image",
    { x: 40, y: 30 },
    {
      src: oldSrc,
      layers,
      mimeType: "image/svg+xml",
      assetState: "ready",
      media: { width: 100, height: 100 },
      settings: createDocument().settings,
      prompt: "keep prompt",
    },
  );
  image.data.taskDraft = createCanvasToolTask(
    "cutout",
    [image.id],
    { selectionMode: "manual" },
    {
      sourceNodeId: image.id,
      width: 100,
      height: 100,
      maskDataUrl: "data:image/png;base64,mask",
    },
  );
  const before = { ...createDocument(), nodes: [image] };
  const renamed = applyCommand(before, {
    type: "update-node",
    id: image.id,
    patch: { data: { title: "renamed" } },
  });
  assert.equal(renamed.nodes[0]!.data.layers, layers);
  const replaced = applyCommand(before, {
    type: "update-node",
    id: image.id,
    patch: {
      data: { src: newSrc, mimeType: "image/svg+xml", assetState: "ready" },
    },
  });
  assert.equal(replaced.nodes[0]!.data.layers, undefined);
  assert.equal(replaced.nodes[0]!.data.taskDraft, undefined);
  assert.equal(replaced.nodes[0]!.data.media, undefined);
  assert.equal(replaced.nodes[0]!.data.settings, image.data.settings);
  assert.equal(replaced.nodes[0]!.data.prompt, "keep prompt");
  assert.equal(parseDocument(replaced).ok, true);
  const newLayers = createLayerDocument(newSrc, 200, 100);
  const edited = applyCommand(before, {
    type: "update-node",
    id: image.id,
    patch: {
      data: {
        src: newSrc,
        layers: newLayers,
        media: { width: 200, height: 100 },
      },
    },
  });
  assert.equal(edited.nodes[0]!.data.layers, newLayers);
  assert.deepEqual(edited.nodes[0]!.data.media, { width: 200, height: 100 });
  const audio = applyCommand(before, {
    type: "update-node",
    id: image.id,
    patch: {
      type: "audio",
      data: { src: "data:audio/wav,new", mimeType: "audio/wav" },
    },
  });
  assert.equal(audio.nodes[0]!.data.layers, undefined);
  assert.equal(audio.nodes[0]!.data.settings, undefined);
  assert.equal(audio.nodes[0]!.data.media, undefined);
  assert.equal(audio.nodes[0]!.data.kind, "audio");
  assert.deepEqual(audio.nodes[0]!.position, image.position);
  assert.equal(parseDocument(audio).ok, true);
});

test("moving the viewport is not a business content change", () => {
  const document = createDocument("View only");
  assert.equal(
    sameCanvasContent(document, {
      ...document,
      viewport: { x: 420, y: -80, zoom: 0.7 },
    }),
    true,
  );
  assert.equal(
    sameCanvasContent(document, { ...document, title: "Renamed" }),
    false,
  );
  assert.equal(
    sameCanvasContent(document, {
      ...document,
      nodes: [createNode("image")],
    }),
    false,
  );
  assert.equal(
    sameCanvasContent(document, {
      ...document,
      hiddenNodes: [createNode("text")],
    }),
    false,
  );
});

test("empty media cards use the agreed shapes and adopt the file aspect once known", () => {
  const blank = createNode("video");
  assert.deepEqual([blank.width, blank.height], [540, 300]);
  assert.deepEqual(
    [createNode("image").width, createNode("image").height],
    [300, 300],
  );
  const portrait = createNode("image", undefined, {
    src: "data:image/png;base64,a",
    media: { width: 1080, height: 1920 },
  });
  assert.deepEqual([portrait.width, portrait.height], [169, 300]);

  const before = { ...createDocument(), nodes: [blank] };
  const decoded = applyCommand(before, {
    type: "update-node",
    id: blank.id,
    patch: { data: { media: { width: 1000, height: 1000 } } },
  });
  assert.deepEqual(
    [decoded.nodes[0]!.width, decoded.nodes[0]!.height],
    [540, 540],
  );
  // A duration update or an unchanged size keeps a block the user resized.
  const resized = { ...decoded.nodes[0]!, width: 500, height: 200 };
  const same = applyCommand(
    { ...decoded, nodes: [resized] },
    {
      type: "update-node",
      id: blank.id,
      patch: {
        data: { media: { width: 1000, height: 1000, durationSeconds: 4 } },
      },
    },
  );
  assert.deepEqual([same.nodes[0]!.width, same.nodes[0]!.height], [500, 200]);
  // Text and audio blocks never follow pixel sizes.
  const audio = createNode("audio");
  assert.deepEqual([audio.width, audio.height], [300, 112]);
  const sound = applyCommand(
    { ...createDocument(), nodes: [audio] },
    {
      type: "update-node",
      id: audio.id,
      patch: { data: { media: { width: 10, height: 10 } } },
    },
  );
  assert.deepEqual(
    [sound.nodes[0]!.width, sound.nodes[0]!.height],
    [audio.width, audio.height],
  );
});

test("a group color change is a business content change", () => {
  const group = createNode("group");
  const document = { ...createDocument("Colors"), nodes: [group] };
  const colored = { ...document, nodes: [{ ...group, color: "#3e63dd" }] };
  assert.equal(sameCanvasContent(document, colored), false);
  assert.equal(
    sameCanvasContent(colored, { ...document, nodes: [{ ...group, color: "#3e63dd" }] }),
    true,
  );
  // Clearing the color back to the default is also saved.
  assert.equal(
    sameCanvasContent(colored, { ...document, nodes: [{ ...group, color: undefined }] }),
    false,
  );
  assert.equal(parseDocument(colored).ok, true);
  assert.equal(parseDocument({ ...document, nodes: [{ ...group, color: "blue" }] }).ok, false);
});
