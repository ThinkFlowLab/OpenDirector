import { useEffect, useRef, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { MIN_ZOOM, MAX_ZOOM } from "./model.ts";

/** Ctrl/pinch wheels zoom the canvas, never the browser or floating controls. */
export function useCanvasWheelBoundary(
  root: RefObject<HTMLElement | null>,
  onNavigate: () => void,
  enabled = true,
) {
  const flow = useReactFlow();
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useEffect(() => {
    const document = root.current?.ownerDocument;
    if (!document) return;
    const window = document.defaultView!;
    let frame = 0;
    let delta = 0;
    let pointer = { x: 0, y: 0 };
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!enabled || !(event.target instanceof Node) || !root.current?.contains(event.target)) return;
      // A React wheel handler can be passive. Capture natively so browser page
      // zoom is cancelled even over controls rendered through a portal.
      event.preventDefault();
      // Own every modified wheel, including those over inputs and portals, so
      // React Flow cannot apply a second zoom or pan the underlying canvas.
      event.stopPropagation();
      const bounds = root.current
        ?.querySelector(".react-flow")
        ?.getBoundingClientRect();
      if (!bounds) return;
      navigate.current();
      delta +=
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? bounds.height
            : 1);
      pointer = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
      if (frame) return;
      // Accumulate trackpad bursts and update at most once per animation frame.
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const current = flow.getViewport();
        const zoom = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, current.zoom * Math.exp(-delta * 0.002)),
        );
        delta = 0;
        if (zoom === current.zoom) return;
        const ratio = zoom / current.zoom;
        void flow.setViewport({
          x: pointer.x - (pointer.x - current.x) * ratio,
          y: pointer.y - (pointer.y - current.y) * ratio,
          zoom,
        });
      });
    };
    document.addEventListener("wheel", wheel, {
      capture: true,
      passive: false,
    });
    return () => {
      document.removeEventListener("wheel", wheel, true);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [root, flow, enabled]);
}
