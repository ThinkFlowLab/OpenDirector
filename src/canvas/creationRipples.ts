import { boundsOfNodes } from "./geometry.ts";
import type { CanvasNode, Rect } from "./model.ts";

/** At most this many ripples start at once, so a large paste stays cheap. */
export const MAX_CREATION_RIPPLES = 8;
/** One wave from the node outline to the edge of its field. */
export const CREATION_RIPPLE_MS = 1400;

/**
 * Dot spacing and diameter of the canvas background, in canvas units. Spacing
 * doubles as the view zooms out so the grid never turns into noise.
 */
export function canvasDotGrid(zoom: number) {
  return {
    gap: 18 * Math.max(1, 2 ** Math.ceil(Math.log2(0.65 / zoom))),
    size: Math.max(1, 1 / zoom),
  };
}

export type CreationRipple = Rect & { key: string };

export type CreationRippleTracker = {
  documentId: string | null;
  /** Every node identity seen in this document; it never shrinks. */
  known: Set<string>;
};

export function creationRippleTracker(): CreationRippleTracker {
  return { documentId: null, known: new Set() };
}

/**
 * Returns the nodes that are new to this document and records them.
 *
 * Opening or switching documents only records the existing nodes. Identities
 * are never forgotten, so undo, redo and history replay that bring a node back
 * do not count as creation. Local creation, paste and nodes created by the
 * Agent all appear as unseen identities.
 */
export function trackCreatedNodes(
  tracker: CreationRippleTracker,
  documentId: string,
  nodes: readonly CanvasNode[],
): CanvasNode[] {
  if (tracker.documentId !== documentId) {
    tracker.documentId = documentId;
    tracker.known = new Set(nodes.map((node) => node.id));
    return [];
  }
  const created = nodes.filter((node) => !tracker.known.has(node.id));
  for (const node of created) tracker.known.add(node.id);
  return created;
}

/** Absolute bounds of each created node, including parent-group offsets. */
export function creationRipples(
  created: readonly CanvasNode[],
  allNodes: readonly CanvasNode[],
  sequence: number,
): CreationRipple[] {
  return created.slice(0, MAX_CREATION_RIPPLES).flatMap((node) => {
    const bounds = boundsOfNodes([node], allNodes);
    return bounds ? [{ key: `${node.id}:${sequence}`, ...bounds }] : [];
  });
}

/** The square of canvas around one node that its wave can light up. */
export function rippleField(ripple: CreationRipple, zoom: number) {
  const { gap, size } = canvasDotGrid(zoom);
  const longest = Math.max(ripple.width, ripple.height);
  const spread = Math.max(longest * 0.85, 240);
  const side = longest + spread * 2;
  const cx = ripple.x + ripple.width / 2;
  const cy = ripple.y + ripple.height / 2;
  return {
    left: cx - side / 2,
    top: cy - side / 2,
    side,
    cx,
    cy,
    gap,
    size,
    /** Lit dots are a little larger than the grey ones so they glow. */
    dotRadius: size * 1.25,
    /** How far past the node outline the front travels. */
    spread,
    /** Depth of the lit band behind the front. */
    band: Math.max(longest * 0.5, 140),
  };
}
export type RippleField = ReturnType<typeof rippleField>;

/**
 * Background dot centres inside the field, in canvas units. Background dots
 * sit at gap * (k - 1/2) + size / 2 on both axes, independent of panning.
 */
export function fieldDots(field: RippleField): [number, number][] {
  const { gap, size } = field;
  const first = (start: number) => Math.ceil((start - size / 2) / gap + 0.5);
  const dots: [number, number][] = [];
  for (let i = first(field.left); gap * (i - 0.5) + size / 2 <= field.left + field.side; i++)
    for (let j = first(field.top); gap * (j - 0.5) + size / 2 <= field.top + field.side; j++)
      dots.push([gap * (i - 0.5) + size / 2, gap * (j - 0.5) + size / 2]);
  return dots;
}

/** Distance from a point to the node rectangle; zero inside it. */
export function outlineDistance(x: number, y: number, rect: Rect) {
  const dx = Math.max(rect.x - x, 0, x - rect.x - rect.width);
  const dy = Math.max(rect.y - y, 0, y - rect.y - rect.height);
  return Math.hypot(dx, dy);
}

/**
 * How lit a dot is: 0 before the front reaches it and after the band has
 * passed. The front is every point at the same distance from the node
 * outline, a rounded rectangle whose corners widen as it grows; it eases
 * outward and the whole wave fades as it nears the field edge.
 */
export function waveIntensity(
  distance: number,
  progress: number,
  field: Pick<RippleField, "spread" | "band">,
) {
  if (progress <= 0 || progress >= 1) return 0;
  const front = (1 - (1 - progress) ** 3) * field.spread;
  const behind = front - distance;
  if (behind < 0 || behind > field.band) return 0;
  const depth = behind / field.band;
  // A quick rise at the front and a long tail behind it.
  const shape = depth < 0.12 ? depth / 0.12 : 1 - (depth - 0.12) / 0.88;
  const fade = progress < 0.7 ? 1 : (1 - progress) / 0.3;
  return shape ** 1.4 * fade;
}

/** Rainbow hue around the node, drifting a little as the wave travels. */
export function waveHue(angle: number, progress: number) {
  return (((angle * 180) / Math.PI + 200 + progress * 80) % 360 + 360) % 360;
}

/** Draws one frame of a wave; the context is in canvas units. */
export function drawRippleFrame(
  context: Pick<CanvasRenderingContext2D, "beginPath" | "arc" | "fill"> & {
    fillStyle: CanvasRenderingContext2D["fillStyle"];
    globalAlpha: number;
  },
  ripple: CreationRipple,
  field: RippleField,
  dots: readonly [number, number][],
  progress: number,
) {
  let drawn = 0;
  for (const [x, y] of dots) {
    const distance = outlineDistance(x, y, ripple);
    if (distance === 0) continue; // under the node
    const light = waveIntensity(distance, progress, field);
    if (light < 0.02) continue;
    context.globalAlpha = Math.min(1, light);
    const angle = Math.atan2(y - field.cy, x - field.cx);
    context.fillStyle = `hsl(${waveHue(angle, progress).toFixed(0)} 95% 66%)`;
    context.beginPath();
    context.arc(x, y, field.dotRadius, 0, Math.PI * 2);
    context.fill();
    drawn++;
  }
  return drawn;
}
