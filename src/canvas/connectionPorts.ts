import { canSourceReference } from "./connectionPolicy.ts";
import type { CanvasNode, Point, Rect } from "./model.ts";

export type PortSide = "top" | "right" | "bottom" | "left";
/** Which ways references can travel from the node these ports surround. */
export type ReferencePortDirection = "in" | "out" | "both";
export const REFERENCE_PORT_SIZE = 22;
export const REFERENCE_PORT_MAX_SIZE = 30;
/** Drawn size of the direction icon inside the port circle. */
export const REFERENCE_PORT_ICON_SIZE = 15;

/**
 * Asset ports point outwards; editable nodes show both directions. A generation
 * node without content can only receive references, so its ports point inwards
 * until a result makes it a source as well.
 */
export function referencePortDirection(
  node: CanvasNode | undefined,
): ReferencePortDirection {
  if (!node) return "both";
  if (node.data.mediaRole === "asset") return "out";
  return canSourceReference(node) ? "both" : "in";
}

const OUTWARD_ICONS: Record<PortSide, string> = {
  top: "arrowUp",
  right: "arrowRight",
  bottom: "arrowDown",
  left: "arrowLeft",
};
const INWARD_ICONS: Record<PortSide, string> = {
  top: "arrowDown",
  right: "arrowLeft",
  bottom: "arrowUp",
  left: "arrowRight",
};
export function referencePortIcon(
  side: PortSide,
  direction: ReferencePortDirection,
) {
  if (direction === "in") return INWARD_ICONS[side];
  if (direction === "out") return OUTWARD_ICONS[side];
  return side === "top" || side === "bottom"
    ? "referenceArrowsVertical"
    : "referenceArrowsHorizontal";
}

/** Apply one scale to the circle, border and icon, including at the screen-size cap. */
export function referencePortMetrics(zoom: number) {
  const scale = Math.min(
    1,
    REFERENCE_PORT_MAX_SIZE / REFERENCE_PORT_SIZE / zoom,
  );
  return {
    scale,
    diameter: REFERENCE_PORT_SIZE * scale,
    iconSize: REFERENCE_PORT_ICON_SIZE * scale,
    borderWidth: scale,
  };
}
export const REFERENCE_PORT_MAX_DISTANCE = 12;
export const REFERENCE_PORT_MIDPOINT_RADIUS = 36;
export const REFERENCE_PORT_SIDES: readonly PortSide[] = [
  "top",
  "right",
  "bottom",
  "left",
];
const normal = (side: PortSide) => ({
  x: side === "left" ? -1 : side === "right" ? 1 : 0,
  y: side === "top" ? -1 : side === "bottom" ? 1 : 0,
});

export function portPoint(bounds: Rect, side: PortSide): Point {
  return {
    x:
      bounds.x +
      (side === "left"
        ? 0
        : side === "right"
          ? bounds.width
          : bounds.width / 2),
    y:
      bounds.y +
      (side === "top"
        ? 0
        : side === "bottom"
          ? bounds.height
          : bounds.height / 2),
  };
}

export function insideNode(bounds: Rect, pointer: Point) {
  return (
    pointer.x > bounds.x &&
    pointer.x < bounds.x + bounds.width &&
    pointer.y > bounds.y &&
    pointer.y < bounds.y + bounds.height
  );
}

/** Leave a screen-space gutter between the enlarged circle and the material. */
export function restingReferencePort(
  bounds: Rect,
  side: PortSide,
  zoom: number,
) {
  const anchor = portPoint(bounds, side);
  const outset = referencePortMetrics(zoom).diameter / 2 + 6 / zoom;
  const direction = normal(side);
  return {
    side,
    anchor,
    point: {
      x: anchor.x + direction.x * outset,
      y: anchor.y + direction.y * outset,
    },
  };
}

/** Activate near edge midpoints; follow the outside pointer within a screen-space cap. */
export function floatingReferencePort(
  bounds: Rect,
  pointer: Point,
  zoom: number,
  previous?: PortSide,
  outset = 0,
) {
  if (insideNode(bounds, pointer)) return null;
  const inset = 16 / zoom;
  const clamp = (value: number, start: number, size: number) =>
    Math.max(
      start + Math.min(size / 2, inset),
      Math.min(start + size - Math.min(size / 2, inset), value),
    );
  const candidates = REFERENCE_PORT_SIDES
    .filter((side) => {
      const midpoint = portPoint(bounds, side);
      const direction = normal(side);
      midpoint.x += direction.x * outset;
      midpoint.y += direction.y * outset;
      const vertical = side === "left" || side === "right";
      const alongEdge = vertical
        ? Math.abs(pointer.y - midpoint.y)
        : Math.abs(pointer.x - midpoint.x);
      // Keep corner regions inactive even when a zoomed-out node is small.
      if (alongEdge > (vertical ? bounds.height : bounds.width) / 4)
        return false;
      return (
        Math.hypot(pointer.x - midpoint.x, pointer.y - midpoint.y) * zoom <=
        REFERENCE_PORT_MIDPOINT_RADIUS
      );
    })
    .map((side) => {
      const vertical = side === "left" || side === "right";
      const anchor = portPoint(bounds, side);
      if (!outset) {
        if (vertical) anchor.y = clamp(pointer.y, bounds.y, bounds.height);
        else anchor.x = clamp(pointer.x, bounds.x, bounds.width);
      }
      const direction = normal(side);
      const origin = {
        x: anchor.x + direction.x * outset,
        y: anchor.y + direction.y * outset,
      };
      const distance = Math.hypot(pointer.x - origin.x, pointer.y - origin.y);
      const scale = distance
        ? Math.min(1, REFERENCE_PORT_MAX_DISTANCE / zoom / distance)
        : 1;
      const point = {
        x: origin.x + (pointer.x - origin.x) * scale,
        y: origin.y + (pointer.y - origin.y) * scale,
      };
      if (outset) {
        // Follow the pointer while retaining a small gap from the node. Align
        // the preview's origin with the circle's actual position along the edge.
        const minimum = outset - 2 / zoom;
        if (side === "right") point.x = Math.max(point.x, anchor.x + minimum);
        if (side === "left") point.x = Math.min(point.x, anchor.x - minimum);
        if (side === "bottom") point.y = Math.max(point.y, anchor.y + minimum);
        if (side === "top") point.y = Math.min(point.y, anchor.y - minimum);
        if (vertical) anchor.y = clamp(point.y, bounds.y, bounds.height);
        else anchor.x = clamp(point.x, bounds.x, bounds.width);
      }
      return {
        side,
        anchor,
        point,
        distance,
      };
    });
  if (!candidates.length) return null;
  const nearest = candidates.reduce((best, item) =>
    item.distance < best.distance ? item : best,
  );
  const old = candidates.find((item) => item.side === previous);
  const result =
    old && old.distance <= nearest.distance + 6 / zoom ? old : nearest;
  return result;
}

/** Freeze the actual grab point while dragging and while the creation menu is open. */
export function referencePreviewPath(start: Point, side: PortSide, end: Point) {
  const direction = normal(side),
    bend = Math.min(120, Math.hypot(end.x - start.x, end.y - start.y) / 2);
  return `M${start.x},${start.y} C${start.x + direction.x * bend},${start.y + direction.y * bend} ${end.x - direction.x * bend},${end.y - direction.y * bend} ${end.x},${end.y}`;
}
