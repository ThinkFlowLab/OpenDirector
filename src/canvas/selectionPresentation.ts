import type { Rect, Viewport } from "./model.ts";

export type ScreenSize = { width: number; height: number };
export type SelectionChrome = {
  safe: Rect;
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

/** Keep the current fit when it clears the floating panel. Otherwise pick a
 * free strip that holds the node and its controls with the least shrinking. */
export function visibleSelectionArea(
  node: Rect,
  view: Viewport,
  chrome: SelectionChrome,
  overlay: Rect | null,
): Rect {
  const { safe, toolbar, composer } = chrome;
  if (!overlay) return safe;
  const x = node.x * view.zoom + view.x;
  const y = node.y * view.zoom + view.y;
  const nodeWidth = node.width * view.zoom;
  const nodeHeight = node.height * view.zoom;
  const placement = selectionPlacement(node, view, chrome);
  const scale = chrome.scaleComposer ? view.zoom : 1;
  const boxes: Rect[] = [
    { x, y: y - TITLE_SPACE, width: nodeWidth, height: nodeHeight + TITLE_SPACE },
    { x: placement.toolbar.left, y: placement.toolbar.top, ...toolbar },
    {
      x: placement.composer.left,
      y: placement.composer.top,
      width: composer.width * scale,
      height: composer.height * scale,
    },
  ];
  const right = overlay.x + overlay.width;
  const bottom = overlay.y + overlay.height;
  const overlaps = boxes.some(box =>
    box.width > 0 && box.height > 0 &&
    box.x < right && box.y < bottom &&
    box.x + box.width > overlay.x && box.y + box.height > overlay.y,
  );
  if (!overlaps) return safe;
  const afterX = Math.max(safe.x, right);
  const afterY = Math.max(safe.y, bottom);
  const candidates = [
    { ...safe, width: Math.min(safe.width, overlay.x - safe.x) },
    { ...safe, x: afterX, width: safe.x + safe.width - afterX },
    { ...safe, height: Math.min(safe.height, overlay.y - safe.y) },
    { ...safe, y: afterY, height: safe.y + safe.height - afterY },
  ];
  const wantedWidth = Math.max(nodeWidth, toolbar.width, composer.width * scale, 1);
  const wantedHeight = nodeHeight + TITLE_SPACE + (toolbar.height ? toolbar.height + TOOLBAR_GAP : 0) +
    (composer.height ? (composer.height + COMPOSER_GAP) * scale : 0);
  const centerX = x + nodeWidth / 2;
  const centerY = y + nodeHeight / 2;
  let best = safe;
  let bestFit = 0;
  let leastDistance = Infinity;
  for (const rect of candidates) {
    const fit = Math.min(1, rect.width / wantedWidth, rect.height / wantedHeight);
    if (fit <= 0) continue;
    const distance = Math.hypot(
      centerX - clamp(centerX, rect.x, rect.x + rect.width),
      centerY - clamp(centerY, rect.y, rect.y + rect.height),
    );
    if (fit > bestFit || (fit === bestFit && distance < leastDistance)) {
      best = rect;
      bestFit = fit;
      leastDistance = distance;
    }
  }
  return best;
}

/** Center content in the usable canvas, preserving zoom unless it cannot fit. */
export function centeredViewport(node: Rect, viewport: Viewport, chrome: SelectionChrome): Viewport {
  return selectionViewport(node, {
    ...viewport,
    x: chrome.safe.x + chrome.safe.width / 2 - (node.x + node.width / 2) * viewport.zoom,
    y: chrome.safe.y + chrome.safe.height / 2 - (node.y + node.height / 2) * viewport.zoom,
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
  const screenCenter = (node.x + node.width / 2) * viewport.zoom + viewport.x;
  const center = clamp(
    screenCenter,
    safe.x + width / 2,
    safe.x + safe.width - width / 2,
  );
  const top = clamp(
    node.y * viewport.zoom + viewport.y,
    safe.y + above,
    safe.y + safe.height - below * composerScale - node.height * zoom,
  );
  return {
    zoom,
    x: center - (node.x + node.width / 2) * zoom,
    y: top - node.y * zoom,
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
  const center = (node.x + node.width / 2) * view.zoom + view.x;
  const top = node.y * view.zoom + view.y;
  const bottom = top + node.height * view.zoom;
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
      center + (node.width * view.zoom) / 2 > safe.x &&
      center - (node.width * view.zoom) / 2 < safe.x + safe.width,
  };
}
