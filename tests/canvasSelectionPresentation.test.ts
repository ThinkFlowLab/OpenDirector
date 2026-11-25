import assert from "node:assert/strict";
import test from "node:test";
import {
  centeredViewport,
  selectionPlacement,
  selectionViewport,
  type SelectionChrome,
} from "../src/canvas/selectionPresentation.ts";

test("selection fits node and both fixed-size controls without changing authored geometry", () => {
  const node = { x: 840, y: 620, width: 720, height: 480 };
  const before = { ...node };
  const chrome: SelectionChrome = {
    safe: { x: 80, y: 72, width: 900, height: 570 },
    toolbar: { width: 880, height: 46 },
    composer: { width: 680, height: 270 },
  };
  const viewport = selectionViewport(node, { x: 0, y: 0, zoom: 1.2 }, chrome);
  const placed = selectionPlacement(node, viewport, chrome);
  assert.deepEqual(node, before);
  assert.ok(viewport.zoom < 1.2);
  assert.ok(placed.toolbar.top >= chrome.safe.y - 0.001);
  assert.ok(
    placed.composer.top + chrome.composer.height <=
      chrome.safe.y + chrome.safe.height + 0.001,
  );
  assert.ok(placed.toolbar.left >= chrome.safe.x);
  assert.ok(
    placed.toolbar.left + chrome.toolbar.width <=
      chrome.safe.x + chrome.safe.width,
  );
  assert.equal(placed.visible, true);
  assert.deepEqual(selectionViewport(node, viewport, chrome), viewport);
});

test("opening a right sidebar reserves the right side; closing never zooms in or recenters a contained selection", () => {
  const node = { x: 350, y: 160, width: 300, height: 200 };
  const chrome: SelectionChrome = {
    safe: { x: 80, y: 72, width: 560, height: 570 },
    toolbar: { width: 550, height: 44 },
    composer: { width: 560, height: 220 },
  };
  const fitted = selectionViewport(node, { x: 0, y: 0, zoom: 1 }, chrome);
  const placed = selectionPlacement(node, fitted, chrome);
  assert.equal(placed.composer.left, 80);
  assert.equal(fitted.zoom, 1);
  assert.deepEqual(
    selectionViewport(node, fitted, {
      ...chrome,
      safe: { ...chrome.safe, width: 1100 },
    }),
    fitted,
  );
});

test("manual pan tracks anchored controls without forcing viewport; offscreen selection hides controls", () => {
  const node = { x: 0, y: 0, width: 300, height: 200 };
  const chrome: SelectionChrome = {
    safe: { x: 80, y: 72, width: 900, height: 570 },
    toolbar: { width: 0, height: 0 },
    composer: { width: 680, height: 240 },
  };
  const viewport = { x: 350, y: 120, zoom: 0.7 };
  const initial = selectionPlacement(node, viewport, chrome);
  const dragged = selectionPlacement({ ...node, y: 100 }, viewport, chrome);
  assert.equal(dragged.composer.top - initial.composer.top, 70);
  assert.equal(
    selectionPlacement(node, { ...viewport, x: -900 }, chrome).visible,
    false,
  );
  assert.deepEqual(viewport, { x: 350, y: 120, zoom: 0.7 });
});

test("toolbar never rises above the safe area into the top bar (#513)", () => {
  const node = { x: 40, y: 80, width: 300, height: 300 };
  const chrome: SelectionChrome = {
    safe: { x: 80, y: 72, width: 1400, height: 850 },
    toolbar: { width: 1260, height: 36 },
    composer: { width: 0, height: 0 },
  };
  // After a drag or manual pan the viewport is deliberately not refitted.
  for (const viewport of [
    { x: 30, y: 24, zoom: 1 },
    { x: 0, y: -60, zoom: 1 },
    { x: 0, y: 0, zoom: 0.5 },
    { x: 0, y: 0, zoom: 1.5 },
  ]) {
    const placed = selectionPlacement(node, viewport, chrome);
    assert.equal(placed.toolbar.top, chrome.safe.y, JSON.stringify(viewport));
    assert.equal(placed.visible, true);
  }
  // A fitted selection keeps the ordinary anchored position above the node.
  const fitted = selectionViewport(node, { x: 0, y: 0, zoom: 1 }, chrome);
  const placed = selectionPlacement(node, fitted, chrome);
  assert.equal(placed.toolbar.top, node.y * fitted.zoom + fitted.y - 32 - 8 - 36);
  assert.ok(placed.toolbar.top >= chrome.safe.y);
  // Far below the top bar the toolbar still follows the node exactly.
  assert.equal(
    selectionPlacement(node, { x: 0, y: 400, zoom: 1 }, chrome).toolbar.top,
    80 + 400 - 32 - 8 - 36,
  );
});

