import assert from "node:assert/strict";
import test from "node:test";
import {
  floatingReferencePort,
  referencePortDirection,
  referencePortIcon,
  referencePortMetrics,
  restingReferencePort,
  REFERENCE_PORT_ICON_SIZE,
  REFERENCE_PORT_MAX_SIZE,
  REFERENCE_PORT_SIZE,
} from "../src/canvas/connectionPorts.ts";
import { createNode } from "../src/canvas/model.ts";
import { canStartReference } from "../src/canvas/connectionPolicy.ts";

const bounds = { x: 100, y: 100, width: 300, height: 300 };

test("asset ports require usable content while empty generation ports stay discoverable", () => {
  for (const kind of ["image", "video", "audio"] as const) {
    const asset = createNode(kind, undefined, {
      mediaRole: "asset",
      src: `data:${kind}/fixture`,
      assetState: "ready",
    });
    assert.equal(canStartReference(asset), true, kind);
    assert.equal(referencePortDirection(asset), "out", kind);
    assert.equal(
      canStartReference({
        ...asset,
        data: { ...asset.data, assetState: "missing" },
      }),
      false,
      kind,
    );
    assert.equal(
      canStartReference(createNode(kind, undefined, { mediaRole: "asset" })),
      false,
      kind,
    );
    const emptyGeneration = createNode(kind);
    assert.equal(canStartReference(emptyGeneration), true, kind);
    assert.equal(referencePortDirection(emptyGeneration), "in", kind);
  }
});

test("resting port keeps its screen size cap and a six pixel gap to the node", () => {
  for (const zoom of [0.08, 0.6, 1, 1.5, 4, 8]) {
    const metrics = referencePortMetrics(zoom);
    assert.ok(
      Math.abs(
        metrics.diameter * zoom -
          Math.min(REFERENCE_PORT_SIZE * zoom, REFERENCE_PORT_MAX_SIZE),
      ) < 1e-8,
    );
    // The drawn plus stays proportional to the circle at every zoom.
    assert.ok(
      Math.abs(metrics.iconSize - REFERENCE_PORT_ICON_SIZE * metrics.scale) <
        1e-8,
    );
    assert.ok(REFERENCE_PORT_ICON_SIZE < REFERENCE_PORT_SIZE);
    const resting = restingReferencePort(bounds, "right", zoom);
    assert.ok(
      Math.abs((resting.point.x - 400 - metrics.diameter / 2) * zoom - 6) <
        1e-8,
    );
  }
});

test("enlarged ports keep their node gutter while following the nearby pointer", () => {
  for (const zoom of [0.08, 0.6, 1, 4, 8]) {
    const metrics = referencePortMetrics(zoom);
    const outset = metrics.diameter / 2 + 6 / zoom;
    const rest = restingReferencePort(bounds, "right", zoom);
    const near = { x: rest.point.x + 24 / zoom, y: rest.point.y };
    const active = floatingReferencePort(
      bounds,
      near,
      zoom,
      undefined,
      outset,
    )!;
    assert.equal(active.side, "right");
    assert.ok(Math.abs((active.point.x - rest.point.x) * zoom - 12) < 1e-8);
    const inward = floatingReferencePort(
      bounds,
      { x: 400 + 1 / zoom, y: 250 },
      zoom,
      "right",
      outset,
    )!;
    assert.ok((inward.point.x - 400 - metrics.diameter / 2) * zoom >= 4 - 1e-8);
    assert.equal(
      floatingReferencePort(bounds, { x: 250, y: 250 }, zoom, "right", outset),
      null,
    );
    assert.equal(
      floatingReferencePort(
        bounds,
        { x: rest.point.x + 50 / zoom, y: rest.point.y },
        zoom,
        "right",
        outset,
      ),
      null,
    );
  }
});

test("port arrows follow what a node can actually give and take", () => {
  const sides = ["top", "right", "bottom", "left"] as const;
  const glyphs = (direction: "in" | "out" | "both") =>
    sides.map((side) => referencePortIcon(side, direction));

  const asset = createNode("image", undefined, {
    src: "data:image/fixture",
    mediaRole: "asset",
  });
  assert.equal(referencePortDirection(asset), "out");
  assert.deepEqual(glyphs("out"), [
    "arrowUp",
    "arrowRight",
    "arrowDown",
    "arrowLeft",
  ]);

  // An empty generation node cannot be a source, so its ports point inwards.
  for (const node of [
    createNode("image"),
    createNode("video"),
    createNode("audio"),
    createNode("text"),
    createNode("subject"),
  ]) {
    assert.equal(referencePortDirection(node), "in", node.type);
    assert.deepEqual(glyphs("in"), [
      "arrowDown",
      "arrowLeft",
      "arrowUp",
      "arrowRight",
    ]);
  }

  // Content makes the same node both a source and a target.
  for (const node of [
    createNode("image", undefined, { src: "data:image/fixture" }),
    createNode("text", undefined, { text: "written" }),
  ]) {
    assert.equal(referencePortDirection(node), "both", node.type);
    assert.deepEqual(glyphs("both"), [
      "referenceArrowsVertical",
      "referenceArrowsHorizontal",
      "referenceArrowsVertical",
      "referenceArrowsHorizontal",
    ]);
  }

  const missing = createNode("image", undefined, {
    src: "data:image/fixture",
    mediaRole: "generation",
    assetState: "missing",
  });
  assert.equal(referencePortDirection(missing), "in");
  // A port whose owner is no longer rendered keeps the two-direction glyph.
  assert.equal(referencePortDirection(undefined), "both");
});
