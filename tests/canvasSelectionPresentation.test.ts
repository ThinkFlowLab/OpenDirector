import assert from "node:assert/strict";
import test from "node:test";
import {
  centeredViewport,
  selectionPlacement,
  selectionViewport,
  visibleSelectionArea,
  type SelectionChrome,
} from "../src/canvas/selectionPresentation.ts";

test("a floating chat only changes the usable area when it covers the selection or its controls", () => {
  const chrome = {
    safe: { x: 80, y: 72, width: 1200, height: 700 },
    toolbar: { width: 160, height: 32 },
    composer: { width: 300, height: 100 },
  };
  const node = { x: 370, y: 200, width: 160, height: 130 };
  const view = { x: 0, y: 0, zoom: 1 };
  const away = { x: 850, y: 100, width: 410, height: 480 };
  assert.equal(visibleSelectionArea(node, view, chrome, null), chrome.safe);
  assert.equal(visibleSelectionArea(node, view, chrome, away), chrome.safe);
  const overlap = { x: 440, y: 355, width: 480, height: 360 };
  const safe = visibleSelectionArea(node, view, chrome, overlap);
  assert.notEqual(safe, chrome.safe, "the composer alone intersects chat");
  const target = selectionViewport(node, view, { ...chrome, safe });
  const placed = selectionPlacement(node, target, { ...chrome, safe });
  assert.equal(target.zoom, view.zoom);
  assert.ok(placed.composer.left + chrome.composer.width <= overlap.x);
  const wideOverlay = { x: 80, y: 250, width: 1200, height: 165 };
  const below = visibleSelectionArea(node, view, chrome, wideOverlay);
  assert.equal(below.y, wideOverlay.y + wideOverlay.height, "can use space below a wide panel");
});

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