test("fitting a distant node preserves its screen center while reducing zoom", () => {
  const node = { x: 10000, y: 8000, width: 600, height: 600 };
  const view = { x: 640 - 10300, y: 200 - 8000, zoom: 1 };
  const chrome: SelectionChrome = {
    safe: { x: 80, y: 72, width: 1180, height: 570 },
    toolbar: { width: 700, height: 46 },
    composer: { width: 680, height: 250 },
  };
  const fitted = selectionViewport(node, view, chrome);
  assert.ok(fitted.zoom < 1);
  assert.equal((node.x + node.width / 2) * fitted.zoom + fitted.x, 640);
});

test("canvas-sized composer participates in fitting at the same zoom as its node", () => {
  const node = { x: 10000, y: 8000, width: 300, height: 300 };
  const before = { ...node };
  const chrome: SelectionChrome = {
    safe: { x: 80, y: 72, width: 500, height: 430 },
    toolbar: { width: 480, height: 44 },
    composer: { width: 680, height: 250 },
    scaleComposer: true,
  };
  const fitted = selectionViewport(node, { x: 0, y: 0, zoom: 1.2 }, chrome);
  const placed = selectionPlacement(node, fitted, chrome);
  assert.ok(fitted.zoom < 1.2);
  assert.ok(placed.toolbar.top >= chrome.safe.y - 1e-6);
  assert.ok(placed.composer.left >= chrome.safe.x - 1e-6);
  assert.ok(
    placed.composer.left + chrome.composer.width * fitted.zoom <=
      chrome.safe.x + chrome.safe.width + 1e-6,
  );
  assert.ok(
    placed.composer.top + chrome.composer.height * fitted.zoom <=
      chrome.safe.y + chrome.safe.height + 1e-6,
  );
  const repeated = selectionViewport(node, fitted, chrome);
  assert.ok(Math.abs(repeated.zoom - fitted.zoom) < 1e-9);
  assert.ok(Math.abs(repeated.x - fitted.x) < 1e-6);
  assert.ok(Math.abs(repeated.y - fitted.y) < 1e-6);
  assert.deepEqual(node, before);
});

test("manual zoom and pan preserve the composer's canvas anchor and scaled gap", () => {
  const node = { x: 200, y: 100, width: 300, height: 300 };
  const chrome: SelectionChrome = {
    safe: { x: 80, y: 72, width: 1100, height: 700 },
    toolbar: { width: 450, height: 44 },
    composer: { width: 680, height: 250 },
    scaleComposer: true,
  };
  for (const zoom of [0.08, 0.5, 1, 2, 8]) {
    const view = { x: 300, y: 100, zoom };
    const placed = selectionPlacement(node, view, chrome);
    const center = (node.x + node.width / 2) * zoom + view.x;
    const bottom = (node.y + node.height) * zoom + view.y;
    assert.equal(
      placed.composer.left + (chrome.composer.width * zoom) / 2,
      center,
    );
    assert.ok(Math.abs(placed.composer.top - bottom - 16 * zoom) < 1e-6);
    const panned = selectionPlacement(
      node,
      { ...view, x: view.x - 400, y: view.y + 150 },
      chrome,
    );
    assert.ok(
      Math.abs(panned.composer.left - placed.composer.left + 400) < 1e-6,
    );
    assert.ok(Math.abs(panned.composer.top - placed.composer.top - 150) < 1e-6);
    assert.deepEqual(view, { x: 300, y: 100, zoom });
  }
});


test("created content centers in the canvas beside the assistant without enlarging", () => {
  const chrome = { safe: { x: 80, y: 72, width: 800, height: 650 }, toolbar: { width: 0, height: 0 }, composer: { width: 0, height: 0 } };
  const node = { x: 0, y: 0, width: 352, height: 528 };
  const view = centeredViewport(node, { x: 0, y: 0, zoom: .8 }, chrome);
  assert.equal(view.zoom, .8);
  assert.equal(view.x + node.width * view.zoom / 2, 480);
  assert.equal(view.y + node.height * view.zoom / 2, 397);
  const large = centeredViewport({ ...node, x: 5000, width: 2000, height: 1200 }, { x: 0, y: 0, zoom: 1 }, chrome);
  assert.ok(large.zoom < 1);
  assert.ok(large.x + 5000 * large.zoom >= chrome.safe.x);
  assert.ok(large.x + 7000 * large.zoom <= chrome.safe.x + chrome.safe.width);
});
