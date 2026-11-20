import assert from "node:assert/strict";
import test from "node:test";
import {
  createImageLayer,
  createLayerDocument,
  hitLayer,
  layerToWorld,
  parseLayerDocument,
  parseLayerDocumentValue,
  recordLayers,
  redoLayers,
  reorderLayer,
  sameLayerDocument,
  undoLayers,
  worldToLayer,
  type LayerHistory,
} from "../src/canvas/layerDocument.ts";

test("mask coordinates round trip through rotation, non-uniform resize, and both flips", () => {
  const initial = createLayerDocument("data:image/png;base64,a", 800, 600)
    .layers[0]!;
  for (const rotation of [0, 90, 270, 37, -63])
    for (const flipX of [true, false])
      for (const flipY of [true, false]) {
        const layer = {
          ...initial,
          x: -150,
          y: 230,
          width: 350,
          height: 912,
          rotation,
          flipX,
          flipY,
        };
        for (const point of [
          { x: 0, y: 0 },
          { x: 800, y: 600 },
          { x: 301.5, y: 278 },
        ]) {
          const back = worldToLayer(layer, layerToWorld(layer, point));
          assert.ok(Math.abs(back.x - point.x) < 1e-8);
          assert.ok(Math.abs(back.y - point.y) < 1e-8);
        }
      }
});
test("hit selection follows actual painter order and skips hidden, locked or transparent layers", () => {
  const doc = createLayerDocument("data:image/png;base64,a", 800, 600);
  const upper = {
    ...createImageLayer(
      { kind: "rectangle", color: "#ffffff", width: 100, height: 100 },
      "upper",
    ),
    x: 10,
    y: 10,
    rotation: 45,
  };
  const stacked = { ...doc, layers: [...doc.layers, upper] };
  assert.equal(hitLayer(stacked, { x: 60, y: 60 })?.id, upper.id);
  for (const change of [{ visible: false }, { locked: true }, { opacity: 0 }])
    assert.equal(
      hitLayer(
        { ...stacked, layers: [doc.layers[0]!, { ...upper, ...change }] },
        { x: 60, y: 60 },
      )?.id,
      doc.layers[0]!.id,
    );
  assert.equal(
    hitLayer(reorderLayer(stacked, upper.id, 0), { x: 60, y: 60 })?.id,
    doc.layers[0]!.id,
  );
  assert.equal(stacked.layers[1], upper);
});
test("a complete mask stroke and drag are one undo entry each, redo preserves painter order", () => {
  const original = createLayerDocument("data:image/png;base64,a", 800, 600);
  const mask = [
    {
      mode: "erase" as const,
      size: 32,
      points: [
        { x: 10, y: 20 },
        { x: 50, y: 90 },
      ],
    },
  ];
  const masked = { ...original, layers: [{ ...original.layers[0]!, mask }] };
  let history: LayerHistory = { past: [], present: original, future: [] };
  history = recordLayers(history, masked);
  const moved = {
    ...masked,
    layers: [{ ...masked.layers[0]!, x: 150, y: 90 }],
  };
  history = recordLayers(
    {
      ...history,
      present: { ...masked, layers: [{ ...masked.layers[0]!, x: 80 }] },
    },
    moved,
    masked,
  );
  assert.equal(history.past.length, 2);
  assert.equal(undoLayers(history).present, masked);
  assert.equal(undoLayers(undoLayers(history)).present, original);
  assert.equal(redoLayers(undoLayers(history)).present, moved);
});
test("locked layers cannot be reordered and do not add an undo entry", () => {
  const original = createLayerDocument("data:image/png;base64,a", 100, 100);
  original.layers[0]!.locked = true;
  original.layers.push(
    createImageLayer(
      { kind: "rectangle", color: "#ffffff", width: 100, height: 100 },
      "upper",
    ),
  );
  const history: LayerHistory = { past: [], present: original, future: [] };
  const refused = reorderLayer(original, original.layers[0]!.id, 1);
  assert.equal(refused, original);
  assert.equal(recordLayers(history, refused), history);
  const unlocked = {
    ...original,
    layers: original.layers.map((layer) => ({ ...layer, locked: false })),
  };
  assert.equal(
    reorderLayer(unlocked, unlocked.layers[0]!.id, 1).layers[1]!.id,
    unlocked.layers[0]!.id,
  );
});
test("editable layer document round trips masks and content and ignores unowned fields", () => {
  const original = createLayerDocument("data:image/png;base64,a", 800, 600);
  original.layers.push(
    createImageLayer(
      {
        kind: "text",
        text: "第一行\n第二行",
        color: "#abc123",
        fontSize: 48,
        width: 600,
        height: 200,
      },
      "标题",
    ),
  );
  original.layers[0]!.mask = [
    { mode: "restore", size: 23, points: [{ x: -12, y: 99 }] },
  ];
  const parsed = parseLayerDocument(
    JSON.stringify({ ...original, other: "ignored" }),
  );
  assert.ok(sameLayerDocument(original, parsed));
  assert.equal("other" in parsed, false);
  assert.ok(
    !sameLayerDocument(original, {
      ...parsed,
      layers: parsed.layers.map((layer, index) =>
        index ? { ...layer, opacity: 0.4 } : layer,
      ),
    }),
  );
  assert.ok(
    !sameLayerDocument(original, {
      ...parsed,
      layers: [...parsed.layers].reverse(),
    }),
  );
});
test("boundary rejects remote assets, duplicate ids, invalid geometry and malformed masks", () => {
  const original = createLayerDocument("data:image/png;base64,a", 800, 600);
  const layer = original.layers[0]!;
  for (const bad of [
    { ...original, width: 0 },
    { ...original, width: 8192, height: 8192 },
    { ...original, layers: [layer, layer] },
    { ...original, layers: [{ ...layer, opacity: NaN }] },
    {
      ...original,
      layers: [
        {
          ...layer,
          content: {
            ...layer.content,
            src: "https://outside.example/image.png",
          },
        },
      ],
    },
    {
      ...original,
      layers: [
        {
          ...layer,
          mask: [
            { mode: "arbitrary-operation", size: 20, points: [{ x: 1, y: 1 }] },
          ],
        },
      ],
    },
  ])
    assert.throws(() => parseLayerDocumentValue(bad));
});

test("layer JSON text imports reject unparsable files with a localized notice", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://localhost:5173" },
  });
  try {
    const document = createLayerDocument(
      "blob:http://localhost:5173/source",
      800,
      600,
    );
    assert.deepEqual(parseLayerDocument(JSON.stringify(document)), document);
    // Non-JSON bytes must report the localized notice, not an engine
    // SyntaxError quoting the file's contents.
    assert.throws(() => parseLayerDocument("glTF not json"), /不是 JSON/);
    assert.throws(() => parseLayerDocument("{ broken"), /不是 JSON/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("project layer sources accept current-origin blobs but reject foreign and opaque origins", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://localhost:5173" },
  });
  try {
    const document = createLayerDocument(
      "blob:http://localhost:5173/source",
      800,
      600,
    );
    assert.deepEqual(parseLayerDocumentValue(document), document);
    for (const src of [
      "blob:https://outside.example/source",
      "blob:http://localhost:5174/source",
      "blob:null/source",
    ]) {
      assert.throws(() =>
        parseLayerDocumentValue(createLayerDocument(src, 800, 600)),
      );
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
