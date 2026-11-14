import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasNode } from "./model.ts";
import {
  CREATION_RIPPLE_MS,
  creationRippleTracker,
  creationRipples,
  drawRippleFrame,
  fieldDots,
  rippleField,
  trackCreatedNodes,
  type CreationRipple,
} from "./creationRipples.ts";
import "./creation-ripple.css";

/** Backing-store cap per ripple, so a huge node at high zoom stays cheap. */
const MAX_CANVAS_PIXELS = 2048;

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One wave of coloured light through the canvas dots around a newly created
 * node, spreading outward from its outline as a rounded rectangle. Render inside
 * ViewportPortal so it pans and zooms with the canvas. Purely decorative: it
 * never takes pointer input or changes the document.
 */
export function CreationRipples({
  documentId,
  nodes,
  zoom,
  active,
}: {
  documentId: string;
  nodes: readonly CanvasNode[];
  zoom: number;
  /** False while the canvas is loading or switching projects. */
  active: boolean;
}) {
  const tracker = useRef(creationRippleTracker());
  const sequence = useRef(0);
  const [ripples, setRipples] = useState<CreationRipple[]>([]);

  useLayoutEffect(() => {
    if (!active) {
      // Re-record the existing nodes once the canvas is usable again.
      tracker.current.documentId = null;
      return;
    }
    const created = trackCreatedNodes(tracker.current, documentId, nodes);
    if (!created.length || reducedMotion()) return;
    const added = creationRipples(created, nodes, ++sequence.current);
    if (added.length) setRipples((current) => [...current, ...added]);
  }, [documentId, nodes, active]);

  useEffect(() => setRipples([]), [documentId]);

  return (
    <>
      {ripples.map((ripple) => (
        <RippleCanvas
          key={ripple.key}
          ripple={ripple}
          zoom={zoom}
          onDone={() =>
            setRipples((current) => current.filter((item) => item.key !== ripple.key))
          }
        />
      ))}
    </>
  );
}

function RippleCanvas({
  ripple,
  zoom,
  onDone,
}: {
  ripple: CreationRipple;
  zoom: number;
  onDone: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ zoom, onDone });
  latest.current = { zoom, onDone };
  // Placement depends only on the node; zoom only changes dot spacing.
  const { left, top, side } = rippleField(ripple, zoom);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) {
      latest.current.onDone();
      return;
    }
    let frame = 0;
    let cached: { zoom: number; dots: [number, number][] } | null = null;
    const start = performance.now();
    const draw = (now: number) => {
      const progress = Math.min(1, (now - start) / CREATION_RIPPLE_MS);
      const { zoom } = latest.current;
      const field = rippleField(ripple, zoom);
      if (cached?.zoom !== zoom) cached = { zoom, dots: fieldDots(field) };
      const scale =
        Math.min(field.side * zoom * (devicePixelRatio || 1), MAX_CANVAS_PIXELS) /
        field.side;
      const pixels = Math.max(1, Math.round(field.side * scale));
      if (element.width !== pixels) element.width = element.height = pixels;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixels, pixels);
      context.setTransform(scale, 0, 0, scale, -field.left * scale, -field.top * scale);
      drawRippleFrame(context, ripple, field, cached.dots, progress);
      if (progress < 1) frame = requestAnimationFrame(draw);
      else latest.current.onDone();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [ripple]);

  return (
    <canvas
      ref={canvas}
      className="cw-creation-ripple"
      aria-hidden="true"
      data-creation-ripple=""
      style={{ left, top, width: side, height: side }}
    />
  );
}
