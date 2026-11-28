import type { Rect, Viewport } from "./model.ts";

export type ScreenSize = { width: number; height: number };
export type SelectionChrome = {
  /** Available area in workspace coordinates. */
  safe: Rect;
  /** Canvas origin relative to the workspace that hosts the overlays. */
  canvasOrigin?: { x: number; y: number };
  toolbar: ScreenSize;
  composer: ScreenSize;
  /** Composer dimensions are canvas units when enabled; toolbar stays screen-sized. */
  scaleComposer?: boolean;
};

export const SELECTION_TITLE_SPACE = 32;
const TITLE_SPACE = SELECTION_TITLE_SPACE;
const TOOLBAR_GAP = 8;
const COMPOSER_GAP = 16;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** Project canvas bounds into the workspace that hosts the selection overlays. */
export function projectSelectionRect(
  bounds: Rect,
  view: Viewport,
  origin?: SelectionChrome["canvasOrigin"],
): Rect {
  return {
    x: bounds.x * view.zoom + view.x + (origin?.x ?? 0),
    y: bounds.y * view.zoom + view.y + (origin?.y ?? 0),
    width: bounds.width * view.zoom,
    height: bounds.height * view.zoom,
  };
}

/** Center content in the usable canvas, preserving zoom unless it cannot fit. */
export function centeredViewport(node: Rect, viewport: Viewport, chrome: SelectionChrome): Viewport {
  return selectionViewport(node, {
    ...viewport,
    x: chrome.safe.x + chrome.safe.width / 2 - (node.x + node.width / 2) * viewport.zoom - (chrome.canvasOrigin?.x ?? 0),
    y: chrome.safe.y + chrome.safe.height / 2 - (node.y + node.height / 2) * viewport.zoom - (chrome.canvasOrigin?.y ?? 0),
  }, chrome);
}

/** Keep the selected node and its controls in one visible envelope.
 * Authored node geometry never changes when opening a generator. */
export function selectionViewport(
  node: Rect,
  viewport: Viewport,
  chrome: SelectionChrome,
): Viewport {
  const { safe, toolbar, composer, scaleComposer } = chrome;
  const above =
    TITLE_SPACE + (toolbar.height ? toolbar.height + TOOLBAR_GAP : 0);
  const below = composer.height ? composer.height + COMPOSER_GAP : 0;
  const zoom = Math.max(
    0.08,
    Math.min(
      viewport.zoom,
      safe.width / Math.max(1, node.width, scaleComposer ? composer.width : 0),
      Math.max(1, safe.height - above - (scaleComposer ? 0 : below)) /
        Math.max(1, node.height + (scaleComposer ? below : 0)),
    ),
  );
  const composerScale = scaleComposer ? zoom : 1;
  const width = Math.max(
    node.width * zoom,
    toolbar.width,
    composer.width * composerScale,
  );
  // Zoom around the selected content, not the world origin, so a distant node
  // does not slide sideways simply because its controls need more vertical space.
  const projected = projectSelectionRect(node, viewport, chrome.canvasOrigin);
  const screenCenter = projected.x + projected.width / 2;
  const center = clamp(
    screenCenter,
    safe.x + width / 2,
    safe.x + safe.width - width / 2,
  );
  const top = clamp(
    projected.y,
    safe.y + above,
    safe.y + safe.height - below * composerScale - node.height * zoom,
  );
  return {
    zoom,
    // React Flow expects its translation relative to its own container.
    x: center - (node.x + node.width / 2) * zoom - (chrome.canvasOrigin?.x ?? 0),
    y: top - node.y * zoom - (chrome.canvasOrigin?.y ?? 0),
  };
}

/** Anchors the multi-selection action bar to the envelope it acts on. */
export function selectionBarPlacement(
  selection: Rect,
  view: Viewport,
  toolbar: ScreenSize,
  safe: Rect,
  gap = 8,
) {
  const selectionLeft = selection.x * view.zoom + view.x;
  const selectionTop = selection.y * view.zoom + view.y;
  const selectionRight = selectionLeft + selection.width * view.zoom;
  const selectionBottom = selectionTop + selection.height * view.zoom;
  const center = (selectionLeft + selectionRight) / 2;
  const left = clamp(
    center - toolbar.width / 2,
    safe.x,
    Math.max(safe.x, safe.x + safe.width - toolbar.width),
  );
  const above = selectionTop - gap - toolbar.height;
  const below = selectionBottom + gap;
  const top =
    above >= safe.y
      ? above
      : below + toolbar.height <= safe.y + safe.height
        ? below
        : clamp(
            above,
            safe.y,
            Math.max(safe.y, safe.y + safe.height - toolbar.height),
          );
  return {
    left,
    top,
    visible:
      selectionBottom > safe.y &&
      selectionTop < safe.y + safe.height &&
      selectionRight > safe.x &&
      selectionLeft < safe.x + safe.width,
  };
}

/** Placement follows the viewport, including manual pan/zoom; it does not move it. */
export function selectionPlacement(
  node: Rect,
  view: Viewport,
  chrome: SelectionChrome,
) {
  const { safe, toolbar, composer, scaleComposer } = chrome;
  const composerScale = scaleComposer ? view.zoom : 1;
  const projected = projectSelectionRect(node, view, chrome.canvasOrigin);
  const center = projected.x + projected.width / 2;
  const top = projected.y;
  const bottom = top + projected.height;
  const left = (width: number) =>
    clamp(center - width / 2, safe.x, safe.x + safe.width - width);
  return {
    toolbar: {
      left: left(toolbar.width),
      top: top - TITLE_SPACE - TOOLBAR_GAP - toolbar.height,
    },
    composer: {
      left: scaleComposer
        ? center - (composer.width * composerScale) / 2
        : left(composer.width),
      top: bottom + COMPOSER_GAP * composerScale,
    },
    visible:
      bottom > safe.y &&
      top < safe.y + safe.height &&
      projected.x + projected.width > safe.x &&
      projected.x < safe.x + safe.width,
  };
}
