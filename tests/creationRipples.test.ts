import assert from "node:assert/strict";
import test from "node:test";
import { createNode } from "../src/canvas/model.ts";
import {
  MAX_CREATION_RIPPLES,
  canvasDotGrid,
  creationRippleTracker,
  creationRipples,
  drawRippleFrame,
  fieldDots,
  outlineDistance,
  rippleField,
  trackCreatedNodes,
  waveIntensity,
} from "../src/canvas/creationRipples.ts";

const node = (x = 0, y = 0) => createNode("image", { x, y });

test("opening a document records its nodes without rippling", () => {
  const tracker = creationRippleTracker();
  const nodes = [node(), node(400)];
  assert.deepEqual(trackCreatedNodes(tracker, "a", nodes), []);
  assert.deepEqual(trackCreatedNodes(tracker, "a", nodes), []);
});

test("a node new to the document ripples once", () => {
  const tracker = creationRippleTracker();
  const first = node();
  trackCreatedNodes(tracker, "a", [first]);
  const added = node(400);
  assert.deepEqual(trackCreatedNodes(tracker, "a", [first, added]).map((n) => n.id), [added.id]);
  assert.deepEqual(trackCreatedNodes(tracker, "a", [first, added]), []);
});

test("undo and redo bringing a known node back do not ripple", () => {
  const tracker = creationRippleTracker();
  const first = node();
  const added = node(400);
  trackCreatedNodes(tracker, "a", [first]);
  trackCreatedNodes(tracker, "a", [first, added]);
  assert.deepEqual(trackCreatedNodes(tracker, "a", [first]), []);
  assert.deepEqual(trackCreatedNodes(tracker, "a", [first, added]), []);
});

test("switching documents records the destination without rippling", () => {
  const tracker = creationRippleTracker();
  trackCreatedNodes(tracker, "a", [node()]);
  const destination = [node(), node(300)];
  assert.deepEqual(trackCreatedNodes(tracker, "b", destination), []);
  const added = node(600);
  assert.deepEqual(trackCreatedNodes(tracker, "b", [...destination, added]).map((n) => n.id), [added.id]);
});

test("ripples carry absolute node bounds, include group offsets and are capped", () => {
  const group = createNode("group", { x: 100, y: 50 });
  const child = { ...node(10, 20), parentId: group.id };
  const [ripple] = creationRipples([child], [group, child], 1);
  assert.deepEqual([ripple.x, ripple.y, ripple.width, ripple.height], [110, 70, child.width, child.height]);
  const many = Array.from({ length: MAX_CREATION_RIPPLES + 5 }, (_, i) => node(i * 10));
  assert.equal(creationRipples(many, many, 2).length, MAX_CREATION_RIPPLES);
});

const ripple = { key: "k", x: 37.3, y: -91.6, width: 352, height: 528 };

test("lit dots are exactly the background dots inside the field at any zoom", () => {
  for (const zoom of [0.2, 0.5, 1, 1.7, 3]) {
    const { gap, size } = canvasDotGrid(zoom);
    const field = rippleField(ripple, zoom);
    const dots = fieldDots(field);
    assert.ok(dots.length > 0);
    for (const [x, y] of dots) {
      // Background dot centres sit at gap * (k - 1/2) + size / 2.
      for (const value of [x, y]) {
        const k = (value - size / 2) / gap + 0.5;
        assert.ok(Math.abs(k - Math.round(k)) < 1e-9, `off grid at zoom ${zoom}`);
      }
      assert.ok(x >= field.left && x <= field.left + field.side && y >= field.top && y <= field.top + field.side);
    }
    // No background dot inside the field is missing.
    const perAxis = Math.round(Math.sqrt(dots.length));
    assert.ok(Math.abs(perAxis - field.side / gap) <= 1.5, `coverage at zoom ${zoom}`);
  }
});

test("the wave passes each dot once, starting at the node outline", () => {
  const field = rippleField(ripple, 1);
  const distance = field.spread * 0.4;
  const samples = Array.from({ length: 201 }, (_, i) => waveIntensity(distance, i / 200, field));
  assert.equal(samples[0], 0);
  assert.equal(samples[200], 0);
  // One contiguous lit interval: a single wave, never a second one.
  const lit = samples.map((value) => value > 0);
  const rises = lit.filter((value, i) => value && !lit[i - 1]).length;
  assert.equal(rises, 1);
  // Early on only dots near the outline are lit.
  assert.equal(waveIntensity(field.spread * 0.9, 0.05, field), 0);
  assert.ok(waveIntensity(4, 0.04, field) > 0);
});

test("the wave front is a rounded rectangle around the node outline", () => {
  const field = rippleField(ripple, 1);
  const { x, y, width, height } = ripple;
  const d = field.spread * 0.3;
  // Beside an edge and diagonally off a corner, at the same distance from the outline.
  const side = outlineDistance(x + width + d, y + height / 2, ripple);
  const corner = outlineDistance(x + width + d / Math.SQRT2, y + height + d / Math.SQRT2, ripple);
  assert.ok(Math.abs(side - d) < 1e-9 && Math.abs(corner - d) < 1e-9);
  // A point off the corner along the edge lines is further away: the corner is rounded.
  assert.ok(outlineDistance(x + width + d, y + height + d, ripple) > d);
  // Intensity depends only on that distance, so every direction lights together.
  for (const progress of [0.2, 0.45, 0.6])
    assert.ok(Math.abs(waveIntensity(side, progress, field) - waveIntensity(corner, progress, field)) < 1e-9);
});

test("a frame lights only dots outside the node", () => {
  const field = rippleField(ripple, 1);
  const arcs: [number, number][] = [];
  const context = { fillStyle: "", globalAlpha: 1, beginPath() {}, fill() {}, arc(x: number, y: number) { arcs.push([x, y]); } };
  const drawn = drawRippleFrame(context, ripple, field, fieldDots(field), 0.3);
  assert.ok(drawn > 0 && drawn === arcs.length);
  assert.ok(arcs.every(([x, y]) => outlineDistance(x, y, ripple) > 0));
  assert.equal(drawRippleFrame(context, ripple, field, fieldDots(field), 1), 0);
});
