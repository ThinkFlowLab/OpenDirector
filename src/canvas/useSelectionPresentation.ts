import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useReactFlow, useStore, useViewport } from "@xyflow/react";
import type { Rect, Viewport } from "./model";
import {
  centeredViewport,
  projectSelectionRect,
  selectionPlacement,
  selectionViewport,
  type SelectionChrome,
} from "./selectionPresentation";

/** One geometry owner for the node, upper action bar and lower generator. */
export function useSelectionPresentation({
  root,
  toolbar,
  composer,
  bounds,
  mediaBounds = bounds,
  nodeId,
  panel,
  focusRequest,
  blocked,
  controlsKey,
  preferredZoom,
  scaleComposer = false,
}: {
  root: RefObject<HTMLDivElement | null>;
  toolbar: RefObject<HTMLDivElement | null>;
  composer: RefObject<HTMLDivElement | null>;
  bounds: Rect | null;
  mediaBounds?: Rect | null;
  nodeId: string | undefined;
  panel: string | null;
  focusRequest: number;
  blocked: boolean;
  controlsKey: string;
  /** Dedicated media editing may enlarge its source; ordinary selection preserves zoom. */
  preferredZoom?: number;
  scaleComposer?: boolean;
}) {
  const flow = useReactFlow();
  const viewport = useViewport();
  const canvas = useStore((state) => state.domNode);
  const measurementKey = JSON.stringify([
    nodeId,
    panel,
    focusRequest,
    controlsKey,
    scaleComposer,
  ]);
  const [measurement, setMeasurement] = useState<{
    key: string;
    obscured: boolean;
    chrome: SelectionChrome;
  }>({
    key: "",
    obscured: false,
    chrome: {
      safe: { x: 80, y: 72, width: 0, height: 0 },
      toolbar: { width: 0, height: 0 },
      composer: { width: 0, height: 0 },
    },
  });
  const { chrome, obscured } = measurement;
  // Observe real controls, including wrapping, sidebar resizing and viewport size.
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const panels = [...host.querySelectorAll(".cw-side-panel,.cw-assistant-panel:not([hidden])")];
      const canvasRect = canvas?.getBoundingClientRect() ?? rect;
      const canvasOrigin = { x: canvasRect.left - rect.left, y: canvasRect.top - rect.top };
      const canvasLeft = canvasOrigin.x + (rect.width < 700 ? 64 : 80);
      const canvasRight = Math.min(rect.right, canvasRect.right) - rect.left - 20;
      let left = canvasLeft;
      let right = canvasRight;
      for (const panel of panels) {
        const sidebar = panel.getBoundingClientRect();
        if (!panel.classList.contains("cw-assistant-panel") && sidebar.left - rect.left < rect.width / 2)
          left = Math.max(left, sidebar.right - rect.left + 16);
        else right = Math.min(right, sidebar.left - rect.left - 16);
      }
      const covered = right - left < 240;
      if (covered) {
        left = canvasLeft;
        right = canvasRight;
      }
      const top = Math.max(72, canvasOrigin.y);
      const bottom = Math.min(rect.bottom - 78, canvasRect.bottom) - rect.top;
      const safe = {
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      };
      const size = (element: HTMLDivElement | null, canvasUnits = false) => {
        const box = element?.getBoundingClientRect();
        return {
          width: canvasUnits
            ? (element?.offsetWidth ?? 0)
            : Math.min(safe.width, box?.width ?? 0),
          height: canvasUnits
            ? (element?.offsetHeight ?? 0)
            : (box?.height ?? 0),
        };
      };
      const next = {
        key: measurementKey,
        obscured: covered,
        chrome: {
          safe,
          canvasOrigin,
          toolbar: size(toolbar.current),
          composer: size(composer.current, scaleComposer),
          scaleComposer,
        },
      };
      setMeasurement((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    if (canvas) observer.observe(canvas);
    if (toolbar.current) observer.observe(toolbar.current);
    if (composer.current) observer.observe(composer.current);
    for (const panel of host.querySelectorAll(".cw-side-panel,.cw-assistant-panel:not([hidden])")) observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, [root, canvas, toolbar, composer, measurementKey, scaleComposer]);

  const lastLayout = useRef("");
  const origin = useRef<{ key: string; viewport: Viewport } | null>(null);
  const animation = useRef<symbol | null>(null);
  const stopPresentation = useCallback(() => {
    if (!animation.current) return;
    animation.current = null;
    // Interrupt only a transition started here, never a user's zoom command.
    void flow.setViewport(flow.getViewport(), { duration: 0 });
  }, [flow]);
  const present = (next: Viewport) => {
    const token = Symbol();
    animation.current = token;
    void flow
      .setViewport(next, {
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 180,
      })
      .finally(() => {
        if (animation.current === token) animation.current = null;
      });
  };
  useLayoutEffect(() => stopPresentation, [stopPresentation]);
  useLayoutEffect(() => {
    if (!bounds || blocked || obscured) stopPresentation();
    // A new node must not be fitted using the previous node's generator height.
    if (measurement.key !== measurementKey) return;
    const key = JSON.stringify([
      nodeId,
      focusRequest,
      controlsKey,
      chrome,
      obscured,
    ]);
    if (key === lastLayout.current) return;
    if (!bounds || blocked || obscured || chrome.safe.width === 0) return;
    lastLayout.current = key;
    const current = flow.getViewport();
    const intent = JSON.stringify([nodeId, focusRequest, panel]);
    if (origin.current?.key !== intent)
      origin.current = {
        key: intent,
        viewport: preferredZoom
          ? {
              ...current,
              zoom: preferredZoom,
              x:
                current.x +
                (bounds.x + bounds.width / 2) * (current.zoom - preferredZoom),
              y: current.y + bounds.y * (current.zoom - preferredZoom),
            }
          : current,
      };
    // Measurement may settle over several frames (wrapping and max-height). Fit
    // from the same user viewport, otherwise each intermediate size only shrinks.
    const next = selectionViewport(bounds, origin.current.viewport, chrome);
    if (
      Math.abs(next.x - current.x) > 0.5 ||
      Math.abs(next.y - current.y) > 0.5 ||
      Math.abs(next.zoom - current.zoom) > 0.0001
    )
      present(next);
    else stopPresentation();
    // bounds/viewport positions are deliberately not triggers: dragging and manual
    // navigation must never be undone by the presentation's automatic fitting.
  }, [
    nodeId,
    focusRequest,
    panel,
    chrome,
    obscured,
    blocked,
    flow,
    measurement.key,
    measurementKey,
    preferredZoom,
  ]);

  const placement = bounds
    ? selectionPlacement(bounds, viewport, chrome)
    : null;
  const media = mediaBounds
    ? projectSelectionRect(mediaBounds, viewport, chrome.canvasOrigin)
    : null;
  return {
    userNavigation: () => {
      stopPresentation();
      origin.current = null;
    },
    fitSelection: (maxZoom = 1.5) => {
      if (!bounds || obscured || !chrome.safe.width) return;
      const view = { ...flow.getViewport(), zoom: maxZoom };
      // The explicit Fit command may enlarge; normal selection only contains.
      view.x = chrome.safe.x + chrome.safe.width / 2 -
        (bounds.x + bounds.width / 2) * maxZoom - (chrome.canvasOrigin?.x ?? 0);
      view.y = chrome.safe.y + chrome.safe.height / 2 -
        (bounds.y + bounds.height / 2) * maxZoom - (chrome.canvasOrigin?.y ?? 0);
      origin.current = {
        key: JSON.stringify([nodeId, focusRequest, panel]),
        viewport: view,
      };
      present(selectionViewport(bounds, view, chrome));
    },
    reveal: (bounds: Rect) => {
      if (obscured || !chrome.safe.width) return;
      present(centeredViewport(bounds, flow.getViewport(), {
        safe: chrome.safe, canvasOrigin: chrome.canvasOrigin, toolbar: { width: 0, height: 0 }, composer: { width: 0, height: 0 },
      }));
    },
    placement,
    mediaRect: media
      ? {
          left: media.x + viewport.zoom,
          top: media.y + viewport.zoom,
          width: media.width - 2 * viewport.zoom,
          height: media.height - 2 * viewport.zoom,
        }
      : null,
    visible: Boolean(placement?.visible) && !obscured,
    composerWidth:
      !scaleComposer && chrome.safe.width
        ? Math.min(680, chrome.safe.width)
        : 680,
    composerTransform: scaleComposer ? `scale(${viewport.zoom})` : undefined,
    toolbarMaxWidth: chrome.safe.width || undefined,
    composerMaxHeight:
      !scaleComposer && chrome.safe.height
        ? Math.max(120, Math.min(360, chrome.safe.height * 0.58))
        : 360,
  };
}
